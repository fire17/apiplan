/**
 * capacity-events.ts — the IMPURE SHELL around `capacity-signal.ts`.
 *
 * WHY THIS EXISTS. `capacity-signal.ts` is a pure diff core with no caller: nothing in apiplan
 * observes capacity and nothing publishes it, so OM's workflow engine has no way to learn that a
 * parked run may resume. The human's requirement, verbatim: "incase of any failure like token usage
 * limit or anything else, it all should just park and await for auto resuming when new tokens are
 * available (by either the time passing or more likely a change in account and a new token window
 * avaialble)". This module is the part that actually observes and actually publishes.
 *
 * ─── THE HONEST SHAPE OF WHAT IS AND IS NOT OBSERVABLE ──────────────────────────────────────
 *
 * Two halves of that requirement are in completely different states on disk today, and this module
 * refuses to pretend otherwise.
 *
 *   A. ACCOUNT IDENTITY — REAL, OBSERVABLE NOW, ZERO CHANGES NEEDED ANYWHERE ELSE.
 *      `src/api.ts` already maintains `${STATE_DIR}/outcomes.json`: one entry per provider,
 *      `{ok, at, detail, cred, ident, exp, carry?}`. `ident` is the CREDENTIAL CHAIN fingerprint —
 *      it moves when `claude`/`codex`/`agy` rewrite their own login, i.e. when the human's account
 *      actually changes. `cred` is the ACCESS-TOKEN hash and moves on every hourly refresh of the
 *      SAME account; reading `cred` would report an account switch every hour. This module reads
 *      `ident` and never `cred`. Writes go through `writeJson` (`src/platform.ts`), which is
 *      temp-file + `rename`, so a reader never sees half a file.
 *
 *      TWO HONEST LIMITS ON THAT COVERAGE, both verified against disk rather than assumed:
 *      (i) `src/api.ts` is imported from exactly one place — the `serve` verb — so ONLY the HTTP
 *      server maintains this ledger. The plain CLI path and the warm daemon never write it. An
 *      identity change therefore becomes visible when the server next handles a request or a health
 *      poll, and a human who drives apiplan purely through the one-shot CLI produces no observation
 *      at all. This module reports what it can see and never invents the rest.
 *      (ii) `writeJson`'s rename has a fallback that truncates and rewrites in place if the rename
 *      itself fails. That window can be read as an empty or partial file, which is why every read
 *      here treats an unparseable ledger as NO OBSERVATION rather than as "every identity changed".
 *
 *   B. CAPACITY WINDOWS — OBSERVABLE ONLY AT THE MOMENT OF A REAL REFUSAL, never by polling.
 *      `src/api.ts` keeps deliberately DISCARDING rate-limit facts from its CREDENTIAL verdict — its
 *      own comment beside the throw explains that a 429 is a busy account rather than a bad
 *      credential and that recording it "would make /health cry wolf" — so `outcomes.json` still says
 *      nothing about windows and must not be read for them. What changed is that the refusal itself is
 *      now captured where it happens, by the hooks described below, into this module's own state.
 *      There is still NOTHING to POLL: no vendor endpoint is asked "is the window open yet", and a
 *      reopening is learned only from the next real accepted request on the same identity.
 *
 * So this module NEVER SYNTHESISES A `window-reset`. It does not run a timer that emits, it does not
 * emit on a tick when nothing changed, and it does not degrade into an idle poll that returns a
 * cheerful nothing. A `window-reset` exists only when a real refusal was really observed and recorded
 * through {@link recordCapacity}. If that function is never called, no `window-reset` is ever
 * produced, and **that silence is the accurate state of the system, not a defect to paper over.**
 *
 * THE HOOKS NOW EXIST (2026-09-06). There are exactly three call sites, all on real HTTP exchanges:
 * `src/api.ts` records a refusal (429/402/`rate_limit_error`/`billing_error`) and an accepted stream
 * on the served surface, and `src/engine.ts` records the warm daemon's `/call` outcome from the
 * original vendor headers before the IPC response is rebuilt. Each is gated on a REAL
 * credential-backed account identity (`isRealAccountIdent`), so an unreadable credential well records
 * nothing rather than recording against a placeholder.
 *
 * Two honest limits on what that activation means:
 *   · `serve` and the warm daemon are SEPARATE processes, activated independently. Traffic through
 *     one is not observed by the other.
 *   · A hook only takes effect in a process that was STARTED with it. An already-running server
 *     carries the code it was launched with, so writing a hook is not the same as observing capacity.
 * The minimal hook specification this replaced is recorded in
 * `~/Creations/OM/.wishes/W006/evidence/capacity-owner.json`.
 *
 * ─── TWO SOURCES, ONE FEED ──────────────────────────────────────────────────────────────────
 *
 *   OUTCOMES WATCHER (source A) — reads `outcomes.json`, diffs `ident` per provider, emits
 *   `account-changed`. Read-only: this module never writes `outcomes.json`.
 *
 *   JOURNAL (source B) — an append-only JSONL file, `${STATE_DIR}/capacity-events.jsonl`
 *   (override `APIPLAN_CAPACITY_EVENTS`). {@link recordCapacity} appends; {@link CapacityJournal}
 *   tails by byte offset. It exists so that the moment a one-line hook is added at a real refusal
 *   site, real `window-reset` signals start flowing with no further negotiation — and so that a
 *   refusal observed in a short-lived CLI process still reaches a long-lived OM process that was not
 *   listening at that instant, which no socket or in-process emitter can do.
 *
 * ─── NO CREDENTIALS, EVER ───────────────────────────────────────────────────────────────────
 *
 * `ident` is a truncated SHA-256 and is the only identity that crosses this boundary. Every batch
 * passes `assertNoSecrets()` before it is appended or emitted. This module reads exactly two paths,
 * both apiplan-owned state, and never opens a credential well.
 *
 * ─── WHAT THIS MODULE MUST NOT DO ───────────────────────────────────────────────────────────
 *
 * It never selects, switches or authenticates an account — it only notices that one changed. It
 * never mutates apiplan state other than appending to its own journal. It has no network access.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, statSync, unlinkSync, watch, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./platform.ts";
import {
  type CapacityObservation,
  type CapacityRecord,
  type CapacitySignal,
  assertNoSecrets,
  isRealAccountIdent,
  capacityRecordFromResponse,
  type HeadersLike,
} from "./capacity-signal.ts";

// ─── paths ──────────────────────────────────────────────────────────────────────────────────

/** `src/api.ts`'s own outcomes ledger. READ ONLY from here — api.ts owns every write. */
export function outcomesPath(): string {
  return process.env.APIPLAN_OUTCOMES_FILE || join(STATE_DIR, "outcomes.json");
}

