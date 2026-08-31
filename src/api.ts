// api.ts — a local server that speaks OpenAI's and Anthropic's wire shapes, so any
// SDK, agent framework or app can point its base URL at localhost and be answered by
// the subscriptions already logged in on this machine.
//
// The endpoint dialect and the backend are deliberately independent: which SHAPE you
// get is decided by the path you call, which MODEL answers is decided by the `model`
// field. So `/v1/chat/completions` with `model: "opus"` gives you Claude in OpenAI's
// shape — which is the whole point, since most tooling only speaks one dialect.
import { PROVIDERS, providerFor, speakRealtime, flatText, rememberToolSig, providerRuntime, warmCreds, type CredFp, type Creds, type Delta, type ImageRef, type Turn, type ToolUse, type ToolResult, type ToolDef, type ToolChoice, type CallOpts } from "./providers.ts";
import { models, resolve, type Model } from "./registry.ts";
import { refreshOllama } from "./providers-ollama.ts";
import { framePayload, deltasOf, watchTerminal, UPSTREAM_TRUNCATED } from "./stream-shape.ts";
import { STATE_DIR, readJson, writeJson } from "./platform.ts";
import { join } from "node:path";

/**
 * chatjimmy.ai is reachable here too, but it is not an apiplan *provider*: it needs no
 * credential and streams raw text rather than SSE, so it lives as a special case in this
 * file instead of distorting the Provider interface for one endpoint.
 */
const JIMMY_API = process.env.JIMMY_API ?? "https://chatjimmy.ai";
const JIMMY_MODEL = process.env.JIMMY_MODEL ?? "llama3.1-8B";
const JIMMY_ALIASES = new Set([JIMMY_MODEL.toLowerCase(), "jimmy", "chatjimmy"]);
const JIMMY_STATS = /<\|stats\|>([\s\S]*?)<\|\/stats\|>/;
const isJimmy = (name: unknown) => typeof name === "string" && JIMMY_ALIASES.has(name.toLowerCase());

