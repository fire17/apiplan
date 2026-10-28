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
//   APIPLAN_POOL_STRATEGY        headroom (default) | sticky | round-robin — see poolStrategy()
//
// TIERS (Tami, voice AC61B89F 2026-10-28: a managed list of which accounts the server may use; his
// own fire17 account never in the pool; work accounts only in an emergency). Each pool dir may hold
// a `.registry.json` (a dotfile, so never a member) keyed by member label (`base` = the well):
//   { "<label>": { "tier": "primary" | "backup" | "emergency" | "blocked", "email"?: "…", "note"?: "…" } }
// A label not listed is `primary`. `blocked` members are dropped entirely — never served, polled
// or failed over to. Every strategy serves only from the BEST tier that has an eligible member,
// and a member on a worse tier hands back as soon as a better one is eligible again (after dwell).
//
// apiplan NEVER refreshes these tokens: an external refresher rewrites the member files, and a
// member re-reads its file whenever the file's mtime/size/inode changes. No token ever enters
// the state file, a log line, /health or the CLI — only labels and 12-hex credential hashes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
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
/**
 * Per provider, keyed by member LABEL — never by credential ident. An external refresher rotates
 * a Claude member's refresh token on every refresh (~8 h on srv2), and the ident hashes that
 * token, so ident-keyed caps/usage were forgotten three times a day. The label (file name) is
 * stable across refreshes; `ident` survives only as a display field in /health + `apiplan pool`.
 */
export type ProviderPoolState = {
  active?: string; switched_at?: number;
  /** label → epoch ms the member is refused until. */
  capped: Record<string, number>;
  /** label → last polled windows. */
  usage: Record<string, MemberUsage>;
};
export type PoolState = { v: 2; providers: Partial<Record<PoolProvider, ProviderPoolState>> };
export type PoolAccount = {
  label: string; ident: string; active: boolean; tier: TierName;
  seven_day: number | null; five_hour: number | null; capped_until: string | null;
};

const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? n : d; };
export const switchPct = () => num(process.env.APIPLAN_POOL_SWITCH_PCT, 95);
export const minDwellMs = () => Math.max(0, num(process.env.APIPLAN_POOL_MIN_DWELL_S, 600)) * 1000;
export const pollMs = () => Math.max(120, num(process.env.APIPLAN_POOL_POLL_S, 300)) * 1000;
export const statePath = () => process.env.APIPLAN_POOL_STATE || join(STATE_DIR, "pool-state.json");
const DEFAULT_CAP_MS = 3600_000;

/**
 * How a request picks its member. Every strategy picks only among ELIGIBLE members (usable, not
 * capped, weekly % < switch pct), falls back to the headroom member when none is, and keeps the
 * one-retry 429 failover.
 *   headroom     (default) one active member at a time: stay on it until it reaches the switch
 *                pct or is capped, then move to the lowest-weekly member. Best prompt-cache reuse.
 *   sticky       a conversation → a member by rendezvous-hashing the request's prompt-cache key
 *                (Codex prompt_cache_key, Anthropic metadata.user_id, else the derived
 *                model+system+first-user-turn hash). One conversation keeps its cache; distinct
 *                conversations spread across accounts. No key ⇒ headroom.
 *   round-robin  rotate PER REQUEST over the eligible members. Even load, but it FORFEITS
 *                prompt-cache hits on multi-turn traffic: consecutive turns of one conversation
 *                land on different accounts, and a prompt cache never crosses accounts.
 */
export type PoolStrategy = "headroom" | "sticky" | "round-robin";
export function poolStrategy(): PoolStrategy {
  const v = (process.env.APIPLAN_POOL_STRATEGY ?? "").trim().toLowerCase();
  return v === "sticky" ? "sticky" : v === "round-robin" || v === "roundrobin" || v === "rr" ? "round-robin" : "headroom";
}
/** Rendezvous (highest-random-weight) score: a member leaving the eligible set only moves the
 *  conversations that were on it; everyone else keeps their member (and their cache). */
const hrw = (key: string, label: string) => parseInt(createHash("sha256").update(`${key}\0${label}`).digest("hex").slice(0, 12), 16);

// ─────────────────────────── tiers ───────────────────────────