/**
 * The durable capacity journal. Absolute path override so a test (or a second apiplan home) never
 * has to reach into `$HOME`.
 */
export function capacityJournalPath(): string {
  return process.env.APIPLAN_CAPACITY_EVENTS || join(STATE_DIR, "capacity-events.jsonl");
}

/**
 * The LEVEL-TRIGGERED capacity snapshot: current state per full identity tuple, whole-file,
 * atomically replaced.
 *
 * This exists because an append-only journal alone is EDGE-triggered, and an edge is only ever
 * delivered to whoever was listening at that instant. A consumer that attaches after the refusal was
 * appended sees its first read as a baseline and emits nothing — a parked run that waits forever with
 * nothing anywhere reporting a fault. Worse, the two obvious repairs are both wrong: replaying the
 * journal from byte 0 on attach re-fires every historical reset at once, and trusting a byte offset
 * across a truncation or a rotation reads from the middle of a different line.
 *
 * A snapshot has none of those failure modes by construction. It states what is true NOW, so a reader
 * may attach at any moment, derive edges against its own previous read, and never replay. The journal
 * is kept alongside it as the durable, diagnosable history — not as the primary mechanism.
 */
export function capacitySnapshotPath(): string {
  return process.env.APIPLAN_CAPACITY_STATE || join(STATE_DIR, "capacity-state.json");
}

// ─── the wire line ──────────────────────────────────────────────────────────────────────────

/** Bump only for a breaking change. A reader that does not know a version SKIPS the line. */
export const CAPACITY_WIRE_VERSION = 1 as const;

/**
 * One journal line.
 *
 * `signal` is the OM `CapacitySignal` verbatim so a consumer passes it through untouched.
 *
 * `scope` is mirrored outside `signal` for legacy feed subscribers. The inner signal carries the
 * same scope/model/org identity as the snapshot. An absent legacy inner scope may inherit the
 * outer claim, but an explicit unknown or a contradictory claim is always held as unknown.
 */
export interface CapacityWireLine {
  v: typeof CAPACITY_WIRE_VERSION;
  /** Monotonic within one journal file. The ONLY ordering authority — never compare clocks. */
  seq: number;
  /** Producer epoch ms. Diagnostics and staleness only; ordering is `seq`. */
  at: number;
  /** Producing process, so a stale journal from a dead writer is diagnosable. */
  pid: number;
  signal: CapacitySignal;
  scope: CapacityRecord["scope"] | "unknown";
}

function isWireLine(v: unknown): v is CapacityWireLine {
  if (!v || typeof v !== "object") return false;
  const l = v as Partial<CapacityWireLine>;
  if (l.v !== CAPACITY_WIRE_VERSION) return false;
  if (typeof l.seq !== "number" || !Number.isFinite(l.seq)) return false;
  const s = l.signal as Partial<CapacitySignal> | undefined;
  if (!s || typeof s !== "object") return false;
  if (s.kind !== "window-reset" && s.kind !== "account-changed" && s.kind !== "manual") return false;
  return typeof s.at === "number" && Number.isFinite(s.at) && typeof s.source === "string";
}

/** Backfill only absent inner scope; conflicting or explicitly unknown claims stay held. */
function journalScope(signal: CapacitySignal, outer?: CapacityWireLine["scope"]): CapacityWireLine["scope"] {
  const inner = signal.scope;
  if (inner === undefined) return outer === "account" || outer === "model" || outer === "org" ? outer : "unknown";
  if (inner !== "account" && inner !== "model" && inner !== "org") return "unknown";
  return outer !== undefined && outer !== inner ? "unknown" : inner;
}

