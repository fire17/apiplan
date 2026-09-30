// providers-gemini.ts — the API-KEY vendor: Google's public Generative Language API.
//
// WHY A SECOND GOOGLE. `google` (providers.ts) is the Antigravity / Gemini Code Assist
// SUBSCRIPTION: an OAuth token minted by `agy`, a `v1internal:streamGenerateContent`
// endpoint whose body wraps the request in `{ model, project, request }`, an effort baked
// into the WIRE ID, and a catalog of whatever that subscription entitles. This provider is
// the same vendor reached the other way — an API key, the documented public endpoint
// `v1beta/models/{model}:streamGenerateContent`, `thinkingLevel` as a real request field,
// and the whole published model list. They are not two configurations of one thing:
//   · different credential (Keychain OAuth vs a key file), so probe/creds/credFp differ,
//   · different URL and body envelope, so build() differs,
//   · different catalog, so the registry entries differ,
//   · and only THIS one can address a cache: the subscription endpoint exposes no
//     `cachedContents` collection, while the public API does.
// So it is its own ProviderId, exactly as `ollama` is, and the subscription path is left
// untouched — a machine with a stale `agy` login still serves gemini through the key, and
// a machine with no key still serves it through the subscription.
//
// WHAT CACHING ACTUALLY IS HERE (measured 2026-09-06 against the live API, not assumed):
//   IMPLICIT   on by default for 2.5 and newer. A prefix that matches a recent request and
//              clears the model's floor (2,048 for 2.5, 4,096 for 3.x) comes back as
//              `usageMetadata.cachedContentTokenCount`. No field to send, no guarantee.
//   EXPLICIT   POST /v1beta/cachedContents uploads the stable prefix as a NAMED server-side
//              object; later requests reference it by name in `cachedContent`. Verified end
//              to end below: create 200 → `usageMetadata.totalTokenCount: 3155`, the next
//              generateContent reported `promptTokenCount 3163 / cachedContentTokenCount
//              3155`, i.e. 8 uncached tokens of fresh question on top of a 3,155-token
//              cached prefix. That is the only mechanism a client can DRIVE, so it is the
//              one this provider's contract declares — and, unlike the subscription
//              provider, this one actually drives it.
// The explicit path is OPT-IN (APIPLAN_GEMINI_EXPLICIT_CACHE=1) because it is not free:
// storage is billed per token-hour whether or not the entry is ever read again, so turning
// it on for every caller would spend money on prefixes that are used once.
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { GEMINI_EFFORTS, GEMINI_EFFORTS_MINIMAL, geminiWireId, saveModels } from "./registry.ts";
import type { Model } from "./registry.ts";
// The proto helpers come from the LEAF, never from providers.ts: that file imports THIS
// one to put `gemini` in PROVIDERS, so importing it back is a temporal-dead-zone crash at
// import time. See the header of gemini-wire.ts.
import { geminiSchema, rememberToolSig, recallToolSig, toGeminiContent } from "./gemini-wire.ts";
import type { CallOpts, CredFp, Creds, Delta, Provider, Turn } from "./providers.ts";
import { geminiApiKey, geminiApiKeyFile, geminiApiKeySource } from "./gemini-media.ts";
import type { StreamShape } from "./stream-shape.ts";

