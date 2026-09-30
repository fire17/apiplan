// serve-keys.ts — per-device / per-project keys for `apiplan serve`, and the usage ledger
// that says who spent what through each one.
//
// Owner's ask (fire17, 2026-10-01): "issue our own tokens per device/project, and calculate the
// usage made specifically through that token — who uses what and how much".
//
// THE STORE holds only sha256 hashes. A key is `apk_<id>_<32 url-safe chars>`; the plaintext is
// returned once by createKey() for the caller to print and is never written, logged or kept. The
// `id` segment is public (it is what `keys list`, the ledger and `keys revoke` name), the tail is
// the secret. File mode 0600, atomic replace, re-read whenever its mtime/size moves — so a revoke
// takes effect on a running server without a restart.
//
// THE LEDGER is append-only JSONL, one line per completed metered request: key id + label, route,
// provider, model, stream, status, the four token buckets (disjoint: input excludes cache), cost
// from the roster's published rate cards, latency. Never a prompt, never a key.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./platform.ts";
import { DOCUMENTED, type ModelCost } from "./roster.ts";

export type KeyRecord = { id: string; label: string; created_at: string; revoked_at?: string; sha256: string };
export type KeyStore = { version: 1; keys: KeyRecord[] };
/** Who a request is attributed to. `legacy` = the single shared key; `anonymous` = open mode. */
export type Ident = { id: string; label: string };
export const LEGACY: Ident = { id: "legacy", label: "legacy" };
export const ANONYMOUS: Ident = { id: "anonymous", label: "anonymous" };

type Env = Record<string, string | undefined>;
const home = (env: Env) => env.APIPLAN_HOME || STATE_DIR;
export const keysFile = (env: Env = process.env) => env.APIPLAN_SERVE_KEYS_FILE || join(home(env), "serve-keys.json");
export const ledgerFile = (env: Env = process.env) => env.APIPLAN_USAGE_LEDGER || join(home(env), "usage-ledger.jsonl");

const KEY_RE = /^apk_([a-z0-9]{8})_([A-Za-z0-9_-]{32})$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function readStore(file = keysFile()): KeyStore {
  if (!existsSync(file)) return { version: 1, keys: [] };
  const j = JSON.parse(readFileSync(file, "utf8"));
  return { version: 1, keys: Array.isArray(j?.keys) ? j.keys : [] };
}

function writeStore(store: KeyStore, file = keysFile()) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/** Mint a key. Returns the plaintext ONCE; only its hash is stored. */
export function createKey(label: string, file = keysFile()): { record: KeyRecord; key: string } {
  const clean = label.trim();
  if (!clean) throw new Error("a key needs a label (the device or project it is for)");
  const store = readStore(file);
  let id = "";
  do id = randomBytes(8).toString("hex").slice(0, 8); while (store.keys.some((k) => k.id === id));
  const secret = randomBytes(24).toString("base64url"); // 24 bytes → exactly 32 url-safe chars
  const key = `apk_${id}_${secret}`;
  const record: KeyRecord = { id, label: clean, created_at: new Date().toISOString(), sha256: sha(key) };
  store.keys.push(record);
  writeStore(store, file);
  return { record, key };
}

export function revokeKey(id: string, file = keysFile()): KeyRecord {
  const store = readStore(file);
  const k = store.keys.find((x) => x.id === id);
  if (!k) throw new Error(`no key with id '${id}' (apiplan keys list)`);
  if (!k.revoked_at) { k.revoked_at = new Date().toISOString(); writeStore(store, file); }
  return k;
}

/** The store a running server consults, re-read only when the file changed. */
export function keyCache(file = keysFile()) {
  let stamp = "", active: KeyRecord[] = [];
  const refresh = () => {
    let s = "missing";
    try { const st = statSync(file); s = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch {}
    if (s === stamp) return;
    stamp = s;
    try { active = readStore(file).keys.filter((k) => !k.revoked_at && typeof k.sha256 === "string"); }
    // An unreadable store must not silently open a server that relied on it: keep the last good set.
    catch (e: any) { process.stderr.write(`apiplan serve: cannot read ${file}: ${e?.message ?? e} (keeping the previous key set)\n`); }
  };
  return {
    file,
    /** How many active keys the store holds right now. */
    activeCount(): number { refresh(); return active.length; },
    /** The key record `presented` belongs to, or null. Hash-to-hash constant-time compare. */
    match(presented: string): KeyRecord | null {
      refresh();
      const m = KEY_RE.exec(presented);
      const h = Buffer.from(sha(presented), "hex");
      const cand = m ? active.find((k) => k.id === m[1]) : undefined;
      // Compare against SOMETHING either way, so an unknown id costs the same as a wrong secret.
      const want = Buffer.from(cand?.sha256 ?? sha("apk_absent"), "hex");
      const ok = want.length === h.length && timingSafeEqual(h, want);
      return ok && cand ? cand : null;
    },
  };
}

// ─────────────────────────── cost ───────────────────────────

export type Buckets = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number };

