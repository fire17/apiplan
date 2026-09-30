/**
 * capacity-signal.ts — turn apiplan's observed account/window state into CapacitySignals.
 *
 * WHY THIS EXISTS. The OM native ultracode engine parks a workflow when a provider reports a usage
 * limit and resumes it when capacity returns. The human's requirement, verbatim: "incase of any
 * failure like token usage limit or anything else, it all should just park and await for auto
 * resuming when new tokens are available (by either the time passing or more likely a change in
 * account and a new token window avaialble)". apiplan is the process that actually watches accounts
 * and windows, so it is the natural producer of that signal. This module is the producer's pure core.
 *
 * PURE BY CONSTRUCTION. No I/O, no clock read, no `process.env`, no network. It takes two
 * observations and returns the signals that the change between them implies. Everything impure —
 * polling, reading credentials, calling providers — stays in the caller, which keeps this testable
 * from fixtures and keeps a poller from re-emitting on every tick.
 *
 * WHAT APIPLAN ALREADY KNOWS (recon, file:line, 2026-09-05):
 *   · A stable, non-secret ACCOUNT FINGERPRINT already exists in `src/providers.ts:1205-1221`
 *     (`googleToken`): `"g:" + sha256(refresh_token).slice(0, 12)`. Its doc comment states the reason
 *     the REFRESH token is hashed rather than the access token — "a refresh mints a new access token
 *     for the SAME account every hour, so an access-token hash would report every refresh as an
 *     account switch". `src/providers.ts:43` holds the same primitive as `h12`. NEITHER IS EXPORTED,
 *     so this module reproduces the formula rather than importing it; `fingerprintAccount()` below is
 *     byte-identical to that expression and `capacity-signal.test.ts` asserts it. The one-line
 *     `export` that would let this module import instead of mirror is recorded in
 *     `~/Creations/OM/.grand/lanes/L3.log` — `src/providers.ts` belongs to another session and is not
 *     edited here.
 *   · The LIMIT TAXONOMY exists: `src/providers.ts:1358-1361` normalises the vendors' own names —
 *     `RESOURCE_EXHAUSTED → "rate_limit_error"`, `UNAUTHENTICATED → "authentication_error"` — and
 *     `src/providers.ts:122` documents the field. `src/engine.ts:333` is where a 429 is recognised,
 *     together with the `retry-after` header (`src/engine.ts:399`, `src/engine.ts:775`).
 *   · There is NO existing type modelling a rate-limit WINDOW (no `RateLimitWindow`, `UsageWindow` or
 *     `Quota` interface exists anywhere in `src/`; the only `contextWindow` is a model's token
 *     capacity, `src/roster.ts:50`). This module therefore defines the minimal observation shape
 *     rather than pretending to reuse one that does not exist. `retry-after` on a 429 is the only
 *     reset time apiplan is actually told about today, which is exactly why `resetsAt` is optional.
 *
 * NO CREDENTIALS. The API never accepts a raw token: `CapacityObservation.account` is already a
 * fingerprint. `fingerprintAccount()` is provided so a caller can produce one without inventing its
 * own scheme, and `assertNoSecrets()` is exported so a caller can prove a batch of signals is clean.
 */
import { createHash } from "node:crypto";

// ─── the signal (shape fixed by the OM engine's `src/workflows/signals.ts`) ──────────────────

export type CapacitySignalKind = "window-reset" | "account-changed" | "manual";

export interface CapacitySignal {
  kind: CapacitySignalKind;
  /** Epoch ms at which the change was observed — always the NEW observation's `at`. */
  at: number;
  /** Who observed it, e.g. "apiplan:usage-poll". */
  source: string;
  detail?: string;
  provider?: string;
  /** Non-secret scoped identity, e.g. "g:9f2c1ab34de5". Never a token. */
  accountFingerprint?: string;
  /** Unknown or absent scope never implies account-wide capacity. */
  scope?: "account" | "model" | "org" | "unknown";
  model?: string;
  orgFingerprint?: string;
}

// ─── the observation ────────────────────────────────────────────────────────────────────────