const env = (k: string, d: string) => (process.env[k]?.length ? process.env[k]! : d);
export const GEMINI_BASE = () => env("APIPLAN_GEMINI_API_BASE", "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
const API_VERSION = () => env("APIPLAN_GEMINI_API_VERSION", "v1beta");

/**
 * The thinking levels this vendor documents, per model family.
 *
 * TWO INCOMPATIBLE FIELDS, and sending the wrong one is a 400 rather than a silent
 * downgrade — measured on the live API 2026-09-06:
 *   gemini-2.5-flash + { thinkingLevel: "LOW" }   → 400 "Thinking level is not supported
 *                                                   for this model."
 *   gemini-2.5-flash + { thinkingBudget: 512 }    → 200, usageMetadata.thoughtsTokenCount 25
 *   gemini-3.8-flash + { thinkingLevel: "LOW" }   → 200
 * So 3.x takes `thinkingLevel` (an enum) and 2.5 takes `thinkingBudget` (a token count).
 * The docs' own table (ai.google.dev/gemini-api/docs/thinking, "Controlling thinking")
 * lists levels for both families, which is why this had to be measured: the 2.5 rows are
 * the Interactions API's spelling, not generateContent's.
 */
/**
 * 2.5 has no level enum, so an effort becomes a BUDGET. These are this gateway's own
 * mapping of the level names onto token counts — the vendor publishes no per-level budget
 * for generateContent, so nothing here is presented as documented. They are only ever a
 * CEILING: dynamic thinking spends less when the question is easy (the 512-budget probe
 * above spent 25 thought tokens, not 512).
 */
const GEMINI_25_BUDGET: Record<string, number> = { minimal: 0, low: 512, medium: 4096, high: 16384 };
/**
 * Does this model take a BUDGET rather than a LEVEL? Read from the registry id, which is
 * route-marked (`gemini-key-2.5-flash`), so the version is matched after the marker rather
 * than at the start of the string.
 */
const isTwoFive = (id: string) => /^gemini-key-2\.5-/.test(id);

// ── the credential ────────────────────────────────────────────────────────────
/**
 * probe() is synchronous by contract (status, models and doctor all call it inline) and
 * must never throw. It reports the key's PRESENCE and its file mode, never a single byte
 * of the key: a status line is printed to terminals, pasted into issues and captured in
 * receipts, so the one thing it may not contain is the secret.
 */
function probeKey(): { connected: boolean; detail: string; loginHint: string } {
  const src = geminiApiKeySource();
  if (src.kind === "absent") return {
    connected: false,
    detail: `no Gemini API key (looked at $APIPLAN_GEMINI_API_KEY, $GEMINI_API_KEY and ${src.file})`,
    loginHint: `create a key at aistudio.google.com/apikey and write it to ${src.file} (chmod 600)`,
  };
  if (src.kind === "env") return { connected: true, detail: `key from $${src.name} (${src.fingerprint})`, loginHint: "" };
  // A key file the whole machine can read is a real finding, and the only actionable one
  // this probe can make: the key itself is either there or not.
  let mode = "";
  try { mode = (statSync(src.file).mode & 0o777).toString(8).padStart(3, "0"); } catch {}
  const loose = mode !== "" && (parseInt(mode, 8) & 0o077) !== 0;
  return {
    connected: true,
    detail: `key from ${src.file}${mode ? ` (mode ${mode}${loose ? " — group/world readable" : ""})` : ""} (${src.fingerprint})`,
    loginHint: loose ? `tighten it: chmod 600 ${src.file}` : "",
  };
}

// ── message shaping ───────────────────────────────────────────────────────────
// A Turn → a Gemini `Content` is `toGeminiContent` in the LEAF, shared with the
// subscription route: the mapping (assistant→model, a tool result named by the FUNCTION
// rather than the call id, images inline as base64, thought signatures echoed back) is the
// vendor's proto, not this route's choice. Same for the `Schema` pruner and the signature
// store. See gemini-wire.ts for why they live there and not in either adapter.

/** A ToolDef → the vendor's `FunctionDeclaration`, with the schema pruned to the proto. */
const toFunctionDeclaration = (t: { name: string; description?: string; parameters?: unknown }) => {
  const params = geminiSchema(t.parameters);
  return { name: t.name, description: t.description ?? "", ...(params ? { parameters: params } : {}) };
};

/** The `tools` array as the wire wants it: ONE entry holding every declaration. */
function toolsBlock(o: CallOpts): { tools?: unknown[]; toolConfig?: unknown } {
  if (!o.tools?.length) return {};
  const tools = [{ functionDeclarations: o.tools.map(toFunctionDeclaration) }];
  if (!o.toolChoice) return { tools };
  const mode = o.toolChoice === "none" ? "NONE" : o.toolChoice === "auto" ? "AUTO" : "ANY";
  return { tools, toolConfig: { functionCallingConfig: {
    mode,
    ...(typeof o.toolChoice === "object" ? { allowedFunctionNames: [o.toolChoice.name] } : {}),
  } } };
}

/** The thinking field this model accepts, at this effort. See GEMINI_EFFORTS. */
function thinkingConfig(m: Model, o: CallOpts): Record<string, unknown> | undefined {
  if (o.thinkOff) return isTwoFive(m.id) ? { thinkingBudget: 0 } : { thinkingLevel: "MINIMAL" };
  const advertised = m.efforts ?? GEMINI_EFFORTS;
  if (!o.effort || !advertised.includes(o.effort)) return undefined;   // let dynamic thinking decide
  if (isTwoFive(m.id)) {
    const budget = GEMINI_25_BUDGET[o.effort];
    return budget === undefined ? undefined : { thinkingBudget: budget };
  }
  return { thinkingLevel: o.effort.toUpperCase() };
}

/**
 * The system prompt, in the field the vendor reads.
 *
 * `systemBlocks` is deliberately NOT used: it is the caller's Anthropic block array with
 * its `cache_control` markers, and this vendor has no per-block marker to map them onto —
 * its cache is a whole named object. Flattening to `system` loses nothing HERE that the
 * vendor could have honoured.
 */
const systemInstruction = (o: CallOpts) => (o.system ? { role: "user", parts: [{ text: o.system }] } : undefined);

// ── the explicit cache ────────────────────────────────────────────────────────
/**
 * WHY AN OPT-IN, AND WHY IN-PROCESS.
 *
 * A CachedContent is billed for STORAGE by the token-hour ($0.50/1M/h through 2026-12-31 on
 * the Flash models, $4.50 on 3.1 Pro) whether or not it is ever read again. Creating one
 * for every request that happens to carry a big system prompt would therefore spend real
 * money on prefixes used once — and the implicit cache already covers the repeated case for
 * free. So the named resource is created only when an operator asks for it
 * (APIPLAN_GEMINI_EXPLICIT_CACHE=1), and only when the stable prefix is big enough to be
 * worth an extra round trip.
 *
 * The map is PROCESS-LOCAL on purpose: the entry it names has a TTL, so persisting it to
 * disk would hand a later process a name that has since expired — and this vendor answers
 * an expired name with 403 PERMISSION_DENIED (measured; see refresh()), which is
 * indistinguishable from a key problem. A process that restarts simply creates its own.
 */
const EXPLICIT_ON = () => env("APIPLAN_GEMINI_EXPLICIT_CACHE", "") === "1";
/** Default lifetime asked for at create time. The vendor documents NO default of its own,
 *  so one is stated here rather than left to the server's unstated choice. */
const EXPLICIT_TTL_S = () => Math.max(1, Number(env("APIPLAN_GEMINI_EXPLICIT_CACHE_TTL", "300")) || 300);
/**
 * The floor, in CHARACTERS of the stable prefix, below which no resource is created.
 * Characters, not tokens: counting tokens exactly costs a `countTokens` round trip per
 * request, and this is a spend gate rather than a correctness gate. ~4 chars/token is the
 * same crude figure api.ts already uses for its estimates, so the default 8,192 is about
 * 2,048 tokens — the documented implicit floor for the 2.5 models, i.e. the point below
 * which this vendor caches nothing at all by any mechanism.
 */
const EXPLICIT_MIN_CHARS = () => Number(env("APIPLAN_GEMINI_EXPLICIT_CACHE_MIN_CHARS", "8192")) || 8192;

type CacheEntry = {
  /** "cachedContents/abc123" — the name the request references. */
  name: string;
  /** The model it was pinned to. A mismatch is a 400, so it is keyed and checked. */
  model: string;
  /**
   * usageMetadata.totalTokenCount from the CREATE response: the tokens that were WRITTEN.
   *
   * Recorded here but NEVER folded into a request's usage, and that is a correctness point
   * rather than a preference. The create is a SEPARATE call with its own billing; the
   * generateContent response that follows reports `promptTokenCount` INCLUSIVE of the
   * cached prefix, so normalizeTally() subtracts cacheRead from it exactly once. Adding
   * this number as `cacheWrite` on the same turn would make it subtract twice — the same
   * prefix counted as both read and written — and the partition either goes negative or
   * trips the source-inconsistent guard. Measured: a 10,000-token prompt with an 8,000
   * cached read plus an 8,000 "write" reads as 10,000 < 16,000 and is refused outright.
   *
   * So it is exposed for a caller that wants to ACCOUNT for the write (a receipt, a cost
   * report) rather than published as part of the turn that referenced it. Google also
   * charges nothing per written token — explicit caching bills by storage, per token-hour
   * — so there is no per-token write cost for a usage field to carry in the first place.
   */
  writeTokens?: number;
  /** When the vendor said it expires, if it said. Used only to avoid an obviously-dead
   *  reference; the authority is still the 403 the server answers. */
  expiresAt?: number;
};
const CACHES = new Map<string, CacheEntry>();

/**
 * The identity of a reusable prefix: the model it is pinned to, plus the exact bytes of
 * everything that is supposed to be STABLE across turns — the system instruction and the
 * tool declarations. The conversation itself is excluded because it grows every turn, and
 * a key that changes every turn names a cache that is never hit.
 *
 * sha256 of the bytes, not a structural comparison: two prefixes that serialise
 * identically ARE the same prefix to the vendor, and one that differs by a byte is a
 * different one — that is precisely the vendor's own matching rule.
 */
function prefixKey(model: string, system: unknown, tools: unknown): string {
  const h = createHash("sha256");
  h.update(model); h.update("\0");
  h.update(JSON.stringify(system ?? null)); h.update("\0");
  h.update(JSON.stringify(tools ?? null));
  return h.digest("hex");
}

const cacheHeaders = (key: string) => ({ "content-type": "application/json", "x-goog-api-key": key });

/** Duration/timestamp → ms, for the two shapes the vendor answers with ("300s", ISO). */
function expiryOf(body: Record<string, unknown>): number | undefined {
  const exp = body.expireTime;
  if (typeof exp === "string") { const t = Date.parse(exp); if (!Number.isNaN(t)) return t; }
  const ttl = body.ttl;
  if (typeof ttl === "string") { const s = Number(ttl.replace(/s$/, "")); if (Number.isFinite(s)) return Date.now() + s * 1000; }
  return undefined;
}

/** The one field a create response must carry, read without trusting the shape. */
function readCreated(body: unknown): { name: string; writeTokens?: number; expiresAt?: number } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || !b.name) return null;
  const um = b.usageMetadata;
  const total = um && typeof um === "object" ? (um as Record<string, unknown>).totalTokenCount : undefined;
  return {
    name: b.name,
    ...(typeof total === "number" ? { writeTokens: total } : {}),
    ...(expiryOf(b) !== undefined ? { expiresAt: expiryOf(b) } : {}),
  };
}