/**
 * USD at the model's published list rates (roster.ts DOCUMENTED — the same card OM prices with).
 * Buckets are DISJOINT (input excludes cache). The long-context card replaces the base card for
 * the whole request once the prompt (input + cache read + cache write) crosses its threshold. A
 * stated 1-hour cache-write share is priced at 2x input (Anthropic's documented 1h rate); the rest
 * of the write at the card's cacheWrite. Unknown model → null (never a guessed zero).
 */
export function costUsd(model: string | undefined, b: Buckets): number | null {
  const card: ModelCost | undefined = model ? DOCUMENTED[model]?.cost : undefined;
  if (!card) return null;
  const prompt = b.input + b.cacheRead + b.cacheWrite;
  const lc = card.longContext;
  const r = lc && (lc.inputThresholdInclusive ? prompt >= lc.inputThreshold : prompt > lc.inputThreshold) ? lc : card;
  const h1 = Math.min(b.cacheWrite1h ?? 0, b.cacheWrite);
  const usd = (b.input * r.input + b.output * r.output + b.cacheRead * r.cacheRead
    + (b.cacheWrite - h1) * r.cacheWrite + h1 * r.input * 2) / 1e6;
  return Math.round(usd * 1e8) / 1e8;
}

// ─────────────────────────── ledger ───────────────────────────

export type LedgerLine = {
  ts: string; key_id: string; label: string; route: string; provider: string | null; model: string | null;
  stream: boolean; status: number; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number; cost_usd: number | null; latency_ms: number;
  /** Present only when some count is this server's estimate rather than the provider's. */
  estimated?: true;
  /** Present only when the provider's counters could not be partitioned exactly. */
  usage_basis?: string;
};

let ledgerWarned = false;
/** Append one line. Never throws into a request: a failed write is reported once on stderr. */
export function appendLedger(line: LedgerLine, file = ledgerFile()) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
  } catch (e: any) {
    if (!ledgerWarned) { ledgerWarned = true; process.stderr.write(`apiplan serve: cannot append usage ledger ${file}: ${e?.message ?? e}\n`); }
  }
}

export function readLedger(sinceMs = 0, file = ledgerFile()): LedgerLine[] {
  if (!existsSync(file)) return [];
  const out: LedgerLine[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw) continue;
    try { const l = JSON.parse(raw); if (!sinceMs || Date.parse(l.ts) >= sinceMs) out.push(l); } catch {}
  }
  return out;
}