async function* runJimmy(turns: Turn[], signal?: AbortSignal): AsyncGenerator<Delta> {
  const messages = turns.map((t) => ({ role: t.role, content: t.text }));
  const res = await fetch(`${JIMMY_API}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, chatOptions: { selectedModel: JIMMY_MODEL } }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) throw new HttpError(res.status, (await res.text()).slice(0, 300));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let raw = "", shown = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
    // Hold back a tail that might be the start of the trailing telemetry sentinel.
    const safe = raw.includes("<|stats|>") ? raw.slice(0, raw.indexOf("<|stats|>")) : raw.slice(0, Math.max(0, raw.length - 16));
    if (safe.length > shown) { yield { text: safe.slice(shown) }; shown = safe.length; }
  }
  const full = raw.replace(JIMMY_STATS, "");
  if (full.length > shown) yield { text: full.slice(shown) };
}

// ─────────────────────────── the local library registers itself ───────────────────────────
/**
 * Ollama models used to exist in this server ONLY because somebody had run
 * `apiplan models --refresh` on this machine first. A server started against a cold state
 * dir served zero of them and answered 404 for `heretic` — it worked here tonight and would
 * not work on a fresh start, which is the definition of a seamlessness bug.
 *
 * So the server asks the daemon itself. The probe is a loopback GET with no login, no quota
 * and no weight loading, so it can be done on the way in: the FIRST request awaits it (once,
 * ~tens of ms), later ones get an already-settled promise, and staleness is refreshed in the
 * BACKGROUND so no request ever pays for it twice. A machine with no ollama daemon fails the
 * fetch instantly and is remembered as "nothing to register" — never an error.
 */
const OLLAMA_REFRESH_MS = Number(process.env.APIPLAN_OLLAMA_REFRESH_MS ?? 300_000);
/** A model this server has never heard of may be one pulled since startup — worth ONE
 *  re-ask, but not one per bogus name, so forced re-asks are throttled. */
const OLLAMA_FORCE_MS = Number(process.env.APIPLAN_OLLAMA_FORCE_MS ?? 10_000);
let ollamaReady: Promise<void> | null = null;
let ollamaAt = 0;
function ensureOllama(force = false): Promise<void> {
  const age = Date.now() - ollamaAt;
  if (!ollamaReady) {
    ollamaAt = Date.now();
    ollamaReady = refreshOllama().then(() => {}, () => {});
    return ollamaReady;
  }
  if (age > (force ? OLLAMA_FORCE_MS : OLLAMA_REFRESH_MS)) {
    ollamaAt = Date.now();
    const p = refreshOllama().then(() => {}, () => {});
    // A FORCED re-ask is answered before the request is routed (the caller named a model we
    // do not know); a routine staleness refresh is never allowed to slow anybody down.
    if (force) { ollamaReady = p; return p; }
  }
  return ollamaReady;
}

// ─────────────────────────── what the LAST real call proved ───────────────────────────
/**
 * probe() reads the credential's own expiry stamp and nothing else — so a token that was
 * REVOKED but has not yet expired reads as perfectly healthy and 401s on every call. That
 * is /health green through a total outage of a provider: exactly the failure /health exists
 * to catch, wearing a different hat. A live probe per health check would spend quota on
 * every watchdog tick, so the honest cheap answer is the evidence the server ALREADY has —
 * what happened on the last real call. An auth rejection marks the provider degraded; the
 * next accepted call clears it. Never a paid probe, never a guess.
 */
type Outcome = {
  ok: boolean; at: number; detail: string;
  /**
   * WHICH credential this verdict was observed on — the provider's own fingerprint, which
   * includes a hash of the ACCESS TOKEN ITSELF.
   *
   * ── WHY THE TOKEN IS IN HERE (round four, 2026-08-27) ── this used to be probe()'s
   * detail line, which carries the expiry STAMP but nothing about the bearer. So a token
   * swapped inside the same minute left the fingerprint identical and a green "ACCEPTED"
   * verdict stood for a credential nobody had ever exercised. A verdict is evidence about
   * one exact bearer; the fingerprint now says which one. Hash only — no token is stored,
   * printed or logged, here or anywhere else.
   */
  cred?: string;
  /**
   * The credential CHAIN (account / refresh token), hashed — what a rotation keeps and a
   * swap does not. Together with `exp` it is what tells an hourly refresh (same chain, later
   * expiry — the bearer this verdict was earned on, renewed) apart from a replacement.
   * Absent on an entry written before this field existed; see the migration in verdictFor.
   */
  ident?: string;
  /** The bearer's expiry, ms, at the moment of the verdict. A rotation only ever raises it. */
  exp?: number;
  /**
   * How far this verdict has already been CARRIED past the bearer it was earned on (S-4).
   * Written only when the fingerprint actually moves — once per rotation, never once per
   * /health poll — so reading health does not rewrite state on a quiet system.
   *   cred/ident  the bearer + chain most recently carried to (so the next read can tell a
   *               NEW rotation from the same one being seen again)
   *   at          when that bearer was first seen — the clock the chain window runs on
   *   n           distinct bearers carried since the success
   *   chains      how many of those were also a CHAIN change (new refresh token)
   * A fresh verdict replaces the whole entry, so a real call resets the ledger by writing.
   */
  carry?: { cred: string; ident: string; at: number; n: number; chains: number };
};

/**
 * ── WHY THIS IS ON DISK ──
 * The verdict used to live only in this Map, so it died with the process — and launchd
 * runs this service with KeepAlive, which restarts it on its own. Every restart therefore
 * answered /health (and apiplan-doctor) GREEN for a credential the vendor had already
 * revoked, until the next real call happened to fail again: exactly the false green the
 * whole outcome mechanism exists to prevent, on a timer nobody controls.
 *
 * Two things end the memory of a rejection, and both are automatic:
 *   · the credential CHANGES — `agy`, `claude`, a refresh — so `cred` no longer matches
 *     what probe() reports now, and a verdict about a credential that is gone says nothing
 *     about the one that replaced it. This is what makes a re-login clear the red with no
 *     restart and no manual step.
 *   · it gets OLD — APIPLAN_OUTCOME_TTL_MS, a week by default. Deliberately long: while
 *     the credential is unchanged, a rejection is still the last thing a real call proved.
 * A successful outcome is held to the same two rules; it is evidence about one credential,
 * not a permanent clean bill of health.
 *
 * ── AND AGE DEMOTES, IT DOES NOT DELETE (R-2, round four, 2026-08-27) ── ageing used to
 * DROP the entry, so a stored rejection simply vanished after the TTL and /health answered
 * `ok=true status=ok` again with nothing whatsoever having been proven: the exact false
 * green this whole mechanism exists to prevent, arriving on a one-week timer instead of a
 * restart. An aged-out verdict is now UNVERIFIED (reason `stale`), keeps its prior verdict
 * for the reader, and never reads ok. Time cannot fix a credential; only a call can.
 */
const OUTCOMES_FILE = join(STATE_DIR, "outcomes.json");
const OUTCOME_TTL_MS = Number(process.env.APIPLAN_OUTCOME_TTL_MS ?? 7 * 24 * 3600_000);

/**
 * ── HOW FAR ONE SUCCESS MAY BE CARRIED (S-4 / S-HEALTHFLAP, 2026-08-28) ──
 * A verdict is evidence about the exact bearer it was earned on. When that bearer is
 * replaced by a MINT — same credential, renewed — the evidence still says something, so
 * it is carried and says that it carried. Round five found the carry had no end: three
 * successive bearer replacements with no call in between each read `verified=ok
 * carried=refreshed`, because a carry never updates `at` or `exp`. One ancient success
 * could vouch for tokens for ever, which is a green nothing recent supports.
 *
 * So a carry now AGES, in three independent ways, and the strictest one wins:
 *   ROTATIONS  how many distinct bearers this one success has been stretched over.
 *   MS         wall-clock since the success itself — the ONLY clock that matters here,
 *              because it is the last moment a vendor actually accepted anything.
 *   CHAINS     how many times the credential CHAIN changed under it (a new refresh token,
 *              which is what `claude` and `codex` write when they rotate their own login).
 *              A chain change is weaker evidence than a mint on the same chain, so it gets
 *              its own much shorter window (CHAIN_MS, measured from first sight of the new
 *              chain) — long enough to absorb the flap of S-HEALTHFLAP, short enough that
 *              an unproven replacement cannot sit green all day.
 * Past any bound the provider reads UNVERIFIED — not ok, not rejected — and one real call
 * clears it. A REJECTED verdict is never carried at all; see verdictFor.
 */
const CARRY_MAX_ROTATIONS = Number(process.env.APIPLAN_CARRY_MAX_ROTATIONS ?? 12);
const CARRY_MAX_MS = Number(process.env.APIPLAN_CARRY_MAX_MS ?? 12 * 3600_000);
const CARRY_MAX_CHAINS = Number(process.env.APIPLAN_CARRY_MAX_CHAINS ?? 1);
const CARRY_CHAIN_MS = Number(process.env.APIPLAN_CARRY_CHAIN_MS ?? 60 * 60_000);

/** The fingerprint of the credential a provider would use RIGHT NOW. Never throws: an
 *  outcome must never be able to take /health down (same promise health() already makes).
 *  A provider without credFp() (ollama, which has no credential at all) falls back to its
 *  probe line, which is what the fingerprint used to be for everyone. */
function credOf(id: string): CredFp {
  try {
    const p = PROVIDERS[id as keyof typeof PROVIDERS];
    let f: CredFp;
    if (p?.credFp) f = p.credFp();
    else { const d = p?.probe().detail ?? ""; f = { cred: d, ident: d, exp: 0 }; }
    // F9-1: remember every bearer THIS PROCESS actually read out of the well. See SEEN.
    SEEN.add(seenKey(id, f.cred));
    return f;
  } catch { return { cred: "", ident: "", exp: 0 }; }
}

/**
 * ── F9-1: A CARRY NEEDS AN ANCHOR (round six, 2026-08-28) ──
 *
 * THE HOLE. The carry (S-4) lets one observed success vouch for the bearer that REPLACED
 * the one it was earned on. Everything it checks — that the entry claims ok, that its
 * `exp` is lower than the bearer's in hand, that its `ident` is or is not the same chain —
 * is read out of `outcomes.json` and compared against itself. So an entry hand-written into
 * that file whose fingerprint matches NOTHING this server ever saw was carried like a real
 * one: observed on a scratch server, a planted `{ok:true, cred:"…forged…",
 * ident:"…also-forged…", exp:0}` read `verified=ok verified_carried=rotated`. No token,
 * model or answer changes — it only lies to /health and to apiplan-doctor, and writing the
 * file already means owning the box. It is still a green nothing supports, which is the one
 * thing this whole mechanism exists to prevent.
 *
 * THE ANCHOR. A verdict may only be CARRIED from a bearer this process has actually
 * OBSERVED — read out of the credential well itself, in this process, since it started.
 * The set is built by credOf() on the way past, from the Keychain/file read, and never from
 * anything on disk or published: a forger who can write outcomes.json still cannot put a
 * fingerprint into it, because the only way in is for the real well to have held that
 * bearer while this process was watching. An entry that fails it is UNVERIFIED, reason
 * `unanchored` — kept, reported, and one real call rewrites it.
 *
 * WHAT IT COSTS, HONESTLY: a carry no longer survives a RESTART. The genuine sequence
 * (a real call, then a rotation) is untouched, because the process that recorded the call
 * necessarily read the bearer it was made on — and every later rotation is observed by the
 * /health polls that walk past credOf(). But a verdict inherited from a PREVIOUS process,
 * whose bearer has already rotated away, can no longer be carried by this one: it reads
 * unverified until one real call re-proves it. That is the conservative direction and the
 * same one R-2 chose — evidence this process cannot attribute is not evidence — and it is
 * self-healing: any real call clears it.
 *
 * The EXACT-match path is deliberately left alone. It needs no anchor: `cred` is a hash of
 * the access token itself (P1-FP), which /health never publishes, so an entry that matches
 * the bearer in hand could only have been written by something that already held it.
 */
const SEEN = new Set<string>();
const seenKey = (id: string, cred: string) => `${id} ${cred}`;

/*  REMOVED (S-3, 2026-08-28): legacyCredOf() read what the fingerprint used to be —
 *  probe()'s detail line — so that an entry predating credFp() could be migrated in place.
 *  That line is published verbatim by /health, which made the legacy shape FORGEABLE: a
 *  planted entry matching it was upgraded to a token-hash fingerprint and read verified=ok.
 *  Nothing may re-derive the old shape any more; verdictFor treats an unfingerprinted entry
 *  as unverified and lets one real call rewrite it. */

const OUTCOMES = new Map<string, Outcome>(
  Object.entries(readJson<Record<string, Outcome>>(OUTCOMES_FILE, {} as any) ?? {})
    .filter(([, o]) => o && typeof o.ok === "boolean" && typeof o.at === "number"),
);

/** Persist after every verdict. writeJson is tmp-file + rename, so a reader (or a crash)
 *  never sees half a file, and this process is single-threaded so the writes serialise. */
function saveOutcomes() {
  try { writeJson(OUTCOMES_FILE, Object.fromEntries(OUTCOMES)); } catch {}
}

const noteCall = (id: string, ok: boolean, detail = "") => {
  const f = credOf(id);
  OUTCOMES.set(id, { ok, at: Date.now(), detail, cred: f.cred, ident: f.ident, exp: f.exp });
  saveOutcomes();
};

/**
 * The verdict that still APPLIES, as a THREE-state answer — because the two-state one lied.
 *
 * ── THE FALSE GREEN THIS SHAPE EXISTS FOR (F6-1, 2026-08-27) ──
 * The rejection memory is keyed on a credential fingerprint, and it used to be DELETED the
 * moment that fingerprint changed. So any refresh — `agy`, `claude`, the google heartbeat,
 * this server's own self-refresh — erased the verdict, and /health plus apiplan-doctor went
 * green again without a single successful call having been observed. A credential that was
 * rejected and then refreshed but is STILL broken reported healthy, which is precisely the
 * false green the outcome mechanism exists to prevent, wearing yet another hat.
 *
 * The fix is not to keep the old rejection (it was about a credential that is gone — that
 * would be the opposite lie). It is to stop treating "no verdict" as "fine": a refreshed
 * credential is UNVERIFIED, and unverified is not a pass. The prior verdict is carried
 * along, unremembered by nobody, so a reader can tell the two unverified kinds apart:
 *   never-exercised     nothing has ever been proven here — unknown, and cheap to prove.
 *   credential-changed  a verdict existed and the credential moved under it. If that prior
 *                       verdict was a REJECTION, this provider is UNPROVEN: the refresh is
 *                       not evidence, and only an observed success may turn it green.
 * Stale-by-age still drops from the Map; stale-by-credential no longer does, so the reason
 * survives long enough to be reported. The next real call overwrites the entry either way.
 */
type Verdict =
  | { state: "ok" | "rejected"; at: number; detail: string;
      /** The verdict was earned on a bearer that has since been replaced by a mint, and is
       *  being CARRIED to the one in hand. Reported, never hidden.
       *    refreshed  same chain (account + refresh token), later expiry — the hourly mint.
       *    rotated    the CHAIN itself was replaced (a new refresh token, which is what
       *               `claude` and `codex` write when they renew their own login). Weaker
       *               evidence, so it lives inside the short CARRY_CHAIN_MS window. */
      carried?: "refreshed" | "rotated";
      /** How far it has been carried, so a reader can see the distance, not just the word. */
      carry?: { rotations: number; chains: number; since: number } }
  | { state: "unverified"; reason: "never-exercised" | "credential-changed" | "stale" | "unfingerprinted" | "unanchored";
      prior?: { verdict: "ok" | "rejected"; at: number; detail: string };
      /** Present when it went unverified because a CARRY ran out rather than because the
       *  credential merely changed — the difference between "never proven" and "proven,
       *  but too long ago and too many bearers back for that to still mean anything". */
      carry?: { rotations: number; chains: number; since: number } };

function verdictFor(id: string): Verdict {
  const o = OUTCOMES.get(id);
  if (!o) return { state: "unverified", reason: "never-exercised" };
  const prior = { verdict: (o.ok ? "ok" : "rejected") as "ok" | "rejected", at: o.at, detail: o.detail };
  // R-2: AGE DEMOTES. The entry stays on disk — a reader is owed the last thing anyone
  // proved and WHY it no longer counts, and deleting it made /health go green on nothing.
  if (Date.now() - o.at > OUTCOME_TTL_MS) return { state: "unverified", reason: "stale", prior };
  const f = credOf(id);
  // ── S-3 (2026-08-28): A LEGACY ENTRY IS NEVER UPGRADED TO A PROVEN STATE ──────────────
  // An entry written before the fingerprint carried the token has no `ident`, and its
  // `cred` is the old fingerprint: probe()'s detail line. That line is PUBLIC — /health
  // publishes it verbatim — so anyone who can read /health can also write an outcomes entry
  // that matches it. This branch used to accept such an entry and upgrade it in place to a
  // real token-hash fingerprint, which handed a forged file the green that P1-FP had just
  // made unforgeable: a planted entry was observed reading `verified=ok`. Evidence that
  // cannot be attributed to a bearer is not evidence. The entry is KEPT (it is still the
  // last thing anyone recorded, and R-2 says never delete), it is reported honestly, and it
  // must earn `ok` the only way anything does here: one real call, which rewrites it in the
  // current shape. The migration window is one restart; correctness beats convenience.
  if (o.ident === undefined) return { state: "unverified", reason: "unfingerprinted", prior };
  if (o.cred !== f.cred) {
    // A REJECTION IS NEVER CARRIED: a verdict that the vendor refused says nothing good
    // about the credential that replaced it (F6-1), and `unproven` is what /health calls it.
    if (!o.ok) return { state: "unverified", reason: "credential-changed", prior };
    // F9-1: AND THE VERDICT MUST BE ANCHORED. Everything below this line reasons about a
    // bearer that is GONE, entirely from fields the entry supplies about itself — so a
    // hand-written entry used to be carried exactly like an earned one. Only a bearer this
    // process actually read out of the well may be carried FROM. See the SEEN block above.
    if (!SEEN.has(seenKey(id, o.cred ?? ""))) return { state: "unverified", reason: "unanchored", prior };
    // MINT vs SWAP. A mint only ever moves the expiry FORWARD, so a new bearer that did not
    // extend the expiry (the same-minute swap of round four) is a different credential and
    // is UNVERIFIED, whatever else it claims.
    if (!(f.exp > (o.exp ?? 0))) return { state: "unverified", reason: "credential-changed", prior };
    // Same chain = the hourly refresh; a different chain = `claude` / `codex` renewing
    // their own login, which also writes a new refresh token. Both are carried, on very
    // different leashes (see the knobs above), and both say which one they are.
    const chainChanged = o.ident !== f.ident;
    const c = trackCarry(o, f, chainChanged);
    const shape = { rotations: c.n, chains: c.chains, since: c.at };
    const spent = c.n > CARRY_MAX_ROTATIONS
               || Date.now() - o.at > CARRY_MAX_MS
               || c.chains > CARRY_MAX_CHAINS
               || (c.chains > 0 && Date.now() - c.at > CARRY_CHAIN_MS);
    // S-4: past the bound the carry stops. The success was real and is still reported as
    // the prior verdict — it just no longer vouches for a bearer this far downstream.
    if (spent) return { state: "unverified", reason: "credential-changed", prior, carry: shape };
    return { state: "ok", at: o.at, detail: o.detail, carried: chainChanged ? "rotated" : "refreshed", carry: shape };
  }
  return { state: o.ok ? "ok" : "rejected", at: o.at, detail: o.detail };
}

/**
 * Advance the carry ledger to the bearer in hand and return it (S-4).
 *
 * Called only when the fingerprint has actually MOVED, and it writes only when it moves to
 * a bearer this ledger has not seen — so an idle system polling /health every few seconds
 * does not rewrite outcomes.json every few seconds, and `n` counts ROTATIONS rather than
 * READS. `at` is reset on each new bearer because the chain window (CARRY_CHAIN_MS) asks
 * "how long has THIS unproven replacement been standing", while the wall-clock bound
 * (CARRY_MAX_MS) runs from `o.at`, the last moment a vendor actually accepted something.
 */
function trackCarry(o: Outcome, f: CredFp, chainChanged: boolean): NonNullable<Outcome["carry"]> {
  const c = o.carry;
  if (c && c.cred === f.cred) return c;                       // same rotation, seen again
  const next = c
    ? { cred: f.cred, ident: f.ident, at: Date.now(), n: c.n + 1, chains: c.chains + (chainChanged ? 1 : 0) }
    : { cred: f.cred, ident: f.ident, at: Date.now(), n: 1, chains: chainChanged ? 1 : 0 };
  o.carry = next;
  saveOutcomes();
  return next;
}

const now = () => Math.floor(Date.now() / 1000);
const rid = (p: string) => `${p}-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

// ─────────────────────────── talking to a provider ───────────────────────────

/** One call, normalised to our own Delta events. The CLI's consume() can't be reused: it
 *  writes to stdout and calls die(), which would take the server down with it. */
async function* run(m: Model, turns: Turn[], o: CallOpts, signal?: AbortSignal): AsyncGenerator<Delta> {
  const p = providerFor(m);
  // An expired subscription token is an AUTHENTICATION fault, not a server fault. creds()
  // throws a plain Error, which used to land in the 500 bucket below — and Anthropic-shaped
  // clients retry a 500 forever instead of saying "log in again".
  let c: Creds;
  // R-1: anything a credential needs from the NETWORK happens here, async, where awaiting
  // frees the event loop for every other request — never inside creds(), which is sync and
  // would block the whole server on one vendor's latency. Never throws by contract, and a
  // provider that has nothing to prepare has no hook at all.
  try { await p.prepare?.(); } catch {}
  try { c = p.creds(); }
  catch (e: any) {
    // ── U-1 (2026-08-28): a refusal is not proof until the well has been re-read ──
    // On a resident host creds() reads a SNAPSHOT (F9-2), so a credential rotated by an
    // external tool — `claude`, `codex` or `agy` renewing its own login — is invisible for
    // one cache window. Observed: three consecutive 401 "token expired" with a token good
    // for an hour already on disk, recovering by itself ~100 ms later. A 401 is exactly the
    // signal that the cached credential is wrong, so drop the snapshot, read the well once,
    // and ask again BEFORE the error reaches the caller. Only the second refusal — the one
    // made against a credential read from the well just now — is real: it alone is thrown,
    // and it alone is recorded, so a stale snapshot can never write a vendor rejection that
    // nobody made (which is how #7 turned /health red on a healthy account).
    // `fresh` is false only when the re-read did not land inside its wait (an unreadable or
    // hanging well). Then the second refusal was made against the SAME old snapshot and is
    // not evidence about the credential — the caller still gets its 401, but nothing is
    // written against the provider, because a read we could not perform may not condemn.
    let fresh = true;
    try { fresh = (await p.refreshCreds?.()) ?? true; } catch { fresh = false; }
    try { c = p.creds(); }
    catch (e2: any) {
      if (fresh) noteCall(m.provider, false, e2?.message ?? "no usable provider credential");
      throw new HttpError(401, e2?.message ?? "no usable provider credential");
    }
  }
  const { url, headers, body } = p.build(m, turns, o, c);
  // Always stream upstream, exactly as callDirect does — build() leaves `stream` to the
  // caller, and Anthropic answers a plain JSON body without it, which the SSE reader
  // below would then read as zero events (an empty, silent reply).
  // `signal`: when the client hangs up (ESC in Claude Code, a cancelled tool call) the
  // upstream generation must die with it, or it runs to completion and bills the
  // subscription for an answer nobody will ever read.
  const res = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify(p.wantsStreamFlag === false ? body : { ...body, stream: true }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    let detail = (await res.text()).slice(0, 500);
    try { const j = JSON.parse(detail); detail = j?.error?.message || j?.detail || detail; } catch {}
    // Only an AUTH rejection condemns the credential. A 429 is a busy account, a 400 is our
    // own request — neither means "log in again", and marking them degraded would make
    // /health cry wolf on the one signal a watchdog is meant to trust.
    if (res.status === 401 || res.status === 403) noteCall(m.provider, false, `HTTP ${res.status}: ${detail.slice(0, 160)}`);
    throw new HttpError(res.status, detail);
  }
  // The vendor accepted the credential and opened a stream: that is proof, and it is free.
  noteCall(m.provider, true, `accepted ${new Date().toISOString().slice(11, 19)}`);
  // ── max_tokens, enforced HERE because one backend cannot enforce it at all ──
  // APIPLAN_MAXTOK_ENFORCE. Anthropic's contract makes max_tokens a hard ceiling and
  // reports stop_reason "max_tokens" when it bites. The codex subscription backend
  // refuses the parameter outright — verified live 2026-08-27: POST
  // /backend-api/codex/responses carrying max_output_tokens: 16 answers HTTP 400
  // {"detail":"Unsupported parameter: max_output_tokens"} — so build() cannot pass it on,
  // and every capped request used to run unbounded (max_tokens 8 -> 215 output tokens,
  // stop_reason end_turn). A proxy that advertises a contract owes the contract, so the
  // cap is applied to the stream instead. Deliberately lenient, and crude on purpose:
  //  · only VISIBLE text is counted — reasoning and tool-call arguments are not — so a
  //    provider that DOES enforce natively (anthropic sets max_tokens, google sets
  //    maxOutputTokens) always stops first and this stays a backstop that never fires.
  //  · ~4 chars/token, the same crude figure estimateOut() already reports as usage, so
  //    where the stream is cut and the number the client is told agree with each other.
  //  · a cut is never taken while a tool call is open: truncating tool JSON would hand
  //    the client unparseable arguments, which is worse than running a few tokens over.
  // Cutting cancels the upstream body, so the subscription stops being billed for an
  // answer nobody will read — the same reason the client's abort signal is plumbed in.
  const capChars = o.maxTokens && o.maxTokens > 0 ? o.maxTokens * 4 : 0;
  let capText = 0;
  let toolsOpen = 0;
  // ── TRUNCATED SUCCESS ──
  // A stream that simply STOPS — the upstream closes a chunked body after two text deltas
  // and never sends its terminator — used to be handed to the client as a finished turn:
  // stop_reason end_turn, exit 0, half an answer. That is the fault the human hits as "no
  // response / it went silent", and it is indistinguishable from a good short reply unless
  // the terminator is actually required. So it is required: every vendor here states which
  // event ends its turn (Provider.terminal), and a body that ends without one is an ERROR.
  // The check itself lives in stream-shape.ts so the CLI and the chat ask it the same way
  // — one rule, one message, one off-switch (APIPLAN_TRUNCATION_CHECK=0).
  const term = watchTerminal(p);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      // framePayload/deltasOf carry the two facts an SSE-only reader cannot know: a local
      // ollama daemon frames NDJSON, and one of its events can be several tool calls. For
      // every SSE vendor both are the identity.
      const payload = framePayload(p, line);
      if (!payload) continue;
      let ev: any;
      try { ev = JSON.parse(payload); } catch { continue }
      term.see(ev);
      for (const d of deltasOf(p, ev)) {
        // The vendor's own label rides along: `overloaded_error` must not reach a client
        // as `api_error`, or a loop that retries on overload and stops on api_error makes
        // exactly the wrong call.
        if (d.error) {
          // An auth fault can also arrive INSIDE an accepted stream (a token revoked between
          // the handshake and the answer) — that condemns the credential just the same.
          if (d.errorType === "authentication_error" || d.errorType === "permission_error") noteCall(m.provider, false, `mid-stream ${d.errorType}: ${d.error.slice(0, 160)}`);
          throw new HttpError(STATUS_FOR_TYPE[d.errorType ?? ""] ?? 502, d.error, d.errorType);
        }
        if (d.toolStart) toolsOpen++;
        if (d.toolStop || d.toolCallDone) toolsOpen = Math.max(0, toolsOpen - 1);
        if (capChars && !toolsOpen && d.text) {
          capText += d.text.length;
          if (capText >= capChars) {
            const keep = Math.max(0, d.text.length - (capText - capChars));
            if (keep > 0) yield { ...d, text: d.text.slice(0, keep) };
            yield { stopReason: "max_tokens" };
            try { await reader.cancel(); } catch {}
            return;
          }
        }
        if (d.text || d.reasoning || d.served || d.imageB64 || d.toolStart || d.toolArgs || d.toolStop || d.toolCallDone || d.usage || d.stopReason) yield d;
      }
    }
  }
  // The body ended. If the vendor's own end-of-turn event never arrived, the answer is
  // INCOMPLETE — say so, loudly, instead of passing a half turn off as a whole one. A
  // client hang-up never lands here (reader.read() rejects with AbortError instead), and
  // the max_tokens cut above returns before this line.
  if (term.missing()) {
    const n = noteTruncation(m.provider);
    if (n <= TRUNC_RETRYABLE) throw new HttpError(502, term.message(), UPSTREAM_TRUNCATED);
    throw new HttpError(TRUNCATED_TERMINAL_STATUS,
      `${term.message()} — cut ${n} times in a row, so retrying is NOT fixing it: reported as terminal instead of leaving the caller on a blank screen`,
      UPSTREAM_TRUNCATED);
  }
  clearTruncations(m.provider);
}