/**
 * Create the named resource for this prefix, or return the one already created.
 *
 * `model` is the REGISTRY id (route-marked) for keying, and goes on the wire as
 * "models/<wireId>". Both halves matter: the create response echoes the wire spelling, and
 * the mismatch error quotes both sides in it — "Model used by GenerateContent request
 * (models/gemini-3.8-flash) and CachedContent (models/gemini-2.5-flash) has to be the
 * same." (measured 2026-09-06). So the model is part of the key, and a second model asking
 * for the same prefix gets its OWN entry rather than that 400.
 *
 * Never throws: an operator opting into a cost optimisation must not thereby make requests
 * fail. A create that is refused (a free-tier key — "Access to Context caching" is a paid
 * feature — a quota, a network fault) leaves the caller on the implicit path, which is
 * what it would have had anyway.
 */
export async function ensureCache(
  key: string, model: string, system: unknown, tools: unknown, contents: unknown[], signal?: AbortSignal,
): Promise<CacheEntry | null> {
  const id = prefixKey(model, system, tools);
  const have = CACHES.get(id);
  if (have && (have.expiresAt === undefined || have.expiresAt > Date.now())) return have;
  if (have) CACHES.delete(id);
  const res = await fetch(`${GEMINI_BASE()}/${API_VERSION()}/cachedContents`, {
    method: "POST", headers: cacheHeaders(key),
    body: JSON.stringify({
      model: `models/${geminiWireId(model)}`,
      ...(system ? { systemInstruction: system } : {}),
      ...(tools ? { tools } : {}),
      contents,
      ttl: `${EXPLICIT_TTL_S()}s`,
      displayName: "apiplan-prefix",
    }),
    ...(signal ? { signal } : {}),
  }).catch(() => null);
  if (!res?.ok) return null;
  const created = readCreated(await res.json().catch(() => null));
  if (!created) return null;
  const entry: CacheEntry = { ...created, model };
  CACHES.set(id, entry);
  return entry;
}