// ─── tri-state capacity, and the level-triggered snapshot ───────────────────────────────────

/**
 * Capacity has THREE states, not two.
 *
 * `CapacityObservation.limited` is `boolean | undefined`, and `isExhausted()` in `capacity-signal.ts`
 * reads `undefined` as "not exhausted" — i.e. as OPEN. That collapse is the single most dangerous
 * thing in this pipeline, because "I did not observe" and "I observed capacity" are then the same
 * value. The concrete cost: a producer restarts and republishes a line it has no fresh reading for;
 * the diff sees `limited:true` become `limited:undefined`, reads it as exhausted-becoming-open, and
 * announces that the window reopened. A parked run resumes into a window that never moved, is refused
 * again, and re-parks — and a re-park after a SUCCESSFUL resume mints a fresh epoch and a fresh resume
 * key, so the attempt counter that is supposed to stop this never advances. The loop is unbounded.
 *
 * So this module never derives an edge from `limited` directly. It derives one from these three
 * states, and only the one honest transition produces a signal.
 */
export type CapacityState = "exhausted" | "open" | "unknown";

/**
 * `unknown` is returned whenever the observation does not actually assert capacity. Silence is never
 * evidence: an absent `limited` is unknown, not open.
 */
export function capacityState(o: Pick<CapacityObservation, "limited" | "remainingFraction"> | undefined): CapacityState {
  if (!o) return "unknown";
  if (o.limited === true) return "exhausted";
  if (o.remainingFraction !== undefined) return o.remainingFraction <= 0.02 ? "exhausted" : "open";
  if (o.limited === false) return "open";
  return "unknown";
}

/** One line of current truth, with only identities actually supplied by the caller. */
export interface CapacitySnapshotEntry {
  provider: string;
  account?: string;
  state: CapacityState;
  observedAt: number;
  resetsAt?: number;
  scope: CapacityRecord["scope"] | "unknown";
  model?: string;
  orgFingerprint?: string;
  /** Which header or status produced this, so a stale or wrong reading is diagnosable. */
  source: string;
  detail?: string;
}

export interface CapacitySnapshot {
  v: typeof CAPACITY_WIRE_VERSION;
  writtenAt: number;
  pid: number;
  lines: Record<string, CapacitySnapshotEntry>;
}

/**
 * How long a snapshot line remains usable.
 *
 * Age DEMOTES, it does not delete — the same doctrine `src/api.ts` already applies to a credential
 * verdict, for the same reason: time cannot prove capacity, only a call can. Past this age a line is
 * reported `unknown` rather than dropped, so a consumer sees "we no longer know" instead of either a
 * fabricated green or a silent hole.
 */
export const SNAPSHOT_STALE_MS = Number(process.env.APIPLAN_CAPACITY_STALE_MS ?? 15 * 60_000);

export function readCapacitySnapshot(path = capacitySnapshotPath()): CapacitySnapshot | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const snap = parsed as Partial<CapacitySnapshot>;
  if (snap.v !== CAPACITY_WIRE_VERSION || !snap.lines || typeof snap.lines !== "object") return undefined;
  // Historical account defaults were not proof of account scope. Preserve legacy lines, held,
  // rather than migrating them into a known-scope baseline that could manufacture a reset.
  for (const [key, entry] of Object.entries(snap.lines)) {
    if (entry && typeof entry === "object" && key === `${entry.provider}|${entry.account ?? ""}`) {
      snap.lines[key] = { ...entry, scope: "unknown", state: "unknown" };
    }
  }
  return snap as CapacitySnapshot;
}

/**
 * Whole-file atomic replace: write a sibling temp, then `rename`. A reader therefore never observes a
 * partial snapshot, and a crash mid-write leaves the previous good file intact. This is the same
 * discipline `writeJson` in `src/platform.ts` uses for every other piece of apiplan state; it is
 * reimplemented here rather than imported so that this module's write path stays confined to the two
 * files it owns and cannot be pointed at another piece of state by a future refactor.
 */
