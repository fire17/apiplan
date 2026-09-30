// usage.ts — subscription usage windows (5-hour + weekly) for Anthropic and OpenAI/Codex.
//
// Owner's ask (fire17, 2026-10-01 01:30): "request their current usage — the 5-hour and the
// weekly windows and their percentages — so we can run checks and at a certain percent switch
// from Anthropic to OpenAI and back." Served as GET /v1/usage and `apiplan usage`.
//
// Sources, both reused from ~/Creations/AccountTracker where they were proven live:
//   · Anthropic: GET api.anthropic.com/api/oauth/usage (tracker.py poll_oauth). anthropic-version
//     is REQUIRED — without it Cloudflare answers a fake 429 with retry-after: 0.
//     That endpoint needs scope user:profile. A `claude setup-token` credential carries only
//     user:inference and gets 403 permission_error "does not meet scope requirement user:profile"
//     (measured on the production server 2026-10-01 01:35). Then — the server's NORMAL path —
//     one max_tokens:1 call on the cheapest model is made and the unified rate-limit headers are
//     read: anthropic-ratelimit-unified-{5h,7d}-utilization (a FRACTION: 0.13 == oauth's 13.0,
//     measured side by side on this Mac 2026-10-01) and -reset (epoch seconds).
//   · Codex: GET chatgpt.com/backend-api/codex/usage (providers/windows.py). Windows are mapped
//     by limit_window_seconds, NEVER by position: on a Pro account measured 2026-10-01 the
//     `primary_window` was the 604800 s weekly window and `secondary_window` was null. An HTML
//     403 is the edge WAF, not an auth failure (providers/liveness.py).
//
// Never refreshes a token, never writes a credential, never prints one: every error string is
// scrubbed of the bearer before it leaves this module.
import { PROVIDERS, type Creds } from "./providers.ts";
import { parseResetValue } from "./capacity-signal.ts";
import { readJson, HOME } from "./platform.ts";
import { join } from "node:path";

export type UsageWindow = { used_percent: number; resets_at: string | null };
export type ProviderUsage = {
  account: string | null;
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  extra: Record<string, UsageWindow>;
  source: string;
  fetched_at: string;
  status?: string;
  plan?: string;
  error?: string;
};
export type UsageProvider = "anthropic" | "openai";
export const USAGE_PROVIDERS: UsageProvider[] = ["anthropic", "openai"];

export type UsageDeps = {
  fetch?: typeof fetch;
  creds?: (p: UsageProvider) => Creds;
  now?: () => number;
};

const FIVE_H = 5 * 3600, SEVEN_D = 7 * 86400;
const TIMEOUT_MS = 10_000;
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const CODEX_UA = "codex_cli_rs/0.144.2";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Fixed TTL, success or failure alike: a poller can never pull it down to an aggressive floor. */
const ttlMs = () => Math.max(1000, Number(process.env.APIPLAN_USAGE_TTL_MS) || 60_000);

type Entry = { at: number; value?: ProviderUsage; inflight?: Promise<ProviderUsage> };
const cache = new Map<UsageProvider, Entry>();
/**
 * Credentials whose token was refused on /api/oauth/usage for SCOPE (403 permission_error,
 * user:profile). A token's scope never changes, so that credential skips the oauth call for as
 * long as it is the credential — keyed by a hash of the token, never the token itself.
 */
const scopeRefused = new Set<string>();
/**
 * oauth/usage rate-limits hard at the edge (AccountTracker measured 15 of 17 one-minute polls
 * refused, and floors its own cadence at 300 s). After a 429 the header probe answers instead
 * and oauth is left alone until this instant — a success elsewhere never shortens the hold.
 */
let oauthHoldUntil = 0;
const OAUTH_HOLD_MS = 300_000;

export function resetUsageCache(): void { cache.clear(); scopeRefused.clear(); oauthHoldUntil = 0; }

const hashTok = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex").slice(0, 16);
const iso = (ms: number | undefined) => (ms && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const pct = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
};
const scrub = (s: string, token?: string) => (token ? s.split(token).join("<redacted>") : s);