class HttpError extends Error {
  /**
   * `upstreamType` is the vendor's OWN name for the fault, carried rather than re-derived:
   * a client that retries on `overloaded_error` but not on `api_error` makes the wrong call
   * when the label is flattened on the way through. Absent means "we only know the status".
   */
  constructor(public status: number, message: string, public upstreamType?: string) { super(message); }
}

// ─────────────────────── how long a cut stream is worth retrying ───────────────────────
/**
 * A truncated stream is a real fault, and the FIRST one is worth one retry: an upstream
 * that dropped a connection once will usually answer the next request. The 27th is not.
 *
 * Measured on 2026-08-27 against a stub that cuts every stream: `claudish` spent 3 m 14 s
 * and 27 upstream attempts before showing the error, Claude Code pointed straight at this
 * server ~4 min and 13 attempts. For those minutes the screen is BLANK — which is the exact
 * symptom the human reported ("no response, it went silent"), now produced by the fix for
 * it. Correct and invisible for four minutes is not correct.
 *
 * So the retry budget is spent HERE, where the streak is visible, instead of by a client
 * that cannot see it: the first cut in a window is reported retryably and a client may try
 * again; a cut that follows another one is reported TERMINAL, and the error lands in
 * seconds. A clean stream clears the streak, so a single transient cut never uses up the
 * budget of the next one — and nothing else is made terminal: a 429, an overloaded_error or
 * any other upstream fault keeps exactly the retry semantics it had.
 *   APIPLAN_TRUNCATION_RETRIES  how many cuts stay retryable inside the window (default 1)
 *   APIPLAN_TRUNCATION_WINDOW_MS  how long a streak is remembered (default 120000)
 */