export interface CapacityObservation {
  /** Provider name as apiplan knows it, e.g. "anthropic", "openai", "google". */
  provider: string;
  /** Epoch ms of the observation. */
  at: number;
  /** Non-secret account fingerprint (see `fingerprintAccount`). Undefined when unknown. */
  account?: string;
  /**
   * True when apiplan has seen this provider/account refuse work for capacity reasons — a 429
   * (`src/engine.ts:333`) or a normalised `rate_limit_error` (`src/providers.ts:1358-1361`).
   */
  limited?: boolean;
  /**
   * When the window is expected to reopen (epoch ms). Today apiplan learns this only from a 429's
   * `retry-after`, hence optional. `observationFromResponse()` computes it.
   */
  resetsAt?: number;
  /**
   * Fraction of the window still available, 0..1, for providers that report it. Absent for every
   * provider apiplan currently talks to; kept because the predicate is strictly better with it.
   */
  remainingFraction?: number;
  /** Free-form, non-secret. Included in the signal's `detail`. */
  note?: string;
}

/**
 * "Exhausted or near-exhausted" — the state a window must have been in for its reopening to be
 * worth waking a parked workflow for.
 *
 * `limited === true` is the authoritative case: apiplan only knows a window is closed because the
 * provider refused. The 2% threshold is the secondary case for a provider that reports remaining
 * capacity: it is deliberately tight because the cost of a false negative (a parked run waits for the
 * next real signal, at most one poll interval later) is far lower than the cost of a false positive
 * (a parked run resumes into a still-closed window and burns its one attempt).
 */
export const NEAR_EXHAUSTED_FRACTION = 0.02;

export function isExhausted(o: CapacityObservation): boolean {
  if (o.limited === true) return true;
  return o.remainingFraction !== undefined && o.remainingFraction <= NEAR_EXHAUSTED_FRACTION;
}

// ─── non-secret identity ────────────────────────────────────────────────────────────────────

/**
 * Byte-identical to `src/providers.ts:1219` — `<prefix> + ":" + sha256(secret).slice(0, 12)`.
 * Hash the REFRESH token, never the access token, for the reason given at `src/providers.ts:1205`.
 */
export function fingerprintAccount(secret: string, prefix = "a"): string {
  return `${prefix}:${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`;
}

/**
 * Whether an `ident` from `src/providers.ts`'s `credFp()` names a REAL, CREDENTIAL-BACKED account.
 *
 * Two distinct kinds of non-identity arrive in this field, and both must be rejected.
 *
 * PLACEHOLDERS. `credFp()` does not return `undefined` when it cannot read the well — it returns a
 * placeholder in the same string a real fingerprint uses: `"absent"` when the token is missing
 * (`src/providers.ts:593`, `:799`, `:1624`) and `"unusable:<state>"` when the well could not be read
 * (`src/providers.ts:1622`, states `absent`/`unreadable`). `credOf()` in `src/api.ts:204` adds the
 * empty string on a throw. Admitting one breaks capacity in both directions:
 *   · CAPACITY. A refusal recorded against `"absent"` and a later acceptance recorded against
 *     `"absent"` land on the SAME snapshot line although they concern different accounts — or none at
 *     all. That is exactly the `exhausted → open` edge, so an unreadable well that later reads fine
 *     announces a `window-reset` nobody observed, and every run parked on that provider resumes into
 *     an unchanged limit.
 *   · IDENTITY, worse: two DIFFERENT accounts both momentarily unreadable both read `"absent"`, so a
 *     real switch straddling a read failure reads as unchanged and the `account-changed` that should
 *     wake parked work is LOST. A placeholder also flaps with the WELL rather than the account, so
 *     `A → "absent" → A` would report two changes where nothing changed.
 *
 * NO-ACCOUNT PROVIDERS. `credOf()` falls back to `probe().detail` for a provider with no credential
 * at all — ollama (`src/api.ts:200`), whose live ledger entry reads
 * `"http://127.0.0.1:11434 · ollama 0.33.0 · no account, no token, no quota"`. That string is stable,
 * so it never fabricates an `account-changed`; but it is a HUMAN-READABLE SERVICE DESCRIPTION, not an
 * account. It moves when the local server's version or port moves, and it is published verbatim by
 * `/health`, which is precisely the forgeable-legacy shape `src/api.ts:245-250` removed for credential
 * verdicts. A local model server has no quota to exhaust and no window to reopen, so there is nothing
 * here for capacity to be right about: it is `unknown`, not an identity.
 *
 * A real identity is a `sha256(...).slice(0, 12)` digest (`src/providers.ts:43`), optionally carrying
 * one `<prefix>:` from {@link fingerprintAccount} (`a:`, `g:`), or — for Google alone — a plain
 * account id (`src/providers.ts:1626`). So this rejects the placeholder vocabulary, anything blank,
 * and anything carrying the shape of a probe line (a URL, whitespace-separated prose, or the
 * `no account` disclaimer itself), and accepts the rest. It fails CLOSED on vocabulary rather than on
 * a digest whitelist, so a future placeholder spelling is still rejected while a legitimately new
 * identity shape is still accepted.
 */