export type TierName = "primary" | "backup" | "emergency" | "blocked";
export const TIER_RANK: Record<Exclude<TierName, "blocked">, number> = { primary: 0, backup: 1, emergency: 2 };
export type RegistryEntry = { tier: TierName; email?: string; note?: string };
export const registryPath = (dir: string) => join(dir, ".registry.json");
/** label → entry; unreadable or absent ⇒ {} (everyone primary). An unknown tier word reads as `blocked`:
 *  a typo must fail closed, never put an account the owner meant to fence off into rotation. */
export function readRegistry(dir: string): Record<string, RegistryEntry> {
  const j = readJson<any>(registryPath(dir), null);
  if (!j || typeof j !== "object") return {};
  const out: Record<string, RegistryEntry> = {};
  for (const [label, v] of Object.entries<any>(j)) {
    if (!v || typeof v !== "object") continue;
    const t = String(v.tier ?? "primary");
    out[label] = { ...v, tier: t === "primary" || t === "backup" || t === "emergency" ? t : "blocked" };
  }
  return out;
}

// ─────────────────────────── state ───────────────────────────

let state: PoolState | null = null;
/** v1 files (ident-keyed caps/usage) keep only their active member; the ident-keyed entries are dropped. */
export function loadState(path = statePath()): PoolState {
  const s = readJson<any>(path, null);
  const out: PoolState = { v: 2, providers: {} };
  if (!s || typeof s !== "object" || !s.providers || typeof s.providers !== "object") return out;
  for (const id of POOL_PROVIDERS) {
    const p = s.providers[id];
    if (!p || typeof p !== "object") continue;
    out.providers[id] = {
      ...(typeof p.active === "string" ? { active: p.active } : {}),
      ...(typeof p.switched_at === "number" ? { switched_at: p.switched_at } : {}),
      capped: s.v === 2 && p.capped && typeof p.capped === "object" ? p.capped : {},
      usage: s.v === 2 && p.usage && typeof p.usage === "object" ? p.usage : {},
    };
  }
  return out;
}
function st(): PoolState { return (state ??= loadState()); }
function pst(provider: PoolProvider, from: PoolState = st()): ProviderPoolState {
  return (from.providers[provider] ??= { capped: {}, usage: {} });
}
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
  const state = statePath();
  return names.filter((n) => n.endsWith(".json") && !n.startsWith(".") && !n.includes(".RECOVER-") && !n.includes(".tmp-"))
    .sort().map((n) => join(dir, n)).filter((f) => f !== state);   // the pool's own state file is never a member
}

// ─────────────────────────── the selector ───────────────────────────

export type Candidate = { label: string; ident: string; expired: boolean; /** 0 primary · 1 backup · 2 emergency */ tier?: number };
/** Usable (credential present, unexpired), not capped, and weekly % below the switch pct. */
export function isEligible(m: Candidate, capped: Record<string, number>, usage: Record<string, MemberUsage>, now: number, pct: number): boolean {
  return !m.expired && m.ident !== "absent" && !((capped[m.label] ?? 0) > now) && (usage[m.label]?.seven_day ?? 0) < pct;
}
/**
 * Which member serves next. Pure: every input is passed in.
 *   · stay on the active member while it is usable, not capped and its weekly % < switchPct;
 *   · otherwise (and past the minimum dwell, unless the active one is capped/unusable) move to
 *     the eligible member with the LOWEST weekly %, ties by 5-hour %, then label order. A member
 *     never polled ranks after every measured one — unknown headroom is not headroom;
 *   · tiers come first: the next member is always from the best tier with an eligible member,
 *     and an eligible active member on a WORSE tier than that hands back ("prefer") past dwell;
 *   · nobody eligible: keep a still-working active member, else the usable one back soonest.
 */