const TRUNC_WINDOW_MS = Number(process.env.APIPLAN_TRUNCATION_WINDOW_MS ?? 120_000);
const TRUNC_RETRYABLE = Number(process.env.APIPLAN_TRUNCATION_RETRIES ?? 1);
/** HTTP 424 Failed Dependency: OUR dependency failed, not the caller's request. Never in a
 *  client's retry set (unlike every 5xx), which is the point. */
const TRUNCATED_TERMINAL_STATUS = 424;
const TRUNC_STREAK = new Map<string, { n: number; at: number }>();
/** Record a cut. Returns the position in the streak (1 = first in this window). */
function noteTruncation(id: string): number {
  const s = TRUNC_STREAK.get(id);
  const n = s && Date.now() - s.at < TRUNC_WINDOW_MS ? s.n + 1 : 1;
  TRUNC_STREAK.set(id, { n, at: Date.now() });
  return n;
}
/** A stream that ended properly: the upstream is delivering again. */
const clearTruncations = (id: string) => { TRUNC_STREAK.delete(id); };

/** An Anthropic error type → the HTTP status the native API answers it with. A fault that
 *  arrives before the response head is committed can then be reported as that real status
 *  instead of a flat 502 — same information, in the place a client already looks. */
const STATUS_FOR_TYPE: Record<string, number> = {
  invalid_request_error: 400, authentication_error: 401, billing_error: 402,
  permission_error: 403, not_found_error: 404, request_too_large: 413,
  rate_limit_error: 429, api_error: 500, overloaded_error: 529, timeout_error: 504,
};

/** The error `type` values an Anthropic client is built to recognise. A vendor label that
 *  is not one of these is carried in the MESSAGE, never smuggled into the type field. */
const ANTHROPIC_ERROR_TYPES = new Set([
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error",
  "request_too_large", "rate_limit_error", "api_error", "overloaded_error", "billing_error",
  "timeout_error",
]);

/** Resolve the caller's model name, or say exactly what we do have. */
function pick(name: unknown): Model {
  if (typeof name !== "string" || !name) throw new HttpError(400, "`model` is required");
  const m = resolve(name);
  if (!m) throw new HttpError(404, `unknown model '${name}'. Try: ${models().slice(0, 8).map((x) => x.id).join(", ")} (GET /v1/models for all)`);
  return m;
}

// ─────────────────────────── request → our Turn[] ───────────────────────────

/** Both dialects allow a bare string or a content-part array; images differ in shape. */
function partsToTurn(role: "user" | "assistant", content: any): Turn {
  if (typeof content === "string") return { role, text: content };
  const images: ImageRef[] = [];
  const toolUses: ToolUse[] = [];
  const toolResults: ToolResult[] = [];
  let text = "";
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "text" && typeof part.text === "string") text += (text ? "\n" : "") + part.text;
    // OpenAI: {type:"image_url", image_url:{url}} — url may be http(s) or a data: URI
    else if (part?.type === "image_url") {
      const u = part.image_url?.url ?? part.image_url;
      if (typeof u === "string") images.push(dataUriOrUrl(u));
    }
    // Anthropic: {type:"image", source:{type:"base64"|"url", ...}}
    else if (part?.type === "image" && part.source) {
      const s = part.source;
      if (s.type === "url" && s.url) images.push({ url: s.url });
      else if (s.data) images.push({ mediaType: s.media_type ?? "image/png", base64: s.data });
    }
    // Tool blocks. Dropping these is what emptied turn 2 of every agent loop: the turn
    // reached upstream with no content at all and came back 400.
    else if (part?.type === "tool_use") {
      toolUses.push({ id: String(part.id ?? ""), name: String(part.name ?? ""), input: part.input ?? {} });
    }
    else if (part?.type === "tool_result") {
      toolResults.push({ toolUseId: String(part.tool_use_id ?? ""), content: part.content ?? "", ...(part.is_error ? { isError: true } : {}) });
    }
  }
  return {
    role, text,
    ...(images.length ? { images } : {}),
    ...(toolUses.length ? { toolUses } : {}),
    ...(toolResults.length ? { toolResults } : {}),
    ...(Array.isArray(content) ? { nativeAnthropicContent: content } : {}),
  };
}
const dataUriOrUrl = (u: string): ImageRef => {
  const m = u.match(/^data:([^;]+);base64,(.*)$/s);
  return m ? { mediaType: m[1], base64: m[2] } : { url: u };
};

/** Tool arguments travel as a JSON string. A half-streamed or malformed one must not take
 *  the request down, so an unparsable body becomes `{}` rather than throwing. */
function parseArgs(v: unknown): any {
  if (v && typeof v === "object") return v;
  if (typeof v !== "string" || !v.trim()) return {};
  try { const j = JSON.parse(v); return j && typeof j === "object" ? j : {}; } catch { return {} }
}

/** OpenAI puts system turns in `messages`; we carry them separately, as Anthropic does. */
function fromOpenAI(body: any): { turns: Turn[]; system?: string } {
  const turns: Turn[] = [];
  let system = "";
  for (const msg of Array.isArray(body?.messages) ? body.messages : []) {
    if (msg?.role === "system" || msg?.role === "developer") {
      const t = typeof msg.content === "string" ? msg.content : partsToTurn("user", msg.content).text;
      system += (system ? "\n\n" : "") + t;
    } else if (msg?.role === "tool" || msg?.role === "function") {
      // OpenAI carries a tool result as its own message; Anthropic as a block on the next
      // user turn. Fold it onto a user turn so neither dialect loses it.
      const r: ToolResult = { toolUseId: String(msg.tool_call_id ?? msg.id ?? ""), content: typeof msg.content === "string" ? msg.content : flatText(msg.content) };
      const last = turns.at(-1);
      if (last?.role === "user") (last.toolResults ??= []).push(r);
      else turns.push({ role: "user", text: "", toolResults: [r] });
    } else if (msg?.role === "user" || msg?.role === "assistant") {
      const t = partsToTurn(msg.role, msg.content);
      for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        (t.toolUses ??= []).push({ id: String(tc.id ?? ""), name: String(tc.function?.name ?? tc.name ?? ""), input: parseArgs(tc.function?.arguments ?? tc.arguments) });
      }
      turns.push(t);
    }
  }
  if (!turns.length) throw new HttpError(400, "`messages` must contain at least one user or assistant message");
  return { turns, ...(system ? { system } : {}) };
}

export function fromAnthropic(body: any): { turns: Turn[]; system?: string; systemBlocks?: any[] } {
  const turns: Turn[] = [];
  // Claude Code pointed straight at this server emits role:"system" entries BETWEEN turns
  // (its system-reminders). The Messages API has no such role, so they are hoisted onto
  // the system prompt rather than dropped — dropping them loses live instructions.
  let inline = "";
  for (const msg of Array.isArray(body?.messages) ? body.messages : []) {
    if (msg?.role === "system" || msg?.role === "developer") {
      const t = typeof msg.content === "string" ? msg.content : partsToTurn("user", msg.content).text;
      if (t) inline += (inline ? "\n\n" : "") + t;
    } else if (msg?.role === "user" || msg?.role === "assistant") turns.push(partsToTurn(msg.role, msg.content));
  }
  if (!turns.length) throw new HttpError(400, "`messages` must contain at least one message");
  const sys = body?.system;
  let system = typeof sys === "string" ? sys
    : Array.isArray(sys) ? sys.map((s: any) => s?.text ?? "").filter(Boolean).join("\n\n")
    : undefined;
  if (inline) system = system ? `${system}\n\n${inline}` : inline;
  // Preserve native blocks and cache controls, except Claude Code's request-bound billing
  // attestation. Its cch hashes the ORIGINAL request body; forwarding it after this proxy
  // rebuilds the body makes the stable system prefix change every turn. Remove it only at
  // this Anthropic-in adapter boundary. Direct provider callers remain lossless.
  const blocks: any[] = Array.isArray(sys)
    ? sys.filter((b: any) => b && typeof b === "object" &&
      (typeof b.text !== "string" || !b.text.startsWith("x-anthropic-billing-header:")))
    : [];
  if (inline) blocks.push({ type: "text", text: inline });
  return { turns, ...(system ? { system } : {}), ...(blocks.length ? { systemBlocks: blocks } : {}) };
}