/**
 * Drop every entry pinned to this MODEL, so the next request mints a fresh one.
 *
 * BY MODEL RATHER THAN BY PREFIX, and that is forced by the recovery hook's signature
 * (`recover(status, body, m)`) — which is correct, not a limitation. By the time an
 * upstream refusal is being handled, the request's CallOpts are gone, so the exact
 * prefix key cannot be recomputed. Keying the eviction on the model is nonetheless
 * PRECISE ENOUGH and strictly safe:
 *   · the model is part of every prefix key, so nothing belonging to another model is
 *     touched;
 *   · over-eviction costs at most one extra create for a prefix that was still alive,
 *     while under-eviction leaves a dead name referenced on every subsequent request —
 *     the poisoning this exists to end. The asymmetry decides it.
 * A wider signature carrying CallOpts was offered and declined for exactly this reason:
 * the narrow hook is honest about what it can know, and this is a correct repair with it.
 *
 * TWO STATUSES MEAN "GONE", and both were measured rather than guessed:
 *   403 PERMISSION_DENIED  "CachedContent not found (or permission denied)" — this is what
 *                          an EXPIRED or deleted name answers. NOT 404, which is what the
 *                          REST reference would lead a reader to expect; recovery keyed on
 *                          404 alone would never fire at all.
 *   400 INVALID_ARGUMENT   "…has to be the same." — the entry exists but is pinned to
 *                          another model. Recreating under this model's key is the fix.
 *
 * Answers how many entries were forgotten, so a test can tell a real eviction from a no-op.
 */
export function forgetCachesFor(model: string): number {
  let n = 0;
  for (const [key, entry] of CACHES) if (entry.model === model) { CACHES.delete(key); n += 1; }
  return n;
}
/** Does this refusal mean the referenced entry is gone? See forgetCachesFor. */
export const cacheGone = (status: number, body: string) =>
  status === 403 ? /CachedContent not found/i.test(body)
  : status === 400 ? /has to be the same/i.test(body)
  : false;

/** Test seam: the explicit-cache map is process-local, so a test must be able to clear it. */
export function resetGeminiCaches() { CACHES.clear(); }

/**
 * Arm the create for this prefix in the BACKGROUND, so a synchronous build() can benefit
 * from a cache it is not allowed to create.
 *
 * SINGLE-FLIGHT, because build() runs on every turn and the whole point of a named cache is
 * that many turns share one prefix: without this, ten requests arriving before the first
 * create returns would mint ten resources, and every one of them is billed for storage by
 * the token-hour until it expires. A key already in flight is left alone.
 *
 * FAILURE IS SILENT AND NOT RETRIED IMMEDIATELY. A create can be refused for reasons that
 * will not change on the next turn — a free-tier key ("Access to Context caching" is a paid
 * feature), a spent quota, an unreachable endpoint. Retrying it per request would add a
 * doomed round trip to every single call, so a failure is remembered for a cooldown and the
 * caller stays on the vendor's free implicit cache, which is what it had anyway. Nothing
 * here can throw into a build: an operator opting into a cost optimisation must never
 * thereby make requests fail.
 */
const armed = new Set<string>();
let armFailAt = 0;
const ARM_COOLDOWN_MS = () => Number(env("APIPLAN_GEMINI_EXPLICIT_CACHE_COOLDOWN_MS", "60000")) || 60_000;
function armCache(key: string, token: string, model: string, system: unknown, tools: unknown): void {
  if (!system && !tools) return;                       // nothing stable to cache
  if (armed.has(key)) return;                          // already in flight
  if (Date.now() - armFailAt < ARM_COOLDOWN_MS()) return;
  // The spend gate, in CHARACTERS of the stable prefix. Characters rather than tokens
  // because counting tokens exactly costs a `countTokens` round trip per request, and this
  // is a spend gate rather than a correctness gate: ~4 chars/token is the same crude figure
  // api.ts already uses for its estimates, so the default 8,192 is about 2,048 tokens — the
  // documented implicit floor for the 2.5 models, i.e. the point below which this vendor
  // caches nothing at all by any mechanism.
  const bytes = JSON.stringify(system ?? "").length + JSON.stringify(tools ?? "").length;
  if (bytes < EXPLICIT_MIN_CHARS()) return;
  armed.add(key);
  // "Cannot cache only part of a conversation" — the entry holds the stable prefix plus one
  // minimal turn, because `contents` may not be empty. The live conversation rides in the
  // request beside the reference.
  const seed = [{ role: "user", parts: [{ text: " " }] }];
  void ensureCache(token, model, system, tools, seed)
    .then((entry) => { if (!entry) armFailAt = Date.now(); })
    .catch(() => { armFailAt = Date.now(); })
    .finally(() => { armed.delete(key); });
}

/**
 * Create the entry for this prefix and WAIT for it — the same work armCache() does in the
 * background, for a caller that would rather pay one round trip now than miss the cache on
 * this turn (a benchmark, a receipt, a batch whose first request is also its largest).
 * Never throws; answers what it did, so a caller can record it honestly.
 */