export function isRealAccountIdent(ident: string | undefined): boolean {
  if (typeof ident !== "string") return false;
  const t = ident.trim();
  if (!t) return false;
  if (t === "absent" || t === "unknown") return false;
  // `unusable:<state>` for any present or future state, and a defensive `absent:<detail>`.
  if (/^(?:unusable|absent)\b/i.test(t)) return false;
  // A probe line, never an account: an endpoint URL, prose (a real ident has no whitespace), or the
  // explicit no-account disclaimer a credential-free provider reports.
  if (/\s/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /no account/i.test(t)) return false;
  return true;
}

/** Anything credential-shaped in a value. Used by `assertNoSecrets` and safe to call on signals. */
const SECRET_RE = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b1\/\/[A-Za-z0-9._-]{20,}/,                      // Google refresh token
];

/** Throws if any credential-shaped string is present. Cheap enough to run on every emitted batch. */
export function assertNoSecrets(signals: CapacitySignal[]): void {
  const blob = JSON.stringify(signals);
  for (const re of SECRET_RE) {
    const hit = re.exec(blob);
    if (hit) throw new Error(`capacity signal carries credential-shaped text (${re.source.slice(0, 24)}…); refusing to emit`);
  }
}

// ─── the pure diff ──────────────────────────────────────────────────────────────────────────

export interface DiffOptions {
  /** Signal `source`. Default "apiplan:usage-poll". */
  source?: string;
  /** Skip the `assertNoSecrets` guard (tests only). */
  unsafeSkipSecretCheck?: boolean;
}

/**
 * The whole contract: what changed between two observations of ONE provider/account line.
 * Legacy observation-diff utility, not the production OM recovery producer. It lacks scope-bound
 * request evidence; use capacity-events.ts recordCapacity and its scoped snapshots for recovery.
 *
 *  · ACCOUNT-CHANGED when the fingerprint differs (and both are known). Emitted whether or not the
 *    old account was limited: a different account is a different token window, which is precisely the
 *    case the human named as the likely one.
 *  · WINDOW-RESET when the previous observation was exhausted (or near it) and the new one is not —
 *    the limit lifted, the announced reset time moved forward, or remaining capacity jumped up.
 *  · NOTHING otherwise. This is what stops a poller from emitting on every tick: two identical
 *    observations produce an empty array, and so does any change that does not mean "capacity is
 *    back".
 *
 * At most one signal of each kind is returned, account-changed first (it is the stronger claim).
 */
export function diffCapacity(prev: CapacityObservation | undefined, next: CapacityObservation, opts: DiffOptions = {}): CapacitySignal[] {
  const source = opts.source ?? "apiplan:usage-poll";
  const out: CapacitySignal[] = [];
  if (!prev) return out;                                    // the first observation is a baseline, never news
  if (prev.provider !== next.provider) return out;          // different lines are diffed separately

  if (prev.account && next.account && prev.account !== next.account) {
    out.push({
      kind: "account-changed", at: next.at, source, provider: next.provider, accountFingerprint: next.account,
      detail: `active account changed ${prev.account} → ${next.account}`,
    });
  }

  const wasBlocked = isExhausted(prev);
  const nowBlocked = isExhausted(next);
  const resetAdvanced = prev.resetsAt !== undefined && next.resetsAt !== undefined && next.resetsAt > prev.resetsAt && !nowBlocked;
  const capacityJumped = prev.remainingFraction !== undefined && next.remainingFraction !== undefined
    && prev.remainingFraction <= NEAR_EXHAUSTED_FRACTION && next.remainingFraction > NEAR_EXHAUSTED_FRACTION;

  if ((wasBlocked && !nowBlocked) || resetAdvanced || capacityJumped) {
    out.push({
      kind: "window-reset", at: next.at, source, provider: next.provider, accountFingerprint: next.account,
      // most specific cause first, so the detail names what actually changed
      detail: next.note ?? (capacityJumped ? "remaining capacity increased" : wasBlocked ? "usage window reopened" : "announced reset time advanced"),
    });
  }

  if (!opts.unsafeSkipSecretCheck) assertNoSecrets(out);
  return out;
}