/** Shared knobs. Effort is accepted under either vendor's spelling. */
export function optsFrom(body: any, system?: string): CallOpts {
  const o: CallOpts = {};
  if (system) o.system = system;
  // OM's OpenAI-compatible transport emits the normalized cache key directly.
  // Retain it unchanged so APIPlan's Codex Responses request can route and cache on it.
  if (typeof body?.prompt_cache_key === "string" && body.prompt_cache_key) o.promptCacheKey = body.prompt_cache_key;
  // Anthropic-compatible OM requests carry stable provider affinity in
  // metadata.user_id. Retain the caller's exact value: Anthropic cache reuse works for
  // both OM's JSON envelope and opaque ids, while rewriting metadata here would change
  // caller-visible routing semantics without improving the cache.
  if (!o.promptCacheKey && typeof body?.metadata?.user_id === "string" && body.metadata.user_id) {
    o.promptCacheKey = body.metadata.user_id;
  }
  const effort = body?.reasoning_effort ?? body?.reasoning?.effort ?? body?.thinking?.effort ?? body?.output_config?.effort;
  if (typeof effort === "string") o.effort = effort;
  const max = body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens;
  if (typeof max === "number") o.maxTokens = max;
  if (typeof body?.temperature === "number") o.temperature = body.temperature;
  if (body?.thinking?.type === "disabled") o.thinkOff = true;
  return o;
}

// ─────────────────────────── tools the caller offered ───────────────────────────

/**
 * Tools, from either dialect, into ONE internal list. An Anthropic block is kept whole in
 * `raw`, so an anthropic-in/anthropic-out call is a passthrough and server tools survive
 * as themselves; OpenAI's nested `function` shape is flattened. `tools: []` and no `tools`
 * at all mean the same thing — nothing is added to the upstream body.
 */
function toolsFrom(body: any, dialect: "openai" | "anthropic"): { tools?: ToolDef[]; toolChoice?: ToolChoice } {
  const tools: ToolDef[] = [];
  for (const t of Array.isArray(body?.tools) ? body.tools : []) {
    if (!t || typeof t !== "object") continue;
    if (dialect === "anthropic") {
      const name = t.name ?? t.function?.name;
      if (typeof name !== "string") continue;
      tools.push({ name, description: t.description, parameters: t.input_schema ?? t.parameters, raw: t });
    } else {
      const fn = t.function ?? t;
      if (typeof fn.name !== "string") continue;
      tools.push({ name: fn.name, description: fn.description, parameters: fn.parameters ?? fn.input_schema });
    }
  }
  if (!tools.length) return {};
  const choice = toolChoiceFrom(body?.tool_choice);
  return { tools, ...(choice ? { toolChoice: choice } : {}) };
}

/** Anthropic says auto|any|tool|none, OpenAI says auto|none|required|{function}. */
function toolChoiceFrom(c: any): ToolChoice | undefined {
  if (typeof c === "string") return c === "auto" || c === "none" || c === "required" ? c : undefined;
  if (!c || typeof c !== "object") return undefined;
  if (c.type === "tool" && typeof c.name === "string") return { name: c.name };
  if (c.type === "function") {
    const n = c.function?.name ?? c.name;
    return typeof n === "string" ? { name: n } : "required";
  }
  if (c.type === "any") return "required";
  if (c.type === "none" || c.type === "auto") return c.type;
  return undefined;
}

/** One tool call being assembled from the stream. `fragged` records that real fragments
 *  arrived, so a backend's whole-arguments repeat at the end is discarded rather than
 *  doubling the JSON. */
type Call = { ref: string; id: string; name: string; json: string; fragged: boolean };
/** The (start|args|stop) triple both emitters speak, normalised from a Delta. A backend
 *  that reports a WHOLE call in one event (Gemini) becomes all three under a minted ref. */
type ToolEv = { start?: { ref: string; id: string; name: string }; args?: { ref: string; json: string; full?: boolean }; stop?: { ref: string } };
function toolEvents(d: Delta, mint: () => string): ToolEv[] {
  const out: ToolEv[] = [];
  if (d.toolStart) out.push({ start: d.toolStart });
  if (d.toolArgs) out.push({ args: d.toolArgs });
  if (d.toolStop) out.push({ stop: d.toolStop });
  if (d.toolCallDone) {
    const ref = mint();
    const json = typeof d.toolCallDone.args === "string" ? d.toolCallDone.args : JSON.stringify(d.toolCallDone.args ?? {});
    const id = d.toolCallDone.id ?? rid("toolu");
    // The vendor's opaque per-call token (Gemini's thought signature) is filed against the
    // id the client will echo back, since no dialect has a field to carry it across a turn.
    if (d.toolCallDone.sig) rememberToolSig(id, d.toolCallDone.sig);
    out.push({ start: { ref, id, name: d.toolCallDone.name } });
    out.push({ args: { ref, json, full: true } });
    out.push({ stop: { ref } });
  }
  return out;
}
/** Fold one event into the call it belongs to. Returns the call, and the fragment of
 *  arguments worth FORWARDING on this event (empty when there is nothing new to say). */
function foldCall(byRef: Map<string, Call>, order: Call[], ev: ToolEv): { call?: Call; frag: string; opened: boolean } {
  if (ev.start) {
    let c = byRef.get(ev.start.ref);
    if (c) { if (ev.start.id) c.id = ev.start.id; if (ev.start.name) c.name = ev.start.name; return { call: c, frag: "", opened: false }; }
    c = { ref: ev.start.ref, id: ev.start.id || rid("toolu"), name: ev.start.name ?? "", json: "", fragged: false };
    byRef.set(c.ref, c); order.push(c);
    return { call: c, frag: "", opened: true };
  }
  if (ev.args) {
    const c = byRef.get(ev.args.ref);
    if (!c) return { frag: "", opened: false };
    if (ev.args.full) {
      if (c.fragged) return { call: c, frag: "", opened: false };   // already streamed in pieces
      c.json = ev.args.json;
      return { call: c, frag: ev.args.json, opened: false };
    }
    c.json += ev.args.json; c.fragged = true;
    return { call: c, frag: ev.args.json, opened: false };
  }
  return { call: ev.stop ? byRef.get(ev.stop.ref) : undefined, frag: "", opened: false };
}

// ─────────────────────────── how many tokens was that? ───────────────────────────

/**
 * A marker on any usage number this server invented rather than measured. Both SDKs ignore
 * unknown fields, and an estimate that says so is honest; a hardcoded 0 is not — every
 * context meter and auto-compact trigger reads 0 as "this session is empty", so compaction
 * never fires and the session dies of an upstream context overflow instead.
 */
const USAGE_MARK = "x_apiplan_usage";

/** ~4 characters per token, plus a little framing per message; an image is charged a flat
 *  ~1600, Anthropic's own rough figure for a full-size one. Deliberately crude. */
function estimateTokens(turns: Turn[], system?: string): number {
  let chars = system ? system.length : 0;
  let images = 0;
  for (const t of turns) {
    chars += t.text.length;
    images += t.images?.length ?? 0;
    for (const u of t.toolUses ?? []) chars += u.name.length + JSON.stringify(u.input ?? {}).length;
    for (const r of t.toolResults ?? []) chars += flatText(r.content).length;
  }
  return Math.max(1, Math.ceil(chars / 4) + turns.length * 3 + images * 1600);
}
const estimateOut = (text: string) => (text ? Math.max(1, Math.ceil(text.length / 4)) : 0);

/** What upstream actually told us during one call. Undefined = it told us nothing. */
type Tally = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; stopReason?: string };
function tally(t: Tally, d: Delta) {
  if (d.usage?.input !== undefined) t.input = d.usage.input;
  if (d.usage?.output !== undefined) t.output = d.usage.output;
  if (d.usage?.cacheRead !== undefined) t.cacheRead = d.usage.cacheRead;
  if (d.usage?.cacheWrite !== undefined) t.cacheWrite = d.usage.cacheWrite;
  if (d.stopReason) t.stopReason = d.stopReason;
}
/** Provider cache counters translated into each caller dialect's own spelling. Preserve
 *  explicit zeroes: zero is measured evidence of a miss; absence means unavailable. */
const cacheUsageAnthropic = (t: Tally) => ({
  ...(t.cacheWrite !== undefined ? { cache_creation_input_tokens: t.cacheWrite } : {}),
  ...(t.cacheRead !== undefined ? { cache_read_input_tokens: t.cacheRead } : {}),
});
const cacheUsageOpenAI = (t: Tally) => ({
  ...(t.cacheRead !== undefined || t.cacheWrite !== undefined ? {
    prompt_tokens_details: {
      ...(t.cacheRead !== undefined ? { cached_tokens: t.cacheRead } : {}),
      ...(t.cacheWrite !== undefined ? { cache_write_tokens: t.cacheWrite } : {}),
    },
  } : {}),
});
/** Anthropic's stop vocabulary → OpenAI's finish_reason. */
const finishFor = (stop?: string) => (stop === "max_tokens" ? "length" : stop === "tool_use" ? "tool_calls" : "stop");

/**
 * Why the turn stopped, when it ALSO carried tool calls.
 *
 * `order.length ? "tool_use" : upstream` threw away every reason that is not "there were
 * tools" — a turn cut at max_tokens WHILE calling a tool was reported as a clean tool_use,
 * so the client ran the truncated call and never continued the reply. Upstream's own reason
 * wins whenever it says something a caller must act on (max_tokens, stop_sequence, refusal,
 * pause_turn); tool presence only decides the DEFAULT, which is what a backend that never
 * says "tool_use" (openai, google, ollama) needs.
 */
const CLEAN_STOP = new Set(["end_turn", "stop", "tool_use"]);
const stopWith = (stop: string | undefined, sawTool: boolean) =>
  stop && !CLEAN_STOP.has(stop) ? stop : sawTool ? "tool_use" : (stop ?? "end_turn");

// ─────────────────────────── our Deltas → each dialect ───────────────────────────

const sse = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

/**
 * Anthropic's own stream sends `ping` frames while the model is quiet. Racing the generator
 * against a timer keeps the pending next() in flight — a settled event is never dropped, a
 * ping only ever fills real silence.
 */
const PING = Symbol("ping");
async function* withPings<T>(src: AsyncGenerator<T>, ms = 15000): AsyncGenerator<T | typeof PING> {
  const it = src[Symbol.asyncIterator]();
  let pending = it.next();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<typeof PING>((r) => { timer = setTimeout(() => r(PING), ms); });
    const w: IteratorResult<T> | typeof PING = await Promise.race([pending, tick]);
    clearTimeout(timer);
    if (w === PING) { yield PING; continue; }
    if (w.done) return;
    yield w.value;
    pending = it.next();
  }
}