function writeCapacitySnapshot(path: string, snapshot: CapacitySnapshot): boolean {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

/** Collision-free identity tuple; observed model/org identities never imply a capacity scope. */
export function lineKey(provider: string, account?: string, scope: CapacitySnapshotEntry["scope"] = "unknown", model?: string, orgFingerprint?: string): string {
  return JSON.stringify([provider, account ?? null, scope, model ?? null, orgFingerprint ?? null]);
}

/**
 * The one honest window-reset edge: a line that was KNOWN exhausted is now KNOWN open.
 *
 * Every other transition returns nothing, and each omission is deliberate:
 *   · `unknown → open` is a first real reading, not a recovery. A producer that restarts and reads a
 *     healthy line must not announce that a window it never saw close has reopened.
 *   · `exhausted → unknown` is a lost reading, not a recovery.
 *   · `open → open` with a later `resetsAt` is a rolling window boundary. A vendor advertises the next
 *     reset on every healthy response, so treating a moving reset instant as a signal in its own right
 *     emits one `window-reset` per window per provider forever, waking runs parked on entirely
 *     different, still-closed lines.
 */
export function windowResetEdge(
  before: CapacitySnapshotEntry | undefined,
  after: CapacitySnapshotEntry,
  source: string,
): CapacitySignal | undefined {
  if (!before) return undefined;
  if (before.state !== "exhausted" || after.state !== "open") return undefined;
  if (before.provider !== after.provider || before.account !== after.account || before.scope !== after.scope || before.model !== after.model || before.orgFingerprint !== after.orgFingerprint) return undefined;
  return {
    kind: "window-reset",
    at: after.observedAt,
    source,
    provider: after.provider,
    accountFingerprint: after.account,
    scope: after.scope ?? "unknown",
    model: after.model,
    orgFingerprint: after.orgFingerprint,
    detail: after.detail ?? `usage window reopened (observed via ${after.source})`,
  };
}

// ─── source A: the outcomes watcher (account identity) ──────────────────────────────────────

/** The subset of `src/api.ts`'s `Outcome` this module reads. `cred` is deliberately absent. */
interface OutcomeIdentity {
  ident?: unknown;
  at?: unknown;
}

/**
 * Non-secret, non-reversible digest of the outcomes file's IDENTITY CONTENT ONLY.
 *
 * Change detection cannot use mtime or size: `api.ts` rewrites this file on every verdict, so mtime
 * moves constantly while the account has not changed, and `saveOutcomes()` also rewrites it whenever
 * `ok`/`at`/`detail` move. Hashing only the `provider -> ident` projection means the watcher wakes on
 * a real identity change and stays quiet through the ordinary write storm.
 */
function identityDigest(idents: ReadonlyMap<string, string>): string {
  const canonical = [...idents.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Parse `outcomes.json` into `provider -> ident`.
 *
 * An entry whose `ident` is missing, blank, non-string, or one of `credFp()`'s PLACEHOLDER strings is
 * OMITTED rather than recorded. The distinction matters: "this provider's identity is currently
 * unknown" must never be allowed to look like an account, because a placeholder compares unequal to a
 * real fingerprint and would fabricate an `account-changed` on both edges of a transient
 * credential-read failure — and worse, compares EQUAL between two genuinely different accounts that
 * are both momentarily unreadable, which loses the real switch. `src/api.ts:265` writes whatever
 * `credOf()` returned, and that is `"absent"` / `"unusable:<state>"` / `""` when the well could not
 * be read (`src/providers.ts:593`, `:799`, `:1622`, `:1624`; `src/api.ts:204`), so the filter belongs
 * on this side of the file too — the ledger is not guaranteed to have been written by a build that
 * already filtered.
 */
export function identsFromOutcomes(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [provider, entry] of Object.entries(raw as Record<string, OutcomeIdentity>)) {
    if (!entry || typeof entry !== "object") continue;
    const ident = (entry as OutcomeIdentity).ident;
    if (typeof ident !== "string" || !isRealAccountIdent(ident)) continue;
    out.set(provider, ident);
  }
  return out;
}

/** Read + parse the outcomes ledger. Returns undefined when it is absent or unparseable — both of
 *  which mean "no observation", never "everything changed". */
export function readOutcomeIdents(path = outcomesPath()): Map<string, string> | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  try { return identsFromOutcomes(JSON.parse(text)); } catch { return undefined; }
}

/**
 * The account-identity diff. Pure: no clock, no I/O.
 *
 * Emits `account-changed` if and ONLY if a provider's last KNOWN identity differs from a new KNOWN
 * identity. Deliberately silent on every other transition, each of which a naive diff would report:
 *
 *   · FIRST SIGHT of a provider — a baseline is not news. Emitting here would fire one signal per
 *     provider every time apiplan or OM restarts, resuming every parked run for nothing.
 *   · KNOWN → UNKNOWN — a credential the reader could not resolve this tick. The identity is not
 *     retained as "changed"; `lastKnown` is left ALONE, so a transient read failure cannot erase the
 *     identity and then re-report it on recovery as a switch.
 *   · UNKNOWN → KNOWN — resolved against the last KNOWN value, not against the gap. This is what
 *     makes `A → (unreadable) → B` report exactly one `A → B` change instead of nothing, which is
 *     the human's own stated recovery path and the case a gap-naive diff loses entirely.
 *
 * `lastKnown` is mutated in place and returned for clarity.
 */
export function diffIdents(
  lastKnown: Map<string, string>,
  next: ReadonlyMap<string, string>,
  at: number,
  source: string,
): { signals: CapacitySignal[]; lastKnown: Map<string, string> } {
  const signals: CapacitySignal[] = [];
  for (const [provider, ident] of next) {
    const before = lastKnown.get(provider);
    lastKnown.set(provider, ident);
    if (before === undefined) continue;      // baseline, not news
    if (before === ident) continue;          // the ordinary case: nothing changed
    signals.push({
      kind: "account-changed",
      at,
      source,
      provider,
      accountFingerprint: ident,
      scope: "account",
      detail: `credential chain changed ${before} → ${ident}`,
    });
  }
  // Providers absent from `next` keep their last known identity: absence is unknown, not a change.
  return { signals, lastKnown };
}

// ─── source B: the journal ──────────────────────────────────────────────────────────────────

/**
 * Append-only JSONL, one complete `\n`-terminated line per event.
 *
 * Chosen over a socket or an in-process emitter for one reason that neither can meet: a refusal is
 * frequently observed by a SHORT-LIVED process (a one-shot `apiplan` call) while the consumer that
 * needs it is a LONG-LIVED one (OM) that may not be listening at that instant, or may not be running
 * at all. A socket delivers only to whoever is connected right now; a file is still there afterwards.
 *
 * Durability notes, honestly stated:
 *   · A single `appendFileSync` of a line opened `O_APPEND` is atomic against other appenders up to
 *     the platform's pipe/atomic-write bound. Lines here are small (a signal is a handful of short
 *     fields), but nothing enforces that bound, so a reader must still tolerate a torn line.
 *   · A reader therefore treats a trailing fragment WITHOUT a newline as "not yet an event" and waits
 *     for the newline rather than parsing it. A line that is complete but unparseable is skipped and
 *     counted, never fatal.
 *   · `seq` is monotonic within one file, and is derived at open time by counting existing lines. It
 *     is NOT globally unique across a rotation or a deletion, which is why a consumer must persist
 *     both its byte offset and its last seen `seq` and treat a `seq` that went BACKWARDS as
 *     "the file was replaced" rather than as new work.
 */
export class CapacityJournal {
  readonly path: string;
  private seq: number;

  constructor(path = capacityJournalPath()) {
    this.path = path;
    this.seq = countLines(path);
  }

  /** Append one signal. Returns the line written, or undefined when the batch was refused. */
  append(signal: CapacitySignal, scope?: CapacityWireLine["scope"]): CapacityWireLine | undefined {
    // Hygiene BEFORE the write, so a credential-shaped string can never reach the disk. A refusal
    // drops this one signal; it must never take down the caller, which is frequently a hot request
    // path inside apiplan.
    try { assertNoSecrets([signal]); } catch { return undefined; }
    const resolvedScope = journalScope(signal, scope);
    const line: CapacityWireLine = { v: CAPACITY_WIRE_VERSION, seq: ++this.seq, at: Date.now(), pid: process.pid, signal: { ...signal, scope: resolvedScope }, scope: resolvedScope };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(line) + "\n", { encoding: "utf8", mode: 0o600 });
    } catch { return undefined; }
    return line;
  }

  /**
   * Read complete lines from `offset`. Returns the new offset, which is advanced ONLY past complete
   * lines — a trailing fragment is left unconsumed so the next read picks it up whole.
   */
  readFrom(offset: number): { lines: CapacityWireLine[]; offset: number; skipped: number } {
    const lines: CapacityWireLine[] = [];
    let skipped = 0;
    let size: number;
    try { size = statSync(this.path).size; } catch { return { lines, offset: 0, skipped }; }
    // A file that SHRANK was truncated, rotated or replaced. Restart from the beginning rather than
    // reading from a byte offset that now points into the middle of a different line.
    if (size < offset) offset = 0;
    if (size === offset) return { lines, offset, skipped };

    let buf: Buffer;
    const fd = openSync(this.path, "r");
    try {
      buf = Buffer.allocUnsafe(size - offset);
      const read = readSync(fd, buf, 0, size - offset, offset);
      buf = buf.subarray(0, read);
    } finally { closeSync(fd); }

    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines, offset, skipped };   // no complete line yet
    const complete = buf.subarray(0, lastNewline + 1).toString("utf8");
    for (const raw of complete.split("\n")) {
      if (!raw) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { skipped++; continue; }
      if (!isWireLine(parsed)) { skipped++; continue; }        // unknown version, or malformed
      const scope = journalScope(parsed.signal, parsed.scope);
      lines.push({ ...parsed, signal: { ...parsed.signal, scope }, scope });
    }
    return { lines, offset: offset + lastNewline + 1, skipped };
  }
}