/**
 * Diff a whole table of observations keyed by `<provider>|<account ?? "">`, so a caller can hold one
 * map and hand it back each poll. Returns the signals and the map to keep for next time.
 */
export function diffCapacityTable(
  prev: ReadonlyMap<string, CapacityObservation>,
  next: readonly CapacityObservation[],
  opts: DiffOptions = {},
): { signals: CapacitySignal[]; state: Map<string, CapacityObservation> } {
  const state = new Map(prev);
  const signals: CapacitySignal[] = [];
  for (const o of next) {
    const key = observationKey(o);
    // An account switch replaces the line, so look the previous state up by provider when the
    // account key misses — otherwise a switch would present as a brand-new line and emit nothing.
    const before = state.get(key) ?? [...state.values()].find(p => p.provider === o.provider);
    signals.push(...diffCapacity(before, o, opts));
    // drop only STALE keys for this provider (an account switch), so an unchanged line keeps its slot
    for (const k of [...state.keys()]) if (k !== key && state.get(k)!.provider === o.provider) state.delete(k);
    state.set(key, o);
  }
  if (!opts.unsafeSkipSecretCheck) assertNoSecrets(signals);
  return { signals, state };
}

export function observationKey(o: CapacityObservation): string { return `${o.provider}|${o.account ?? ""}`; }

// ─── glue for the impure caller ─────────────────────────────────────────────────────────────

// ─── the capacity record (U11) ──────────────────────────────────────────────────────────────

/**
 * What apiplan LEARNS from a refused request, in a form the OM workflow engine can park against.
 *
 * The gap this closes (`~/Creations/OM/.grand/UNKNOWNS.md` U11): OM parks with
 * `resumeAt: outcome.resetsAt`, but nothing ever fills `resetsAt`, because the rate-limit facts are
 * destroyed before they can reach it. `src/engine.ts:333` interpolates `retry-after` into a `die()`
 * string and drops it; `src/engine.ts:653` forwards exactly two headers downstream
 * (`content-type` and `x-retry-after`), so `anthropic-ratelimit-unified-reset` / `-status` never
 * arrive. A parked run therefore has no wake-up time — a dead run with a reassuring message.
 *
 * This type and its parser are the pure half. They are deliberately header-name-driven rather than
 * provider-specific, so the caller passes whatever the upstream response carried.
 */
export interface CapacityRecord {
  provider: string;
  /** Non-secret account fingerprint, when the caller knows one. */
  account?: string;
  observedAt: number;
  limited: boolean;
  /** Epoch ms when the window is expected to reopen, when the upstream said so. */
  resetsAt?: number;
  /** What is limited. Unspecified upstream scope remains unknown. */
  scope: "account" | "model" | "org" | "unknown";
  model?: string;
  orgFingerprint?: string;
  /** Which header (or status) the reset time came from, so a stale record is diagnosable. */
  source: string;
  detail?: string;
}

/** Header names carrying a reset instant, most specific first. */
const RESET_HEADERS = [
  "anthropic-ratelimit-unified-reset",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset",
  "ratelimit-reset",
] as const;

/**
 * Parse one reset value. Upstreams disagree on the encoding, so all three live forms are accepted:
 * an absolute RFC-3339 timestamp, an absolute epoch (seconds or milliseconds), and a relative
 * duration in seconds. Anything else yields undefined rather than a fabricated instant — a wrong
 * wake-up time is worse than none, because it resumes a run into a window that is still closed.
 */
export function parseResetValue(raw: string | number | null | undefined, at: number): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const str = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str);
    if (!Number.isFinite(n) || n < 0) return undefined;
    if (n > 1e12) return n;                       // epoch milliseconds
    if (n > 1e9) return n * 1000;                 // epoch seconds
    return at + n * 1000;                         // relative seconds (retry-after's own encoding)
  }
  // Date.parse is far too permissive to use as a validator — JavaScriptCore happily turns "soon"
  // into a real instant (observed: 988675200000). Only the two encodings an HTTP upstream actually
  // uses are accepted: RFC 3339, and the RFC 1123 HTTP-date that `retry-after` also allows.
  const looksLikeDate = /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(str) || /^[A-Za-z]{3},\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s/.test(str);
  if (!looksLikeDate) return undefined;
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Case-insensitive lookup over whatever header bag the caller has (Headers, Map, or a plain object). */
function headerOf(headers: HeadersLike, name: string): string | undefined {
  if (!headers) return undefined;
  const anyH = headers as { get?(k: string): string | null };
  if (typeof anyH.get === "function") return anyH.get(name) ?? anyH.get(name.toLowerCase()) ?? undefined;
  for (const [k, v] of Object.entries(headers as Record<string, string>)) if (k.toLowerCase() === name) return v;
  return undefined;
}

