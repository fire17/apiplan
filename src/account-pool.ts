// account-pool.ts — several subscription ACCOUNTS per provider, one active at a time.
//
// Owner's ask (Tami, 2026-10-28): "automatic account switching so we stop hitting limits; round
// robin across accounts", switching at 95% of the WEEKLY limit.
//
// OFF BY DEFAULT, AND OFF MEANS ABSENT. A provider has a pool only when its pool dir env is set
// AND the dir holds at least one member file — base well + ≥1 file = ≥2 members. Otherwise
// poolFor() answers null, nothing here reads or writes any state, and every caller takes the
// exact single-account path it took before this file existed.
//
//   APIPLAN_ANTHROPIC_POOL_DIR   dir of *.json, each shaped like the Anthropic well:
//                                {claudeAiOauth:{accessToken, refreshToken?, expiresAt, …}}
//   APIPLAN_CODEX_POOL_DIR       dir of *.json, each shaped like ~/.codex/auth.json
//   APIPLAN_POOL_SWITCH_PCT      weekly % at which the active member is left (default 95)
//   APIPLAN_POOL_MIN_DWELL_S     minimum seconds on a member before a non-forced switch (600)
//   APIPLAN_POOL_POLL_S          usage poll cadence inside `serve` (default 300, floor 120)
//   APIPLAN_POOL_STATE           state file (default <APIPLAN_HOME>/pool-state.json)
//
// apiplan NEVER refreshes these tokens: an external refresher rewrites the member files, and a
// member re-reads its file whenever the file's mtime/size/inode changes. No token ever enters
// the state file, a log line, /health or the CLI — only labels and 12-hex credential hashes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { PROVIDERS, credFpFromJson, credsFromJson, type CredFp, type Creds } from "./providers.ts";
import { HOME, STATE_DIR, readJson, writeJson } from "./platform.ts";
import { accountUsage, type ProviderUsage, type UsageDeps } from "./usage.ts";

export type PoolProvider = "anthropic" | "openai";
export const POOL_PROVIDERS: PoolProvider[] = ["anthropic", "openai"];
const DIR_ENV: Record<PoolProvider, string> = { anthropic: "APIPLAN_ANTHROPIC_POOL_DIR", openai: "APIPLAN_CODEX_POOL_DIR" };

export type PoolMember = {
  /** `base` for the provider's own well, else the member file's basename without `.json`. */
  label: string;
  base: boolean;
  creds(): Creds;
  fp(): CredFp;
};

export type MemberUsage = {
  seven_day?: number; five_hour?: number;
  seven_day_resets_at?: string | null; five_hour_resets_at?: string | null;
  at: number; error?: string;
};
export type PoolState = {
  v: 1;
  providers: Partial<Record<PoolProvider, { active?: string; switched_at?: number }>>;
  /** ident → epoch ms the member is refused until. */
  capped: Record<string, number>;
  /** ident → last polled windows. */
  usage: Record<string, MemberUsage>;
};
export type PoolAccount = {
  label: string; ident: string; active: boolean;
  seven_day: number | null; five_hour: number | null; capped_until: string | null;
};

const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? n : d; };
export const switchPct = () => num(process.env.APIPLAN_POOL_SWITCH_PCT, 95);
export const minDwellMs = () => Math.max(0, num(process.env.APIPLAN_POOL_MIN_DWELL_S, 600)) * 1000;
export const pollMs = () => Math.max(120, num(process.env.APIPLAN_POOL_POLL_S, 300)) * 1000;
export const statePath = () => process.env.APIPLAN_POOL_STATE || join(STATE_DIR, "pool-state.json");
const DEFAULT_CAP_MS = 3600_000;

// ─────────────────────────── state ───────────────────────────