function countLines(path: string): number {
  try {
    const text = readFileSync(path, "utf8");
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x0a) n++;
    return n;
  } catch { return 0; }
}

// ─── the producer entry point (for a real hook site to call) ────────────────────────────────

/**
 * Record ONE genuinely observed refusal or acceptance.
 *
 * THIS IS THE FUNCTION A HOOK CALLS, and the only path by which a `window-reset` can ever be born.
 * It takes what a real HTTP exchange already has in scope and does the rest: builds a
 * `CapacityRecord` through the existing `capacityRecordFromResponse()`, diffs it against this
 * process's previous observation of the same provider+account line, and appends whatever real change
 * that implies.
 *
 * It emits NOTHING when nothing changed — two identical observations produce no line — which is what
 * keeps a hook on a hot request path from turning into a per-request event storm.
 *
 * There is deliberately no timer, no interval and no self-scheduling anywhere in this module. If this
 * function is never called, no `window-reset` is ever produced. That is the intended behaviour while
 * the hook is absent.
 */
export function recordCapacity(
  input: {
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
    source?: string;
  },
  ctx: CapacityProducerState = defaultProducerState,
): CapacityWireLine[] {
  const record = capacityRecordFromResponse(input);
  const observation: CapacityObservation = {
    provider: record.provider,
    at: record.observedAt,
    account: record.account,
    limited: record.limited,
    resetsAt: record.resetsAt,
    note: record.detail,
  };

  const entry: CapacitySnapshotEntry = {
    provider: record.provider,
    account: record.account,
    state: capacityState(observation),
    observedAt: record.observedAt,
    resetsAt: record.resetsAt,
    scope: input.scope ?? record.scope ?? "unknown",
    model: input.model,
    orgFingerprint: input.orgFingerprint,
    source: record.source,
    detail: record.detail,
  };

  // Only the exact provider/account/scope/model/org tuple supplies a previous capacity reading.
  // A sibling model or an unknown scope is never a baseline for a known, different line.
  const key = lineKey(entry.provider, entry.account, entry.scope, entry.model, entry.orgFingerprint);
  const previous = ctx.snapshot.lines[key];
  ctx.snapshot.lines[key] = entry;
  ctx.snapshot.writtenAt = record.observedAt;
  ctx.snapshot.pid = process.pid;

  // The snapshot is the authority and is written on EVERY observation, including ones that produce no
  // signal — that is what makes it level-triggered and what lets a consumer attach at any moment.
  writeCapacitySnapshot(ctx.snapshotPath, ctx.snapshot);

  const edge = windowResetEdge(previous, entry, input.source ?? `apiplan:${record.source}`);
  const written: CapacityWireLine[] = [];
  if (edge) {
    const line = ctx.journal.append(edge, entry.scope);
    if (line) written.push(line);
  }
  return written;
}