export async function prepareGeminiCache(
  m: Model, o: CallOpts, c: Creds, signal?: AbortSignal,
): Promise<{ name?: string; writeTokens?: number }> {
  if (!EXPLICIT_ON()) return {};
  const { tools } = toolsBlock(o);
  const system = systemInstruction(o);
  if (!system && !tools) return {};
  const bytes = JSON.stringify(system ?? "").length + JSON.stringify(tools ?? "").length;
  if (bytes < EXPLICIT_MIN_CHARS()) return {};
  const seed = [{ role: "user", parts: [{ text: " " }] }];
  const entry = await ensureCache(c.token, m.id, system, tools, seed, signal).catch(() => null);
  if (!entry) return {};
  return { name: entry.name, ...(entry.writeTokens !== undefined ? { writeTokens: entry.writeTokens } : {}) };
}

// ── stream events ─────────────────────────────────────────────────────────────
/** Finish reasons that mean "nothing was generated, and here is why". */
const BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "MALFORMED_FUNCTION_CALL"]);

/** The vendor's error `status` → the Anthropic error vocabulary a client keys retries on. */
function errType(status: unknown, code: unknown): { errorType?: string } {
  const s = typeof status === "string" ? status : "";
  if (s === "RESOURCE_EXHAUSTED" || code === 429) return { errorType: "rate_limit_error" };
  if (s === "UNAUTHENTICATED" || code === 401) return { errorType: "authentication_error" };
  if (s === "PERMISSION_DENIED" || code === 403) return { errorType: "permission_error" };
  if (s === "INVALID_ARGUMENT" || code === 400) return { errorType: "invalid_request_error" };
  if (s === "NOT_FOUND" || code === 404) return { errorType: "not_found_error" };
  if (s === "UNAVAILABLE" || code === 503) return { errorType: "overloaded_error" };
  if (s === "DEADLINE_EXCEEDED" || code === 504) return { errorType: "timeout_error" };
  return {};
}

/**
 * usageMetadata → the gateway's three buckets.
 *
 * INCLUSIVE, so this maps and does NOT subtract. `promptTokenCount` is the whole prompt
 * with `cachedContentTokenCount` as a breakdown of it — measured on the live API: a
 * request against a 3,155-token cached prefix reported promptTokenCount 3163 and
 * cachedContentTokenCount 3155, i.e. the 8 fresh tokens were 3163 − 3155, not 3163. The
 * single conversion lives in api.ts's normalizeTally(), which reads this provider's
 * `usageBasis` and subtracts the cached share exactly once; subtracting here as well would
 * drive the uncached remainder negative.
 *
 * `thoughtsTokenCount` is folded INTO output, because that is how it is BILLED ("response
 * pricing is the sum of output tokens and thinking tokens" — docs/thinking, Pricing) and
 * because `candidatesTokenCount` does NOT contain it: the vendor's own totalTokenCount
 * identity is "prompt + thoughts + response candidates" (api/generate-content), three
 * addends, and it was measured — candidatesTokenCount 1 beside thoughtsTokenCount 25 for a
 * totalTokenCount of 29. Publishing output without it under-reports the billed output on
 * every thinking turn. The same number is ALSO reported as `usage.reasoning`, whose
 * contract is "the reasoning share OF output, already contained in it" — so a consumer
 * gets one vendor-independent invariant (reasoning <= output, never added to anything)
 * instead of having to know that OpenAI's reasoning_tokens is already inside its output
 * while Google's is not.
 *
 * cacheWrite is NOT read here, and that is the vendor stating no counter rather than a
 * dropped field — confirmed by positive control, not assumed: this lane's live captures
 * show every other usageMetadata field the vendor sends (including the two per-modality
 * detail arrays), and no write counter appears on ANY generateContent response, cached or
 * uncached. The only write that ever happens is the `cachedContents` create, whose own
 * `usageMetadata.totalTokenCount` states it (measured: 3695). That number is recorded on
 * the cache entry for accounting and never published as this turn's cacheWrite — see the
 * `writeTokens` doc on CacheEntry for why adding it here would make normalizeTally()
 * subtract the same prefix twice.
 *
 * DELIBERATELY NOT MAPPED. Each reason is a DESIGN decision about a field the vendor does
 * send, never a claim that the vendor does not send it — the distinction matters because
 * "never observed" is a claim about the OBSERVER, and a capture that could not have shown
 * the field would guarantee the absence a priori. Checked against this lane's own live
 * captures (.deify/gemini/receipt.json), which really do carry `promptTokensDetails`,
 * `cacheTokensDetails` and `serviceTier`, so the first three below are observed-and-dropped
 * rather than assumed-absent:
 *   · promptTokensDetails / cacheTokensDetails — OBSERVED live. Per-MODALITY breakdowns
 *     ([{ modality: "TEXT", tokenCount: 3697 }]). Dropped because neither caller dialect
 *     has a field for them and they sub-divide numbers already published in full — not
 *     because they are missing.
 *   · serviceTier — OBSERVED live ("standard"). A billing tier, not a token count.
 *   · toolUsePromptTokenCount — NOT observed here, and this lane's live calls sent no
 *     tools, so its absence is a property of the probe and says nothing about the vendor.
 *     It stays unmapped on the DOCUMENTED ground instead: its containment relative to
 *     `promptTokenCount` is documented nowhere and the totalTokenCount identity omits it,
 *     so folding it into input could double-count and subtracting could go negative. An
 *     unknown containment stays unmapped — which is the same reason either way, but the
 *     evidence for it is the documentation, not this probe's silence.
 */
function usageOf(um: Record<string, unknown>): Delta["usage"] | undefined {
  const num = (k: string) => (typeof um[k] === "number" ? (um[k] as number) : undefined);
  const input = num("promptTokenCount");
  const cand = num("candidatesTokenCount");
  const thoughts = num("thoughtsTokenCount");
  const cached = num("cachedContentTokenCount");
  const output = cand === undefined && thoughts === undefined ? undefined : (cand ?? 0) + (thoughts ?? 0);
  if (input === undefined && output === undefined && cached === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(thoughts !== undefined ? { reasoning: thoughts } : {}),
    ...(cached !== undefined ? { cacheRead: cached } : {}),
  };
}