export type HeadersLike = { get?(k: string): string | null } | Record<string, string> | undefined;

/**
 * Turn a refused response into a CapacityRecord. Pure: `at` is supplied, never read from a clock, so
 * a captured exchange replays deterministically.
 *
 * `limited` is true on a 429, on apiplan's own normalised `rate_limit_error`
 * (`src/providers.ts:1358-1361`), and on a 402/billing refusal — the last of which is a capacity
 * failure that no reset time will ever clear, so it is recorded with `resetsAt` undefined and the
 * caller's blocker stays until a human or an account change resolves it.
 */
export function capacityRecordFromResponse(input: {
  provider: string;
  at: number;
  account?: string;
  status?: number;
  errorType?: string;
  headers?: HeadersLike;
  scope?: CapacityRecord["scope"];
  model?: string;
  orgFingerprint?: string;
  detail?: string;
}): CapacityRecord {
  const { provider, at, account, status, errorType, headers } = input;
  const limited = status === 429 || status === 402 || errorType === "rate_limit_error" || errorType === "billing_error";
  let resetsAt: number | undefined;
  let source = status === 429 ? "status:429" : errorType ? `error:${errorType}` : "status";
  for (const h of RESET_HEADERS) {
    const v = headerOf(headers, h);
    const parsed = parseResetValue(v, at);
    if (parsed !== undefined) { resetsAt = parsed; source = h; break; }
  }
  if (resetsAt === undefined) {
    // `retry-after` is the one apiplan already reads (src/engine.ts:399, :775) and the one it
    // forwards as `x-retry-after` (src/engine.ts:653), so both spellings are accepted here.
    const ra = headerOf(headers, "retry-after") ?? headerOf(headers, "x-retry-after");
    const parsed = parseResetValue(ra, at);
    if (parsed !== undefined) { resetsAt = parsed; source = "retry-after"; }
  }
  return {
    provider, account, observedAt: at, limited,
    resetsAt: limited ? resetsAt : undefined,
    scope: input.scope ?? "unknown",
    model: input.model,
    orgFingerprint: input.orgFingerprint,
    source,
    detail: scrubDetail(input.detail),
  };
}

/** A record is only useful next to the previous one; this makes it a `CapacityObservation`. */
export function recordToObservation(record: CapacityRecord): CapacityObservation {
  return { provider: record.provider, at: record.observedAt, account: record.account, limited: record.limited, resetsAt: record.resetsAt, note: record.detail };
}

/** Free text on a record is upstream-controlled; never let a credential ride along inside it. */
function scrubDetail(detail: string | undefined): string | undefined {
  if (!detail) return detail;
  let out = detail;
  for (const re of SECRET_RE) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "[redacted]");
  return out;
}

/**
 * Build an observation from what a real apiplan request already produces: the HTTP status, the
 * `retry-after` header apiplan already reads (`src/engine.ts:333`, `:399`, `:775`), and the
 * normalised error type from `src/providers.ts:1358-1361`. Pure: `at` is supplied, never read from a
 * clock, so replaying a captured exchange is deterministic.
 */
export function observationFromResponse(input: {
  provider: string;
  at: number;
  account?: string;
  status?: number;
  retryAfterSeconds?: number | string | null;
  errorType?: string;
  note?: string;
}): CapacityObservation {
  const secs = typeof input.retryAfterSeconds === "string" ? Number(input.retryAfterSeconds) : input.retryAfterSeconds ?? undefined;
  const limited = input.status === 429 || input.errorType === "rate_limit_error";
  return {
    provider: input.provider,
    at: input.at,
    account: input.account,
    limited,
    resetsAt: limited && Number.isFinite(secs) && (secs as number) > 0 ? input.at + (secs as number) * 1000 : undefined,
    note: input.note,
  };
}