export interface CapacityProducerState {
  journal: CapacityJournal;
  snapshot: CapacitySnapshot;
  snapshotPath: string;
}

function emptySnapshot(): CapacitySnapshot {
  return { v: CAPACITY_WIRE_VERSION, writtenAt: 0, pid: process.pid, lines: {} };
}

/** Build producer state, resuming from an existing snapshot so a restart is not a blank slate. */
export function createProducerState(journalPath = capacityJournalPath(), snapshotPath = capacitySnapshotPath()): CapacityProducerState {
  return {
    journal: new CapacityJournal(journalPath),
    snapshot: readCapacitySnapshot(snapshotPath) ?? emptySnapshot(),
    snapshotPath,
  };
}

/** Lazily created so importing this module never touches the filesystem. */
let _defaultState: CapacityProducerState | undefined;
export const defaultProducerState: CapacityProducerState = new Proxy({} as CapacityProducerState, {
  get(_t, prop) {
    _defaultState ??= createProducerState();
    return (_defaultState as unknown as Record<string | symbol, unknown>)[prop];
  },
  set(_t, prop, value) {
    _defaultState ??= createProducerState();
    (_defaultState as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
});

/** Reset the process-wide producer state. Tests only. */
export function resetDefaultProducerState(): void { _defaultState = undefined; }

// ─── the consumer feed ──────────────────────────────────────────────────────────────────────

/**
 * A fresh capacity answer.
 *
 * `"unknown"` is a first-class result and is the one this module returns most often, because apiplan
 * records nothing about windows. It must never be collapsed into `false`: OM applies a provider's
 * recheck to EVERY signal, including its own time sweep and the human's manual resume, and a `false`
 * from any registered provider vetoes all of them. "I cannot tell" must therefore read as "do not
 * block", never as "capacity is absent".
 */
export type CapacityProbe =
  | { available: true; observedAt: number; reason: string }
  | { available: false; observedAt: number; reason: string; retryAt?: number }
  | { available: "unknown"; observedAt: number; reason: string };

export interface CapacityProbeQuery {
  provider?: string;
  accountFingerprint?: string;
  scope?: CapacitySignal["scope"];
  model?: string;
  orgFingerprint?: string;
  /** The `at` of the signal being rechecked, epoch ms. */
  at: number;
}

/**
 * The transport-agnostic surface a consumer binds to. A consumer never learns whether a signal came
 * from the outcomes watcher or the journal, and never learns the file layout.
 */
export interface CapacityFeed {
  readonly name: string;
  /** Begin delivering. Returns an idempotent unsubscribe. `emit` is never called re-entrantly. */
  subscribe(emit: (signal: CapacitySignal, scope: CapacityWireLine["scope"]) => void): () => void;
  /** Bounded, cheap, never throws, never hangs. Backs OM's `CapacityProvider.recheck`. */
  probe(query: CapacityProbeQuery): Promise<CapacityProbe>;
  close(): void;
  stats(): CapacityFeedStats;
}

export interface CapacityFeedStats {
  accountChanges: number;
  windowResets: number;
  journalLines: number;
  journalSkipped: number;
  outcomeReads: number;
  outcomeUnreadable: number;
  snapshotReads: number;
  snapshotUnreadable: number;
  lastSeq: number;
}

export interface CapacityFeedOptions {
  name?: string;
  outcomes?: string;
  snapshot?: string;
  journal?: string;
  /**
   * Safety re-read interval for the outcomes file, ms.
   *
   * This is a BACKSTOP for a missed filesystem event, not the primary mechanism, and it is not a
   * poll that produces output: a re-read whose identity digest is unchanged emits nothing at all. The
   * default is deliberately slow because `api.ts` writes via temp-file + `rename`, which REPLACES the
   * inode — a watcher bound to the file itself stops receiving events after the very first write, so
   * this module watches the containing DIRECTORY and keeps the timer only for the case where even
   * that is missed. Set to 0 to disable it entirely.
   */
  outcomesRecheckMs?: number;
  /** Journal tail interval, ms. Set to 0 to disable journal tailing. */
  journalPollMs?: number;
  /** Start the journal tail from the end rather than replaying history. Default true. */
  journalFromEnd?: boolean;
  onError?(error: unknown): void;
}

/**
 * Build the feed.
 *
 * Nothing happens until `subscribe()` is called: constructing a feed opens no watcher, starts no
 * timer and reads no file.
 */
export function createCapacityFeed(options: CapacityFeedOptions = {}): CapacityFeed {
  const name = options.name ?? "apiplan:capacity";
  const outcomesFile = options.outcomes ?? outcomesPath();
  const snapshotFile = options.snapshot ?? capacitySnapshotPath();
  const journal = new CapacityJournal(options.journal ?? capacityJournalPath());
  const recheckMs = options.outcomesRecheckMs ?? 30_000;
  const journalMs = options.journalPollMs ?? 1_000;

  const stats: CapacityFeedStats = {
    accountChanges: 0, windowResets: 0, journalLines: 0, journalSkipped: 0,
    outcomeReads: 0, outcomeUnreadable: 0, snapshotReads: 0, snapshotUnreadable: 0, lastSeq: 0,
  };

  const lastKnown = new Map<string, string>();
  const lastLines = new Map<string, CapacitySnapshotEntry>();
  let lastDigest: string | undefined;
  let offset = 0;
  let listener: ((s: CapacitySignal, scope: CapacityWireLine["scope"]) => void) | undefined;
  let closed = false;

  function fail(error: unknown): void { try { options.onError?.(error); } catch { /* a reporter must not break the feed */ } }

  function pumpOutcomes(): void {
    if (closed || !listener) return;
    let idents: Map<string, string> | undefined;
    try { idents = readOutcomeIdents(outcomesFile); } catch (e) { fail(e); return; }
    stats.outcomeReads++;
    if (!idents) { stats.outcomeUnreadable++; return; }   // absent/corrupt = no observation, not a change

    const digest = identityDigest(idents);
    if (digest === lastDigest) return;                    // the common case: identities are unchanged
    const first = lastDigest === undefined;
    lastDigest = digest;

    const at = Date.now();
    const { signals } = diffIdents(lastKnown, idents, at, `${name}:outcomes`);
    if (first) return;                                    // seeded the baseline; diffIdents emitted nothing anyway
    for (const signal of signals) {
      try { assertNoSecrets([signal]); } catch (e) { fail(e); continue; }   // drop one, never the batch
      stats.accountChanges++;
      // This is an account identity fact, not proof that any capacity window reopened.
      try { listener(signal, "account"); } catch (e) { fail(e); }
    }
  }

  /**
   * The level-triggered half: read the CURRENT state of every capacity line and derive edges against
   * this consumer's own previous read.
   *
   * Deriving locally rather than trusting a published edge is what makes attaching at an arbitrary
   * moment safe. On the first read every line is simply recorded — `windowResetEdge` returns nothing
   * without a `before`, so a fresh consumer cannot mistake the existing state of the world for news.
   *
   * `seed` suppresses emission entirely for the very first pass, so this holds even if a line somehow
   * already had a prior value in `lastLines`.
   */
  function pumpSnapshot(seed = false): void {
    if (closed || (!listener && !seed)) return;
    const snapshot = readCapacitySnapshot(snapshotFile);
    stats.snapshotReads++;
    if (!snapshot) { stats.snapshotUnreadable++; return; }

    const now = Date.now();
    for (const [key, raw] of Object.entries(snapshot.lines)) {
      if (!raw || typeof raw !== "object" || typeof raw.provider !== "string") continue;
      // Age demotes, it does not delete. A line older than the staleness bound is reported as
      // `unknown` rather than trusted, so an abandoned snapshot from a process that died hours ago can
      // never present itself as fresh evidence that capacity returned.
      const aged: CapacitySnapshotEntry = now - (raw.observedAt ?? 0) > SNAPSHOT_STALE_MS
        ? { ...raw, state: "unknown" }
        : raw;
      const before = lastLines.get(key);
      lastLines.set(key, aged);
      if (seed) continue;
      const edge = windowResetEdge(before, aged, `${name}:snapshot`);
      if (!edge) continue;
      try { assertNoSecrets([edge]); } catch (e) { fail(e); continue; }
      stats.windowResets++;
      try { listener?.(edge, aged.scope); } catch (e) { fail(e); }
    }
  }

  function pumpJournal(): void {
    if (closed || !listener) return;
    let result: ReturnType<CapacityJournal["readFrom"]>;
    try { result = journal.readFrom(offset); } catch (e) { fail(e); return; }
    offset = result.offset;
    stats.journalSkipped += result.skipped;
    for (const line of result.lines) {
      // A `seq` that went backwards means the file was replaced under us. Accept the new lineage
      // rather than silently discarding real events, but never treat the rewind itself as work.
      if (line.seq <= stats.lastSeq && line.seq !== 1) continue;
      stats.lastSeq = line.seq;
      stats.journalLines++;
      try { listener(line.signal, line.scope); } catch (e) { fail(e); }
    }
  }

  return {
    name,

    subscribe(emit) {
      listener = emit;
      const timers: ReturnType<typeof setInterval>[] = [];
      const watchers: { close(): void }[] = [];

      // Seed every source WITHOUT emitting: the current state of the world is a baseline, and a
      // consumer that just started must not be handed the entire history as if it were news.
      pumpOutcomes();
      pumpSnapshot(true);
      if (options.journalFromEnd !== false) {
        try { offset = existsSync(journal.path) ? statSync(journal.path).size : 0; } catch { offset = 0; }
        stats.lastSeq = countLines(journal.path);
      }

      // Watch the DIRECTORY, not the file: `writeJson` renames a temp file over the target, which
      // replaces the inode and permanently detaches a file-bound watcher after the first write.
      try {
        const w = watch(dirname(outcomesFile), { persistent: false }, () => {
          try { pumpOutcomes(); pumpSnapshot(); } catch (e) { fail(e); }
        });
        watchers.push(w);
      } catch (e) { fail(e); }

      // The snapshot lives in the same directory, so the one directory watcher covers it too; the
      // timers below are the backstop for a coalesced or missed filesystem event, not the mechanism.
      if (recheckMs > 0) {
        const t = setInterval(() => { pumpOutcomes(); pumpSnapshot(); }, recheckMs);
        t.unref?.(); timers.push(t);
      }
      if (journalMs > 0) { const t = setInterval(pumpJournal, journalMs); t.unref?.(); timers.push(t); }

      let done = false;
      return () => {
        if (done) return;
        done = true;
        listener = undefined;
        for (const t of timers) clearInterval(t);
        for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
      };
    },

    /**
     * What apiplan can honestly say about capacity RIGHT NOW.
     *
     * For an `account-changed` question the answer is real: the outcomes ledger states the identity
     * currently in the well, so a stale signal naming an identity that has since moved on is
     * answered `false`.
     *
     * For a capacity-window question the answer is `"unknown"`, because — as documented at the top of
     * this file — apiplan records nothing about windows. Returning `true` here would be a lie that
     * the consumer cannot detect and that costs a parked run its resume attempt; returning `false`
     * would veto the consumer's own time sweep and the human's manual resume. `"unknown"` is the only
     * honest answer, and it is the caller's job to map it to "do not block".
     */
    async probe(query) {
      const observedAt = Date.now();

      // The capacity snapshot is the only thing that can answer the real question. A line that is
      // still recorded exhausted is a definite NO, and that answer is the last barrier between a
      // stale signal and a parked run spending its resume on a window that never opened.
      if (query.provider) {
        const snapshot = readCapacitySnapshot(snapshotFile);
        const entry = query.scope && query.scope !== "unknown"
          && (query.scope !== "model" || !!query.model)
          && (query.scope !== "org" || !!query.orgFingerprint)
          ? snapshot?.lines?.[lineKey(query.provider, query.accountFingerprint, query.scope, query.model, query.orgFingerprint)]
          : undefined;
        if (entry && entry.provider === query.provider && entry.account === query.accountFingerprint
          && entry.scope === query.scope && entry.model === query.model && entry.orgFingerprint === query.orgFingerprint
          && (entry.scope !== "account" || !!entry.account)) {
          const age = observedAt - entry.observedAt;
          if (age > SNAPSHOT_STALE_MS) {
            return { available: "unknown", observedAt, reason: `last capacity reading for ${query.provider} is ${Math.round(age / 1000)}s old` };
          }
          if (entry.state === "exhausted") {
            return { available: false, observedAt, reason: `${query.provider} still recorded exhausted (${entry.source})`, retryAt: entry.resetsAt };
          }
          if (entry.state === "open") {
            return { available: true, observedAt, reason: `${query.provider} observed open at ${new Date(entry.observedAt).toISOString()}` };
          }
        }
      }

      // Identity is the other thing apiplan genuinely knows. A signal naming a chain that has since
      // moved on is stale, and saying so is a real answer rather than a guess.
      if (query.provider && query.accountFingerprint) {
        let idents: Map<string, string> | undefined;
        try { idents = readOutcomeIdents(outcomesFile); } catch { idents = undefined; }
        const current = idents?.get(query.provider);
        if (current !== undefined && current !== query.accountFingerprint) {
          return { available: false, observedAt, reason: "credential chain has moved on since this signal was observed" };
        }
      }

      // Everything else is genuinely unknown, and must be reported as such rather than guessed in
      // either direction. `true` would be a lie the consumer cannot detect, costing a parked run its
      // resume attempt against a window that never moved. `false` is worse: a consumer applies a
      // provider's recheck to EVERY signal, including its own scheduled sweep and the human's manual
      // resume, so one provider answering `false` vetoes all of them — an unobservable capacity state
      // would silently disable the human's own escape hatch. "I cannot tell" must read as "do not
      // block", and mapping it that way is the caller's job.
      return {
        available: "unknown",
        observedAt,
        reason: "apiplan records no rate-limit window for this line; capacity can be neither confirmed nor denied",
      };
    },

    close() { closed = true; listener = undefined; },
    stats: () => ({ ...stats }),
  };
}