/** `24h`, `7d`, `30m`, `90s` → milliseconds; undefined/"all" → 0 (everything). */
export function parseWindow(w: string | undefined | null): number {
  if (!w || w === "all") return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(w.trim());
  if (!m) throw new Error(`window must look like 30m, 24h, 7d or all (got '${w}')`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[m[2] as "s"];
}

export type KeyTotals = {
  key_id: string; label: string; requests: number; errors: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  total_tokens: number; cost_usd: number; unpriced_requests: number; last_used: string | null;
};

export function totalsByKey(lines: LedgerLine[], only?: (keyId: string) => boolean): KeyTotals[] {
  const by = new Map<string, KeyTotals>();
  for (const l of lines) {
    if (only && !only(l.key_id)) continue;
    let t = by.get(l.key_id);
    if (!t) by.set(l.key_id, t = { key_id: l.key_id, label: l.label, requests: 0, errors: 0, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost_usd: 0, unpriced_requests: 0, last_used: null });
    t.label = l.label; // the newest label wins
    t.requests++;
    if (l.status >= 400) t.errors++;
    t.input_tokens += l.input_tokens || 0; t.output_tokens += l.output_tokens || 0;
    t.cache_read_tokens += l.cache_read_tokens || 0; t.cache_write_tokens += l.cache_write_tokens || 0;
    if (typeof l.cost_usd === "number") t.cost_usd += l.cost_usd;
    else if ((l.input_tokens || l.output_tokens) && l.status < 400) t.unpriced_requests++;
    if (!t.last_used || l.ts > t.last_used) t.last_used = l.ts;
  }
  for (const t of by.values()) {
    t.total_tokens = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens;
    t.cost_usd = Math.round(t.cost_usd * 1e6) / 1e6;
  }
  return [...by.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.requests - a.requests);
}

// ─────────────────────────── breakdowns (the dashboard's pies) ───────────────────────────
//
// Owner's ask (fire17, 2026-10-01 02:07): "see the overall, but also understand from it — like a
// pie chart — how it was used in terms of tokens". One aggregation over the same (already
// visibility-filtered) ledger lines, keyed three ways. Every line lands in exactly one bucket of
// each grouping, so each grouping's rows sum to `overall` — the tests hold that.

export type Tally = {
  requests: number; errors: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  total_tokens: number; cost_usd: number; unpriced_requests: number;
};
export type ModelTally = Tally & { model: string; provider: string | null };
export type DayTally = Tally & { day: string };
export type Breakdown = { overall: Tally; by_model?: ModelTally[]; by_day?: DayTally[]; by_key?: KeyTotals[]; tz_offset_min: number };
export type Group = "model" | "day" | "key";
export const GROUPS: Group[] = ["model", "day", "key"];

const zero = (): Tally => ({ requests: 0, errors: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  total_tokens: 0, cost_usd: 0, unpriced_requests: 0 });
function add(t: Tally, l: LedgerLine) {
  t.requests++;
  if (l.status >= 400) t.errors++;
  t.input_tokens += l.input_tokens || 0; t.output_tokens += l.output_tokens || 0;
  t.cache_read_tokens += l.cache_read_tokens || 0; t.cache_write_tokens += l.cache_write_tokens || 0;
  if (typeof l.cost_usd === "number") t.cost_usd += l.cost_usd;
  else if ((l.input_tokens || l.output_tokens) && l.status < 400) t.unpriced_requests++;
}
function seal<T extends Tally>(t: T): T {
  t.total_tokens = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens;
  t.cost_usd = Math.round(t.cost_usd * 1e6) / 1e6;
  return t;
}
/** `group=model,day` / `model` / `all` → the groupings asked for; unknown names are an error. */
export function parseGroups(s: string | null | undefined): Group[] {
  if (!s) return [];
  const out = new Set<Group>();
  for (const g of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (g === "all") GROUPS.forEach((x) => out.add(x));
    else if ((GROUPS as string[]).includes(g)) out.add(g as Group);
    else throw new Error(`group must be model, day or key (comma-separated), got '${g}'`);
  }
  return [...out];
}
/** The calendar day of `ts` at a fixed offset (minutes EAST of UTC — Israel summer is 180). */
export const dayOf = (ts: string, tzOffsetMin = 0) => new Date(Date.parse(ts) + tzOffsetMin * 6e4).toISOString().slice(0, 10);

/**
 * Totals plus the requested groupings over `lines` (filter them for visibility FIRST — or pass
 * `only`). by_day is contiguous: every calendar day from the window start (or the first line) to
 * `now` appears, zero-filled, so a bar strip has no silent gaps.
 */
export function breakdown(lines: LedgerLine[], groups: Group[], opts: { only?: (keyId: string) => boolean; tzOffsetMin?: number; sinceMs?: number; now?: number } = {}): Breakdown {
  const tz = opts.tzOffsetMin ?? 0;
  const mine = opts.only ? lines.filter((l) => opts.only!(l.key_id)) : lines;
  const overall = zero();
  const models = new Map<string, ModelTally>(), days = new Map<string, DayTally>();
  for (const l of mine) {
    add(overall, l);
    if (groups.includes("model")) {
      const name = l.model || "(no model)";
      let m = models.get(name);
      if (!m) models.set(name, m = { model: name, provider: l.provider ?? null, ...zero() });
      if (l.provider) m.provider = l.provider;
      add(m, l);
    }
    if (groups.includes("day")) {
      const d = dayOf(l.ts, tz);
      let t = days.get(d);
      if (!t) days.set(d, t = { day: d, ...zero() });
      add(t, l);
    }
  }
  const out: Breakdown = { overall: seal(overall), tz_offset_min: tz };
  if (groups.includes("model")) out.by_model = [...models.values()].map(seal).sort((a, b) => b.cost_usd - a.cost_usd || b.total_tokens - a.total_tokens);
  if (groups.includes("day")) {
    const now = opts.now ?? Date.now();
    const firstTs = mine.reduce((m, l) => (l.ts < m ? l.ts : m), new Date(now).toISOString());
    const start = opts.sinceMs ? new Date(opts.sinceMs).toISOString() : firstTs;
    const all: DayTally[] = [];
    // Walk calendar days at the offset; capped so a garbage ts cannot allocate forever.
    for (let d = dayOf(start, tz), end = dayOf(new Date(now).toISOString(), tz), n = 0; d <= end && n < 800; n++) {
      all.push(days.get(d) ? seal(days.get(d)!) : { day: d, ...zero() });
      d = new Date(Date.parse(d + "T00:00:00Z") + 8.64e7).toISOString().slice(0, 10);
    }
    // Lines stamped after `now` (clock skew) still count: append any day the walk did not reach.
    for (const [d, t] of days) if (!all.some((x) => x.day === d)) all.push(seal(t));
    out.by_day = all.sort((a, b) => a.day.localeCompare(b.day));
  }
  if (groups.includes("key")) out.by_key = totalsByKey(mine);
  return out;
}