let state: PoolState | null = null;
export function loadState(path = statePath()): PoolState {
  const s = readJson<any>(path, null);
  return s && s.v === 1 && typeof s === "object"
    ? { v: 1, providers: s.providers ?? {}, capped: s.capped ?? {}, usage: s.usage ?? {} }
    : { v: 1, providers: {}, capped: {}, usage: {} };
}
function st(): PoolState { return (state ??= loadState()); }
function save() { try { writeJson(statePath(), st()); } catch (e: any) { process.stderr.write(`[apiplan] pool: cannot write ${statePath()}: ${e?.message ?? e}\n`); } }

// ─────────────────────────── members ───────────────────────────

/** A member file that is re-read only when it changed on disk (mtime/size/inode). */
function fileMember(provider: PoolProvider, file: string): PoolMember {
  const label = basename(file).replace(/\.json$/, "");
  const source = file.replace(HOME, "~");
  let sig = "", json: any = null;
  const read = () => {
    let s;
    try { s = statSync(file); } catch { sig = ""; json = null; return null; }
    const now = `${s.mtimeMs}:${s.size}:${s.ino}`;
    if (now !== sig) {
      // A half-written file does not record its signature, so the next call tries again.
      try { json = JSON.parse(readFileSync(file, "utf8")); sig = now; } catch { json = null; }
    }
    return json;
  };
  return { label, base: false, creds: () => credsFromJson(provider, read(), source), fp: () => credFpFromJson(provider, read()) };
}
function baseMember(provider: PoolProvider): PoolMember {
  const p = PROVIDERS[provider];
  return { label: "base", base: true, creds: () => p.creds(), fp: () => p.credFp!() };
}
/** Pool dir members: every `*.json`, sorted, minus dotfiles and refresher temp/recovery files. */
export function memberFiles(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".json") && !n.startsWith(".") && !n.includes(".RECOVER-") && !n.includes(".tmp-"))
    .sort().map((n) => join(dir, n));
}

// ─────────────────────────── the selector ───────────────────────────

export type Candidate = { label: string; ident: string; expired: boolean };
/**
 * Which member serves next. Pure: every input is passed in.
 *   · stay on the active member while it is usable, not capped and its weekly % < switchPct;
 *   · otherwise (and past the minimum dwell, unless the active one is capped/unusable) move to
 *     the eligible member with the LOWEST weekly %, ties by 5-hour %, then label order. A member
 *     never polled ranks after every measured one — unknown headroom is not headroom;
 *   · nobody eligible: keep a still-working active member, else the usable one back soonest.
 */
export function choose(c: {
  members: Candidate[]; active?: string; switchedAt?: number; now: number;
  capped: Record<string, number>; usage: Record<string, MemberUsage>; switchPct: number; minDwellMs: number;
}): { label: string; reason: "stay" | "dwell" | "switch" | "none-eligible" | "soonest" } {
  const { members, now } = c;
  const isCapped = (m: Candidate) => (c.capped[m.ident] ?? 0) > now;
  const usable = (m: Candidate) => !m.expired && m.ident !== "absent";
  const eligible = (m: Candidate) => usable(m) && !isCapped(m) && (c.usage[m.ident]?.seven_day ?? 0) < c.switchPct;
  const idx = (m: Candidate) => members.indexOf(m);
  const rank = (a: Candidate, b: Candidate) => {
    const ua = c.usage[a.ident], ub = c.usage[b.ident];
    const ka = ua?.seven_day !== undefined ? 0 : 1, kb = ub?.seven_day !== undefined ? 0 : 1;
    return (ka - kb) || ((ua?.seven_day ?? 0) - (ub?.seven_day ?? 0)) || ((ua?.five_hour ?? 0) - (ub?.five_hour ?? 0)) || (idx(a) - idx(b));
  };
  const cur = members.find((m) => m.label === c.active);
  if (cur && eligible(cur)) return { label: cur.label, reason: "stay" };
  const curDown = !cur || !usable(cur) || isCapped(cur);
  if (cur && !curDown && now - (c.switchedAt ?? 0) < c.minDwellMs) return { label: cur.label, reason: "dwell" };
  const next = members.filter((m) => m !== cur && eligible(m)).sort(rank)[0];
  if (next) return { label: next.label, reason: "switch" };
  if (cur && !curDown) return { label: cur.label, reason: "none-eligible" };
  const back = (m: Candidate) => (isCapped(m) ? c.capped[m.ident] : now);
  const alt = members.filter(usable).sort((a, b) => (back(a) - back(b)) || rank(a, b))[0];
  return { label: (alt ?? cur ?? members[0]).label, reason: "soonest" };
}