export function choose(c: {
  members: Candidate[]; active?: string; switchedAt?: number; now: number;
  capped: Record<string, number>; usage: Record<string, MemberUsage>; switchPct: number; minDwellMs: number;
}): { label: string; reason: "stay" | "dwell" | "switch" | "prefer" | "none-eligible" | "soonest" } {
  const { members, now } = c;
  const isCapped = (m: Candidate) => (c.capped[m.label] ?? 0) > now;
  const usable = (m: Candidate) => !m.expired && m.ident !== "absent";
  const eligible = (m: Candidate) => isEligible(m, c.capped, c.usage, now, c.switchPct);
  const idx = (m: Candidate) => members.indexOf(m);
  const rank = (a: Candidate, b: Candidate) => {
    const ua = c.usage[a.label], ub = c.usage[b.label];
    const ka = ua?.seven_day !== undefined ? 0 : 1, kb = ub?.seven_day !== undefined ? 0 : 1;
    return (ka - kb) || ((ua?.seven_day ?? 0) - (ub?.seven_day ?? 0)) || ((ua?.five_hour ?? 0) - (ub?.five_hour ?? 0)) || (idx(a) - idx(b));
  };
  const tier = (m: Candidate) => m.tier ?? 0;
  const best = Math.min(...members.filter(eligible).map(tier));   // Infinity when nobody is eligible
  const cur = members.find((m) => m.label === c.active);
  if (cur && eligible(cur) && tier(cur) <= best) return { label: cur.label, reason: "stay" };
  const curDown = !cur || !usable(cur) || isCapped(cur);
  if (cur && !curDown && now - (c.switchedAt ?? 0) < c.minDwellMs) return { label: cur.label, reason: "dwell" };
  const next = members.filter((m) => m !== cur && eligible(m)).sort((a, b) => (tier(a) - tier(b)) || rank(a, b))[0];
  if (next) return { label: next.label, reason: cur && eligible(cur) ? "prefer" : "switch" };
  if (cur && !curDown) return { label: cur.label, reason: "none-eligible" };
  const back = (m: Candidate) => (isCapped(m) ? c.capped[m.label] : now);
  const alt = members.filter(usable).sort((a, b) => (back(a) - back(b)) || (tier(a) - tier(b)) || rank(a, b))[0];
  return { label: (alt ?? cur ?? members[0]).label, reason: "soonest" };
}

// ─────────────────────────── the pool ───────────────────────────