/** One SSE frame of a `streamGenerateContent?alt=sse` body → what it contributed. */
function frameDelta(ev: unknown): Delta {
  if (!ev || typeof ev !== "object") return {};
  const r = ev as Record<string, unknown>;
  if (r.error && typeof r.error === "object") {
    const e = r.error as Record<string, unknown>;
    return { error: typeof e.message === "string" ? e.message : "stream error", ...errType(e.status, e.code) };
  }
  const out: Delta = {};
  if (typeof r.modelVersion === "string") out.served = r.modelVersion;
  const candidates = Array.isArray(r.candidates) ? r.candidates : [];
  const cand = (candidates[0] ?? undefined) as Record<string, unknown> | undefined;
  const content = cand?.content as Record<string, unknown> | undefined;
  for (const raw of Array.isArray(content?.parts) ? content!.parts : []) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const fc = p.functionCall as Record<string, unknown> | undefined;
    if (fc && typeof fc.name === "string") {
      // A function call arrives WHOLE in one part — there is no fragment stream to
      // reassemble — so it is reported finished and the dialect layer numbers the block.
      out.toolCallDone = {
        name: fc.name,
        args: fc.args ?? {},
        ...(typeof p.thoughtSignature === "string" ? { sig: p.thoughtSignature } : {}),
      };
      continue;
    }
    if (typeof p.text !== "string" || !p.text) continue;   // signature-only parts print nothing
    if (p.thought) out.reasoning = (out.reasoning ?? "") + p.text;
    else out.text = (out.text ?? "") + p.text;
  }
  const um = r.usageMetadata;
  if (um && typeof um === "object") {
    const u = usageOf(um as Record<string, unknown>);
    if (u) out.usage = u;
  }
  const finish = typeof cand?.finishReason === "string" ? cand.finishReason : undefined;
  if (finish === "STOP" && out.toolCallDone) out.stopReason = "tool_use";
  else if (finish === "MAX_TOKENS") out.stopReason = "max_tokens";
  else if (finish === "STOP") out.stopReason = "end_turn";
  // A refusal arrives as a finish reason on an empty candidate, a prompt-level block as
  // promptFeedback. Both are reported as errors: the alternative is an empty answer and a
  // zero exit code, which a caller cannot tell from "the model had nothing to say".
  const feedback = r.promptFeedback as Record<string, unknown> | undefined;
  const block = typeof feedback?.blockReason === "string" ? feedback.blockReason : undefined;
  if (block && !out.text) out.error = `blocked before generating: ${block}`;
  else if (finish && BLOCKED.has(finish) && !out.text) out.error = `stopped: ${finish}`;
  return out;
}