/**
 * A failure that lands AFTER the response head is committed. The status line already said
 * 200, so the only way left to tell the client is inside the stream — and it has to be
 * told in the dialect it is parsing, WITH A TERMINATOR. Before this, a mid-stream fault
 * rode a bare `data:` frame with no `event:` line and no end-of-message event, and the
 * stream simply stopped: an Anthropic-shaped client read a failed generation as a
 * COMPLETE one — the "the model went silent" class, where an agent loop then acts on half
 * an answer instead of retrying. Observed live 2026-08-27 19:28 on an expired google
 * token.
 *   anthropic → `event: error` (what the SDK raises on) then `message_stop`, so a reader
 *               that only watches for the terminator still stops cleanly rather than
 *               waiting out its read timeout.
 *   openai    → `data: {"error":…}` then `data: [DONE]`.
 * The error TYPE is carried too: an authentication_error stops a client dead, where
 * api_error makes it retry a dead token forever.
 */
function streamFault(dialect: "openai" | "anthropic", e: any): string {
  const status = e instanceof HttpError ? e.status : 502;
  const message = e?.message ?? String(e);
  const upstream = typeof e?.upstreamType === "string" ? e.upstreamType : undefined;
  if (dialect === "anthropic") {
    const type = upstream && ANTHROPIC_ERROR_TYPES.has(upstream) ? upstream
      : status === 401 ? "authentication_error"
      // 424 is this server saying "do not retry" (see TRUNCATED_TERMINAL_STATUS). Anthropic's
      // vocabulary has no terminal-upstream member, and `type` is the only field a client's
      // retry policy reads — so it carries the DECISION, while the message carries the truth
      // and `upstream_truncated` still rides in the openai `code`.
      : status === TRUNCATED_TERMINAL_STATUS ? "invalid_request_error"
      : status === 400 ? "invalid_request_error"
      : status === 404 ? "not_found_error"
      : status === 429 ? "rate_limit_error"
      : status === 529 ? "overloaded_error"
      : "api_error";
    return sse({ type: "error", error: { type, message } }, "error")
         + sse({ type: "message_stop" }, "message_stop");
  }
  return sse({ error: { message, type: status === 401 ? "authentication_error" : status === TRUNCATED_TERMINAL_STATUS ? "invalid_request_error" : "upstream_error", param: null, code: status === 401 ? "invalid_api_key" : (upstream ?? null) } })
       + "data: [DONE]\n\n";
}

/** How long a stream may take to produce its FIRST upstream event before the HTTP head is
 *  committed. A rejected credential or a rejected body answers far inside this; a slow
 *  model does not, so its head goes out on time and any later fault rides the stream. */
const PREFLIGHT_MS = Number(process.env.APIPLAN_PREFLIGHT_MS ?? 2500);

type Primed<T> = { it: AsyncIterator<T>; pending: Promise<IteratorResult<T>> };

/**
 * Start the upstream generator and wait — briefly — for its first event, WITHOUT
 * consuming it. A failure inside that window happened before a single byte of the
 * response was written, so it can still be answered as a real HTTP status (401, 400, 404)
 * exactly as the native API answers it, instead of a 200 stream carrying an error frame.
 * That distinction is what makes an expired token surface in Claude Code as
 * "authentication_error" rather than as an empty answer.
 * Anything slower keeps the SAME in-flight promise and is replayed into the stream, so no
 * event is ever dropped and a slow model is never punished for being slow.
 */
async function preflight<T>(src: AsyncGenerator<T>): Promise<{ primed?: Primed<T>; error?: any }> {
  const it = src[Symbol.asyncIterator]() as AsyncIterator<T>;
  const pending = it.next();
  // Handle the rejection HERE as well, so a fault arriving after the window is never an
  // unhandled rejection. The same promise is still awaited by replay(), so nothing is
  // swallowed — a late fault still reaches streamFault().
  const settled = pending.then(() => null, (e: any) => e ?? new Error("upstream failed"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), PREFLIGHT_MS); });
  const err = await Promise.race([settled, late]);
  clearTimeout(timer);
  return err ? { error: err } : { primed: { it, pending } };
}

/** Resume a preflighted generator from the first event that is already in flight. */
async function* replay<T>(p: Primed<T>): AsyncGenerator<T> {
  let next = p.pending;
  while (true) {
    const r = await next;
    if (r.done) return;
    yield r.value;
    next = p.it.next();
  }
}

function streamResponse(dialect: "openai" | "anthropic", gen: () => AsyncGenerator<string>, onCancel?: () => void): Response {
  const stream = new ReadableStream({
    async start(c) {
      const enc = new TextEncoder();
      try { for await (const chunk of gen()) c.enqueue(enc.encode(chunk)); }
      catch (e: any) {
        // A client that hung up is NOT a fault to report — there is nobody to tell, and
        // both enqueue() and close() throw on a controller the runtime already tore down.
        if (e?.name !== "AbortError") {
          try { c.enqueue(enc.encode(streamFault(dialect, e))); } catch {}
        }
      }
      try { c.close(); } catch {}
    },
    // Fires when the consumer walks away; the upstream fetch has to walk away too.
    cancel() { onCancel?.(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

async function openaiChat(body: any, signal?: AbortSignal): Promise<Response> {
  const jimmy = isJimmy(body?.model);
  const m = jimmy ? null : pick(body?.model);
  const { turns, system } = fromOpenAI(body);
  const o = optsFrom(body, system);
  Object.assign(o, toolsFrom(body, "openai"));
  const ac = linkAbort(signal);
  const gen = () => (jimmy ? runJimmy(turns, ac.signal) : run(m!, turns, o, ac.signal));
  const id0 = jimmy ? JIMMY_MODEL : m!.id;
  const id = rid("chatcmpl"), created = now();
  let auto = 0;
  const mint = () => `auto:${auto++}`;

  if (!body?.stream) {
    let text = "";
    const t: Tally = {};
    const byRef = new Map<string, Call>(), order: Call[] = [];
    for await (const d of gen()) {
      text += d.text ?? "";
      tally(t, d);
      for (const ev of toolEvents(d, mint)) foldCall(byRef, order, ev);
    }
    const inTok = t.input ?? estimateTokens(turns, system);
    const outTok = t.output ?? estimateOut(text);
    // OpenAI's shape: content is null when the turn IS the tool call.
    const message: any = { role: "assistant", content: order.length && !text ? null : text };
    if (order.length) {
      message.tool_calls = order.map((c, i) => ({ index: i, id: c.id, type: "function", function: { name: c.name, arguments: c.json || "{}" } }));
    }
    return json({
      id, object: "chat.completion", created, model: id0,
      choices: [{ index: 0, message, logprobs: null, finish_reason: finishFor(stopWith(t.stopReason, order.length > 0)) }],
      usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok, ...cacheUsageOpenAI(t) },
      ...(t.input === undefined || t.output === undefined ? { [USAGE_MARK]: "estimated" } : {}),
    });
  }
  // Commit the head only once the upstream has actually answered — see preflight().
  const pre = await preflight(gen());
  if (pre.error) { ac.abort(); throw pre.error; }
  const primed = pre.primed!;
  return streamResponse("openai", async function* () {
    const head = { id, object: "chat.completion.chunk", created, model: id0 };
    yield sse({ ...head, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    let text = "";
    const t: Tally = {};
    // OpenAI numbers tool calls per choice, in the order they open.
    const byRef = new Map<string, Call>(), order: Call[] = [];
    for await (const d of replay(primed)) {
      tally(t, d);
      if (d.text) { text += d.text; yield sse({ ...head, choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] }); }
      for (const ev of toolEvents(d, mint)) {
        const r = foldCall(byRef, order, ev);
        if (!r.call) continue;
        const i = order.indexOf(r.call);
        if (r.opened) yield sse({ ...head, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: r.call.id, type: "function", function: { name: r.call.name, arguments: "" } }] }, finish_reason: null }] });
        if (r.frag) yield sse({ ...head, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: r.frag } }] }, finish_reason: null }] });
      }
    }
    const last: any = { ...head, choices: [{ index: 0, delta: {}, finish_reason: finishFor(stopWith(t.stopReason, order.length > 0)) }] };
    // OpenAI only sends usage on a stream when the caller asked for it; honour that rather
    // than inventing a field a strict client is not expecting.
    if (body?.stream_options?.include_usage) {
      const inTok = t.input ?? estimateTokens(turns, system);
      const outTok = t.output ?? estimateOut(text);
      last.usage = { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok, ...cacheUsageOpenAI(t) };
      if (t.input === undefined || t.output === undefined) last[USAGE_MARK] = "estimated";
    }
    yield sse(last);
    yield "data: [DONE]\n\n";
  }, () => ac.abort());
}