export class AccountPool {
  private files: string[] = [];
  private byFile = new Map<string, PoolMember>();
  private dirSig = "";
  private regSig = "";
  private reg: Record<string, RegistryEntry> = {};
  private readonly base: PoolMember;
  constructor(readonly provider: PoolProvider, readonly dir: string, base?: PoolMember) {
    this.base = base ?? baseMember(provider);
  }
  /** The dir's `.registry.json`, re-read whenever it changes on disk. */
  registry(): Record<string, RegistryEntry> {
    let sig = "";
    try { const s = statSync(registryPath(this.dir)); sig = `${s.mtimeMs}:${s.size}:${s.ino}`; } catch {}
    if (sig !== this.regSig) { this.regSig = sig; this.reg = sig ? readRegistry(this.dir) : {}; }
    return this.reg;
  }
  tierOf(label: string): TierName { return this.registry()[label]?.tier ?? "primary"; }
  /** base + the dir's member files, minus `blocked` ones; the dir is re-listed whenever its mtime changes. */
  members(): PoolMember[] {
    let sig = "";
    try { sig = String(statSync(this.dir).mtimeMs); } catch {}
    if (sig !== this.dirSig) {
      this.dirSig = sig;
      this.files = memberFiles(this.dir);
      for (const f of this.files) if (!this.byFile.has(f)) this.byFile.set(f, fileMember(this.provider, f));
    }
    return [this.base, ...this.files.map((f) => this.byFile.get(f)!)].filter((m) => this.tierOf(m.label) !== "blocked");
  }
  /** True when the provider's own well is fenced off: then even ONE member file is a pool (it must serve instead). */
  baseBlocked(): boolean { return this.tierOf(this.base.label) === "blocked"; }
  private candidates(now: number): { m: PoolMember; c: Candidate }[] {
    return this.members().map((m) => {
      let f: CredFp;
      try { f = m.fp(); } catch { f = { cred: "absent", ident: "absent", exp: 0 }; }
      const t = this.tierOf(m.label);
      return { m, c: { label: m.label, ident: f.ident, expired: f.ident === "absent" || (f.exp > 0 && f.exp < now),
        tier: TIER_RANK[t as Exclude<TierName, "blocked">] ?? 0 } };
    });
  }
  /** Re-run the selector, persist a change, and answer the member that serves next. */
  select(now = Date.now()): PoolMember {
    const all = this.candidates(now);
    const ps = pst(this.provider);
    const pick = choose({ members: all.map((x) => x.c), active: ps.active, switchedAt: ps.switched_at, now,
      capped: ps.capped, usage: ps.usage, switchPct: switchPct(), minDwellMs: minDwellMs() });
    if (pick.label !== ps.active) {
      if (ps.active !== undefined) process.stderr.write(`[apiplan] pool ${this.provider}: ${ps.active} → ${pick.label} (${pick.reason})\n`);
      ps.active = pick.label;
      ps.switched_at = now;
      save();
    }
    return all.find((x) => x.c.label === pick.label)!.m;
  }
  private rr = 0;
  /**
   * The member ONE request uses under the configured strategy. select() still runs first, so the
   * headroom `active` member (/health, `apiplan pool`) stays current whatever the strategy.
   */
  lease(key?: string, now = Date.now()): PoolMember {
    const active = this.select(now);
    const strat = poolStrategy();
    if (strat === "headroom" || (strat === "sticky" && !key)) return active;
    const ps = pst(this.provider);
    const pct = switchPct();
    const all = this.candidates(now).filter((x) => isEligible(x.c, ps.capped, ps.usage, now, pct));
    if (!all.length) return active;
    const best = Math.min(...all.map((x) => x.c.tier ?? 0));
    const elig = all.filter((x) => (x.c.tier ?? 0) === best);   // spread only within the best tier
    if (strat === "sticky") return elig.reduce((a, b) => (hrw(key!, b.c.label) > hrw(key!, a.c.label) ? b : a)).m;
    return elig[this.rr++ % elig.length].m;
  }
  /** Capped-until, by member label. */
  cappedUntil(label: string): number { return pst(this.provider).capped[label] ?? 0; }
  markCapped(label: string, until: number) {
    if (!label) return;
    const ps = pst(this.provider);
    ps.capped[label] = Math.max(ps.capped[label] ?? 0, until);
    save();
  }
  /** Fold one polled usage answer in. A window at ≥100% caps the member until it resets. */
  recordUsage(label: string, u: ProviderUsage, now = Date.now()) {
    if (!label) return;
    const s = pst(this.provider);
    const prev = s.usage[label];
    if (!u.five_hour && !u.seven_day) {
      s.usage[label] = { ...(prev ?? {}), at: prev?.at ?? 0, error: u.error ?? "no windows reported" };
      save();
      return;
    }
    s.usage[label] = {
      ...(u.seven_day ? { seven_day: u.seven_day.used_percent, seven_day_resets_at: u.seven_day.resets_at } : {}),
      ...(u.five_hour ? { five_hour: u.five_hour.used_percent, five_hour_resets_at: u.five_hour.resets_at } : {}),
      at: now,
    };
    const full = [u.five_hour, u.seven_day].filter((w) => w && w.used_percent >= 100);
    if (full.length) {
      const until = Math.max(...full.map((w) => (w!.resets_at ? Date.parse(w!.resets_at) : NaN)).filter(Number.isFinite), 0);
      s.capped[label] = Math.max(s.capped[label] ?? 0, until > now ? until : now + DEFAULT_CAP_MS);
    }
    save();
  }
  /** The /health + CLI view. Labels, 12-hex idents and percentages only — never a token. */
  accounts(now = Date.now(), from: PoolState = st()): PoolAccount[] {
    const ps = from.providers[this.provider];
    const active = ps?.active;
    return this.candidates(now).map(({ c }) => {
      const u = ps?.usage[c.label];
      const cap = ps?.capped[c.label] ?? 0;
      return { label: c.label, ident: c.ident, active: c.label === active, tier: this.tierOf(c.label),
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
  const n = e.pool.members().length;
  return n > 1 || (n === 1 && e.pool.baseBlocked()) ? e.pool : null;
}
/** Tests only: forget every pool and the in-memory state. */
export function resetPools() { pools.clear(); state = null; }

/** The member a serve request should use, or null when this provider is single-account.
 *  `key` is the request's prompt-cache key (used by the sticky strategy only). */
export function poolLease(provider: string, key?: string): PoolMember | null {
  const p = poolFor(provider);
  return p ? p.lease(key) : null;
}

/**
 * The member `failed` was refused for capacity before a byte reached the client: cap it until
 * `resetAt` (or +1h when the upstream did not say), re-select, and answer the new member — or
 * null when there is no OTHER uncapped member to try, so the caller surfaces the refusal as before.
 */
export function poolFailover(provider: string, failed: PoolMember, resetAt?: number, key?: string, now = Date.now()): PoolMember | null {
  const p = poolFor(provider);
  if (!p) return null;
  p.markCapped(failed.label, resetAt && resetAt > now ? resetAt : now + DEFAULT_CAP_MS);
  const next = p.lease(key, now);
  if (next.label === failed.label) return null;
  // A member that is itself capped would only repeat the refusal: no retry then.
  return p.cappedUntil(next.label) > now ? null : next;
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
        try { p.recordUsage(m.label, await accountUsage(provider, m.label, () => m.creds(), deps)); } catch {}
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