export const gemini: Provider & StreamShape = {
  id: "gemini",
  label: "Google Gemini (API key)",
  /**
   * INCLUSIVE. The UsageMetadata reference states that `promptTokenCount` is "still the
   * total effective prompt size meaning this includes the number of tokens in the cached
   * content", with `cachedContentTokenCount` as the breakdown of it — and the live API
   * agrees: promptTokenCount 3163 against cachedContentTokenCount 3155 for a request whose
   * only fresh content was an 8-token question (measured 2026-09-06).
   */
  usageBasis: "inclusive",
  /**
   * A CACHED-CONTENT RESOURCE, and unlike the subscription provider this one DRIVES it:
   * build() sends `cachedContent` whenever an operator has opted in and a named entry
   * exists for the prefix, and delta() reads `cachedContentTokenCount` on every response
   * (which also reports the vendor's free IMPLICIT hits, for which there is no field to
   * send). The named object is the only mechanism a client can address, so it is the one
   * this contract declares.
   *
   * minTokens 2,048 — the documented floor for Gemini 2.5 Flash and 2.5 Pro, the LOWEST
   * across the family; every 3.x model requires 4,096
   * (ai.google.dev/gemini-api/docs/caching, "Min token limit"). Necessary, not sufficient:
   * below it nothing caches at all, above it the threshold is per-model.
   *
   * ttlMs is ABSENT ON PURPOSE. Google documents no implicit-cache lifetime — only the
   * advice to "send requests with similar prefix in a short amount of time" — and states
   * no default TTL for a CachedContent either (its `ttl` is set per resource, which is why
   * this provider sends one explicitly). An undocumented number here would read as a
   * measured one.
   */
  cache: { kind: "cached-content-resource", minTokens: 2048, identity: "cachedContent" },
  probe: probeKey,
  creds() {
    // geminiApiKey() throws with the fix-it line when there is no key; that is the
    // contract, so it is not caught. A key file is a plain read with no expiry and no
    // refresh, which is why there is no prepare() and no refreshCreds() here.
    const key = geminiApiKey();
    const src = geminiApiKeySource();
    return { token: key, source: src.kind === "env" ? `$${src.name}` : src.file };
  },
  credFp(): CredFp {
    const src = geminiApiKeySource();
    if (src.kind === "absent") return { cred: "absent", ident: "absent", exp: 0 };
    // exp 0: an API key has no expiry. `ident` is a HASH PREFIX of the key, never the key
    // — this value reaches the capacity ledger on disk and every /health reader.
    return { cred: src.fingerprint, ident: src.fingerprint, exp: 0 };
  },
  efforts: (m) => m.efforts ?? GEMINI_EFFORTS,
  // Strict proto-JSON: an unknown body field is a 400, and the engine spreads `stream: true`
  // in AFTER build() returns, so the vendor fact has to be declared rather than handled.
  wantsStreamFlag: false,
  build(m, turns, o, c) {
    // Gemini names a function RESULT by the function's name while both caller dialects name
    // it by the call's id; the mapping exists only in the transcript, so it is rebuilt here.
    const nameOf = new Map<string, string>();
    for (const t of turns) for (const u of t.toolUses ?? []) if (u.id) nameOf.set(u.id, u.name);
    const { tools, toolConfig } = toolsBlock(o);
    const system = systemInstruction(o);
    const generationConfig: Record<string, unknown> = {};
    if (o.maxTokens) generationConfig.maxOutputTokens = o.maxTokens;
    if (o.temperature !== undefined) generationConfig.temperature = o.temperature;
    const thinking = thinkingConfig(m, o);
    if (thinking) generationConfig.thinkingConfig = thinking;

    // The named entry for this prefix, if one exists for this model.
    //
    // build() is SYNCHRONOUS by contract — every caller (the CLI, the chat, the server)
    // depends on that — and creating a CachedContent is a network call, so it cannot be
    // created HERE: a sync network call on a resident host blocks every other request.
    // Instead the create is ARMED in the background and this request goes out on the
    // implicit path; the entry is in hand for the NEXT request carrying the same prefix,
    // which is precisely the case the cache exists for (a one-off prefix is never worth a
    // stored object billed by the token-hour). Nothing is awaited and nothing can throw
    // into this build.
    const key = EXPLICIT_ON() ? prefixKey(m.id, system, tools) : "";
    const entry = key ? CACHES.get(key) : undefined;
    const live = entry && (entry.expiresAt === undefined || entry.expiresAt > Date.now()) ? entry : undefined;
    if (key && !live) armCache(key, c.token, m.id, system, tools);

    const body: Record<string, unknown> = { contents: turns.map((t) => toGeminiContent(t, nameOf)) };
    if (live) {
      // "System instructions and tools MUST be stored in the cache, not sent separately."
      // Sending either beside a `cachedContent` is a 400, so referencing the entry REPLACES
      // them — they are byte-identical to what the entry holds, which is what its key means.
      body.cachedContent = live.name;
    } else {
      if (system) body.systemInstruction = system;
      if (tools) body.tools = tools;
      if (toolConfig) body.toolConfig = toolConfig;
    }
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    // `promptCacheKey` has no counterpart here — this vendor exposes no routing key, and
    // inventing a body field would be a 400. What it CAN honour is ordering, and it already
    // does: the stable prefix (systemInstruction, then tools, then the transcript in order)
    // is emitted in the same positions on every turn, which is exactly the vendor's own
    // advice for an implicit hit ("put large and common contents at the beginning").
    return {
      // alt=sse frames the reply as `data:` lines; without it the method transcodes to one
      // JSON array, which an SSE reader sees as zero events.
      //
      // geminiWireId strips the registry's route marker: `gemini-key-3.8-flash` is how this
      // gateway names the API-key route (the subscription publishes the same vendor names —
      // see parseGemini), and the endpoint answers 404 for an id it does not publish.
      url: `${GEMINI_BASE()}/${API_VERSION()}/models/${geminiWireId(m.id)}:streamGenerateContent?alt=sse`,
      headers: { "content-type": "application/json", "x-goog-api-key": c.token },
      body,
    };
  },
  /** The turn is over the moment a candidate says why it stopped, or the prompt was
   *  refused outright (which arrives as promptFeedback with no candidate at all). */
  terminal(ev) {
    if (!ev || typeof ev !== "object") return false;
    const r = ev as Record<string, unknown>;
    const cand = (Array.isArray(r.candidates) ? r.candidates[0] : undefined) as Record<string, unknown> | undefined;
    const feedback = r.promptFeedback as Record<string, unknown> | undefined;
    return !!(cand?.finishReason || feedback?.blockReason);
  },
  delta(ev) {
    const d = frameDelta(ev);
    // The signature is kept as it arrives, in the store BOTH Google routes read. api.ts
    // also feeds that store from its own dialect layer (which mints the tool-call id a
    // client will echo), so only the case where the vendor itself named the call is
    // covered here; a miss costs one re-request of the signature, never a wrong answer.
    if (d.toolCallDone?.sig && d.toolCallDone.id) rememberToolSig(d.toolCallDone.id, d.toolCallDone.sig);
    return d;
  },
  /**
   * A referenced CachedContent that upstream says is GONE is repaired by forgetting it, so
   * the next request with that prefix mints a fresh entry instead of referencing a corpse.
   *
   * Without this, ONE eviction poisons every subsequent request carrying that prefix for
   * the life of the process: build() keeps finding the entry in the map, keeps sending its
   * name, and upstream keeps refusing. The hook takes the RAW body precisely because the
   * distinguishing text ("CachedContent not found (or permission denied)") is what the
   * vendor puts in `error.message` — matching a narrowed message would work here but the
   * model-mismatch 400 is recognised by its own sentence too, so both are read off the raw
   * text rather than a re-parse.
   *
   * There is no retry: the caller gets one honest refusal carrying the vendor's own words,
   * and the repair shows up as the NEXT request succeeding. That is deliberate — a retry
   * inside the error path is a control-flow change several other lanes' tests reason about,
   * and a silent retry would hide a cache that is failing to be created at all.
   */
  recover(status, body, m) {
    if (cacheGone(status, body)) forgetCachesFor(m.id);
  },
  explain(status, body) {
    let msg = body.slice(0, 200);
    let reason: string | undefined;
    try {
      const j: unknown = JSON.parse(body);
      const e = j && typeof j === "object" ? (j as Record<string, unknown>).error : undefined;
      if (e && typeof e === "object") {
        const err = e as Record<string, unknown>;
        if (typeof err.message === "string") msg = err.message;
        if (typeof err.status === "string") reason = err.status;
      }
    } catch {}
    if (status === 400 && /Unknown name "stream"/.test(msg))
      return "the body carried a `stream` flag — this endpoint is strict proto-JSON and has no such field. The provider sets wantsStreamFlag=false; the caller added it anyway.";
    if (status === 400 && /Thinking level is not supported/i.test(msg))
      return "this model takes `thinkingBudget` (a token count), not `thinkingLevel` (an enum) — the 2.5 family predates the level enum. The provider chooses per model id; a model id this registry does not recognise as 2.5 lands here.";
    if (status === 400 && /has to be the same/i.test(msg))
      return "the CachedContent was pinned to a DIFFERENT model — a cache entry is model-specific. The provider keys its entries by model and recreates on this fault, so seeing it twice means the recreate also failed.";
    if (status === 403 && /CachedContent not found/i.test(msg))
      return "the referenced CachedContent has EXPIRED or was deleted (this vendor answers 403, not 404, for a dead cache name) — the provider drops it and recreates once. Nothing is wrong with the API key.";
    if (status === 400 && /API key not valid/i.test(msg))
      return `the API key was rejected — check ${geminiApiKeyFile()} (or $APIPLAN_GEMINI_API_KEY) holds a current key from aistudio.google.com/apikey.`;
    if (status === 403 && /Context caching|billing|paid/i.test(msg))
      return "explicit context caching is a PAID-tier feature; a free-tier key cannot create a CachedContent. Unset APIPLAN_GEMINI_EXPLICIT_CACHE — the free implicit cache still applies.";
    if (status === 429)
      return `the key's quota is spent (${reason ?? "RESOURCE_EXHAUSTED"}) — this is per-key rate limiting, not a bad credential; wait for the window rather than re-issuing the key.`;
    if (status === 404)
      return "no such model on this endpoint — the API-key catalog is not the subscription catalog. `apiplan models --refresh` rewrites it from GET /v1beta/models.";
    return undefined;
  },
};