async function anthropicMessages(body: any, signal?: AbortSignal): Promise<Response> {
  const jimmy = isJimmy(body?.model);
  const m = jimmy ? null : pick(body?.model);
  const { turns, system, systemBlocks } = fromAnthropic(body);
  const o = optsFrom(body, system);
  if (systemBlocks) o.systemBlocks = systemBlocks;
  Object.assign(o, toolsFrom(body, "anthropic"));
  const ac = linkAbort(signal);
  const gen = () => (jimmy ? runJimmy(turns, ac.signal) : run(m!, turns, o, ac.signal));
  const id0 = jimmy ? JIMMY_MODEL : m!.id;
  const id = rid("msg");
  let auto = 0;
  const mint = () => `auto:${auto++}`;

  if (!body?.stream) {
    let text = "";
    const t: Tally = {};
    const byRef = new Map<string, Call>(), order: Call[] = [];
    for await (const d of gen()) {
      text += d.text ?? "";
      tally(t, d);
      for (const ev of toolEvents(d, mint)) foldCall(byRef, order, ev);
    }
    const content: any[] = [];
    if (text) content.push({ type: "text", text });
    for (const c of order) content.push({ type: "tool_use", id: c.id, name: c.name, input: parseArgs(c.json) });
    // A reply that carried nothing at all still answers in the old shape.
    if (!content.length) content.push({ type: "text", text });
    return json({
      id, type: "message", role: "assistant", model: id0,
      content,
      // A reply cut off at max_tokens used to be reported as a finished turn, so the client
      // never continued it and the human silently lost the tail.
      stop_reason: stopWith(t.stopReason, order.length > 0), stop_sequence: null,
      usage: { input_tokens: t.input ?? estimateTokens(turns, system), output_tokens: t.output ?? estimateOut(text), ...cacheUsageAnthropic(t) },
      ...(t.input === undefined || t.output === undefined ? { [USAGE_MARK]: "estimated" } : {}),
    });
  }
  // Commit the head only once the upstream has actually answered — see preflight().
  const pre = await preflight(gen());
  if (pre.error) { ac.abort(); throw pre.error; }
  const primed = pre.primed!;
  return streamResponse("anthropic", async function* () {
    // The real input count only arrives with the upstream stream, which has not been opened
    // yet — so message_start carries an estimate, MARKED as one, and the closing
    // message_delta corrects it with whatever upstream really reported.
    const estIn = estimateTokens(turns, system);
    const msg = { id, type: "message", role: "assistant", model: id0, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estIn, output_tokens: 0 }, [USAGE_MARK]: "estimated" };
    yield sse({ type: "message_start", message: msg }, "message_start");
    // Blocks are numbered as they open — text is no longer permanently index 0, because a
    // reply can be tool calls only, or text and calls interleaved. Anthropic's wire format
    // has exactly ONE block open at a time and no gaps in the indices, so text closes
    // before a call opens and every index is handed out by this one cursor.
    let next = 0, textIdx: number | null = null, sawTool = false;
    let text = "";
    const t: Tally = {};
    const byRef = new Map<string, Call>(), order: Call[] = [];
    const idxOf = new Map<string, number>();
    for await (const d of withPings(replay(primed))) {
      if (d === PING) { yield sse({ type: "ping" }, "ping"); continue; }
      tally(t, d);
      if (d.text) {
        text += d.text;
        if (textIdx === null) {
          textIdx = next++;
          yield sse({ type: "content_block_start", index: textIdx, content_block: { type: "text", text: "" } }, "content_block_start");
        }
        yield sse({ type: "content_block_delta", index: textIdx, delta: { type: "text_delta", text: d.text } }, "content_block_delta");
      }
      for (const ev of toolEvents(d, mint)) {
        const r = foldCall(byRef, order, ev);
        if (r.opened && r.call) {
          // A tool call cannot open inside a text block: close text first.
          if (textIdx !== null) { yield sse({ type: "content_block_stop", index: textIdx }, "content_block_stop"); textIdx = null; }
          const i = next++; idxOf.set(r.call.ref, i); sawTool = true;
          yield sse({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: r.call.id, name: r.call.name, input: {} } }, "content_block_start");
        }
        if (r.frag && r.call) {
          const i = idxOf.get(r.call.ref);
          if (i !== undefined) yield sse({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: r.frag } }, "content_block_delta");
        }
        if (ev.stop) {
          const i = idxOf.get(ev.stop.ref);
          if (i !== undefined) { idxOf.delete(ev.stop.ref); yield sse({ type: "content_block_stop", index: i }, "content_block_stop"); }
        }
      }
    }
    if (textIdx !== null) yield sse({ type: "content_block_stop", index: textIdx }, "content_block_stop");
    for (const i of idxOf.values()) yield sse({ type: "content_block_stop", index: i }, "content_block_stop");
    // An empty reply still gets the one empty text block clients saw before this patch.
    if (next === 0) {
      yield sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
      yield sse({ type: "content_block_stop", index: 0 }, "content_block_stop");
    }
    yield sse({
      type: "message_delta",
      delta: { stop_reason: stopWith(t.stopReason, sawTool), stop_sequence: null },
      usage: { input_tokens: t.input ?? estIn, output_tokens: t.output ?? estimateOut(text), ...cacheUsageAnthropic(t) },
      ...(t.input === undefined || t.output === undefined ? { [USAGE_MARK]: "estimated" } : {}),
    }, "message_delta");
    yield sse({ type: "message_stop" }, "message_stop");
  }, () => ac.abort());
}

/**
 * POST /v1/messages/count_tokens — answered LOCALLY on purpose: counting must never spend
 * quota or add a network hop, and a 404 here breaks a client's context bookkeeping (Claude
 * Code sizes context and drives auto-compact from it). The number is this file's estimate,
 * and the reply says so.
 */
function countTokens(body: any): Response {
  const { turns, system } = fromAnthropic(body);
  const tools = toolsFrom(body, "anthropic").tools ?? [];
  const toolChars = tools.reduce((n, t) => n + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.parameters ?? {}).length, 0);
  return json({ input_tokens: estimateTokens(turns, system) + Math.ceil(toolChars / 4), [USAGE_MARK]: "estimated" });
}

/**
 * GET /health — the truth, PER PROVIDER. It used to answer `{ok:true}` whenever the
 * process was listening, which is not health: on 2026-08-27 the google credential expired
 * at 16:22 and every gemini call 401'd for hours while /health stayed green, so every
 * watchdog built on it stayed quiet through a total outage of one model family.
 * probe() is network-free — it reads the credential already on disk — so the honest
 * answer costs nothing and cannot itself hang or spend quota.
 *   ok        true only when every provider is usable
 *   status    "ok" | "degraded" (some usable) | "down" (none usable)
 * The HTTP status stays 200 on purpose: the SERVICE is up and still serving whatever is
 * alive, and readiness probes elsewhere use `curl -sf` on this route. The verdict lives
 * in the body, where a caller has to actually read it.
 */