function blank(source: string, now: number): ProviderUsage {
  return { account: null, five_hour: null, seven_day: null, extra: {}, source, fetched_at: new Date(now).toISOString() };
}

async function get(f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  return f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

/** ~/.claude.json's signed-in account, only when the credential is the machine's own login. */
function claudeAccount(c: Creds): string | null {
  if (process.env.APIPLAN_ANTHROPIC_CRED_FILE) return null;
  if (!/Keychain|\.claude\/\.credentials\.json/.test(c.source)) return null;
  const j = readJson<any>(join(HOME, ".claude.json"), null);
  const e = j?.oauthAccount?.emailAddress;
  return typeof e === "string" && e ? e : null;
}

/** oauth/usage body → windows. utilization there is already a percent (0-100). */
function fromOauthBody(b: any, u: ProviderUsage): void {
  const win = (v: any): UsageWindow | null => {
    const p = pct(v?.utilization);
    if (p === undefined) return null;
    const r = typeof v?.resets_at === "string" ? Date.parse(v.resets_at) : NaN;
    return { used_percent: p, resets_at: Number.isFinite(r) ? new Date(r).toISOString() : null };
  };
  u.five_hour = win(b?.five_hour);
  u.seven_day = win(b?.seven_day);
  for (const [k, v] of Object.entries(b ?? {})) {
    if (k === "five_hour" || k === "seven_day" || k === "extra_usage" || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const w = win(v);
    if (w) u.extra[k] = w;
  }
}

const UNIFIED = /^anthropic-ratelimit-unified-(.+)-utilization$/;
/** Unified rate-limit headers → windows. utilization is a FRACTION; -reset is epoch seconds. */
export function fromUnifiedHeaders(h: Headers, u: ProviderUsage, now: number): boolean {
  let any = false;
  for (const [k, v] of h) {
    const m = k.toLowerCase().match(UNIFIED);
    if (!m) continue;
    const frac = pct(v);
    if (frac === undefined) continue;
    const w: UsageWindow = { used_percent: Math.round(frac * 10000) / 100, resets_at: iso(parseResetValue(h.get(`anthropic-ratelimit-unified-${m[1]}-reset`), now)) };
    any = true;
    if (m[1] === "5h") u.five_hour = w;
    else if (m[1] === "7d") u.seven_day = w;
    else u.extra[m[1]] = w;
  }
  const st = h.get("anthropic-ratelimit-unified-status");
  if (st) u.status = st;
  return any;
}

async function anthropicUsage(d: Required<UsageDeps>): Promise<ProviderUsage> {
  const now = d.now();
  let c: Creds;
  try { c = d.creds("anthropic"); }
  catch (e) { return { ...blank("none", now), error: `credential: ${e instanceof Error ? e.message : String(e)}` }; }
  const tok = c.token;
  const mode = (process.env.APIPLAN_USAGE_ANTHROPIC_SOURCE ?? "auto").toLowerCase();
  const id = hashTok(tok);
  let oauthNote = "";
  if (mode !== "headers" && !scopeRefused.has(id) && (mode === "oauth" || now >= oauthHoldUntil)) {
    const u = blank("oauth/usage", now);
    u.account = claudeAccount(c);
    try {
      const r = await get(d.fetch, OAUTH_USAGE_URL, { headers: {
        authorization: `Bearer ${tok}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01",
        accept: "application/json", "user-agent": "apiplan-usage/1",
      } });
      const text = await r.text();
      if (r.ok) {
        let b: any;
        try { b = JSON.parse(text); } catch { b = undefined; }
        if (b && !b.error) { fromOauthBody(b, u); return u; }
        oauthNote = "oauth/usage answered 200 with no usable body";
      } else {
        let b: any;
        try { b = JSON.parse(text); } catch { b = undefined; }
        const msg = String(b?.error?.message ?? b?.message ?? "");
        const type = String(b?.error?.type ?? b?.type ?? "");
        if (r.status === 403 && (type === "permission_error" || /user:profile|scope/i.test(msg))) {
          scopeRefused.add(id);
          oauthNote = "oauth/usage refused: token lacks scope user:profile";
        } else {
          oauthNote = `oauth/usage HTTP ${r.status}${msg ? `: ${msg.slice(0, 160)}` : ""}`;
          if (r.status === 429) {
            const ra = parseResetValue(r.headers.get("retry-after"), now);
            oauthHoldUntil = Math.max(now + OAUTH_HOLD_MS, ra ?? 0);
          }
        }
        if (mode === "oauth") return { ...u, error: scrub(oauthNote, tok) };
      }
    } catch (e) {
      oauthNote = `oauth/usage unreachable: ${e instanceof Error ? e.message : String(e)}`;
      if (mode === "oauth") return { ...u, error: scrub(oauthNote, tok) };
    }
  } else if (scopeRefused.has(id)) {
    oauthNote = "oauth/usage skipped: this token lacks scope user:profile";
  } else if (mode !== "headers") {
    oauthNote = `oauth/usage held after a 429 until ${new Date(oauthHoldUntil).toISOString()}`;
  }

  // The inference-header probe: the one path a user:inference-only token can take.
  const model = process.env.APIPLAN_USAGE_PROBE_MODEL || "claude-haiku-4-5-20251001";
  const u = blank(`ratelimit-headers (${model} max_tokens:1)`, now);
  u.account = claudeAccount(c);
  try {
    const r = await get(d.fetch, `${process.env.APIPLAN_ANTHROPIC_BASE || "https://api.anthropic.com"}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json", authorization: `Bearer ${tok}`,
        "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20",
        "anthropic-client-platform": "cli", "x-app": "cli",
      },
      body: JSON.stringify({ model, max_tokens: 1, system: [{ type: "text", text: IDENTITY }], messages: [{ role: "user", content: "." }] }),
    });
    // A 429 still carries the unified headers — and is exactly when a switch matters most.
    const got = fromUnifiedHeaders(r.headers, u, now);
    try { await r.body?.cancel(); } catch {}
    if (!got) u.error = scrub(`probe HTTP ${r.status}: no unified rate-limit headers${oauthNote ? ` (${oauthNote})` : ""}`, tok);
    else if (oauthNote && mode !== "headers") u.source += ` — ${oauthNote}`;
  } catch (e) {
    u.error = scrub(`probe unreachable: ${e instanceof Error ? e.message : String(e)}${oauthNote ? ` (${oauthNote})` : ""}`, tok);
  }
  return u;
}

// ── OpenAI / Codex ────────────────────────────────────────────────────────────

function codexWhy(status: number, text: string): string {
  const t = text.trimStart();
  if (status === 401) return "credential rejected (HTTP 401)";
  if (status === 403) {
    if (t.startsWith("{")) return `refused by the vendor (HTTP 403): ${t.slice(0, 160)}`;
    return "blocked by the edge WAF, not by auth (HTTP 403, HTML body)";
  }
  return `HTTP ${status}${t && t.startsWith("{") ? `: ${t.slice(0, 160)}` : ""}`;
}

/** One codex window → [span seconds, window]. Unknown spans come back with their own label. */
function codexWindow(w: any, now: number): [number | undefined, UsageWindow] | undefined {
  if (!w || typeof w !== "object") return undefined;
  const p = pct(w.used_percent ?? w.used_percentage);
  if (p === undefined) return undefined;
  const secs = Number(w.limit_window_seconds ?? (w.window_minutes != null ? Number(w.window_minutes) * 60 : NaN));
  const reset = w.reset_at ?? w.resets_at;
  const at = reset != null ? parseResetValue(reset, now)
    : w.reset_after_seconds != null ? now + Number(w.reset_after_seconds) * 1000 : undefined;
  return [Number.isFinite(secs) ? secs : undefined, { used_percent: p, resets_at: iso(at) }];
}
const spanLabel = (s: number | undefined) =>
  s === undefined ? "window" : s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : `${s}s`;

function fromCodexBody(b: any, u: ProviderUsage, now: number): void {
  if (typeof b?.email === "string" && b.email) u.account = b.email;
  if (typeof b?.plan_type === "string") u.plan = b.plan_type;
  const place = (bucket: string, key: string, w: any, positional?: "five_hour" | "seven_day") => {
    const got = codexWindow(w, now);
    if (!got) return;
    const [span, win] = got;
    // By span first; a window that does not state one falls back to its position.
    const slot = span === FIVE_H ? "five_hour" : span === SEVEN_D ? "seven_day" : span === undefined ? positional : undefined;
    if (bucket === "rate_limit" && slot && !u[slot]) { u[slot] = win; return; }
    u.extra[`${bucket === "rate_limit" ? "" : bucket + "."}${key}_${spanLabel(span)}`] = win;
  };
  const rl = b?.rate_limit;
  if (rl && typeof rl === "object") {
    place("rate_limit", "primary", rl.primary_window ?? rl.primary, "five_hour");
    place("rate_limit", "secondary", rl.secondary_window ?? rl.secondary, "seven_day");
    if (rl.limit_reached === true) u.status = "limit_reached";
    else if (rl.allowed === true) u.status = "allowed";
    else if (rl.allowed === false) u.status = "rejected";
  }
  const crl = b?.code_review_rate_limit;
  if (crl && typeof crl === "object") {
    place("code_review", "primary", crl.primary_window ?? crl.primary);
    place("code_review", "secondary", crl.secondary_window ?? crl.secondary);
  }
  for (const a of Array.isArray(b?.additional_rate_limits) ? b.additional_rate_limits : []) {
    const name = String(a?.limit_name ?? a?.limit_id ?? "additional").replace(/\s+/g, "_");
    const inner = a?.rate_limit ?? a;
    place(name, "primary", inner?.primary_window ?? inner?.primary);
    place(name, "secondary", inner?.secondary_window ?? inner?.secondary);
  }
}

async function openaiUsage(d: Required<UsageDeps>): Promise<ProviderUsage> {
  const now = d.now();
  const u = blank("codex/usage", now);
  let c: Creds;
  try { c = d.creds("openai"); }
  catch (e) { return { ...u, source: "none", error: `credential: ${e instanceof Error ? e.message : String(e)}` }; }
  try {
    const r = await get(d.fetch, CODEX_USAGE_URL, { headers: {
      authorization: `Bearer ${c.token}`, "user-agent": CODEX_UA, accept: "application/json",
      ...(c.account ? { "chatgpt-account-id": c.account } : {}),
    } });
    const text = await r.text();
    if (!r.ok) return { ...u, error: scrub(codexWhy(r.status, text), c.token) };
    let b: any;
    try { b = JSON.parse(text); } catch { return { ...u, error: "codex/usage returned a body that is not JSON" }; }
    fromCodexBody(b, u, now);
    return u;
  } catch (e) {
    return { ...u, error: scrub(`codex/usage unreachable: ${e instanceof Error ? e.message : String(e)}`, c.token) };
  }
}

// ── entry point ───────────────────────────────────────────────────────────────

const defaults = (deps: UsageDeps): Required<UsageDeps> => ({
  fetch: deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch,
  creds: deps.creds ?? ((p) => PROVIDERS[p].creds()),
  now: deps.now ?? Date.now,
});

async function one(p: UsageProvider, d: Required<UsageDeps>): Promise<ProviderUsage> {
  const e = cache.get(p);
  const now = d.now();
  if (e?.value && now - e.at < ttlMs()) return e.value;
  if (e?.inflight) return e.inflight;
  const run = (p === "anthropic" ? anthropicUsage(d) : openaiUsage(d)).catch((err): ProviderUsage =>
    ({ ...blank("none", now), error: `internal: ${err instanceof Error ? err.message : String(err)}` }));
  cache.set(p, { at: e?.at ?? 0, value: e?.value, inflight: run });
  const v = await run;
  cache.set(p, { at: d.now(), value: v });
  return v;
}

/** Each provider answers on its own: one failing never fails the other. */
export async function subscriptionUsage(provider?: UsageProvider, deps: UsageDeps = {}): Promise<Partial<Record<UsageProvider, ProviderUsage>>> {
  const d = defaults(deps);
  const which = provider ? [provider] : USAGE_PROVIDERS;
  const vals = await Promise.all(which.map((p) => one(p, d)));
  return Object.fromEntries(which.map((p, i) => [p, vals[i]]));
}