// ── self-registration ─────────────────────────────────────────────────────────
/**
 * Ask the API-key catalog what this key can reach, and write it into the registry cache.
 *
 * Filtered to the models this PROVIDER serves — the ones that answer
 * `generateContent`/`streamGenerateContent` as chat, plus the Live ids that answer
 * `bidiGenerateContent`. Deliberately NOT the whole catalog: veo (video), lyria (music),
 * the TTS ids, the image models and the embedders are reached through gemini-media.ts, and
 * listing them as chat models would advertise ids that answer 400 to a chat request.
 */
export async function refreshGemini(): Promise<{ count: number; live: number; source: string }> {
  const key = geminiApiKey();
  const res = await fetch(`${GEMINI_BASE()}/${API_VERSION()}/models?pageSize=1000`, {
    headers: { "x-goog-api-key": key },
  });
  if (!res.ok) throw new Error(`Gemini model catalog answered ${res.status}`);
  const body: unknown = await res.json();
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).models : undefined;
  const out: { id: string; label: string; efforts?: string[]; contextWindow?: number }[] = [];
  let live = 0;
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = String(e.name ?? "").replace(/^models\//, "");
    const methods = Array.isArray(e.supportedGenerationMethods) ? e.supportedGenerationMethods.map(String) : [];
    const chat = methods.includes("generateContent");
    const bidi = methods.includes("bidiGenerateContent");
    if (!chat && !bidi) continue;
    if (!/^gemini-/.test(id)) continue;                       // gemma / lyria / veo are not this provider
    if (/-image|-tts|-transcribe(?!-live)|embedding/.test(id)) continue;   // non-chat modalities
    if (bidi) live++;
    // The registry id carries the route marker; the vendor's own name goes only on the
    // wire (see parseGemini for why the two routes cannot share a name).
    out.push({
      id: `gemini-key-${id.replace(/^gemini-/, "")}`, label: labelFor(id),
      ...(bidi ? { efforts: [] } : { efforts: effortsFor(id) }),
      ...(typeof e.inputTokenLimit === "number" ? { contextWindow: e.inputTokenLimit } : {}),
    });
  }
  saveModels("gemini", out);
  return { count: out.length, live, source: `${GEMINI_BASE()}/${API_VERSION()}/models` };
}

/** "gemini-3.8-flash" → "Gemini 3.8 Flash (API key)". The suffix matters: the picker shows
 *  BOTH Google routes, and a human choosing between them needs to see which is which. */
export function labelFor(id: string): string {
  const words = id.replace(/^gemini-/, "").split("-").map((w) =>
    /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));
  return `Gemini ${words.join(" ")} (API key)`;
}

/**
 * The levels this model id documents (docs/thinking, "Controlling thinking", read
 * 2026-09-06), keyed on the VENDOR's id as the catalog reports it. `minimal` is listed only
 * for some ids, and sending a level a model does not serve is a 400, so the narrower set is
 * the default and the wider one is opt-in per id.
 */
export function effortsFor(id: string): string[] {
  if (/^gemini-3\.6-|^gemini-3\.5-flash|^gemini-3-flash/.test(id)) return GEMINI_EFFORTS_MINIMAL;
  return GEMINI_EFFORTS;
}