// ─────────────────────────── the pool ───────────────────────────

export class AccountPool {
  private files: string[] = [];
  private byFile = new Map<string, PoolMember>();
  private dirSig = "";
  private readonly base: PoolMember;
  constructor(readonly provider: PoolProvider, readonly dir: string, base?: PoolMember) {
    this.base = base ?? baseMember(provider);
  }
  /** base + the dir's member files; the dir is re-listed whenever its mtime changes. */
  members(): PoolMember[] {
    let sig = "";
    try { sig = String(statSync(this.dir).mtimeMs); } catch {}
    if (sig !== this.dirSig) {
      this.dirSig = sig;
      this.files = memberFiles(this.dir);
      for (const f of this.files) if (!this.byFile.has(f)) this.byFile.set(f, fileMember(this.provider, f));
    }
    return [this.base, ...this.files.map((f) => this.byFile.get(f)!)];
  }
  private candidates(now: number): { m: PoolMember; c: Candidate }[] {
    return this.members().map((m) => {
      let f: CredFp;
      try { f = m.fp(); } catch { f = { cred: "absent", ident: "absent", exp: 0 }; }
      return { m, c: { label: m.label, ident: f.ident, expired: f.ident === "absent" || (f.exp > 0 && f.exp < now) } };
    });
  }
  /** Re-run the selector, persist a change, and answer the member that serves next. */
  select(now = Date.now()): PoolMember {
    const all = this.candidates(now);
    const s = st();
    const ps = (s.providers[this.provider] ??= {});
    const pick = choose({ members: all.map((x) => x.c), active: ps.active, switchedAt: ps.switched_at, now,
      capped: s.capped, usage: s.usage, switchPct: switchPct(), minDwellMs: minDwellMs() });
    if (pick.label !== ps.active) {
      if (ps.active !== undefined) process.stderr.write(`[apiplan] pool ${this.provider}: ${ps.active} → ${pick.label} (${pick.reason})\n`);
      ps.active = pick.label;
      ps.switched_at = now;
      save();
    }
    return all.find((x) => x.c.label === pick.label)!.m;
  }
  markCapped(ident: string, until: number) {
    if (!ident || ident === "absent") return;
    st().capped[ident] = Math.max(st().capped[ident] ?? 0, until);
    save();
  }
  /** Fold one polled usage answer in. A window at ≥100% caps the member until it resets. */
  recordUsage(ident: string, u: ProviderUsage, now = Date.now()) {
    if (!ident || ident === "absent") return;
    const s = st();
    const prev = s.usage[ident];
    if (!u.five_hour && !u.seven_day) {
      s.usage[ident] = { ...(prev ?? {}), at: prev?.at ?? 0, error: u.error ?? "no windows reported" };
      save();
      return;
    }
    s.usage[ident] = {
      ...(u.seven_day ? { seven_day: u.seven_day.used_percent, seven_day_resets_at: u.seven_day.resets_at } : {}),
      ...(u.five_hour ? { five_hour: u.five_hour.used_percent, five_hour_resets_at: u.five_hour.resets_at } : {}),
      at: now,
    };
    const full = [u.five_hour, u.seven_day].filter((w) => w && w.used_percent >= 100);
    if (full.length) {
      const until = Math.max(...full.map((w) => (w!.resets_at ? Date.parse(w!.resets_at) : NaN)).filter(Number.isFinite), 0);
      s.capped[ident] = Math.max(s.capped[ident] ?? 0, until > now ? until : now + DEFAULT_CAP_MS);
    }
    save();
  }
  /** The /health + CLI view. Labels, 12-hex idents and percentages only — never a token. */
  accounts(now = Date.now(), from: PoolState = st()): PoolAccount[] {
    const active = from.providers[this.provider]?.active;
    return this.candidates(now).map(({ c }) => {
      const u = from.usage[c.ident];
      const cap = from.capped[c.ident] ?? 0;
      return { label: c.label, ident: c.ident, active: c.label === active,
        seven_day: u?.seven_day ?? null, five_hour: u?.five_hour ?? null,
        capped_until: cap > now ? new Date(cap).toISOString() : null };
    });
  }
}