function health(): Response {
  const ids = Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[];
  const registry = models();
  const providers = ids.map((id) => {
    // probe() promises never to throw; a provider that breaks that promise must still not
    // take /health down — an unreadable credential is a RED provider, not a 500.
    let p: { connected: boolean; detail: string; loginHint: string };
    try { p = PROVIDERS[id].probe(); }
    catch (e: any) { p = { connected: false, detail: `probe threw: ${e?.message ?? String(e)}`, loginHint: "" }; }
    // The zone is part of the stamp now (round four: "expires 21:14" was UTC, unlabelled,
    // three hours off the clock he reads it on), and it is OPTIONAL in these patterns only
    // so a stamp from an older provider still parses rather than reading as no expiry.
    const ZONE = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: [+-]\d{4})?`;
    const expires = new RegExp(`expires (${ZONE})`).exec(p.detail)?.[1]
      ?? new RegExp(`expired \\((${ZONE})\\)`).exec(p.detail)?.[1]
      ?? new RegExp(`expired (${ZONE})`).exec(p.detail)?.[1] ?? null;
    // What a REAL call last proved, which outranks what the credential claims about itself.
    const v = verdictFor(id);
    const rejected = v.state === "rejected";
    // UNPROVEN: the credential moved after a rejection and nothing has succeeded on the new
    // one. Not rejected (that verdict was about a credential that is gone) and emphatically
    // not ok — a refresh is not evidence. Green here must cost one observed success.
    const unproven = v.state === "unverified" && v.prior?.verdict === "rejected";
    // An unexercised, aged-out or replaced credential is UNVERIFIED — not ok. Nothing here
    // has proven anything, and a green answer would be a claim this server cannot support:
    // a cold state dir used to read `ok=true` while apiplan-doctor, reading the same body,
    // called it probe-only. Two surfaces, one truth (round four).
    const unverified = v.state === "unverified" && !unproven;
    const staleV = v.state === "unverified" && v.reason === "stale";
    const fix = rejected ? (p.loginHint || "the vendor REJECTED this credential on a real call — re-login for this provider")
              : unproven ? "the previous credential was REJECTED and this replacement has not been proven — make one real call (apiplan-doctor --deep); if that call is rejected too, re-login for this provider"
              : unverified ? "nothing has been proven on this credential — make one real call (apiplan-doctor --deep) to turn it green"
              : p.loginHint;
    return {
      id, label: PROVIDERS[id].label, connected: p.connected && !rejected, expires,
      models: registry.filter((m) => m.provider === id).length,
      // "unverified" is the honest word for a credential no call has exercised yet: it is
      // not a claim of health, and a reader that treats it as one is reading it wrong.
      verified: v.state,
      verified_at: v.state === "unverified" ? null : new Date(v.at).toISOString(),
      // WHY it is unverified, and what the last thing anyone proved was. Without these two
      // a reader cannot tell "never tried" from "the thing we last saw fail was replaced".
      ...(v.state === "unverified" ? { verified_reason: v.reason } : {}),
      ...(v.state === "unverified" && v.prior
          ? { verified_prior: { verdict: v.prior.verdict, at: new Date(v.prior.at).toISOString(), detail: v.prior.detail } }
          : {}),
      // The verdict stands, on a bearer that has been rotated since — said out loud rather
      // than folded into a plain "ok", because a reader is entitled to know which token the
      // evidence was actually earned on.
      ...(v.state === "ok" && v.carried ? { verified_carried: v.carried } : {}),
      // How far the evidence has been stretched — rotations, chain changes, and when the
      // bearer in hand was first seen. Published on BOTH sides of the bound: while it is
      // still carrying, so a reader can watch the distance grow, and after it has run out,
      // so "unverified" says which kind of unverified it is (S-4).
      ...(v.carry ? { carry: { rotations: v.carry.rotations, chains: v.carry.chains, since: new Date(v.carry.since).toISOString() } } : {}),
      ...(unproven ? { unproven: true } : {}),
      ...(unverified ? { unverified: true } : {}),
      detail: rejected ? `${p.detail} · LAST CALL REJECTED (${v.detail})`
            : unproven ? `${p.detail} · UNPROVEN — credential replaced after a rejection (${v.prior!.detail}); no call has succeeded since`
            : staleV ? `${p.detail} · UNVERIFIED (stale) — the last real call is older than the outcome TTL, so it proves nothing now (it was ${v.prior?.verdict ?? "unknown"})`
            : v.state === "unverified" && v.reason === "unfingerprinted" ? `${p.detail} · UNVERIFIED — the stored verdict predates the credential fingerprint, so it cannot be attributed to this bearer and is not evidence; one real call rewrites it`
            : v.state === "unverified" && v.reason === "unanchored" ? `${p.detail} · UNVERIFIED — the stored verdict was earned on a bearer this server has never read out of the credential well, so it cannot be carried to the one in hand; one real call rewrites it`
            : v.state === "unverified" && v.carry ? `${p.detail} · UNVERIFIED — the last accepted call has been carried across ${v.carry.rotations} bearer${v.carry.rotations === 1 ? "" : "s"}${v.carry.chains ? ` and ${v.carry.chains} credential rotation${v.carry.chains === 1 ? "" : "s"}` : ""} and is now too far from it to count; one real call re-proves it`
            : unverified ? `${p.detail} · UNVERIFIED — ${v.reason === "credential-changed" ? "the credential changed since the last verdict" : "no call has ever exercised this credential"}`
            : v.state === "ok" && v.carried === "rotated" ? `${p.detail} · last call ACCEPTED before this credential was rotated (a new refresh token); re-proven by the next real call`
            : v.state === "ok" && v.carried === "refreshed" ? `${p.detail} · last call ACCEPTED on this credential (bearer rotated since)`
            : p.detail,
      ...(fix ? { fix } : {}),
    };
  });
  const live = providers.filter((p) => p.connected).length;
  const unprovenN = providers.filter((p: any) => p.unproven).length;
  const unverifiedN = providers.filter((p: any) => p.unverified).length;
  return json({
    // Green requires an observed SUCCESS on the credential in hand — never merely a new
    // credential, never merely an unexpired one, and never the mere passage of time. A
    // provider that was refreshed after a rejection, one nothing has ever called, and one
    // whose last proof has aged out all read ok=false until a real call proves them.
    ok: live === providers.length && unprovenN === 0 && unverifiedN === 0,
    status: live === 0 ? "down" : live < providers.length ? "degraded"
          : unprovenN ? "unproven" : unverifiedN ? "unverified" : "ok",
    service: "apiplan",
    // +1 for chatjimmy, which is not in the registry but is served — health must not
    // report a different number than /v1/models actually lists.
    models: registry.length + 1,
    dialects: ["openai", "anthropic"],
    providers,
  });
}

/** Both vendors serve GET /v1/models; the shapes differ, so answer by dialect. */
function listModels(dialect: "openai" | "anthropic"): Response {
  const all = [...models(), { id: JIMMY_MODEL, label: `${JIMMY_MODEL} on chatjimmy.ai`, provider: "jimmy" } as any];
  if (dialect === "anthropic") {
    return json({ data: all.map((m) => ({ type: "model", id: m.id, display_name: m.label, created_at: new Date(0).toISOString() })), has_more: false, first_id: all[0]?.id ?? null, last_id: all.at(-1)?.id ?? null });
  }
  return json({ object: "list", data: all.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.provider })) });
}

async function speech(body: any): Promise<Response> {
  const text = body?.input;
  if (typeof text !== "string" || !text) throw new HttpError(400, "`input` is required");
  const voice = typeof body?.voice === "string" ? body.voice : "alloy";
  // `instructions` is OpenAI's own field for steering delivery — same idea as `tts --as`.
  const direction = typeof body?.instructions === "string" ? body.instructions : undefined;
  const { bytes, contentType } = await speakRealtime(PROVIDERS.openai.creds(), { text, voice, format: "wav", direction });
  return new Response(bytes, { headers: { "content-type": contentType } });
}

async function images(body: any, signal?: AbortSignal): Promise<Response> {
  const prompt = body?.prompt;
  if (typeof prompt !== "string" || !prompt) throw new HttpError(400, "`prompt` is required");
  const requested = body?.model ? String(body.model) : "sol";
  const m = resolve(requested);
  if (!m) throw new HttpError(404, `no model '${requested}' is available`);
  const p = providerFor(m);
  if (!p.canGenerateImages) throw new HttpError(400, `${m.label} cannot generate images`);
  const o: CallOpts = { genImage: true, ...(body?.size ? { imageSize: body.size } : {}), ...(body?.quality ? { imageQuality: body.quality } : {}) };
  let b64 = "", revised = "";
  if (p.generateImage) {
    await p.prepare?.();
    const r = await p.generateImage(prompt, o, p.creds(), signal);
    b64 = r.base64;
    revised = r.revisedPrompt ?? "";
  } else {
    for await (const d of run(m, [{ role: "user", text: prompt }], o, signal)) {
      if (d.imageB64) b64 = d.imageB64;
      if (d.revisedPrompt) revised = d.revisedPrompt;
    }
  }
  if (!b64) throw new HttpError(502, "the model returned no image");
  return json({ created: now(), data: [{ b64_json: b64, ...(revised ? { revised_prompt: revised } : {}) }] });
}

// ─────────────────────────── the server ───────────────────────────

const json = (v: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...extra } });

/** One controller per request: aborted either by the client hanging up (req.signal) or by
 *  the response stream being cancelled. Both must reach the upstream fetch. */
function linkAbort(signal?: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac;
}

/** Error bodies must match the dialect too, or the SDKs won't parse them. */
function errorFor(dialect: "openai" | "anthropic", status: number, message: string, upstream?: string): Response {
  // 401 must be labelled an AUTH failure in both dialects: SDKs retry api_error with
  // backoff (forever, on a dead token) and stop dead on authentication_error. When the
  // vendor named the fault itself, that name outranks anything derived from the status.
  const known = upstream && ANTHROPIC_ERROR_TYPES.has(upstream) ? upstream : undefined;
  // `x-should-retry: false` is the header both vendors' SDKs honour ahead of their own
  // status rules, so a fault this server has already decided is terminal says so in the
  // place a client looks first — belt to the 424's braces.
  const extra = status === TRUNCATED_TERMINAL_STATUS ? { "x-should-retry": "false" } : {};
  return dialect === "anthropic"
    ? json({ type: "error", error: { type: known ?? (status === 404 ? "not_found_error" : status === TRUNCATED_TERMINAL_STATUS ? "invalid_request_error" : status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status === 529 ? "overloaded_error" : "api_error"), message } }, status, extra)
    // OpenAI's own vocabulary: a 4xx the caller can fix is invalid_request_error, anything
    // upstream broke is a server_error — reporting THAT as invalid_request_error told every
    // client the request was malformed when the truth was "the far end fell over".
    : json({ error: { message, type: status === 401 ? "authentication_error" : status >= 500 ? "server_error" : "invalid_request_error", param: null, code: status === 401 ? "invalid_api_key" : (upstream ?? null) } }, status, extra);
}

export type ServeOpts = { port?: number; host?: string; token?: string; reusePort?: boolean };

export function serve(opts: ServeOpts = {}) {
  // R-1: this process has an EVENT LOOP and exactly one thread, so no credential may ever be
  // minted by blocking it — a slow OAuth endpoint would become this service's latency for
  // every caller, /health included (measured at 5.30 s, round four). Providers refresh
  // through prepare() + a background single-flight instead. The CLI leaves this alone.
  providerRuntime.syncRefresh = false;
  // F9-2: the same law for the PLAIN credential reads R-1 left behind. `security` is a
  // spawnSync and there are several per /health, so ten parallel checks served a perfect
  // staircase. Filling every snapshot HERE — before Bun.serve() is listening — is what
  // makes the one unavoidable blocking read of each well happen while nobody is queued
  // behind it; every later read is served from memory and refreshed in the background.
  warmCreds();
  // Kick the local-library registration on the way up, so the first caller usually finds it
  // already done (the handler awaits the same promise, so a race cannot serve a cold list).
  ensureOllama();
  const port = opts.port ?? Number(process.env.APIPLAN_API_PORT ?? 8787);
  // Bind loopback by default: this hands out your subscription to whoever can reach it.
  const hostname = opts.host ?? process.env.APIPLAN_API_HOST ?? "127.0.0.1";
  const token = opts.token ?? process.env.APIPLAN_API_KEY;
  const cachePolicy = "cached" as const;
  const startedAt = Date.now();
  let accepting = true;
  let activeRequests = 0;
  let completedRequests = 0;
  let drainingSince = 0;

  const control = () => ({
    pid: process.pid,
    cachePolicy,
    port,
    hostname,
    accepting,
    activeRequests,
    completedRequests,
    draining: !accepting,
    drainingSince: drainingSince || null,
    startedAt,
  });


  const server = Bun.serve({
    port, hostname, reusePort: opts.reusePort ?? false,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const dialect: "openai" | "anthropic" = path.includes("/messages") || req.headers.has("x-api-key") ? "anthropic" : "openai";
      if (req.method === "GET" && path === "/_apiplan/control") return json(control());
      if (req.method === "POST" && path === "/_apiplan/drain") {
        if (!accepting) return json(control());
        accepting = false;
        drainingSince = Date.now();
        return json(control());
      }
      if (!accepting) return errorFor(dialect, 503, "APIPlan instance is draining; retry on the active instance");
      activeRequests++;
      try {
        // Register whatever the local daemon holds before anything reads the registry —
        // /v1/models, /health and every call resolve against the same live truth.
        await ensureOllama();
        // A token is optional (it is loopback), but when set it is enforced on both the
        // OpenAI and the Anthropic auth headers, since callers use whichever they know.
        if (token) {
          const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
          if (bearer !== token && req.headers.get("x-api-key") !== token) throw new HttpError(401, "invalid api key");
        }
        if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return listModels(dialect);
        if (req.method === "GET" && (path === "/health" || path === "/")) return health();
        if (req.method !== "POST") throw new HttpError(405, `${req.method} ${path} is not supported`);

        let body: any;
        try { body = await req.json(); } catch { throw new HttpError(400, "body must be JSON") }
        // A name we cannot resolve may be a model pulled since this process started; ask the
        // daemon once more before telling the caller it does not exist.
        if (typeof body?.model === "string" && body.model && !isJimmy(body.model) && !resolve(body.model)) await ensureOllama(true);
        switch (path) {
          case "/v1/chat/completions": case "/chat/completions": return await openaiChat(body, req.signal);
          case "/v1/messages": case "/messages": return await anthropicMessages(body, req.signal);
          case "/v1/messages/count_tokens": case "/messages/count_tokens": return countTokens(body);
          case "/v1/audio/speech": case "/audio/speech": return await speech(body);
          case "/v1/images/generations": case "/images/generations": return await images(body, req.signal);
          default: throw new HttpError(404, `no route for POST ${path}`);
        }
      } catch (e: any) {
        const status = e instanceof HttpError ? e.status : 500;
        return errorFor(dialect, status, e?.message ?? String(e), e instanceof HttpError ? e.upstreamType : undefined);
      } finally {
        activeRequests--;
        completedRequests++;
      }
    },
  });
  // server.port, not the requested one: port 0 means "any free port", and only the
  // server knows which it got.
  return { url: `http://${hostname}:${server.port}`, port: server.port, hostname, tokenRequired: !!token, control, stop: () => server.stop(true) };
}