// ─────────────────────────── per-process registry ───────────────────────────

const pools = new Map<PoolProvider, { dir: string; pool: AccountPool }>();
/** The provider's pool, or null when pooling is off for it (no dir, or no member file). */
export function poolFor(provider: string): AccountPool | null {
  if (provider !== "anthropic" && provider !== "openai") return null;
  const dir = process.env[DIR_ENV[provider]];
  if (!dir) return null;
  let e = pools.get(provider);
  if (!e || e.dir !== dir) { e = { dir, pool: new AccountPool(provider, dir) }; pools.set(provider, e); }
  return e.pool.members().length > 1 ? e.pool : null;
}
/** Tests only: forget every pool and the in-memory state. */
export function resetPools() { pools.clear(); state = null; }

/** The member a serve request should use, or null when this provider is single-account. */
export function poolLease(provider: string): PoolMember | null {
  const p = poolFor(provider);
  return p ? p.select() : null;
}

/**
 * The member `failed` was refused for capacity before a byte reached the client: cap it until
 * `resetAt` (or +1h when the upstream did not say), re-select, and answer the new member — or
 * null when there is no OTHER uncapped member to try, so the caller surfaces the refusal as before.
 */
export function poolFailover(provider: string, failed: PoolMember, resetAt?: number, now = Date.now()): PoolMember | null {
  const p = poolFor(provider);
  if (!p) return null;
  let ident = "absent";
  try { ident = failed.fp().ident; } catch {}
  p.markCapped(ident, resetAt && resetAt > now ? resetAt : now + DEFAULT_CAP_MS);
  const next = p.select(now);
  if (next.label === failed.label) return null;
  // A member that is itself capped would only repeat the refusal: no retry then.
  let nextIdent = "absent";
  try { nextIdent = next.fp().ident; } catch {}
  return (st().capped[nextIdent] ?? 0) > now ? null : next;
}

/** /health's `accounts` for a provider, or undefined when its pool is off. */
export function poolAccounts(provider: string): PoolAccount[] | undefined {
  return poolFor(provider)?.accounts();
}

// ─────────────────────────── usage polling (serve only) ───────────────────────────

let polling: Promise<void> | null = null;
/** Poll every member of every active pool once, then re-select. Never more than one in flight. */
export function pollPoolsOnce(deps: UsageDeps = {}): Promise<void> {
  if (polling) return polling;
  polling = (async () => {
    for (const provider of POOL_PROVIDERS) {
      const p = poolFor(provider);
      if (!p) continue;
      for (const m of p.members()) {
        let ident = "absent";
        try { ident = m.fp().ident; } catch {}
        if (ident === "absent") continue;
        try { p.recordUsage(ident, await accountUsage(provider, ident, () => m.creds(), deps)); } catch {}
      }
      try { p.select(); } catch {}
    }
  })().finally(() => { polling = null; });
  return polling;
}
/** Start the background poller when any provider has an active pool. Returns its stopper. */
export function startPoolPoller(): (() => void) | null {
  if (!POOL_PROVIDERS.some((p) => poolFor(p))) return null;
  const kick = () => { void pollPoolsOnce().catch(() => {}); };
  const first = setTimeout(kick, 0);
  const t = setInterval(kick, pollMs());
  (first as any).unref?.();
  (t as any).unref?.();
  return () => { clearTimeout(first); clearInterval(t); };
}
