// providers.ts — one adapter per vendor. Everything vendor-specific (where the
// subscription credential lives, the endpoint, the request shape, how a stream
// event becomes text) is behind this interface; the engine knows none of it.
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { HOME, IS_MAC, STATE_DIR, readJson, writeJson } from "./platform.ts";
import type { Model, ProviderId } from "./registry.ts";
import { ANTHROPIC_EFFORTS, GOOGLE_EFFORTS, saveModels } from "./registry.ts";
import type { StreamShape } from "./stream-shape.ts";
import { realtimeModelId } from "./live-models.ts";

/**
 * Wall-clock with its ZONE, re-exported from `./responses-wire.ts` where it now lives.
 *
 * ── WHY IT SAYS THE ZONE (round four, 2026-08-27) ── every expiry printed here used to be
 * `toISOString().slice(0,16)` — UTC, with nothing saying so. `/health` therefore told him
 * the google token "expires 21:14" while it was in fact good until 00:14 local (+0300):
 * a reader three hours out of step with reality, on the one number he uses to decide
 * whether a credential is about to die. An unlabelled timestamp is a lie by omission, so
 * every stamp now carries its zone and no reader has to guess which clock it is on.
 *
 * ── WHY IT MOVED ── the grok adapter needs it for the same expiry line, and importing it
 * from here would have re-created the providers ⇄ providers-grok cycle that
 * ./responses-wire.ts exists to end. Re-exported so every existing caller is unchanged.
 */
// One import, one re-export of the bound name — never also `export … from`, which does not
// bind locally and would declare `stampZ` twice (Bun rejects the whole module).
import { stampZ } from "./responses-wire.ts";
export { stampZ };

/**
 * Knobs a HOST sets once, that change how a credential may be obtained — never what it is.
 *
 * `syncRefresh` is the one that matters: a CLI is a single-shot process where blocking on a
 * token mint is exactly right, and the server is a single-threaded event loop where it is
 * exactly wrong (a hanging OAuth endpoint stalled EVERY request, /health included — measured
 * at 5.30 s, round four). api.ts turns it OFF for the server, which then refreshes through
 * `prepare()` / the background single-flight instead. Nothing else reads it.
 */
export const providerRuntime = { syncRefresh: true };

/** A truncated hash. Credential material NEVER leaves this file in any other form. */
const h12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/**
 * The identity of the credential a provider would use RIGHT NOW, in three parts, so a
 * caller can tell an hourly ROTATION from a credential SWAP without ever seeing a token.
 *   cred   the exact bearer — includes the ACCESS token's own hash. Round four: a fingerprint
 *          blind to the access token let a same-minute token swap keep a green "ACCEPTED"
 *          verdict, so the bearer itself is now part of it.
 *   ident  the credential CHAIN (account / refresh token). Survives a rotation by design.
 *   exp    that bearer's expiry, ms. A rotation ADVANCES it; a swap does not have to.
 * Hash only: the token is never stored, printed, logged or returned.
 */
export type CredFp = { cred: string; ident: string; exp: number };

export type ImageRef = { url?: string; mediaType?: string; base64?: string };
/**
 * A tool call the assistant made, and the result the following turn carries back.
 * First class because an agent transcript is unusable without them: a turn whose tool
 * blocks were dropped reaches upstream with empty content and Anthropic answers
 * `messages.N: user messages must have non-empty content` — turn 2 of every loop.
 */
export type ToolUse = { id: string; name: string; input: any };
export type ToolResult = { toolUseId: string; content: any; isError?: boolean };
export type Turn = {
  role: "user" | "assistant"; text: string; images?: ImageRef[];
  toolUses?: ToolUse[]; toolResults?: ToolResult[];
  /**
   * A mid-conversation system/developer turn, kept in position instead of hoisted into the
   * system prompt. Opt-in so the three backends keep switching on a three-value `role`.
   */
  isSystem?: boolean;
  /** Native Anthropic content blocks, retained only for Anthropic-in/out passthrough. */
  nativeAnthropicContent?: unknown[];
};
/**
 * A tool the caller offered, normalised to ONE internal shape so a request arriving in
 * either dialect can be built for either backend. `raw` keeps the caller's original
 * Anthropic block, so anthropic-in/anthropic-out is a pure passthrough and server tools
 * (web_search, code_execution) survive as themselves instead of becoming custom tools.
 */
export type ToolDef = { name: string; description?: string; parameters?: any; raw?: any };
/** tool_choice is spelled four ways across the two dialects; this is their union. */
export type ToolChoice = "auto" | "none" | "required" | { name: string };
export type CallOpts = {
  effort?: string; maxTokens?: number; system?: string; thinkOff?: boolean;
  /**
   * Chat vs Work — the two composer modes chatgpt.com itself exposes, chosen per request.
   * ONLY the `online` website provider acts on it; every other provider ignores it, because
   * no other transport has the concept (the Codex responses backend has no mode at all).
   * Strictly orthogonal to `effort`: a mode never implies a reasoning level, never changes
   * one, and never downgrades one.
   */
  mode?: "chat" | "work";
  /** Stable caller identity for provider-side prompt-cache affinity. */
  promptCacheKey?: string;
  /**
   * The caller's system prompt as it ARRIVED — the whole block array, cache_control and
   * all — for a provider whose native shape is the same array. `system` above is the
   * flattened string every other provider needs; flattening is lossy, and what it lost
   * was every prompt-caching marker.
   */
  systemBlocks?: unknown[];
  showThinking?: boolean; fast?: boolean; oneM?: boolean; temperature?: number;
  /** Ask the model to draw: adds the provider's image-generation tool to the request. */
  genImage?: boolean; imageSize?: string; imageQuality?: string;
  /** Send the drawing prompt through untouched instead of letting the model rewrite it. */
  rawPrompt?: boolean;
  /** Tools the caller offered, and how hard the model is pushed to pick one. */
  tools?: ToolDef[]; toolChoice?: ToolChoice;
  /**
   * OpenAI Responses `service_tier`. "priority" is the Codex Fast tier ("fast" is accepted
   * as its alias). Falls back to `fast` → "priority", then env APIPLAN_SERVICE_TIER. The
   * Codex backend accepts exactly `priority` and `default` (live 2026-09-29: flex/auto/fast
   * answer 400 "Unsupported service_tier"). Only the `openai` provider reads it.
   */
  serviceTier?: string;
  /**
   * OpenAI `input_image.detail` for EVERY image in the request (user images and images
   * inside tool results): low | high | auto | original (the backend's own list, live
   * 2026-09-29). Falls back to env APIPLAN_IMAGE_DETAIL. Only the `openai` provider reads it.
   */
  imageDetail?: string;
};

/** Text-to-speech is a different shape from a chat call: one request, binary back. */
export type SpeechOpts = { text: string; voice: string; format: string; model?: string; liveModel?: string; speed?: number;
  /** How to perform it — emotion, pace, character. Separate input from the words. */
  direction?: string };
export type SpeechResult = { bytes: Uint8Array; contentType: string };
export type ImageResult = { base64: string; contentType: string; model: string; revisedPrompt?: string };
export type Creds = { token: string; account?: string; expiresAt?: number; source: string };
export type Built = { url: string; headers: Record<string, string>; body: any };
/**
 * What one stream event contributed. `text` is answer content, `reasoning` is
 * thinking, and `served` is the model id the API itself reports — the only
 * trustworthy proof of which model answered (a model's self-description is not).
 */
export type Delta = {
  text?: string; reasoning?: string; error?: string; served?: string;
  /**
   * The vendor's OWN name for that fault — "overloaded_error", "rate_limit_error",
   * "authentication_error". Carried rather than re-derived, because a client that retries
   * on overload and gives up on api_error makes the opposite decision when the label is
   * flattened. Absent means the vendor said only that something broke.
   */
  errorType?: string;
  /**
   * A tool call opened upstream: id and name are known, arguments still to come. `ref` is
   * the UPSTREAM handle for that call (Anthropic block index, Responses item id) — the
   * dialect layer maps it to its own block numbering, so the two never have to agree.
   */
  toolStart?: { ref: string; id: string; name: string };
  /** A chunk of that call's arguments, as raw JSON text — never re-parsed in transit.
   *  `full` marks a backend's own complete copy (Codex repeats it once at the end); it
   *  REPLACES what was accumulated, and is ignored when fragments already arrived. */
  toolArgs?: { ref: string; json: string; full?: boolean };
  /** That call's arguments are complete. */
  toolStop?: { ref: string };
  /** A whole tool call reported in ONE event (Gemini does this) — the dialect layer opens,
   *  fills and closes a block for it on the spot, under a ref of its own making. `sig` is
   *  Gemini's thought signature, which that vendor REQUIRES echoed back on the next turn. */
  toolCallDone?: { id?: string; name: string; args: any; sig?: string };
  /**
   * Token counts the upstream stream reported. Absent means it reported none.
   * cacheRead/cacheWrite are Anthropic's prompt-cache counters: without them a caller
   * cannot tell a cache HIT from a full re-read of the prefix, which is the whole point
   * of sending cache_control in the first place.
   *
   * ── THE THREE BUCKETS, AND WHY EVERYTHING ELSE IS A SUB-DIVISION OF ONE OF THEM ──
   *
   * input/cacheRead/cacheWrite are the only BUCKETS: after api.ts's normalizeTally() has
   * converted an inclusive vendor to this gateway's exclusive footing, those three cover
   * the prompt exactly once and nothing else may be added to a total. Every other counter
   * a vendor reports is therefore modelled as a SUB-DIVISION — a finer description of a
   * bucket already counted — or is deliberately not carried at all.
   *
   * That rule is not a house style; it is what the vendors themselves state. Anthropic:
   * "the current cache_creation_input_tokens field equals the sum of the values in the
   * cache_creation object". A fourth bucket would double-count the same physical tokens
   * and break the disjointness the provider-cache contract suite asserts on both fronts.
   *
   * AND A DROPPED OPTIONAL FIELD IS A REAL FAULT, not a tidy omission. It produces no
   * symptom whatsoever — the numbers stay self-consistent, every test passes — and shows
   * up only as money nobody notices, or as a working cache that reads as one that never
   * hits. Two were live here (UNKNOWNS I-13): the anthropic TTL breakdown below, and
   * google's cachedContentTokenCount, which is the cache-HIT counter and was simply never
   * read. So the standing rule for anything a vendor documents: forward it as a
   * sub-division, or record why it is not carried. "We didn't notice it" is not a reason.
   */
  usage?: {
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
    /**
     * HOW cacheWrite splits across cache lifetimes, when the vendor said. A pure
     * SUB-DIVISION of cacheWrite: m5 + h1 == cacheWrite whenever both are stated, and
     * neither is ever added to anything.
     *
     * It exists because the two components cost DIFFERENT money — a 1-hour write bills at
     * 2x base input where a 5-minute write bills at 1.25x — so a consumer handed only the
     * flat total prices every write at the cheaper 5-minute rate. Anthropic is the only
     * vendor here that reports a lifetime breakdown at all.
     *
     * NEVER SYNTHESIZED. Absent means the vendor reported no breakdown, which a consumer
     * already handles by pricing the flat total; inventing a split would put a
     * derived-looking number in front of a reader who would take it as measured.
     */
    cacheWriteTtl?: { m5?: number; h1?: number };
    /**
     * The reasoning/thinking share OF output — a SUB-DIVISION of output, always already
     * contained in it, never added to it.
     *
     * The containment is stated here rather than left to each consumer because the vendors
     * disagree about their own wire shape and getting it wrong costs money in both
     * directions. OpenAI's `output_tokens_details.reasoning_tokens` is already inside
     * `output_tokens`; Google's `thoughtsTokenCount` is NOT inside `candidatesTokenCount`
     * ("totalTokenCount … (prompt + thoughts + response candidates)") and is billed as
     * output, so the google adapter adds it INTO `output` and reports the same number
     * here. Either way the invariant a consumer can rely on is the same one: reasoning is
     * a share of output, so `reasoning <= output`, and summing them double-counts.
     */
    reasoning?: number;
    /**
     * Vendor-side tool invocations billed per REQUEST rather than per token — Anthropic's
     * `server_tool_use`. Not tokens at all, so it cannot be a bucket or a sub-division of
     * one; it rides beside them, and only the front whose vendor defines the field
     * republishes it.
     */
    serverTools?: { webSearch?: number; webFetch?: number };
  };
  /** Why generation stopped, in Anthropic's vocabulary:
   *  "end_turn" | "max_tokens" | "stop_sequence" | "tool_use". */
  stopReason?: string;
  /** base64 image data produced by an image-generation tool call. */
  imageB64?: string;
  /** the model's rewritten version of the drawing prompt, when it reports one. */
  revisedPrompt?: string;
  /** progress note worth showing while a slow non-text job runs. */
  progress?: string;
};

/**
 * WHAT A VENDOR MEANS BY "INPUT TOKENS" — the one fact that decides whether this gateway's
 * three usage buckets are disjoint or double-counted.
 *
 *   "exclusive"  the vendor's input counter holds ONLY what was neither read from nor
 *                written to the cache, so input + cacheRead + cacheWrite is the whole
 *                prompt exactly once, with no conversion needed.
 *   "inclusive"  the vendor's input counter is the WHOLE prompt and the cache counters are
 *                a breakdown OF it, so the cached share must be subtracted once before the
 *                three can be published side by side.
 *
 * Read from each vendor's own documentation, never assumed — see the per-provider doc
 * comments below for the quoted sentence. api.ts's normalizeTally() is the ONE consumer,
 * and it converts at the dialect boundary rather than at each emission site.
 */
export type UsageBasis = "inclusive" | "exclusive";

/**
 * HOW A PREFIX BECOMES A CACHE ENTRY, as a mechanism this GATEWAY can actually drive.
 *
 *   "implicit-prefix"          the vendor places the breakpoint itself; a client influences
 *                              only WHERE the request lands (routing), not what is cached.
 *   "explicit-breakpoint"      the client marks the end of the reusable prefix in the body.
 *   "cached-content-resource"  the prefix is uploaded as a SEPARATE, named server-side
 *                              object first, and later requests reference it by name.
 *   "none"                     this vendor has no prompt cache to address.
 *
 * IT NAMES THE MECHANISM THIS GATEWAY USES — not the only one the vendor offers. Three of
 * the four vendors now support several at once (Anthropic added top-level automatic
 * caching beside explicit `cache_control`; OpenAI added explicit breakpoints beside
 * implicit ones on GPT-5.6+; Google caches implicitly as well as by CachedContent). A
 * single-valued `kind` is still the right shape because a gateway drives exactly one of
 * them per provider, and `identity` below is that mechanism's handle.
 */
export type CacheKind = "implicit-prefix" | "explicit-breakpoint" | "cached-content-resource" | "none";

/**
 * The FIELD a request uses to reach the right cache entry — the mechanism's handle, spelled
 * the way its vendor spells it, so a reader never has to guess which body key this provider
 * expects.
 *
 * "none" means there is nothing to address, and that is TWO different situations which the
 * `kind` beside it tells apart:
 *   · kind "none" too      the vendor has no prompt cache at all.
 *   · kind names a mechanism   the cache is real but fully internal — it exists, it changes
 *                          the bill, and no client field reaches it. A purely implicit
 *                          prefix cache is exactly this: the vendor decides, and the only
 *                          lever a caller has is what it sends and when.
 * So a real identity implies a real kind (a handle for a cache that does not exist is
 * incoherent), but a real kind does NOT imply a real identity. Only that one direction is
 * a coherence rule; the contract suite asserts it in that direction only.
 */
export type CacheIdentity = "prompt_cache_key" | "cache_control" | "cachedContent" | "none";

/**
 * One vendor's prompt cache, as facts rather than as code.
 *
 * Every field is DOCUMENTED-OR-ABSENT. An optional field left off means the vendor does not
 * state that number, and an undocumented number must never be invented here: a consumer
 * that reads `minTokens: undefined` learns "unknown", while one that reads a guessed 4096
 * learns something false and cannot tell. This is the same unknown-stays-unknown law
 * normalizeTally() applies to token counts, applied to the contract itself.
 */
export type CacheContract = {
  kind: CacheKind;
  /**
   * The SMALLEST prefix any currently-active model of this vendor will cache — the floor
   * below which no model caches at all, so a caller under it can stop wondering. Above it
   * the threshold is model-dependent, and the per-provider comment names the spread. Absent
   * means the vendor publishes no minimum.
   */
  minTokens?: number;
  /** The DEFAULT lifetime of an entry, in ms, as the vendor documents it. Absent means the
   *  vendor documents none — not that entries live forever. */
  ttlMs?: number;
  identity: CacheIdentity;
};

export interface Provider {
  id: ProviderId;
  label: string;
  /**
   * How this vendor counts input tokens — see UsageBasis. REQUIRED, because a provider that
   * declines to say leaves api.ts guessing, and the wrong guess double-counts the cached
   * prefix (or drives the uncached remainder negative) on every single turn it serves.
   */
  usageBasis: UsageBasis;
  /**
   * This vendor's prompt cache, as facts — see CacheContract. REQUIRED for the same reason:
   * a new provider added without it would silently inherit nothing, and "no declaration"
   * and "no cache" would become indistinguishable. `kind: "none"` states the absence.
   */
  cache: CacheContract;
  /** Where the login lives, for `apiplan status` — never throws. */
  probe(): { connected: boolean; detail: string; loginHint: string };
  /** Throws Error (with a fix-it message) when not logged in. */
  creds(): Creds;
  /**
   * ASYNC preparation creds() is not allowed to do itself — today: minting a token that is
   * about to expire. creds() is sync (every caller depends on that), and the only sync way
   * to reach the network is spawnSync, which on a single-threaded server blocks EVERY other
   * request. A host that has an event loop calls this first and awaits it; one that does not
   * (the CLI) skips it and keeps the sync path. It must never throw and never block on a
   * token that is still usable — a slow vendor may not delay an unrelated request.
   */
  prepare?(): Promise<void>;
  /**
   * U-1: drop whatever credential snapshot this provider is serving and read the well once,
   * NOW. A resident host calls it when creds() has just REFUSED, before it turns that
   * refusal into a 401 — an auth failure is exactly the signal that the cached credential
   * is the wrong one, and the well may already hold the right one (an external `claude` /
   * `codex` / `agy` login landing inside the cache window). Async so the request path never
   * blocks on the Keychain. Absent means the provider reads its well on every creds() and
   * has nothing to drop. It must never throw.
   *
   * Answers whether the credential the next creds() will see was ACTUALLY re-read. `false`
   * (the read did not land inside its wait) means the refusal that follows says nothing
   * about the credential, so nothing may be recorded against the provider for it.
   */
  refreshCreds?(): Promise<boolean>;
  /** Fingerprint of the credential creds() would use now — see CredFp. Never a token. */
  credFp?(): CredFp;
  efforts(m: Model): string[];
  build(m: Model, turns: Turn[], o: CallOpts, c: Creds): Built;
  /**
   * Open a provider-specific transport from the already-built request. Absent keeps the
   * ordinary streamed HTTP POST. Local providers can use this hook without pretending
   * their account/session state is an upstream bearer credential or URL.
   */
  open?(built: Built, signal?: AbortSignal): Promise<Response>;
  delta(ev: any): Delta;
  /**
   * Does this vendor accept the engine's `stream: true` body flag? Absent means yes
   * (the two OpenAI-shaped vendors). Google's endpoint is strict proto-JSON and answers
   * 400 `Unknown name "stream"`, and build() cannot help: the engine spreads the flag in
   * AFTER build() returns. The vendor fact belongs here; the engine reads it in one line.
   */
  wantsStreamFlag?: boolean;
  /**
   * Turn a non-2xx status + error body into an accurate fix-it line. Absent means the
   * engine's generic wording is right. It is NOT right for every vendor: Google answers
   * 403 SUBSCRIPTION_REQUIRED when the CLIENT identity is wrong, not when the login is
   * stale, so "run `agy` and log in again" would send a user to re-auth a healthy account.
   */
  explain?(status: number, body: string): string | undefined;
  /**
   * An upstream refusal this provider can REPAIR by dropping local state it holds, so that
   * the caller's NEXT request succeeds. Side effect only: it returns nothing, changes no
   * status, and never throws — the refusal in hand is still reported honestly.
   *
   * IT EXISTS BECAUSE A STALE HANDLE POISONS EVERY LATER REQUEST, not just the one that
   * hit it. Google's explicit cache is the case: an evicted or expired CachedContent is
   * answered 403 PERMISSION_DENIED "CachedContent not found" (NOT 404 — recovery written
   * against 404 by instinct never fires), and a provider still holding that dead name
   * keeps referencing a corpse on every subsequent turn with the same prefix, until the
   * process restarts. Nothing in build() or delta() can see a status: build() is
   * synchronous by contract and delta() only ever sees stream frames.
   *
   * NO RETRY IS IMPLIED, and none is performed. The engine calls this for its side effect
   * and then reports the fault exactly as it would have — a hook that promised a retry
   * nothing performs would be a contract asserting a capability that is absent. The
   * repair shows up as the next request working, which is the honest shape of it.
   *
   * The body is the RAW upstream text, not a narrowed message: an implementation matching
   * on any field outside `error.message` would otherwise silently never fire, which looks
   * exactly like the bug it was written to fix while still being broken.
   */
  recover?(status: number, body: string, m: Model): void;
  /** Can this provider draw? Absent means no, and the CLI says so by name. */
  canGenerateImages?: boolean;
  /** A provider-native image endpoint. OpenAI draws through its chat tool; Google exposes
   *  a separate non-streaming generateContent image model, so it uses this direct path. */
  generateImage?(prompt: string, o: CallOpts, c: Creds, signal?: AbortSignal): Promise<ImageResult>;
  /** Text to speech. Absent means the provider offers none here. Throws with a
   *  fix-it message when the credential in hand doesn't cover it. */
  speak?(o: SpeechOpts): Promise<SpeechResult>;
  /** Voices this provider accepts, for `--help` and validation. */
  voices?: string[];
  /** Voices the live backend serves right now (a local server may offer its own). */
  listVoices?(): Promise<{ backend: string; voices: string[] }>;
  /** Speak a message that already exists in the account — ChatGPT's product
   *  read-aloud. A separate, older engine from speak()'s realtime path, with its own
   *  voice set; kept because those voices exist nowhere else. */
  readAloud?(o: AloudOpts): Promise<SpeechResult & { spoke: string; voice: string }>;
  /** The read-aloud voices this account is entitled to, live. */
  aloudVoices?(): Promise<{ selected: string; voices: string[] }>;
}
export type AloudOpts = { conversation?: string; message?: string; voice?: string; format?: string;
  /** Explicit opt-in to touching stored history at all. Never implied. */ last?: boolean };

/** The voices the realtime endpoint serves (it names them itself when you send a bad one). */
export const REALTIME_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];

/** PCM16 mono → a .wav file. 44 bytes of header is the whole "codec". */
function wav(pcm: Uint8Array, rate = 24000): Uint8Array {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.from(pcm)]));
}

/**
 * The instruction that turns a conversational model into a narrator. Two inputs, kept
 * apart: the WORDS are fixed, the DIRECTION is free. Measured — a direction changes
 * loudness ~3x between whisper and shout, and "laugh" produces a real laugh — but the
 * model will also happily ad-lib, so the words are pinned in the same breath.
 */
function perform(o: SpeechOpts): string {
  if (!o.direction) return `Read the following text aloud, verbatim, and say nothing else — no greeting, no comment:\n\n${o.text}`;
  return [
    "You are performing a line of dialogue, not chatting.",
    `Direction: ${o.direction}`,
    "Perform that direction with your voice — actually laugh, whisper, shout, pause or cry as asked; never announce or describe it.",
    "Say the words below and nothing else: no greeting, no commentary, no added sentences.",
    "If the words contain bracketed stage directions, perform them instead of reading them aloud.",
    "",
    o.text,
  ].join("\n");
}

/**
 * Speak text through the realtime endpoint using the ChatGPT subscription token.
 * One WebSocket, one response, PCM16 back. The model is told to read the text
 * verbatim — it is a conversational model being used as a narrator, so the
 * instruction matters.
 */
/**
 * The ONE place a realtime WebSocket is opened. Both the narrator (speakRealtime) and the
 * conversation (talk.ts) go through here, so any transport fix — reconnect, keepalive,
 * headers — lands on every caller instead of half of them.
 * `perMessageDeflate:false`: the payload is base64 PCM, which is incompressible; deflate
 * only burns CPU and holds context memory (honored by Bun ≥1.3.14, ignored harmlessly before).
 * No OpenAI-Beta header: the beta shape is retired and answers beta_api_shape_disabled.
 */
export function openRealtime(token: string, selected?: string): WebSocket {
  const model = realtimeModelId(selected);
  return new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    { headers: { Authorization: `Bearer ${token}` }, perMessageDeflate: false } as any,
  );
}

export function speakRealtime(c: Creds, o: SpeechOpts, timeoutMs = 120000): Promise<SpeechResult> {
  const model = realtimeModelId(o.liveModel || o.model);
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = openRealtime(c.token, model); }
    catch (e: any) { return reject(new Error(`realtime speech could not connect: ${e?.message ?? e}`)); }

    const chunks: Buffer[] = [];
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} ; fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("realtime speech timed out"))), timeoutMs);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "session.update", session: { type: "realtime", output_modalities: ["audio"],
        audio: { output: { voice: o.voice, format: { type: "audio/pcm", rate: 24000 } } } } }));
      ws.send(JSON.stringify({ type: "response.create", response: { instructions: perform(o) } }));
    };
    ws.onmessage = (e: any) => {
      let ev: any;
      try { ev = JSON.parse(String(e.data)); } catch { return; }
      if (typeof ev.type === "string" && ev.type.endsWith("audio.delta") && ev.delta) chunks.push(Buffer.from(ev.delta, "base64"));
      else if (ev.type === "error") done(() => reject(new Error(`realtime speech refused: ${ev.error?.message ?? "unknown error"}`)));
      else if (ev.type === "response.done") {
        const pcm = Buffer.concat(chunks);
        if (!pcm.length) return done(() => reject(new Error("realtime speech returned no audio")));
        done(() => resolve({ bytes: wav(pcm), contentType: "audio/wav" }));
      }
    };
    ws.onerror = () => done(() => reject(new Error("realtime speech connection failed")));
    ws.onclose = (e: any) => done(() => reject(new Error(`realtime speech closed early (${e?.code ?? "?"}) ${String(e?.reason ?? "").slice(0, 120)}`)));
  });
}

const env = (k: string, d: string) => (process.env[k]?.length ? process.env[k]! : d);

// ─────────────────────────── the resident credential cache (F9-2) ───────────────────────────
/**
 * ── WHY THIS EXISTS (round six, 2026-08-28) ──
 * Every credential well on this machine is read SYNCHRONOUSLY: the Keychain through
 * `security` (a spawnSync), the retry window through Bun.sleepSync. That is correct in the
 * CLI — a one-shot process has nothing else to do — and wrong in a RESIDENT host, which has
 * exactly one thread. Measured here: one /health costs ~65 ms of `security` alone (anthropic
 * probe 16.6 + credFp 14.3, google probe 13.2 + credFp 14.1), so ten parallel /health came
 * back as a perfect staircase — 0.079 s, 0.161, 0.234 … 0.863 — and /v1/models went from
 * 0.0008 s idle to 0.479 s under that load. Tens of milliseconds today; the moment the
 * Keychain LOCKS or prompts, `security` has no timeout of its own and the whole service
 * stalls behind one read. A vendor's or an OS binary's latency must never become ours —
 * the same law R-1 wrote for the OAuth mint, applied to the plain reads it left behind.
 *
 * So on a resident host the sync readers read a SNAPSHOT instead of the well:
 *   · ONE cold read fills it, and warmCreds() does that at start-up, BEFORE the host
 *     accepts anything — so no request in flight ever meets an empty cache;
 *   · a snapshot past APIPLAN_CRED_CACHE_MS is still SERVED, and the well is re-read in the
 *     BACKGROUND through Bun.spawn (async — the event loop keeps serving everyone else);
 *   · SINGLE-FLIGHT: ten concurrent readers cost one `security`, not ten;
 *   · a refresh that fails leaves the snapshot exactly as it was and cannot hot-loop.
 * The window is a few seconds, and the two things that must be instant do not go through
 * it: a token this process MINTED is served from googleFresh (memory, no well involved),
 * and a real call's verdict is written against the fingerprint the same snapshot produced,
 * so /health can never compare two different reads of the world against each other.
 *
 * The CLI is untouched — `providerRuntime.syncRefresh` (the flag R-1 introduced for exactly
 * this distinction) takes the direct sync path, cache and all bypassed.
 */
const CRED_CACHE_MS = () => Number(env("APIPLAN_CRED_CACHE_MS", "3000")) || 3000;
/**
 * A hard ceiling on `security`, which has none of its own. A locked Keychain, a denied
 * prompt or a hung securityd can leave it waiting for ever; a sync read of that takes the
 * server with it, and even the async one would pin a process. Generous — a read of this
 * Keychain measures 15-20 ms — and it applies to the CLI too, where an unbounded hang is
 * merely a different kind of broken.
 */
const SECURITY_TIMEOUT_MS = () => Number(env("APIPLAN_SECURITY_TIMEOUT_MS", "2000")) || 2000;
/** U-1: how long a caller that is ABOUT TO FAIL waits for the one fresh read it asked for.
 *  Not a timeout on the read (that is SECURITY_TIMEOUT_MS, and the read keeps going) — a
 *  ceiling on the WAIT, so an unreadable well can never turn a fast 401 into a hang. */
const CRED_REFRESH_WAIT_MS = () => Number(env("APIPLAN_CRED_REFRESH_WAIT_MS", "1500")) || 1500;

/** What one `security` invocation returned. `exitCode` is the binary's, except -2, which is
 *  this wrapper's own: killed for running past the timeout. Every caller already treats any
 *  non-zero, non-44 code as a READ FAULT rather than a logout — which is exactly what a
 *  timeout is, and emphatically not "signed out". */
type SecRun = { exitCode: number; stdout?: any; stderr?: any };
const SEC_TIMED_OUT = -2;
const secTimeout = (): SecRun => ({ exitCode: SEC_TIMED_OUT, stderr: Buffer.from(`timed out after ${SECURITY_TIMEOUT_MS()}ms`) });

/** The blocking read — the CLI's path, and the one cold fill on a resident host. */
function securitySync(args: string[]): SecRun {
  const r = Bun.spawnSync(["security", ...args], { stderr: "pipe", timeout: SECURITY_TIMEOUT_MS(), killSignal: "SIGKILL" }) as any;
  return r.exitCode === null ? secTimeout() : r;
}
/** The same read with an event loop left free. Both pipes are drained together: `security`
 *  writes little, but a caller that drains one and then waits for the other can deadlock on
 *  a full pipe, and this one runs unattended. */
async function securityAsync(args: string[]): Promise<SecRun> {
  const p = Bun.spawn(["security", ...args], { stdout: "pipe", stderr: "pipe", timeout: SECURITY_TIMEOUT_MS(), killSignal: "SIGKILL" });
  const [out, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).arrayBuffer()]);
  await p.exited;
  return p.exitCode === null ? secTimeout() : { exitCode: p.exitCode, stdout: Buffer.from(out), stderr: Buffer.from(err) };
}

/**
 * Wrap a well reader so a resident host serves a snapshot and refreshes it off the request
 * path. The returned reader is SYNCHRONOUS, because probe(), creds() and credFp() are
 * synchronous by contract — the change is invisible at every call site, which is the point.
 *
 * ── U-1 (2026-08-28): the snapshot must be DROPPABLE ──
 * Stale-while-revalidate is right for a probe and wrong for a REFUSAL. Observed on this
 * rig: an external tool (the `claude` CLI renewing its own login) rewrites the well one
 * second before the snapshot's token expires; the next three calls are refused 401
 * "token expired" while a token good for an hour sits on disk, and the fourth — 100 ms
 * later, once the background re-read has landed — succeeds. Serving a stale snapshot to a
 * reader that is merely LOOKING costs nothing; serving it to one that is about to turn it
 * into an error costs a call, and writes a vendor rejection nobody made.
 * So the reader carries `refresh()`: one fresh read, awaited, for the caller who is about
 * to fail on what it was handed. It is ASYNC on purpose — the request path never blocks on
 * `security` again (F9-2's whole point); it is SINGLE-FLIGHT, so a burst of ten refusals
 * costs one `security`, not ten; and it applies its result monotonically, so a slow read
 * that started BEFORE a rotation can never land on top of a newer one.
 */
type ResidentReader<T> = (() => T) & { refresh: () => Promise<boolean> };
function residentCache<T>(syncRead: () => T, asyncRead: () => Promise<T>): ResidentReader<T> {
  let snap: { v: T } | null = null;
  let at = 0;
  let flight: Promise<void> | null = null;
  /** When the read now held in `snap` STARTED. A result is only applied if it began no
   *  earlier than the one already in hand, so an in-flight read that predates a rotation
   *  cannot clobber a newer one that overtook it. */
  let applied = 0;
  /** The one FORCED read a burst of refusals shares (see read.refresh below). */
  let forced: Promise<boolean> | null = null;
  const take = (started: number, v: T) => { if (started >= applied) { applied = started; snap = { v }; } };
  const read = () => {
    if (providerRuntime.syncRefresh) return syncRead();          // the CLI keeps the direct path
    if (!snap) { snap = { v: syncRead() }; at = applied = Date.now(); return snap.v; }
    if (!flight && Date.now() - at >= CRED_CACHE_MS()) {
      // STALE-WHILE-REVALIDATE. The caller is served the snapshot it already has — at most
      // one window old — and the well is re-read behind it. `at` moves when the refresh
      // SETTLES, so a slow or failing well is retried once per window, never once per
      // request, and a failure keeps the last good snapshot rather than inventing a state.
      const started = Date.now();
      flight = asyncRead().then((v) => { take(started, v); }, () => {})
        .finally(() => { at = Date.now(); flight = null; });
    }
    return snap.v;
  };
  /**
   * U-1: read the well NOW and replace the snapshot with what it holds. Never throws — the
   * readers below answer with a state rather than an exception, and a read that fails
   * outright leaves the snapshot exactly as it was, which is what the window already does.
   * A cold cache needs nothing: the next read() fills it from the well itself.
   *
   * RETURNS: whether the caller is now holding a FRESHLY READ well. `false` means the read
   * did not land in time and the snapshot is still the old one — which the caller must know,
   * because a refusal it cannot re-verify is not evidence about the credential (it must not
   * be recorded as a vendor rejection).
   *
   * WHY THE WAIT IS BOUNDED (found by V1's own attack rig, before this shipped). `security`
   * carries a hard timeout, but a stub — or a real one — that leaves a CHILD behind keeps the
   * stdout pipe open after the process is killed, and the drain in securityAsync() then never
   * resolves. Awaiting that unbounded turned a 9 ms 401 into a request that never answered at
   * all: measured, in a world where `security` hangs, five refusals still pending after 118 s
   * against 8-11 ms before. So the WAIT is capped here (the read itself carries on in the
   * background and lands whenever it lands, monotonically guarded), and a caller that runs out
   * of patience falls back to exactly the behaviour it had before this fix existed — the old
   * snapshot, the same error — never to a hang. A healthy read is 15-20 ms; google's retry
   * chain is ~200 ms; the cap is an order of magnitude above both.
   */
  read.refresh = (): Promise<boolean> => {
    if (providerRuntime.syncRefresh || !snap) return Promise.resolve(true);  // both read the well itself
    if (!forced) {
      const started = Date.now();
      let landed = false;
      const done = asyncRead().then((v) => { take(started, v); landed = true; }, () => {})
        .finally(() => { at = Date.now(); forced = null; });
      // Everyone in the same burst shares ONE read, and everyone gets the same honest
      // answer about whether it landed. `forced` clears when the read SETTLES, not when the
      // wait ends, so a well that is hanging cannot be re-spawned once per request either.
      forced = Promise.race([done, Bun.sleep(CRED_REFRESH_WAIT_MS())]).then(() => landed);
    }
    return forced;
  };
  return read as ResidentReader<T>;
}

/**
 * Fill every credential snapshot before a resident host accepts its first request, so the
 * ONE blocking read each well ever needs happens while nobody is waiting. Never throws: a
 * well that cannot be read is a red provider, not a failed start-up.
 */
export function warmCreds(): void {
  for (const p of Object.values(PROVIDERS)) {
    try { p.credFp?.(); } catch {}
    try { p.probe(); } catch {}
  }
}

// ─────────────────────────── Anthropic (Claude Code subscription) ───────────────────────────

/** macOS keeps it in the Keychain; Linux/WSL/Windows in ~/.claude/.credentials.json. */
function anthropicCredFile(): string {
  return env("APIPLAN_ANTHROPIC_CRED_FILE", join(HOME, ".claude", ".credentials.json"));
}
const anthropicKcService = () => env("APIPLAN_KEYCHAIN_SERVICE", "Claude Code-credentials");
const anthropicKcArgs = () => ["find-generic-password", "-s", anthropicKcService(), "-w"];
/** Keychain answer (or none) -> the credential, falling back to the file well exactly as
 *  before. Shared by the sync and async readers so the two can never drift. */
function anthropicFrom(r: SecRun | null): { json: any; source: string } | null {
  if (r && r.exitCode === 0 && r.stdout?.length) {
    try { return { json: JSON.parse(r.stdout.toString()), source: `Keychain (${anthropicKcService()})` }; } catch {}
  }
  const f = anthropicCredFile();
  if (existsSync(f)) {
    try { return { json: JSON.parse(readFileSync(f, "utf8")), source: f.replace(HOME, "~") }; } catch {}
  }
  return null;
}
// The spawn is wrapped now: `security` missing from PATH, or exec denied, used to THROW out
// of a reader that probe() promises never to throw from. A read fault falls through to the
// file well, which is what a machine without the binary has anyway.
function readAnthropicRawSync(): { json: any; source: string } | null {
  let r: SecRun | null = null;
  if (IS_MAC) { try { r = securitySync(anthropicKcArgs()); } catch { r = null; } }
  return anthropicFrom(r);
}
async function readAnthropicRawFresh(): Promise<{ json: any; source: string } | null> {
  let r: SecRun | null = null;
  if (IS_MAC) { try { r = await securityAsync(anthropicKcArgs()); } catch { r = null; } }
  return anthropicFrom(r);
}
/** F9-2: on a resident host this is a snapshot read; in the CLI it is the direct read. */
const readAnthropicRaw = residentCache(readAnthropicRawSync, readAnthropicRawFresh);

/** Modern contract: output_config.effort + adaptive thinking. Legacy: budget_tokens.
 *  Opus 4.5 is deliberately NOT here: the vendor's per-model table (thinking-troubleshooting
 *  #supported-models, read 2026-09-06) lists Opus 4.5 / Sonnet 4.5 / Haiku 4.5 as "Extended
 *  only" — `adaptive` is rejected with a 400 — so it takes the legacy budget branch. */
const MODERN_THINKING = (id: string) => /opus-(5|4-(6|7|8))|sonnet-5|sonnet-4-6|fable-5|mythos-5/.test(id);
const LEGACY_BUDGET: Record<string, number> = { low: 0, medium: 4000, high: 10000, xhigh: 24000, max: 48000 };
const HIGH_EFFORT = new Set(["high", "xhigh", "max"]);
/**
 * Models where thinking CANNOT be turned off: `thinking: {type: "disabled"}` is a 400.
 *
 * The vendor publishes this per model, listing the `thinking.type` values each one
 * "rejects with a 400 error; any value not listed as rejected is accepted". For Claude
 * Fable 5.1, Mythos 5.1, Fable 5, Mythos 5 and Mythos Preview that list contains
 * `"disabled"`: they are "Always on", and "Models marked `Always on` cannot turn thinking
 * off." (docs/en/build-with-claude/thinking-troubleshooting#supported-models, read
 * 2026-09-06.) Confirmed live through this gateway on claude-fable-5-1 — HTTP 400
 * invalid_request_error, verbatim: `"thinking.type.disabled" is not supported for this
 * model. Thinking defaults to adaptive mode when not specified; use
 * "thinking.type.enabled" with "budget_tokens" for extended thinking.` That message's own
 * suggestion is a second 400 on this model, which is why it is not the remedy here.
 *
 * The remedy is the vendor's: "Omit the `thinking` parameter; these models think without
 * any configuration", and where the goal was to stop paying for thinking, "use lower
 * `effort` levels to control token cost instead". So on these ids thinkOff travels as
 * effort, never as a thinking field — see build().
 *
 * FAMILY-level and deliberately version-agnostic. The vendor states this of the Fable and
 * Mythos lines as such, so the next member of either inherits it instead of silently
 * falling out of a version-pinned pattern — the failure mode MODERN_THINKING's `fable-5`
 * already has, where it matches claude-fable-5-1 by prefix but not a future claude-fable-6.
 * This predicate also covers claude-mythos-preview, which MODERN_THINKING does not match
 * at all: that id lands in the legacy branch, where thinkOff means budget 0 and no
 * thinking field is emitted, so it is already free of the rejected shape.
 */
const THINKING_ALWAYS_ON = (id: string) => /fable|mythos/.test(id);
/**
 * Efforts at which `thinking: {type: "disabled"}` is itself rejected on the models below.
 * The vendor's phrase is "accepts `"disabled"` at effort `high` or below; combining it
 * with effort `xhigh` or `max` returns a 400 error", so this is the complement of "high or
 * below" and NOT HIGH_EFFORT, which includes `high` and would over-clamp by one level.
 */
const ABOVE_HIGH: Record<string, true> = { xhigh: true, max: true };
/**
 * Models that enforce that ceiling: "This restriction applies to Claude Opus 5 and later
 * models and is enforced on each request." Read as Opus 5 plus any generation after 5,
 * because "and later models" is forward-looking while the footnote sits on the Opus 5 row
 * alone — Claude Sonnet 5's row carries no such footnote, so a gen-5 non-Opus id is left
 * exactly as the table has it. Parsed rather than pattern-matched because a regex for
 * "generation 6 or newer" reads the trailing `-6` of claude-opus-4-6 as a generation.
 */
const NO_DISABLED_ABOVE_HIGH = (id: string) => {
  const g = /(opus|sonnet|haiku|fable|mythos)-(\d+)/.exec(id);
  if (!g) return false;
  const major = Number(g[2]);
  return major > 5 || (major === 5 && g[1] === "opus");
};
/**
 * Only these first-party Anthropic models accept a `role:"system"` entry INSIDE
 * `messages[]`. Everywhere else that role is a 400, so a mid-conversation system turn has
 * to travel as a `user` turn — still in position, which is the point.
 *
 * This is the ANTHROPIC-BACKEND half of the gateway capability. Ask
 * {@link honoursMidConversationInstruction} instead unless you specifically mean this backend.
 */
export const MIDCONV_SYSTEM = (id: string) => /opus-(5|4-8)|sonnet-5|fable-5|mythos-5/.test(id);

/**
 * Does THIS GATEWAY carry a mid-conversation operator instruction as a distinct role for `model`?
 *
 * The one capability function, exported because a harness cannot derive it and a second copy would
 * drift. `src/roster.ts` emits it as `compat.supportsMidConversationSystem`.
 *
 * WHY IT MUST BE ASKED AT ALL, and why it is broader than the Anthropic predicate: a harness
 * catalog derives its mid-conversation opt-in from the base URL being the first-party Anthropic
 * API. This gateway is loopback, so that derivation is false for EVERY model, and a harness that
 * believes it DEMOTES the operator turn to `role:"user"` before the request ever leaves. The
 * gateway's intake only tags `isSystem` for a non-leading `system`/`developer` message, so a
 * pre-demoted turn is indistinguishable from an ordinary user turn and the instruction is lost
 * UPSTREAM of every backend mapping. The flag therefore describes what this gateway ACCEPTS AND
 * FORWARDS — not what api.anthropic.com accepts.
 *
 * Observed per backend on the outbound wire (test/lx/midsystem-gateway-capability.ts):
 *   · openai — the Responses API spells it `developer`, and `toResponsesItems` maps every
 *     `isSystem` turn to that role for ALL models on this backend. gpt-6-astra and gpt-5.6-sol
 *     were both observed emitting `[user, developer]`. So it is capable regardless of the id.
 *   · anthropic — wire `role:"system"`, but only for {@link MIDCONV_SYSTEM} ids and only where
 *     Anthropic's placement rules hold; claude-opus-5 emitted `[user, system]`, claude-opus-4-6
 *     was correctly downgraded to `[user, user]`.
 *   · google — Gemini has no mid-conversation system role, so the turn stays `user` in position.
 *   · ollama — no `isSystem` handling at all.
 * The last two are NOT capable, and claiming otherwise would make a harness send a role that is
 * then silently flattened.
 */
export function honoursMidConversationInstruction(provider: ProviderId, id: string): boolean {
  if (provider === "openai") return true;
  if (provider === "anthropic") return MIDCONV_SYSTEM(id);
  return false;
}
/**
 * Anthropic's placement rules for a wire `system` message, as the API states them
 * (observed live against api.anthropic.com, 2026-08-31, claude-opus-5):
 *   (a) it must FOLLOW a `user` turn - "role 'system' must follow a 'user' message or an
 *       'assistant' message ending in a server tool result"; never first, because
 *       "use the top-level 'system' parameter for the initial system prompt";
 *   (b) it must PRECEDE an `assistant` turn or END the array - "role 'system' must precede
 *       an 'assistant' message or end the array".
 * (b) also subsumes the no-consecutive-`system` rule: a `system` turn followed by another
 * `system` turn precedes neither an assistant nor the end.
 *
 * A turn that would break either rule is DOWNGRADED to `user` - it keeps its position,
 * only its role changes. Without (b) this proxy forwarded `[user, system, user]`, which
 * the API rejects outright, so the whole request 400ed instead of merely losing the role.
 * Allocation-light: the original array comes straight back when every flag is already
 * legal (and when none is set at all).
 */
function placeSystemTurns(turns: Turn[], allowed: boolean): Turn[] {
  let out: Turn[] | null = null;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t.isSystem) { out?.push(t); continue; }
    // `prev` is the PLACED predecessor: a system turn already downgraded to `user` is a
    // legal anchor, so read it out of `out` whenever the copy has started.
    const prev = (out ?? turns)[i - 1];
    const followsUser = i > 0 && prev !== undefined && !prev.isSystem && prev.role === "user";
    // An `isSystem` turn carries `role: "user"`, so it never satisfies this test - which is
    // exactly the no-consecutive-`system` guarantee.
    const next = turns[i + 1];
    const lastOrBeforeAssistant = next === undefined || next.role === "assistant";
    if (allowed && followsUser && lastOrBeforeAssistant) { out?.push(t); continue; }
    if (!out) out = turns.slice(0, i);
    const { isSystem: _drop, ...rest } = t;
    out.push({ ...rest, role: "user" });
  }
  return out ?? turns;
}

/**
 * The two wire guards — `unknown` in, a finite number or a real object out — now live in
 * `./wire.ts`, a dependency-free leaf, and are imported here for the three vendor usage
 * readers that need them (anthropicUsage, googleUsage, and the Responses reader that moved
 * to ./responses-wire.ts). They were extracted for exactly that third case: the leaf that
 * ended the providers ⇄ providers-grok import cycle could not import back into this file
 * without reinstating it.
 *
 * Their contract is the load-bearing one in this whole file: a vendor may send null, a
 * string, or nothing at all for any counter, and each of those must read as "NOT STATED"
 * rather than as a zero — an explicit zero is measured evidence of a cache miss, which is
 * exactly the distinction a cache reader must keep.
 */
import { wireNum, wireObj } from "./wire.ts";
/**
 * One Anthropic `usage` object → this gateway's buckets and their sub-divisions. ONE reader
 * for one wire shape, because that object arrives TWICE per turn — an opening count on
 * `message_start` and a corrected one on `message_delta` — and a second copy is how the two
 * snapshots drift into disagreeing about what the same turn cost.
 *
 * WHAT THE VENDOR DOCUMENTS, AND WHERE EACH FIELD GOES (Messages API `Usage`):
 *   input_tokens                 → input        the uncached remainder (this vendor is EXCLUSIVE)
 *   output_tokens                → output
 *   cache_read_input_tokens      → cacheRead
 *   cache_creation_input_tokens  → cacheWrite   the FLAT write total
 *   cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}
 *                                → cacheWriteTtl.{m5, h1}   a sub-division of cacheWrite
 *   server_tool_use.{web_search_requests, web_fetch_requests}
 *                                → serverTools.{webSearch, webFetch}   requests, not tokens
 *   iterations[]                 NOT carried: per-attempt counts inside a server-side
 *                                fallback chain, whose totals are already the fields above.
 *                                Republishing them would invite a reader to sum the same
 *                                tokens twice, and no front dialect has a field for them.
 *
 * WHY THE TTL BREAKDOWN IS WORTH CARRYING AT ALL. The two components cost different money:
 * a 1-hour write bills at 2x base input where a 5-minute write bills at 1.25x, so a
 * consumer handed only the flat total prices every 1h write at the cheaper 5-minute rate.
 * It is a pure sub-division and the vendor says so — "the current
 * cache_creation_input_tokens field equals the sum of the values in the cache_creation
 * object" — so it never becomes a fourth bucket and is never added to anything.
 *
 * NOTHING IS SYNTHESIZED, AND AN ALL-ZERO BREAKDOWN IS NOT EMITTED. A consumer treats an
 * explicit all-zero `cache_creation` as a command to CLEAR any breakdown a previous
 * snapshot of the same turn established, so emitting one on the message_delta correction
 * would erase the real split the message_start carried. Absent means the vendor reported no
 * breakdown, which a consumer already handles by pricing the flat total.
 */
export const anthropicUsage = (u: unknown): Delta["usage"] | undefined => {
  if (!u || typeof u !== "object") return undefined;
  const cc = wireObj(u, "cache_creation"), st = wireObj(u, "server_tool_use");
  const input = wireNum(u, "input_tokens"), output = wireNum(u, "output_tokens");
  const cacheRead = wireNum(u, "cache_read_input_tokens"), cacheWrite = wireNum(u, "cache_creation_input_tokens");
  const m5 = wireNum(cc, "ephemeral_5m_input_tokens"), h1 = wireNum(cc, "ephemeral_1h_input_tokens");
  const webSearch = wireNum(st, "web_search_requests"), webFetch = wireNum(st, "web_fetch_requests");
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    // Only a breakdown that actually SAYS something rides along: see the all-zero note above.
    ...((m5 ?? 0) > 0 || (h1 ?? 0) > 0 ? { cacheWriteTtl: { ...(m5 ? { m5 } : {}), ...(h1 ? { h1 } : {}) } } : {}),
    ...((webSearch ?? 0) > 0 || (webFetch ?? 0) > 0 ? { serverTools: { ...(webSearch ? { webSearch } : {}), ...(webFetch ? { webFetch } : {}) } } : {}),
  };
};

export const anthropic: Provider & StreamShape = {
  id: "anthropic",
  label: "Anthropic (Claude Code subscription)",
  /**
   * EXCLUSIVE. The docs state the identity outright: "total_input_tokens =
   * cache_read_input_tokens + cache_creation_input_tokens + input_tokens", and define the
   * input counter as "Number of input tokens which were not read from or used to create a
   * cache (that is, tokens after the last cache breakpoint)".
   */
  usageBasis: "exclusive",
  /**
   * Explicit breakpoints: `cache_control` marks the end of the reusable prefix, and "Prompt
   * caching references the entire prompt - tools, system, and messages (in that order) up
   * to and including the block designated with cache_control." That is the mechanism this
   * gateway drives — it forwards the caller's own cache_control blocks untouched, which is
   * why CallOpts.systemBlocks exists at all (flattening the system prompt to a string lost
   * every marker). The vendor also offers a top-level automatic mode; this gateway does not
   * substitute it for the caller's explicit placement.
   *
   * minTokens 512 is the LOWEST floor across active models, and the floor is NOT monotonic
   * in version: 512 for Opus 5 / Fable 5 / Fable 5.1 / Mythos 5(.1), 1,024 for Opus 4.8 and
   * Sonnet 5 / 4.6 / 4.5, 2,048 for Opus 4.7, 4,096 for Opus 4.6 / 4.5 and Haiku 4.5. So
   * this number is a necessary condition, not a sufficient one: below it NOTHING caches
   * ("Shorter prompts cannot be cached, even if marked with cache_control … and no error is
   * returned"), while at or above it the answer is per-MODEL. A per-provider scalar cannot
   * express a non-monotonic per-model function, and the honest choice is the one number
   * that is true for every model rather than one that is wrong for half of them.
   *
   * ttlMs 5 minutes: "Currently, \"ephemeral\" is the only supported cache type, which by
   * default has a 5-minute lifetime", refreshed free on every hit. A 1-hour duration is
   * opt-in per request via `cache_control.ttl` at a higher write price — a caller's choice,
   * not this vendor's default, so the default is what is declared here.
   */
  cache: { kind: "explicit-breakpoint", minTokens: 512, ttlMs: 5 * 60_000, identity: "cache_control" },
  probe() {
    const raw = readAnthropicRaw();
    const t = raw?.json?.claudeAiOauth;
    if (!t?.accessToken) {
      return { connected: false, detail: IS_MAC ? "no Keychain entry / cred file" : `no ${anthropicCredFile().replace(HOME, "~")}`, loginHint: "run `claude` and log in" };
    }
    const exp = t.expiresAt ? stampZ(t.expiresAt) : "unknown";
    const stale = t.expiresAt && t.expiresAt < Date.now();
    return {
      connected: !stale,
      detail: stale ? `token expired (${exp})` : `${raw!.source} · expires ${exp}${t.subscriptionType ? ` · ${t.subscriptionType}` : ""}`,
      loginHint: stale ? "run `claude` once to refresh the token" : "",
    };
  },
  creds() {
    const raw = readAnthropicRaw();
    const t = raw?.json?.claudeAiOauth;
    if (!t?.accessToken) throw new Error(`no Claude subscription credential (${IS_MAC ? "Keychain" : anthropicCredFile()}) — run \`claude\` and log in first.`);
    if (t.expiresAt && t.expiresAt < Date.now()) throw new Error("Claude OAuth token expired — run `claude` once to refresh it.");
    return { token: t.accessToken, expiresAt: t.expiresAt, source: raw!.source };
  },
  /** U-1: the Keychain/file well, re-read once, before a refusal becomes a 401. */
  refreshCreds() { return readAnthropicRaw.refresh(); },
  credFp() {
    const t = readAnthropicRaw()?.json?.claudeAiOauth;
    if (!t?.accessToken) return { cred: "absent", ident: "absent", exp: 0 };
    const exp = Number(t.expiresAt) || 0;
    return { cred: `${h12(t.accessToken)}:${exp}`, ident: h12(String(t.refreshToken ?? t.accessToken)), exp };
  },
  efforts: (m) => m.efforts ?? ANTHROPIC_EFFORTS,
  build(m, turns, o, c) {
    const betas = [env("APIPLAN_OAUTH_BETA", "oauth-2025-04-20")];
    if (o.oneM) betas.push("context-1m-2025-08-07");
    if (o.fast) betas.push("fast-mode-2026-02-01");
    // system[0] must be the Claude Code identity line: the subscription token is
    // only accepted for Claude Code traffic. The user's prompt is appended after.
    const system: any[] = [{ type: "text", text: env("APIPLAN_IDENTITY", "You are Claude Code, Anthropic's official CLI for Claude.") }];
    // Native Anthropic blocks pass through whole. The API adapter sanitizes request-bound
    // proxy metadata before it reaches this provider; direct provider callers retain the
    // exact blocks they supplied.
    if (o.systemBlocks?.length) system.push(...o.systemBlocks);
    else if (o.system) system.push({ type: "text", text: o.system });

    const placed = placeSystemTurns(turns, MIDCONV_SYSTEM(m.id));
    const body: any = { model: m.id, system, messages: placed.map(toAnthropicMsg) };
    if (o.promptCacheKey) body.metadata = { user_id: o.promptCacheKey };
    if (o.fast) body.speed = "fast";
    // Anthropic is the native shape: tools go out as they came in.
    if (o.tools?.length) {
      body.tools = o.tools.map(toAnthropicTool);
      if (o.toolChoice) body.tool_choice = toAnthropicToolChoice(o.toolChoice);
    }

    if (MODERN_THINKING(m.id)) {
      // `thinking: {type: "disabled"}` is NOT universally accepted, so thinkOff resolves
      // against the per-model table BEFORE it can become a field. Two classes of id reject
      // it, each with a documented substitute; everywhere else it goes out as asked.
      const alwaysOn = !!o.thinkOff && THINKING_ALWAYS_ON(m.id);
      const overCeiling = !!o.thinkOff && !alwaysOn && NO_DISABLED_ABOVE_HIGH(m.id) && !!o.effort && !!ABOVE_HIGH[o.effort];
      // The caller asked to stop paying for thinking, and on both rejecting classes the
      // vendor answers with effort rather than a thinking field. An always-on model has no
      // "off" at all, so the faithful reading of thinkOff is the least thinking it will do
      // — the vendor's own substitute, "use lower `effort` levels to control token cost
      // instead" — hence `low`, deliberately overriding a higher effort the caller paired
      // with it, because the two are contradictory and thinkOff is the more specific ask.
      // Over Opus 5's ceiling the vendor lists "Lower the effort level, or leave thinking
      // on"; the first keeps the explicit request (no thinking) and only relaxes the
      // implicit one, so effort steps down to the highest level that still accepts it.
      const effort = alwaysOn ? "low" : overCeiling ? "high" : o.effort;
      // On an always-on id this omits `thinking` entirely — "these models think without any
      // configuration". Nothing is lost for a thinkOff caller: `display` already defaults to
      // "omitted" there, so no thinking text comes back either way.
      if (o.thinkOff) { if (!alwaysOn) body.thinking = { type: "disabled" }; }
      else if (effort) body.thinking = o.showThinking ? { type: "adaptive", display: "summarized" } : { type: "adaptive" };
      if (effort) body.output_config = { effort };
      // The EFFECTIVE effort, never the requested one: a body whose output_config says
      // `low` while max_tokens reserved room for `max` would bill a ceiling the request
      // can no longer reach, and the two fields would disagree about the same request.
      body.max_tokens = o.maxTokens ?? (effort && HIGH_EFFORT.has(effort) ? 32000 : 8192);
    } else {
      const budget = o.thinkOff ? 0 : LEGACY_BUDGET[o.effort ?? ""] ?? 0;
      if (budget > 0) betas.push("interleaved-thinking-2025-05-14");
      body.max_tokens = o.maxTokens ?? (budget > 0 ? budget + 8192 : 8192);
      if (budget > 0) body.thinking = { type: "enabled", budget_tokens: budget };
      else if (o.temperature !== undefined) body.temperature = o.temperature;
    }
    return {
      url: `${env("APIPLAN_ANTHROPIC_BASE", "https://api.anthropic.com")}/v1/messages?beta=true`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${c.token}`,
        "anthropic-version": env("APIPLAN_API_VERSION", "2023-06-01"),
        "anthropic-beta": betas.join(","),
        "anthropic-client-platform": "cli",
        "x-app": "cli",
      },
      body,
    };
  },
  /** Anthropic ends a turn with exactly one `message_stop`. Nothing else terminates it. */
  terminal: (ev) => ev?.type === "message_stop",
  delta(ev) {
    if (ev.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta") return { text: ev.delta.text };
      if (ev.delta?.type === "thinking_delta") return { reasoning: ev.delta.thinking };
      // A tool call's arguments arrive as fragments of JSON on the block that opened it.
      if (ev.delta?.type === "input_json_delta") return { toolArgs: { ref: String(ev.index), json: ev.delta.partial_json ?? "" } };
      return {};
    }
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      return { toolStart: { ref: String(ev.index), id: ev.content_block.id, name: ev.content_block.name } };
    }
    // Closes text blocks too; the dialect layer ignores a ref it never opened as a tool.
    if (ev.type === "content_block_stop") return { toolStop: { ref: String(ev.index) } };
    if (ev.type === "message_start") {
      const u = anthropicUsage(ev.message?.usage);
      return { served: ev.message?.model, ...(u ? { usage: u } : {}) };
    }
    // The one event that says WHY generation stopped, and the final output count.
    // Dropping it is what made every reply look like a clean end_turn costing 0 tokens.
    if (ev.type === "message_delta") {
      const d: Delta = {};
      if (typeof ev.delta?.stop_reason === "string") d.stopReason = ev.delta.stop_reason;
      const u = anthropicUsage(ev.usage);
      if (u) d.usage = u;
      return d;
    }
    if (ev.type === "error") return { error: ev.error?.message ?? "stream error", ...(typeof ev.error?.type === "string" ? { errorType: ev.error.type } : {}) };
    return {};
  },
};
function toAnthropicMsg(t: Turn) {
  // A mid-conversation system turn differs from a user turn ONLY in this wire role;
  // placeSystemTurns already proved the position is legal for this model.
  const role = t.isSystem ? "system" : t.role;
  if (t.nativeAnthropicContent) {
    return { role, content: t.nativeAnthropicContent.length ? t.nativeAnthropicContent : " " };
  }
  if (!t.images?.length && !t.toolUses?.length && !t.toolResults?.length) {
    // An empty string here is a 400 upstream, so a blank turn goes as one space.
    return { role, content: t.text || " " };
  }
  const content: any[] = [];
  // Results first: Anthropic requires every tool_result at the head of its turn.
  for (const r of t.toolResults ?? []) {
    content.push({ type: "tool_result", tool_use_id: r.toolUseId, content: r.content ?? "", ...(r.isError ? { is_error: true } : {}) });
  }
  if (t.text) content.push({ type: "text", text: t.text });
  for (const im of t.images ?? []) {
    content.push(im.url
      ? { type: "image", source: { type: "url", url: im.url } }
      : { type: "image", source: { type: "base64", media_type: im.mediaType, data: im.base64 } });
  }
  for (const u of t.toolUses ?? []) {
    content.push({ type: "tool_use", id: u.id, name: u.name, input: u.input ?? {} });
  }
  if (!content.length) content.push({ type: "text", text: " " });
  return { role, content };
}
function toAnthropicTool(t: ToolDef) {
  return t.raw ?? { name: t.name, description: t.description ?? "", input_schema: t.parameters ?? { type: "object", properties: {} } };
}
function toAnthropicToolChoice(c: ToolChoice) {
  if (typeof c === "object") return { type: "tool", name: c.name };
  return c === "required" ? { type: "any" } : c === "none" ? { type: "none" } : { type: "auto" };
}

// ─────────────────────────── OpenAI (Codex / ChatGPT subscription) ───────────────────────────

const codexAuthFile = () => env("APIPLAN_CODEX_AUTH", join(HOME, ".codex", "auth.json"));
function readCodexRaw(): any | null {
  const f = codexAuthFile();
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}
function jwtExp(tok: string): number | undefined {
  try { const p = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString()); return p.exp ? p.exp * 1000 : undefined; } catch { return undefined; }
}
/**
 * THE RESPONSES WIRE SHAPE LIVES IN ITS OWN MODULE, AND THIS RE-EXPORTS IT.
 *
 * These readers were written here, next to the `openai` adapter that first needed them.
 * They now have a SECOND consumer — the grok subscription proxy, whose own catalog declares
 * `api_backend: "responses"` — and importing them from providers-grok.ts made a CYCLE: this
 * file imports the grok provider to put it in PROVIDERS, and that file imported this one for
 * the helpers. That cycle is not a style problem but a temporal-dead-zone CRASH: ESM
 * evaluated providers-grok.ts first, re-entered a providers.ts whose bindings were not yet
 * initialised, and `PROVIDERS = { …, grok }` threw `ReferenceError: Cannot access '…' before
 * initialization` at import time — before a single test could run.
 *
 * So they moved to `./responses-wire.ts`, a LEAF that imports only `type` from here (erased
 * by ESM) plus the two guards in `./wire.ts`. Both adapters now depend on the leaf and
 * neither depends on the other. Copying them into the grok adapter would also have broken
 * the cycle, and would have been the wrong repair: a second parser for one wire shape is how
 * two backends drift into disagreeing about what the same event meant.
 *
 * Re-exported under their historical names — including `openaiErrType`, which the leaf calls
 * `responsesErrType` now that it serves two vendors — so every existing caller is unchanged.
 */
import {
  responsesUsage, responsesStop, fnRef, stripSchemaMeta, toResponsesItems,
  responsesErrType as openaiErrType,
} from "./responses-wire.ts";
// Re-exported from the LOCAL bindings above, not with a second `export … from`: that form
// does not bind locally (the call sites below need `toResponsesItems`), so both statements
// together declare each name twice and Bun rejects the module outright — "Cannot export a
// duplicate function name". One import, one re-export of what it bound.
export { responsesUsage, responsesStop, fnRef, stripSchemaMeta, toResponsesItems, openaiErrType };

/** The Responses `service_tier` to send, or undefined for the backend default. Explicit
 *  option → `fast` → env APIPLAN_SERVICE_TIER. "fast" (the Codex CLI's word) is spelled
 *  "priority" on the wire; any other value passes through so the backend's 400 names it. */
export function openaiServiceTier(o: CallOpts): string | undefined {
  const raw = o.serviceTier ?? (o.fast ? "priority" : undefined) ?? process.env.APIPLAN_SERVICE_TIER;
  const t = raw?.trim().toLowerCase();
  return !t ? undefined : t === "fast" ? "priority" : t;
}

/** Set `detail` on every `input_image` in a Responses input list — message content AND
 *  `function_call_output.output` arrays (tool-result images). A part that already names
 *  its own detail keeps it. Mutates the freshly built items in place. */
export function withImageDetail(input: any[], detail: string): void {
  const tag = (parts: unknown) => {
    if (!Array.isArray(parts)) return;
    for (const p of parts) if (p && typeof p === "object" && (p as any).type === "input_image" && !(p as any).detail) (p as any).detail = detail;
  };
  for (const it of input ?? []) {
    if (it?.type === "message") tag(it.content);
    else if (it?.type === "function_call_output") tag(it.output);
  }
}

export const openai: Provider & StreamShape = {
  id: "openai",
  label: "OpenAI (Codex / ChatGPT subscription)",
  /**
   * INCLUSIVE. The prompt-caching guide's own cost sample computes the ordinary share by
   * SUBTRACTION — "ordinaryInputTokens = inputTokens - cachedTokens - cacheWriteTokens" —
   * which is only meaningful if `input_tokens` already contains both cached parts.
   */
  usageBasis: "inclusive",
  /**
   * Implicit prefix caching: "When prompt_cache_options.mode is implicit, OpenAI places a
   * breakpoint at the end of the latest eligible message." That is the mechanism this
   * gateway drives, and it is the right one here: a client of THIS server sends a growing
   * conversation, not a hand-placed breakpoint, so the vendor's own end-of-latest-message
   * placement is exactly what an appending thread wants. (GPT-5.6+ also accepts explicit
   * `prompt_cache_breakpoint` markers; this gateway places none of its own.)
   *
   * identity `prompt_cache_key` — the field that INFLUENCES which machine serves the
   * request, and nothing more: "Cached states live on individual machines … Set
   * prompt_cache_key to help requests with the same prefix reach the same cache. Keys
   * influence routing; they do not pin requests to a machine or guarantee a cache read hit."
   * api.ts forwards the caller's key, and derives a stable one from model + system + first
   * user turn when a client sends none, so a keyless conversation still gets a consistent
   * routing hint.
   *
   * A KEY ROUTES, IT DOES NOT OWN. Measured: a never-before-used key read a resident prefix
   * 1,339s after a DIFFERENT key wrote it. So a cache entry is not partitioned by key, and
   * two consequences follow for anyone reasoning about this field: a fresh key is NOT a
   * clean-cache condition (an experiment that varies the key is not isolated by it), and a
   * changed key does not invalidate anything. Tuning the key's FORM is a known dead end.
   *
   * minTokens 1,024: "The minimum cacheable prompt length is 1,024 tokens for GPT-5.6 and
   * later and 2,048 tokens for models older than GPT-5.6" — again the lowest floor across
   * active models, and again necessary rather than sufficient (the older tier needs 2,048,
   * and "You may occasionally get cache hits below 2,048 tokens for some earlier models").
   * Hidden OpenAI system tokens do not count toward it.
   *
   * ttlMs 30 minutes: "Use prompt_cache_options.ttl to control the minimum cache lifetime.
   * The only supported value, 30m, is also the default." Older models instead take
   * `prompt_cache_retention` (in_memory ≈ 5-10 min idle, or 24h) — a per-model spread, so
   * what is declared here is the current default, not a promise for every id.
   *
   * MEASURED ON ONE MODEL, NOT DOCUMENTED — on `gpt-6-astra` the reported `cached_tokens`
   * is QUANTIZED TO 128, and the guide's claim that GPT-5.6+ reports an "Exact eligible
   * boundary" does not hold there. Every non-zero value observed is a clean multiple:
   * 7,424 = 58×128 and 6,144 = 48×128 from a 12-call run against a byte-stable fixture
   * (0 errors; receipt .deify/cache-proof/live-ab.json), plus a production plateau of
   * 10,368 = 81×128. Three arbitrary values landing on multiples by chance is ~5e-7, so the
   * pattern is real — but it is THREE values on ONE id, which says nothing about
   * gpt-5.6-sol / -terra / -luna, gpt-5.5 or the mini ids. Those are UNVERIFIED, and the
   * cheapest falsifier is a small cache read (a low value has the most room to sit off-grid).
   *
   * There is deliberately NO granularity FIELD for it: the vendor publishes no such number,
   * and inventing one would read as documented. It is recorded here so a test comparing a
   * cache read against an expected prefix LENGTH allows a 128-token band on that id instead
   * of flaking — the counters this gateway republishes are untouched either way, since a
   * quantized count is still the count upstream reported. That distinction is the point: it
   * is a test-assertion concern, not an accounting one, and no accounting fault appeared
   * anywhere in the 12 calls.
   *
   * Also measured on that run: a reply NEVER echoes `prompt_cache_key`. The identity is
   * send-only, so it can only be asserted on the OUTBOUND body, never from a response.
   */
  cache: { kind: "implicit-prefix", minTokens: 1024, ttlMs: 30 * 60_000, identity: "prompt_cache_key" },
  probe() {
    const a = readCodexRaw();
    if (!a) return { connected: false, detail: `no ${codexAuthFile().replace(HOME, "~")}`, loginHint: "run `codex` and log in" };
    const tok = a?.tokens?.access_token;
    if (!tok) {
      return a.OPENAI_API_KEY
        ? { connected: false, detail: "API-key mode, not a ChatGPT subscription", loginHint: "log in with ChatGPT inside `codex`" }
        : { connected: false, detail: "auth.json has no tokens.access_token", loginHint: "run `codex` and log in" };
    }
    const exp = jwtExp(tok);
    const stale = exp !== undefined && exp < Date.now();
    const when = exp ? stampZ(exp) : "unknown";
    return {
      connected: !stale,
      detail: stale ? `token expired (${when})` : `${codexAuthFile().replace(HOME, "~")} · ${a.auth_mode ?? "chatgpt"} · expires ${when}`,
      loginHint: stale ? "run `codex` once to refresh the token" : "",
    };
  },
  creds() {
    const a = readCodexRaw();
    if (!a) throw new Error(`no ${codexAuthFile()} — run \`codex\` and log in first.`);
    const t = a.tokens;
    if (!t?.access_token) throw new Error(a.OPENAI_API_KEY ? "auth.json is API-key mode, not a ChatGPT subscription." : "auth.json has no tokens.access_token — run `codex` and log in.");
    const exp = jwtExp(t.access_token);
    if (exp && exp < Date.now()) throw new Error("Codex OAuth token expired — run `codex` once to refresh it.");
    return { token: t.access_token, account: t.account_id ?? a.account_id, expiresAt: exp, source: codexAuthFile().replace(HOME, "~") };
  },
  credFp() {
    const a = readCodexRaw();
    const tok = a?.tokens?.access_token;
    if (!tok) return { cred: "absent", ident: "absent", exp: 0 };
    const exp = jwtExp(tok) ?? 0;
    return { cred: `${h12(tok)}:${exp}`, ident: h12(String(a.tokens.refresh_token ?? a.tokens.account_id ?? a.account_id ?? tok)), exp };
  },
  efforts: (m) => m.efforts ?? ["low", "medium", "high", "xhigh"],
  build(m, turns, o, c) {
    const body: any = {
      model: m.id,
      instructions: o.system ?? "",
      input: turns.flatMap(toResponsesItems),
      store: false,
      stream: true,
      ...(o.promptCacheKey ? { prompt_cache_key: o.promptCacheKey } : {}),
    };
    // Thinking OFF has no field of its own on this wire: the faithful reading is the LEAST
    // reasoning the model accepts — the bottom of its own ladder (`none` on gpt-6-sol/luna,
    // `low` on gpt-6-astra, which 400s `none` live). It overrides a paired higher effort,
    // exactly as the Anthropic adapter does: the two are contradictory and thinkOff is the
    // more specific ask. An empty ladder leaves the backend default untouched.
    const effort = o.thinkOff ? (openai.efforts(m)[0] ?? o.effort) : o.effort;
    if (effort) body.reasoning = { effort, ...(o.showThinking ? { summary: "auto" } : {}) };
    const tier = openaiServiceTier(o);
    if (tier) body.service_tier = tier;
    const detail = o.imageDetail ?? process.env.APIPLAN_IMAGE_DETAIL;
    if (detail) withImageDetail(body.input, detail);
    // No max_output_tokens: the codex backend rejects it outright with
    // "Unsupported parameter: max_output_tokens" (400). Sending it broke every call
    // that carried a length cap — including any API client that sets max_tokens by
    // default, which is most of them.
    // Caller tools ride as Responses-API function tools in the FLAT shape (type/name/
    // description/parameters at the top level) — the exact shape this same backend was
    // observed to accept live on 2026-08-27, and the one the Codex CLI itself exchanges
    // here (its rollout files record `function_call` / `function_call_output` items).
    // `strict` is never set: Claude Code's schemas use anyOf/const/default, which strict
    // mode forbids outright. `$schema` is pruned — it is JSON-Schema framing, not a
    // parameter schema, and this backend is inconsistent about tolerating it.
    if (o.tools?.length) {
      body.tools = [...(body.tools ?? []), ...o.tools.map((t) => ({
        type: "function", name: t.name, description: t.description ?? "",
        parameters: stripSchemaMeta(t.parameters) ?? { type: "object", properties: {} },
      }))];
      if (o.toolChoice) {
        body.tool_choice = typeof o.toolChoice === "object" ? { type: "function", name: o.toolChoice.name } : o.toolChoice;
      }
    }
    // Drawing runs as a built-in tool on the SAME subscription endpoint as chat —
    // verified live: the backend returns base64 in an image_generation_call.
    if (o.genImage) {
      // The model — not the image backend — is what rewrites a drawing prompt: it
      // decides the tool-call arguments, which is why `prompt used:` differs from what
      // you typed. --raw removes that liberty; the default keeps it, because the
      // rewrite genuinely helps a terse prompt.
      if (o.rawPrompt) {
        body.instructions = (o.system ? o.system + "\n\n" : "") +
          "Call the image_generation tool exactly once. Its `prompt` argument MUST be the user's " +
          "message copied character for character — do not rewrite, expand, translate, summarise, " +
          "reorder, add style words, or add detail of any kind. Reply with no text.";
      }
      const tool: any = { type: "image_generation" };
      if (o.imageSize) tool.size = o.imageSize;
      if (o.imageQuality) tool.quality = o.imageQuality;
      body.tools = [...(body.tools ?? []), tool];
    }
    return {
      url: `${env("APIPLAN_OPENAI_BASE", "https://chatgpt.com")}${env("APIPLAN_RESPONSES_PATH", "/backend-api/codex/responses")}`,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${c.token}`,
        "chatgpt-account-id": c.account ?? "",
        originator: env("APIPLAN_ORIGINATOR", "codex_cli_rs"),
        // Keep upstream routing on the same stable identity as the prompt cache. A random
        // UUID here made every OM turn look like a brand-new conversation to Codex.
        session_id: o.promptCacheKey ?? crypto.randomUUID(),
      },
      body,
    };
  },
  /** The Responses stream ends on the response object being reported final — completed,
   *  cut short (incomplete), or failed. A body that stops before one of these arrived was
   *  truncated in transit. */
  terminal: (ev) => ev?.type === "response.completed" || ev?.type === "response.incomplete"
                 || ev?.type === "response.failed" || ev?.type === "response.done",
  delta(ev) {
    switch (ev.type) {
      case "response.created": case "response.in_progress": return { served: ev.response?.model };
      case "response.output_text.delta": return { text: ev.delta ?? "" };
      // Function calling on the Responses shape: the item opens carrying call_id + name,
      // the arguments arrive as a JSON text stream, then the item is done and repeats
      // them whole. `ev.item.id` is the handle the argument events quote as `item_id`.
      case "response.output_item.added":
        if (ev.item?.type === "function_call") {
          return { toolStart: { ref: fnRef(ev), id: ev.item.call_id ?? ev.item.id, name: ev.item.name } };
        }
        return {};
      case "response.function_call_arguments.delta":
        return { toolArgs: { ref: fnRef(ev), json: ev.delta ?? "" } };
      case "response.function_call_arguments.done":
        return { toolStop: { ref: fnRef(ev) } };
      // Image generation: progress first, then the finished base64 — which arrives
      // either on the item-done event or inside the final response's output list.
      case "response.image_generation_call.in_progress": return { progress: "drawing…" };
      case "response.image_generation_call.generating": return { progress: "rendering…" };
      case "response.image_generation_call.partial_image": return { progress: "partial…" };
      case "response.image_generation_call.completed":
        return { imageB64: ev.result ?? ev.item?.result, revisedPrompt: ev.revised_prompt ?? ev.item?.revised_prompt };
      case "response.output_item.done":
        if (ev.item?.type === "image_generation_call") {
          return { imageB64: ev.item.result, revisedPrompt: ev.item.revised_prompt };
        }
        // The backend's own final copy of the arguments. Marked `full` so it replaces a
        // partial accumulation, and is discarded when the fragments already arrived.
        if (ev.item?.type === "function_call") {
          return {
            toolArgs: { ref: fnRef(ev), json: ev.item.arguments ?? "", full: true },
            toolStop: { ref: fnRef(ev) },
          };
        }
        return {};
      case "response.incomplete":
      case "response.completed": {
        for (const it of ev.response?.output ?? []) {
          if (it?.type === "image_generation_call" && it.result) return { imageB64: it.result, revisedPrompt: it.revised_prompt };
        }
        const u = responsesUsage(ev.response);
        return { stopReason: responsesStop(ev.response), ...(u ? { usage: u } : {}) };
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": return { reasoning: ev.delta ?? "" };
      case "response.failed": return { error: ev.response?.error?.message ?? "response failed", ...openaiErrType(ev.response?.error) };
      case "response.error": case "error": return { error: ev.error?.message ?? ev.message ?? "stream error", ...openaiErrType(ev.error) };
      default: return {};
    }
  },
  canGenerateImages: true,
  voices: REALTIME_VOICES,
  /**
   * Read-aloud — the ChatGPT product's own TTS, and the ONE speech path the
   * subscription really does cover. `GET /backend-api/synthesize` returns audio/aac
   * in the nine ChatGPT product voices for a message that already exists in the
   * account. Measured working 2026-08-02.
   *
   * It reads a stored message and only that: there is no text parameter (probed —
   * text/message/content/input/prompt/ssml are all ignored), and putting new text
   * into the account means POST /backend-api/conversation, which is behind ChatGPT's
   * anti-automation proof-of-work sentinel (403 "Unusual activity"). So this speaks
   * what is in your history; arbitrary text still needs speak() or --local.
   */
  async readAloud(o: AloudOpts) {
    const c = openai.creds();
    const H = { authorization: `Bearer ${c.token}`, ...(c.account ? { "chatgpt-account-id": c.account } : {}) };
    const get = (u: string) => fetch(`https://chatgpt.com${u}`, { headers: H, signal: AbortSignal.timeout(45000) });

    let { conversation, message } = o;
    let spoke = "";
    if (!conversation || !message) {
      // Newest conversation, newest assistant message in it. `aloud` names what it
      // does, so needing a second flag to say "yes, the last one" was friction for
      // nothing — but this is the ONLY path that reads stored history, and no other
      // command in apiplan touches it.
      if (!conversation) {
        const list: any = await (await get("/backend-api/conversations?limit=1&offset=0")).json();
        conversation = list?.items?.[0]?.id;
        if (!conversation) throw new Error("no ChatGPT conversations on this account to read aloud.");
      }
      const det: any = await (await get(`/backend-api/conversation/${conversation}`)).json();
      const turns = Object.values<any>(det?.mapping ?? {})
        .map((n) => n?.message)
        .filter((m) => m?.author?.role === "assistant" && m?.content?.parts?.length)
        .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
      const last = turns[turns.length - 1];
      if (!last) throw new Error(`conversation ${conversation} has no assistant message to read.`);
      message = last.id;
      spoke = last.content.parts.filter((p: any) => typeof p === "string").join(" ").trim();
    }
    const voice = o.voice || (await openai.aloudVoices!()).selected;
    const format = o.format || "aac";
    const res = await get(`/backend-api/synthesize?conversation_id=${conversation}&message_id=${message}&voice=${encodeURIComponent(voice)}&format=${encodeURIComponent(format)}`);
    if (!res.ok) {
      const d = (await res.text()).slice(0, 200);
      throw new Error(`read-aloud failed (${res.status}): ${d}\n  conversation=${conversation} message=${message}`);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "audio/aac", spoke, voice };
  },
  /** The account's real ChatGPT voices — asked live, never a hardcoded guess. */
  async aloudVoices() {
    const c = openai.creds();
    const r = await fetch("https://chatgpt.com/backend-api/settings/voices", {
      headers: { authorization: `Bearer ${c.token}`, ...(c.account ? { "chatgpt-account-id": c.account } : {}) },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`could not list ChatGPT voices (${r.status})`);
    const j: any = await r.json();
    return { selected: j?.selected ?? "cove", voices: (j?.voices ?? []).map((v: any) => v.voice).filter(Boolean) };
  },
  /**
   * Speech from arbitrary text, on the subscription — no API key, no conversation,
   * nothing stored. The realtime endpoint accepts the ChatGPT OAuth token over a
   * plain WebSocket (the GA shape: send no `OpenAI-Beta` header, or it answers
   * `beta_api_shape_disabled`), and streams back raw PCM16 at 24 kHz, which needs a
   * 44-byte WAV header and no codec at all.
   *
   * Measured 2026-08-02: `/v1/audio/speech` still refuses a subscription token (429
   * "account is not active"). A REST speech backend must be configured explicitly.
   */
  async speak(o: SpeechOpts): Promise<SpeechResult> {
    const base = process.env.APIPLAN_TTS_BASE;
    if ((o.liveModel || process.env.APIPLAN_LIVE_MODEL) && base) throw new Error("--live-model selects subscription speech; unset APIPLAN_TTS_BASE to use it.");
    if (!base) return speakRealtime(openai.creds(), o);
    const key = process.env.OPENAI_API_KEY || process.env.APIPLAN_OPENAI_API_KEY;
    const url = base || env("APIPLAN_OPENAI_API_BASE", "https://api.openai.com");
    const model = o.model || env("APIPLAN_TTS_MODEL", "gpt-4o-mini-tts");
    const res = await fetch(`${url}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, voice: o.voice, input: o.text, response_format: o.format, ...(o.speed ? { speed: o.speed } : {}) }),
    });
    if (!res.ok) {
      let detail = (await res.text()).slice(0, 300);
      try { detail = JSON.parse(detail)?.error?.message ?? detail; } catch {}
      throw new Error(`speech failed (${res.status}) via ${url}: ${detail}`);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") || `audio/${o.format}` };
  },
  /** Voices the chosen backend actually serves (local server asked live, else OpenAI's). */
  async listVoices(): Promise<{ backend: string; voices: string[] }> {
    const base = process.env.APIPLAN_TTS_BASE;   // only when explicitly configured
    if (!base) return { backend: "realtime (your ChatGPT subscription)", voices: REALTIME_VOICES };
    if (base) {
      try {
        const r = await fetch(`${base}/v1/audio/voices`);
        const j: any = await r.json();
        const v = Array.isArray(j?.voices) ? j.voices : Array.isArray(j) ? j : Object.keys(j ?? {});
        if (v.length) return { backend: base, voices: v };
      } catch {}
    }
    return { backend: "api.openai.com (needs OPENAI_API_KEY)", voices: openai.voices ?? [] };
  },
};

/** A tool_result content may be a string or a block array; these backends take text. */
export function flatText(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text ?? "" : `[${b?.type ?? "block"}]`)).join("\n");
  return c == null ? "" : JSON.stringify(c);
}

// ─────────────────────────── Google (Antigravity / Gemini Code Assist subscription) ───────────────────────────

/**
 * The credential is the Antigravity CLI's OAuth token, kept in the macOS Keychain under
 * service "gemini", account "antigravity" — the well `agy` itself reads (its own log:
 * `ChainedAuth: authenticated via keyring`). `security` hands it back wrapped as
 * `go-keyring-base64:<b64>`, and the base64 decodes to
 * `{auth_method, token:{access_token, refresh_token, expiry, token_type}}`.
 *
 * NOT ~/.gemini/oauth_creds.json: that file authenticates but its account sits off the
 * eligible tier server-side (loadCodeAssist → ineligibleTiers free-tier
 * UNSUPPORTED_CLIENT), so generate answers 403. Verified live 2026-08-27: the Keychain
 * token returned model text through exactly the request built below.
 *
 * Behaviour under the conditions that actually bite, measured on this rig:
 *  · CONCURRENT READERS — 12 simultaneous `security` reads all returned the identical 691
 *    bytes, exit 0, ~17ms each, no approval prompt. Reading is safe to do per call.
 *  · THE VENDOR REWRITING IT MID-READ — `agy` writes with `security add-generic-password -U`
 *    (an in-place UPDATE, string lifted from its binary), so an hourly refresh swaps the
 *    value transactionally: a reader gets the old token or the new one, never half of one.
 *  · THE ITEM VANISHING — sign-out uses `delete-generic-password`, so an ACCOUNT SWITCH is
 *    delete-then-add and the item is genuinely missing for an instant (`security` exit 44).
 *  · A HALF-WRITTEN VAULT — only reachable through APIPLAN_GOOGLE_CRED_FILE, which is a
 *    plain file with no atomic-rename guarantee from whoever wrote it.
 * Hence: bounded retries, and three states kept apart instead of one nullable read.
 *
 * The source is pluggable so no run is ever blocked on a Keychain prompt: point
 * APIPLAN_GOOGLE_CRED_FILE at a file holding either the decoded JSON or the raw
 * `go-keyring-base64:` dump, and the Keychain is never touched.
 */

const GK_PREFIX = "go-keyring-base64:";
/**
 * How long to ride out a millisecond-wide window before giving a verdict. A switch is
 * delete-then-add and a cred file can be caught mid-write; both windows are milliseconds.
 * Two extra reads cost ~160ms on a genuinely broken login and buy a correct verdict on a
 * healthy one — the wrong verdict here sends a user to re-authenticate an account that
 * was never logged out.
 */
const GOOGLE_TRIES = 3, GOOGLE_TRY_MS = 80;

/**
 * What one read of the credential well found. The three states demand OPPOSITE answers,
 * so they are never collapsed into `null` the way a single-file provider can afford to:
 * `absent` → log in · `unreadable` → do NOT log in, fix the read (a re-login would replace
 * a credential that is probably fine, and on a shared machine could switch the account) ·
 * `ok` → use it.
 */
type GoogleRead =
  | { state: "ok"; json: any; source: string }
  | { state: "absent"; source: string; detail: string }
  | { state: "unreadable"; source: string; detail: string };

function decodeGoogleBlob(s: string): any | null {
  const t = s.trim();
  if (!t) return null;
  const body = t.startsWith(GK_PREFIX) ? Buffer.from(t.slice(GK_PREFIX.length), "base64").toString("utf8") : t;
  try { const j = JSON.parse(body); return j && typeof j === "object" ? j : null; } catch { return null; }
}

/** The file well. No `security`, no spawn — a small readFileSync, sync on every host. */
function readGoogleFile(file: string): GoogleRead {
  // A file the operator pointed at is AUTHORITATIVE: never silently fall back to the
  // Keychain, which may well hold a DIFFERENT google account. A wrong account answering
  // is worse than no answer — it spends someone else's quota and attributes the reply
  // to an identity that never made the call.
  const shown = file.replace(HOME, "~");
  if (!existsSync(file)) return { state: "absent", source: shown, detail: "APIPLAN_GOOGLE_CRED_FILE points at nothing" };
  let raw = "";
  try { raw = readFileSync(file, "utf8"); }
  catch (e: any) { return { state: "unreadable", source: shown, detail: `read failed: ${e?.code ?? e?.message ?? e}` }; }
  const j = decodeGoogleBlob(raw);
  return j ? { state: "ok", json: j, source: shown }
           : { state: "unreadable", source: shown, detail: raw.trim() ? "not the credential JSON — a file caught mid-write reads exactly like this" : "empty file" };
}

const googleKcService = () => env("APIPLAN_GOOGLE_KEYCHAIN_SERVICE", "gemini");
const googleKcAccount = () => env("APIPLAN_GOOGLE_KEYCHAIN_ACCOUNT", "antigravity");
const googleKcShown = () => `Keychain (${googleKcService()}/${googleKcAccount()})`;
const googleKcArgs = () => ["find-generic-password", "-s", googleKcService(), "-a", googleKcAccount(), "-w"];

/** One `security` answer -> a GoogleRead. Shared by the sync and async readers so the exit
 *  codes can never be interpreted two different ways. */
function googleFromRun(r: SecRun): GoogleRead {
  const shown = googleKcShown();
  // 44 is SecKeychainSearchCopyNext's "item not found" — the ONLY exit code that means
  // signed out. Every other failure (locked Keychain, denied prompt, no `security`, and
  // now this wrapper's own timeout) is a read fault, and telling a user to log in because
  // of one would be a lie.
  if (r.exitCode === 44) return { state: "absent", source: shown, detail: "no such Keychain item — signed out, or mid account-switch" };
  if (r.exitCode !== 0) return { state: "unreadable", source: shown, detail: `security exited ${r.exitCode}: ${(r.stderr?.toString() ?? "").trim().slice(0, 120) || "no detail"}` };
  const j = decodeGoogleBlob(r.stdout?.toString() ?? "");
  return j ? { state: "ok", json: j, source: shown }
           : { state: "unreadable", source: shown, detail: "the Keychain value is not the go-keyring JSON blob" };
}

const googleNoKeychain = (): GoogleRead =>
  ({ state: "absent", source: "APIPLAN_GOOGLE_CRED_FILE", detail: "no Keychain off macOS — export the credential and point APIPLAN_GOOGLE_CRED_FILE at it" });

function readGoogleOnce(): GoogleRead {
  const file = env("APIPLAN_GOOGLE_CRED_FILE", "");
  if (file) return readGoogleFile(file);
  if (!IS_MAC) return googleNoKeychain();
  // probe() promises never to throw, and spawnSync does when `security` cannot be run at
  // all (absent from PATH, or a sandbox denying exec) — that is a read fault, not a logout.
  try { return googleFromRun(securitySync(googleKcArgs())); }
  catch (e: any) { return { state: "unreadable", source: googleKcShown(), detail: `could not run \`security\`: ${e?.message ?? e}` }; }
}

async function readGoogleOnceAsync(): Promise<GoogleRead> {
  const file = env("APIPLAN_GOOGLE_CRED_FILE", "");
  if (file) return readGoogleFile(file);
  if (!IS_MAC) return googleNoKeychain();
  try { return googleFromRun(await securityAsync(googleKcArgs())); }
  catch (e: any) { return { state: "unreadable", source: googleKcShown(), detail: `could not run \`security\`: ${e?.message ?? e}` }; }
}

/** Read, retrying every non-ok state: each one can be a momentary artefact — a file caught
 *  mid-write, or the delete half of a sign-out/sign-in pair. A settled verdict is worth the
 *  ~160ms; a wrong one costs a needless re-login.
 *
 *  F9-2: the SLEEPING retry belongs to the CLI, a one-shot process with nothing else to do.
 *  On a resident host Bun.sleepSync stops the single thread dead, so the retries happen in
 *  readGoogleFresh() below instead — asynchronously, where 160 ms of waiting costs nobody
 *  anything. Same policy, same three tries; only the thread it burns is different. */
function readGoogleSync(): GoogleRead {
  let r = readGoogleOnce();
  if (!providerRuntime.syncRefresh) return r;
  for (let i = 1; i < GOOGLE_TRIES && r.state !== "ok"; i++) { Bun.sleepSync(GOOGLE_TRY_MS); r = readGoogleOnce(); }
  return r;
}
async function readGoogleFresh(): Promise<GoogleRead> {
  let r = await readGoogleOnceAsync();
  for (let i = 1; i < GOOGLE_TRIES && r.state !== "ok"; i++) { await Bun.sleep(GOOGLE_TRY_MS); r = await readGoogleOnceAsync(); }
  return r;
}
/** F9-2: on a resident host this is a snapshot read; in the CLI it is the direct read. */
const readGoogle = residentCache(readGoogleSync, readGoogleFresh);

/**
 * Pull the access token, its expiry (ms) and a STABLE account fingerprint out of whichever
 * blob shape arrived. The fingerprint hashes the REFRESH token, never the access token: a
 * refresh mints a new access token for the SAME account every hour, so an access-token hash
 * would report every refresh as an account switch and every switch would look identical to
 * a refresh. It stays a truncated hash — the credential itself must never reach a log, a
 * --dry-run dump or a bus line.
 */
function googleToken(json: any): { access?: string; expiresAt?: number; account?: string } {
  const t = json?.token ?? json;
  const access = typeof t?.access_token === "string" && t.access_token ? t.access_token : undefined;
  const exp = t?.expiry ?? t?.expiry_date ?? t?.expires_at;
  const expiresAt = typeof exp === "number" ? (exp > 1e12 ? exp : exp * 1000)
                  : typeof exp === "string" ? (Date.parse(exp) || undefined) : undefined;
  const rt = typeof t?.refresh_token === "string" ? t.refresh_token : "";
  const account = rt ? "g:" + createHash("sha256").update(rt).digest("hex").slice(0, 12) : undefined;
  return { access, expiresAt, account };
}

/**
 * Clock-expiry is a HINT; the server is the authority on whether a token works. Refusing a
 * live token blocks a user who is not logged out — and `agy` rewrites the item ~4s before
 * expiry, so the boundary is exactly where a refusal would be wrong. Attempting a dead one
 * costs a single ~0.3s 401 that says so precisely. So the boundary fails OPEN, and only a
 * token stale beyond this grace earns a hard "run `agy`".
 */
const GOOGLE_STALE_GRACE_MS = () => Number(env("APIPLAN_GOOGLE_STALE_GRACE_MS", "90000")) || 90000;

/** The license discriminator (proven live): the server grants the subscription tier by the
 *  CLIENT identity in the User-Agent. A generic UA on the identical token and body answers
 *  403 SUBSCRIPTION_REQUIRED; the Antigravity CLI's UA answers with model text. */
const GOOGLE_UA = () => env("APIPLAN_GOOGLE_UA", "antigravity/cli/1.1.22 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)");
/** The `daily-` host prefix is what `agy` uses (161/161 URLs in its logs). The binary also
 *  carries a "dynamically updating CloudCode URL" path, so the host may move server-side —
 *  hence an env override rather than a constant nobody can reach. */
const GOOGLE_BASE = () => env("APIPLAN_GOOGLE_BASE", "https://daily-cloudcode-pa.googleapis.com");
const GOOGLE_PROJECT = () => env("APIPLAN_GOOGLE_PROJECT", "default-cli-project");
/** Media calls use the product project agy sends, which is distinct from the placeholder
 * project accepted by ordinary chat. Both remain overridable for enterprise deployments. */
const GOOGLE_MEDIA_PROJECT = () => env("APIPLAN_GOOGLE_MEDIA_PROJECT", "aicode-consumers");
const GOOGLE_MEDIA_CACHE = () => join(STATE_DIR, "models.google.media.json");
const GOOGLE_IMAGE_FALLBACK = "gemini-3.1-flash-image";
const GOOGLE_BLOCKED = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);

type GoogleMediaCatalog = {
  fetched_at?: number;
  imageGenerationModelIds?: string[];
  audioTranscriptionModelIds?: string[];
  supportedMimeTypes?: Record<string, string[]>;
};

/** The live catalog agy itself consumes. Besides preventing stale model names, this is the
 * authority for the crucial distinction between input and output capability: a chat model's
 * `supportsVideo` means it can WATCH video; only imageGenerationModelIds names a media
 * generator. The current catalog has no video- or music-generation id. */
export async function refreshGoogleCatalog(): Promise<{ count: number; imageModels: string[] }> {
  await google.prepare?.();
  const c = google.creds();
  const res = await fetch(`${GOOGLE_BASE()}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${c.token}`, "user-agent": GOOGLE_UA() },
    body: JSON.stringify({ project: GOOGLE_MEDIA_PROJECT() }),
  });
  if (!res.ok) throw new Error(`fetchAvailableModels answered ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const body: any = await res.json();
  const grouped = new Map<string, { id: string; label: string; efforts: string[] }>();
  const mime: Record<string, string[]> = {};
  for (const [wire, info] of Object.entries<any>(body?.models ?? {})) {
    const hit = wire.match(/^(gemini-[\d.]+-(?:flash|pro))-(low|medium|high)$/);
    if (!hit) continue;
    const base = hit[1], effort = hit[2];
    const row = grouped.get(base) ?? {
      id: base,
      label: String(info?.displayName ?? base).replace(/\s*\((?:Low|Medium|High)\)\s*$/i, ""),
      efforts: [],
    };
    if (!row.efforts.includes(effort)) row.efforts.push(effort);
    grouped.set(base, row);
    const supported = Object.keys(info?.supportedMimeTypes ?? {}).filter((k) => info.supportedMimeTypes[k]);
    if (supported.length) mime[base] = [...new Set([...(mime[base] ?? []), ...supported])].sort();
  }
  const list = [...grouped.values()].map((m) => ({
    ...m,
    efforts: GOOGLE_EFFORTS.filter((e) => m.efforts.includes(e)),
  }));
  if (!list.length) throw new Error("fetchAvailableModels returned no addressable Gemini chat models");
  saveModels("google", list);
  const imageModels = Array.isArray(body?.imageGenerationModelIds) ? body.imageGenerationModelIds.filter((x: any) => typeof x === "string") : [];
  const catalog: GoogleMediaCatalog = {
    fetched_at: Date.now(), imageGenerationModelIds: imageModels,
    audioTranscriptionModelIds: Array.isArray(body?.audioTranscriptionModelIds) ? body.audioTranscriptionModelIds : [],
    supportedMimeTypes: mime,
  };
  writeJson(GOOGLE_MEDIA_CACHE(), catalog);
  return { count: list.length, imageModels };
}

function googleImageModel(): string {
  const explicit = env("APIPLAN_GOOGLE_IMAGE_MODEL", "");
  if (explicit) return explicit;
  const cached = readJson<GoogleMediaCatalog>(GOOGLE_MEDIA_CACHE(), {});
  return cached.imageGenerationModelIds?.[0] ?? GOOGLE_IMAGE_FALLBACK;
}

/** agy's image tool offers these exact aspect ratios. --size remains useful across providers:
 * a pixel size is reduced to the nearest supported ratio instead of being silently ignored. */
function googleAspectRatio(size?: string): string {
  if (!size) return "1:1";
  if (/^(1:1|2:3|3:2|3:4|4:3|9:16|16:9)$/.test(size)) return size;
  const m = size.match(/^(\d+)x(\d+)$/i);
  if (!m || !+m[1] || !+m[2]) throw new Error(`invalid image size '${size}' — use WxH or 1:1/2:3/3:2/3:4/4:3/9:16/16:9`);
  const ratio = +m[1] / +m[2];
  const choices = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"];
  return choices.reduce((best, v) => {
    const [w, h] = v.split(":").map(Number);
    const [bw, bh] = best.split(":").map(Number);
    return Math.abs(w / h - ratio) < Math.abs(bw / bh - ratio) ? v : best;
  });
}

/** Exact non-streaming request used by agy's native generate_image tool. Kept pure so the
 * contract can be regression-tested without spending image quota. */
export function buildGoogleImageRequest(prompt: string, o: CallOpts, model = googleImageModel()) {
  if (o.imageQuality) throw new Error("--quality is not supported by Antigravity's image endpoint; omit it");
  return {
    project: GOOGLE_MEDIA_PROJECT(),
    requestId: `image_gen/${Date.now()}/${crypto.randomUUID()}/2`,
    request: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { candidateCount: 1, imageConfig: { aspectRatio: googleAspectRatio(o.imageSize) } },
    },
    model,
    userAgent: "antigravity",
    requestType: "image_gen",
  };
}

/** Parse the wrapper returned by v1internal:generateContent and refuse empty-successes. */
export function parseGoogleImageResponse(body: any, requestedModel: string): ImageResult {
  const r = body?.response ?? body ?? {};
  const cand = r.candidates?.[0];
  const part = cand?.content?.parts?.find((p: any) => typeof p?.inlineData?.data === "string");
  if (part?.inlineData?.data) return {
    base64: part.inlineData.data,
    contentType: part.inlineData.mimeType ?? "image/jpeg",
    model: r.modelVersion ?? requestedModel,
  };
  const block = r.promptFeedback?.blockReason ?? cand?.finishReason;
  throw new Error(block ? `image generation stopped: ${block}` : "the Gemini image model returned no image");
}

/**
 * Google speaks gRPC status names, not Anthropic error types. Translating HERE keeps the
 * vendor fact with the vendor: an UNAVAILABLE is an overload a client should retry, and a
 * RESOURCE_EXHAUSTED is a rate limit — neither is the "api_error" they both used to become.
 */
const GOOGLE_STATUS_TYPE: Record<string, string> = {
  RESOURCE_EXHAUSTED: "rate_limit_error", UNAUTHENTICATED: "authentication_error",
  PERMISSION_DENIED: "permission_error", NOT_FOUND: "not_found_error",
  INVALID_ARGUMENT: "invalid_request_error", UNAVAILABLE: "overloaded_error",
  DEADLINE_EXCEEDED: "timeout_error", INTERNAL: "api_error",
};
const googleErrType = (e: any) => {
  const t = GOOGLE_STATUS_TYPE[String(e?.status ?? "")];
  return t ? { errorType: t } : {};
};

// Z2 self-refresh (Lane D) ---------------------------------------------------
const GOOGLE_REFRESH_WINDOW_MS = () => Number(env("APIPLAN_GOOGLE_REFRESH_WINDOW_MS", "300000")) || 300000;
const GOOGLE_TOKEN_URL = () => env("APIPLAN_GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token");

/** Antigravity's OAuth client (id + secret). Preferred from env; otherwise lifted ONCE
 *  from the `agy` binary, the authoritative owner of the credential. Memoized so the
 *  179MB binary is scanned at most once per process. The secret NEVER reaches a log,
 *  a --dry-run dump, or a bus line. */
let _googleOAuthClient: { id: string; secret: string } | null | undefined;
function googleOAuthClient(): { id: string; secret: string } | null {
  if (_googleOAuthClient !== undefined) return _googleOAuthClient;
  const id = env("APIPLAN_GOOGLE_OAUTH_CLIENT_ID", "");
  const secret = env("APIPLAN_GOOGLE_OAUTH_CLIENT_SECRET", "");
  if (id && secret) return (_googleOAuthClient = { id, secret });
  const agy = env("APIPLAN_AGY_BIN", join(HOME, ".local/bin/agy"));
  try {
    const b = readFileSync(agy);
    // The proven pair: the 1071006060591 consumer client + the FIRST of the two
    // concatenated GOCSPX secrets (each is GOCSPX- + 28 chars = 35).
    const idM = b.toString("latin1").match(/1071006060591-[a-z0-9]{20,}\.apps\.googleusercontent\.com/);
    const runM = b.toString("latin1").match(/GOCSPX-[A-Za-z0-9_-]{60,}/);
    if (idM && runM) return (_googleOAuthClient = { id: idM[0], secret: runM[0].slice(0, 35) });
  } catch {}
  return (_googleOAuthClient = null);
}

/** Persist a refreshed credential blob back into the SAME well readGoogleOnce read from,
 *  so the next process/probe/call sees it too. Returns an error string, or null on success. */
function writeGoogleBlob(blob: any): string | null {
  const file = env("APIPLAN_GOOGLE_CRED_FILE", "");
  const body = JSON.stringify(blob);
  if (file) {
    try { writeFileSync(file, body); return null; }
    catch (e: any) { return `cred-file write failed: ${e?.code ?? e?.message ?? e}`; }
  }
  if (!IS_MAC) return "no Keychain off macOS and APIPLAN_GOOGLE_CRED_FILE unset";
  const payload = GK_PREFIX + Buffer.from(body, "utf8").toString("base64");
  try {
    // F9-2: the same hard ceiling the reads got. This one runs on a resident host too (it
    // is reached from the async mint), and a `security` that never returns would pin the
    // single thread here exactly the way it did on the read side.
    const r = securitySync(["add-generic-password", "-U", "-s", googleKcService(), "-a", googleKcAccount(), "-w", payload]);
    return r.exitCode === 0 ? null : r.exitCode === SEC_TIMED_OUT ? "keychain write timed out" : `keychain write exited ${r.exitCode}`;
  } catch (e: any) { return `could not run \`security\`: ${e?.message ?? e}`; }
}

const GOOGLE_REFRESH_TIMEOUT_MS = () => (Number(env("APIPLAN_GOOGLE_REFRESH_TIMEOUT_S", "5")) || 5) * 1000;
/** After a mint FAILS, how long the request path stops trying. Without it a hanging OAuth
 *  endpoint is re-dialled by every single request, and each one pays the timeout again. */
const GOOGLE_REFRESH_COOLDOWN_MS = () => Number(env("APIPLAN_GOOGLE_REFRESH_COOLDOWN_MS", "30000")) || 30000;

/**
 * The newest token THIS PROCESS minted, kept in memory so it is usable the instant it
 * exists — before, and even if, the write-back to the Keychain/file succeeds. Tagged with
 * the account it was minted for, so a credential swap under us can never be served a token
 * belonging to the account that was replaced.
 */
let googleFresh: { access: string; expiresAt: number; account?: string } | null = null;
/** The ONE mint in flight. Concurrent callers share it: N requests, one curl, one token. */
let googleFlight: Promise<{ access: string; expiresAt: number } | null> | null = null;
let googleFailAt = 0;

/** The form body for a refresh, or null when this credential cannot be refreshed at all. */
function googleRefreshForm(read: Extract<GoogleRead, { state: "ok" }>): string | null {
  const tok = read.json?.token ?? read.json;
  const rt = typeof tok?.refresh_token === "string" ? tok.refresh_token : "";
  if (!rt) return null;
  const cli = googleOAuthClient();
  if (!cli) return null;
  return new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: cli.id, client_secret: cli.secret }).toString();
}

/** Take a token-endpoint reply, put the new token where every reader will find it (memory
 *  first, then the well), and answer with it. Shared by the sync and async mints so the two
 *  can never drift. Returns null when the reply carried no access_token. */
function googleApplyMint(read: Extract<GoogleRead, { state: "ok" }>, o: any): { access: string; expiresAt: number } | null {
  const access = typeof o?.access_token === "string" ? o.access_token : "";
  if (!access) return null;
  const expiresAt = Date.now() + (Number(o?.expires_in) || 3600) * 1000;
  const tok = read.json?.token ?? read.json;
  // rebuild the blob preserving shape; refresh_token is unchanged (Google does not return one).
  tok.access_token = access;
  tok.token_type = o?.token_type ?? tok.token_type ?? "Bearer";
  tok.expiry = new Date(expiresAt).toISOString();
  const blob = read.json?.token ? { ...read.json, token: tok } : tok;
  googleFresh = { access, expiresAt, account: googleToken(blob).account };
  writeGoogleBlob(blob); // best-effort persist; even if it fails, callers use the fresh token
  return { access, expiresAt };
}

/** Refresh the Antigravity token in place, SYNCHRONOUSLY (curl via spawnSync) so creds()
 *  stays sync, the same way readGoogleOnce shells out to `security`. Returns the fresh
 *  {access, expiresAt}, or null if refresh could not run (missing refresh_token, no client,
 *  network/oauth failure) — the caller then falls back to the existing stale/throw logic, so
 *  a broken refresh never makes a healthy token worse.
 *
 *  ⚠️ THIS BLOCKS THE CALLER FOR UP TO THE CURL TIMEOUT. That is correct in a CLI and wrong
 *  in a server, so a host with an event loop sets `providerRuntime.syncRefresh = false` and
 *  gets the async path below instead. See the R-1 note on creds(). */
function refreshGoogle(read: Extract<GoogleRead, { state: "ok" }>): { access: string; expiresAt: number } | null {
  const form = googleRefreshForm(read);
  if (!form) return null;
  let r: { exitCode: number; stdout?: any };
  try {
    r = Bun.spawnSync(["curl", "-s", "-m", String(Math.ceil(GOOGLE_REFRESH_TIMEOUT_MS() / 1000)), "-H", "Content-Type: application/x-www-form-urlencoded",
      "--data-binary", form, GOOGLE_TOKEN_URL()], { stderr: "ignore" }) as any;
  } catch { return null; }
  if (r.exitCode !== 0) return null;
  let o: any;
  try { o = JSON.parse(r.stdout?.toString() ?? ""); } catch { return null; }
  return googleApplyMint(read, o);
}

/**
 * The same mint, off the request path — the R-1 fix.
 *
 * ── WHAT WENT WRONG (round four, 2026-08-27) ── the sync mint above sat inside creds(),
 * which sits inside the request path of a SINGLE-THREADED server. One slow OAuth endpoint
 * therefore stalled everything: /health measured at 5.30 s with nothing else served, and up
 * to the full curl timeout of total outage on 8787. A vendor's latency must never become
 * this service's latency.
 *
 * Three properties, and all three are load-bearing:
 *   · ASYNC — `fetch`, so the event loop keeps serving every unrelated request while the
 *     token endpoint takes its time. This is what makes a hanging vendor cost nothing.
 *   · SINGLE-FLIGHT — concurrent callers await ONE promise. Before, five simultaneous
 *     requests each spawned their own curl and each minted a token, four of them wasted.
 *   · COOLDOWN — a failed mint is not retried by the very next request; a dead endpoint
 *     costs one attempt per cooldown window, not one per request.
 * It never throws: a failure leaves the existing token exactly as it was.
 */
function refreshGoogleAsync(read: Extract<GoogleRead, { state: "ok" }>): Promise<{ access: string; expiresAt: number } | null> {
  if (googleFlight) return googleFlight;
  const form = googleRefreshForm(read);
  if (!form) return Promise.resolve(null);
  const p = (async () => {
    try {
      const res = await fetch(GOOGLE_TOKEN_URL(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(GOOGLE_REFRESH_TIMEOUT_MS()),
      });
      if (!res.ok) return null;
      return googleApplyMint(read, await res.json());
    } catch { return null; }
  })();
  googleFlight = p;
  p.then((v) => { if (!v) googleFailAt = Date.now(); }, () => { googleFailAt = Date.now(); })
   .finally(() => { if (googleFlight === p) googleFlight = null; });
  return p;
}

/** The best token this process has: whatever is in the well, unless a mint of the SAME
 *  account produced a longer-lived one that has not landed in the well yet. */
function googleBest(t: { access?: string; expiresAt?: number; account?: string }): { access?: string; expiresAt?: number; account?: string } {
  const f = googleFresh;
  if (f && f.account === t.account && f.expiresAt > (t.expiresAt ?? 0)) return { access: f.access, expiresAt: f.expiresAt, account: t.account };
  return t;
}

/**
 * One Gemini `usageMetadata` → this gateway's buckets. EXPORTED so the API-key Gemini
 * provider and this subscription one cannot drift: they wrap the same proto, and two
 * readers of one wire shape is how two routes end up disagreeing about what a turn cost.
 *
 * WHAT THE VENDOR DOCUMENTS, AND WHERE EACH FIELD GOES (UsageMetadata reference):
 *   promptTokenCount          → input      the WHOLE prompt (this vendor is INCLUSIVE)
 *   candidatesTokenCount      → output     plus thoughts, see below
 *   cachedContentTokenCount   → cacheRead  a breakdown OF promptTokenCount
 *   thoughtsTokenCount        → output (added) and reported again as `reasoning`
 *   totalTokenCount           NOT carried: "(prompt + thoughts + response candidates)", so
 *                             it is derivable from the above and each front computes its
 *                             own total. A second total invites two answers to one question.
 *   toolUsePromptTokenCount   NOT carried, and this one is a genuine unknown rather than a
 *                             redundancy: the vendor documents it only as "Number of tokens
 *                             present in tool-use prompt(s)" and never says whether
 *                             promptTokenCount contains it — the totalTokenCount identity
 *                             above omits it entirely. Folding it into `input` could
 *                             double-count and subtracting it could go negative, so it stays
 *                             absent until the vendor states the containment. Documented-or-
 *                             absent: a guessed partition outlives the person who guessed.
 *   promptTokensDetails[] / cacheTokensDetails[]
 *                             NOT carried: per-MODALITY breakdowns (TEXT/IMAGE/AUDIO) of
 *                             counters already carried in full. Neither front dialect has a
 *                             modality dimension, so there is nowhere to put them.
 *   serviceTier               NOT carried: not a token count.
 *
 * TWO FAULTS THIS READER EXISTS TO FIX, both silent (UNKNOWNS I-13):
 *
 * 1. cachedContentTokenCount was DROPPED, and it is the cache-HIT counter. Downstream, a
 *    dropped counter is indistinguishable from a measured zero, so a cache that was working
 *    read as one that never hit — the exact question a caller sends cached content to
 *    answer. It maps straight to cacheRead, UNSUBTRACTED: this provider declares
 *    `usageBasis: "inclusive"` and api.ts's normalizeTally() owns the single conversion, so
 *    subtracting here as well would double-subtract.
 *
 * 2. thoughtsTokenCount was DROPPED, and unlike OpenAI's reasoning_tokens it is NOT already
 *    inside the output counter: "totalTokenCount … Total token count for the generation
 *    request (prompt + thoughts + response candidates)" makes thoughts a THIRD addend, and
 *    the thinking guide prices it as output. So publishing candidatesTokenCount alone
 *    under-reports the BILLED output on every thinking turn. It is added into `output` and
 *    ALSO reported as `reasoning`, whose contract is "the reasoning share of output" — that
 *    way a consumer reads one invariant (reasoning is inside output) on every vendor and
 *    never has to know which of them nests its own counters.
 */
export const googleUsage = (um: unknown): Delta["usage"] | undefined => {
  if (!um || typeof um !== "object") return undefined;
  const input = wireNum(um, "promptTokenCount"), cand = wireNum(um, "candidatesTokenCount");
  const cacheRead = wireNum(um, "cachedContentTokenCount"), reasoning = wireNum(um, "thoughtsTokenCount");
  // Each addend counts only when the vendor stated it: absent output plus stated thoughts
  // is still a real billed output, and stated output plus absent thoughts is unchanged.
  const output = cand === undefined && reasoning === undefined ? undefined : (cand ?? 0) + (reasoning ?? 0);
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
};

export const google: Provider & StreamShape = {
  id: "google",
  label: "Google (Antigravity / Gemini Code Assist subscription)",
  /**
   * INCLUSIVE. The UsageMetadata reference states that `promptTokenCount` is "still the
   * total effective prompt size meaning this includes the number of tokens in the cached
   * content", with `cachedContentTokenCount` as the breakdown of it.
   */
  usageBasis: "inclusive",
  /**
   * A CACHED-CONTENT RESOURCE: unlike the other two vendors, the prefix is not marked inside
   * the request at all — it is uploaded first as a separate, server-side `CachedContent`
   * object, and later requests reference it by name in `cachedContent`. Google ALSO caches
   * implicitly (no client field, no guarantee), which is why the vendor advises sending
   * similar-prefix requests close together; the named resource is the only mechanism a
   * client can actually address, so it is the one this contract declares.
   *
   * NOT YET DRIVEN BY THE REQUEST PATH. build() sends no `cachedContent` and delta() reads
   * no `cachedContentTokenCount` today — this declaration is the vendor fact, not a claim
   * about this gateway's behaviour. The basis above is live and load-bearing regardless:
   * normalizeTally() already converts Google's inclusive counters the moment any cache
   * counter appears, so the day delta() starts reporting one, the partition is correct
   * rather than double-counted.
   *
   * minTokens 2,048 — the documented floor for Gemini 2.5 Flash and 2.5 Pro, and the lowest
   * across the family (newer 3.x versions require 4,096). Necessary, not sufficient, for the
   * same reason as the other two vendors.
   *
   * ttlMs is ABSENT ON PURPOSE. Google documents no implicit-cache lifetime (only the
   * advice to "send requests with similar prefix in a short amount of time") and states no
   * default TTL for a CachedContent resource — its `ttl` is set per resource, and storage
   * is billed per token-hour. An undocumented number would read as a measured one, so
   * nothing is declared: absent means unknown here, exactly as it does for a token count.
   */
  cache: { kind: "cached-content-resource", minTokens: 2048, identity: "cachedContent" },
  probe() {
    const r = readGoogle();
    if (r.state === "unreadable") return {
      connected: false, detail: `${r.source} unreadable — ${r.detail}`,
      loginHint: "this is NOT a logged-out state — fix the read (unlock the Keychain, repair the file) rather than logging in again",
    };
    if (r.state === "absent") return { connected: false, detail: `${r.source}: ${r.detail}`, loginHint: "run `agy` once to log in with Antigravity" };
    const { access, expiresAt, account } = googleBest(googleToken(r.json));
    if (!access) return { connected: false, detail: `${r.source} holds no access_token`, loginHint: "run `agy` once to rewrite the credential" };
    const exp = expiresAt ? stampZ(expiresAt) : "unknown";
    const now = Date.now();
    const stale = expiresAt !== undefined && expiresAt + GOOGLE_STALE_GRACE_MS() < now;
    const grace = !stale && expiresAt !== undefined && expiresAt < now;
    return {
      connected: !stale,
      detail: `${r.source}${account ? ` · ${account}` : ""} · expires ${exp}${grace ? " (past expiry, inside the grace window — the server decides)" : ""}`,
      loginHint: stale ? "run `agy` once to refresh the token" : "",
    };
  },
  /**
   * Mint ahead of the request, never inside it (R-1). Called by a host with an event loop
   * before creds(); the CLI does not call it and keeps the sync path.
   *   · token still USABLE  → kick the mint into the background and return AT ONCE. The
   *     caller is served the token it already has, which is still valid: a slow vendor
   *     costs this request exactly nothing.
   *   · token UNUSABLE      → await the bounded async mint. Awaiting is not blocking: the
   *     event loop serves /health and every other request throughout.
   *   · mint just FAILED    → return at once and let creds() fail fast with a clear line,
   *     rather than making every request pay the timeout over again.
   */
  async prepare() {
    const r = readGoogle();
    if (r.state !== "ok") return;
    const { access, expiresAt } = googleBest(googleToken(r.json));
    if (!access) return;
    if (expiresAt !== undefined && expiresAt - Date.now() >= GOOGLE_REFRESH_WINDOW_MS()) return;
    // A mint that failed moments ago is not retried by the next request — and, crucially,
    // is not WAITED ON by it either. Without this the fail path re-armed a mint on its way
    // out, so the following request found one "in flight", awaited it, and paid the whole
    // timeout again: every request slow, for ever, off ONE dead endpoint (measured 8.0 s on
    // the second call before this guard).
    const cooling = Date.now() - googleFailAt < GOOGLE_REFRESH_COOLDOWN_MS();
    if (expiresAt !== undefined && expiresAt > Date.now()) { if (!cooling) void refreshGoogleAsync(r); return; }
    if (cooling) return;
    await refreshGoogleAsync(r);
  },
  creds() {
    const r = readGoogle();
    if (r.state === "unreadable") throw new Error(`could not read the Antigravity credential (${r.source}): ${r.detail} — this is not a logged-out state, so do not re-login until the read works.`);
    if (r.state === "absent") throw new Error(`no Antigravity/Gemini subscription credential (${r.source}: ${r.detail}) — run \`agy\` and log in first.`);
    let { access, expiresAt, account } = googleBest(googleToken(r.json));
    if (!access) throw new Error(`the Antigravity credential in ${r.source} carries no access_token — run \`agy\` once to rewrite it.`);
    // SELF-REFRESH: a token inside its expiry window (or past it) is renewed in place from
    // the stored refresh_token — the same thing `agy` does, but headless and automatic, so
    // the ~1h Antigravity token is never a manual step (canon 164). A refresh that cannot
    // run leaves `access` untouched and the existing stale/throw guard below still applies.
    //
    // R-1: WHERE that mint happens depends on the host. In a CLI it happens right here, in
    // line, because a one-shot process has nothing else to do. On a server it must not: the
    // mint is sync, the server is one thread, and a slow token endpoint would stall every
    // other request behind this one. There the mint has already been done (or started) by
    // prepare(), and this path only ever READS — serving the still-valid token, or failing
    // fast and clearly when there is nothing valid to serve.
    if (expiresAt === undefined || expiresAt - Date.now() < GOOGLE_REFRESH_WINDOW_MS()) {
      if (providerRuntime.syncRefresh) {
        const fresh = refreshGoogle(r);
        if (fresh) { access = fresh.access; expiresAt = fresh.expiresAt; }
      } else if (expiresAt === undefined || expiresAt + GOOGLE_STALE_GRACE_MS() <= Date.now()) {
        // Past expiry AND past the grace window: there is nothing valid left to serve, so
        // say so in one line instead of hanging. Inside the grace window the boundary still
        // fails OPEN (the branch below) — that was deliberate and R-1 does not change it.
        // Start one if none is running and none has just failed; NEVER wait for it here.
        if (!googleFlight && Date.now() - googleFailAt >= GOOGLE_REFRESH_COOLDOWN_MS()) void refreshGoogleAsync(r);
        throw new Error(`Antigravity OAuth token expired ${expiresAt ? stampZ(expiresAt) : "(no expiry stamp)"} and the background refresh has not produced a new one yet `
          + `(${googleFlight ? "a mint is in flight — retry in a few seconds" : "the last mint failed; the token endpoint is slow or unreachable"}) — or run \`agy\` once.`);
      } else if (Date.now() - googleFailAt >= GOOGLE_REFRESH_COOLDOWN_MS()) {
        void refreshGoogleAsync(r);   // still valid: mint in the background, serve it now
      }
    }
    if (expiresAt !== undefined && expiresAt + GOOGLE_STALE_GRACE_MS() < Date.now())
      throw new Error(`Antigravity OAuth token expired ${stampZ(expiresAt)} — run \`agy\` once to refresh it.`);
    return { token: access, account, expiresAt, source: r.source };
  },
  /** U-1: the Antigravity well, re-read once, before a refusal becomes a 401. */
  refreshCreds() { return readGoogle.refresh(); },
  credFp() {
    const r = readGoogle();
    if (r.state !== "ok") return { cred: `unusable:${r.state}`, ident: `unusable:${r.state}`, exp: 0 };
    const { access, expiresAt, account } = googleBest(googleToken(r.json));
    if (!access) return { cred: "absent", ident: account ?? "absent", exp: 0 };
    const exp = expiresAt ?? 0;
    return { cred: `${h12(access)}:${exp}`, ident: account ?? h12(access), exp };
  },
  efforts: (m) => m.efforts ?? GOOGLE_EFFORTS,
  canGenerateImages: true,
  async generateImage(prompt, o, c, signal) {
    const model = googleImageModel();
    const res = await fetch(`${GOOGLE_BASE()}/v1internal:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${c.token}`,
        "user-agent": GOOGLE_UA(),
      },
      body: JSON.stringify(buildGoogleImageRequest(prompt, o, model)),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const raw = await res.text();
      let msg = raw.slice(0, 300);
      try { msg = JSON.parse(raw)?.error?.message ?? msg; } catch {}
      throw new Error(`Gemini image generation answered ${res.status}: ${msg}`);
    }
    return parseGoogleImageResponse(await res.json(), model);
  },
  // The endpoint is strict proto-JSON: an unknown field is a 400, so the engine's blanket
  // `stream: true` must be skipped here. build() cannot do it — the flag is spread in after.
  wantsStreamFlag: false,
  build(m, turns, o, c) {
    // Google bakes the reasoning level into the WIRE id — gemini-3.6-flash + effort "low"
    // becomes gemini-3.6-flash-low. registry.ts strips it back off when parsing, so a
    // model's public id never carries an effort; build() is the one place it goes back on,
    // and an id that already ends in one is left alone (a doubled suffix is a 404).
    const advertised = m.efforts ?? GOOGLE_EFFORTS;
    const effort = o.effort && advertised.includes(o.effort) ? o.effort : advertised[0];
    const wire = advertised.some((e) => m.id.endsWith(`-${e}`)) ? m.id : `${m.id}-${effort}`;
    // Gemini names a function RESULT by the function's name, while both other dialects
    // name it by the call's id. The mapping only exists in the transcript, so it is built
    // here from every tool call the assistant already made.
    const nameOf = new Map<string, string>();
    for (const t of turns) for (const u of t.toolUses ?? []) if (u.id) nameOf.set(u.id, u.name);
    const request: any = { contents: turns.map((t) => toGeminiContent(t, nameOf)) };
    if (o.system) request.systemInstruction = { role: "user", parts: [{ text: o.system }] };
    if (o.tools?.length) {
      request.tools = [{ functionDeclarations: o.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        ...(geminiSchema(t.parameters) ? { parameters: geminiSchema(t.parameters) } : {}),
      })) }];
      if (o.toolChoice) {
        const mode = o.toolChoice === "none" ? "NONE" : o.toolChoice === "auto" ? "AUTO" : "ANY";
        request.toolConfig = { functionCallingConfig: {
          mode,
          ...(typeof o.toolChoice === "object" ? { allowedFunctionNames: [o.toolChoice.name] } : {}),
        } };
      }
    }
    const gen: any = {};
    if (o.maxTokens) gen.maxOutputTokens = o.maxTokens;
    if (o.temperature !== undefined) gen.temperature = o.temperature;
    if (Object.keys(gen).length) request.generationConfig = gen;
    return {
      // alt=sse frames the reply as `data:` lines; without it the method transcodes to a
      // single JSON array an SSE reader sees as zero events. Note the frames are separated
      // by CRLF here, not LF — measured on a live 200.
      url: `${GOOGLE_BASE()}/v1internal:streamGenerateContent?alt=sse`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${c.token}`,
        "user-agent": GOOGLE_UA(),
      },
      body: { model: wire, project: GOOGLE_PROJECT(), request },
    };
  },
  /** Gemini terminates by reporting a finishReason on the candidate (or by refusing the
   *  prompt outright, which arrives as promptFeedback instead of a candidate). */
  terminal(ev) {
    const r = ev?.response ?? ev ?? {};
    return !!(r.candidates?.[0]?.finishReason || r.promptFeedback?.blockReason);
  },
  delta(ev) {
    // Cloud Code wraps the Gemini payload: { response: GenerateContentResponse, traceId, … }.
    if (ev?.error) return { error: ev.error?.message ?? "stream error", ...googleErrType(ev.error) };
    const r = ev?.response ?? ev ?? {};
    const out: Delta = {};
    if (r.modelVersion) out.served = r.modelVersion;
    const cand = r.candidates?.[0];
    for (const p of cand?.content?.parts ?? []) {
      // A function call arrives WHOLE in one part — no fragment stream to reassemble — so
      // it is reported as a finished call and the dialect layer numbers the block itself.
      if (p.functionCall?.name) {
        out.toolCallDone = { name: p.functionCall.name, args: p.functionCall.args ?? {}, ...(p.thoughtSignature ? { sig: p.thoughtSignature } : {}) };
        continue;
      }
      if (typeof p.text !== "string" || !p.text) continue;   // thoughtSignature-only parts carry nothing to print
      if (p.thought) out.reasoning = (out.reasoning ?? "") + p.text;
      else out.text = (out.text ?? "") + p.text;
    }
    const u = googleUsage(r.usageMetadata);
    if (u) out.usage = u;
    if (cand?.finishReason === "STOP" && out.toolCallDone) out.stopReason = "tool_use";
    else if (cand?.finishReason === "MAX_TOKENS") out.stopReason = "max_tokens";
    // A refusal arrives as a finish reason on an empty candidate, and a prompt-level block
    // as promptFeedback. Reported as errors, because the alternative is an empty answer and
    // a zero exit code — a caller cannot tell that from "the model had nothing to say".
    const block = r.promptFeedback?.blockReason;
    if (block && !out.text) out.error = `blocked before generating: ${block}`;
    else if (cand?.finishReason && GOOGLE_BLOCKED.has(cand.finishReason) && !out.text) out.error = `stopped: ${cand.finishReason}`;
    return out;
  },
  explain(status, body) {
    let msg = body.slice(0, 200), reason: string | undefined;
    try {
      const j = JSON.parse(body);
      msg = j?.error?.message ?? msg;
      reason = (j?.error?.details ?? []).find((d: any) => d?.reason)?.reason;
    } catch {}
    if (status === 400 && msg.includes('Unknown name "stream"'))
      return "the body carried a `stream` flag — this endpoint is strict proto-JSON and has no such field. The provider sets wantsStreamFlag=false; the caller added it anyway.";
    if (status === 403 && (reason === "SUBSCRIPTION_REQUIRED" || /valid license/i.test(msg)))
      return "the subscription tier was not served — this endpoint decides that by CLIENT identity, so APIPLAN_GOOGLE_UA no longer matching the Antigravity client is the likely cause. The token is probably fine; re-logging in will not help.";
    if (status === 401)
      return "the token was rejected — `agy` refreshes it hourly, so run `agy` once; if it repeats, the account was switched under us.";
    if (status === 404)
      return "no such model on the wire — wire ids come from v1internal:fetchAvailableModels, and the display names a client prints are not them.";
    if (status === 429)
      return "the subscription's credit budget is spent — each reply carries its remaining credits.";
    return undefined;
  },
};
/**
 * The GEMINI PROTO now lives in a LEAF, src/gemini-wire.ts — `toGeminiContent`, the
 * `Schema` pruner and the thought-signature store, all moved VERBATIM.
 *
 * They lived here because the `google` adapter was written here, but they are facts about
 * the VENDOR rather than about this route, and the API-key adapter
 * (`providers-gemini.ts`) needs every one of them. Importing them from there made a
 * genuine CYCLE — this file imports the gemini provider to put it in PROVIDERS, and that
 * provider imported this file for the helpers — which is a hard temporal-dead-zone crash
 * rather than a style complaint: `PROVIDERS = { …, gemini }` threw `ReferenceError: Cannot
 * access '…' before initialization` at import time, taking every test in the repo with it.
 * Exactly the failure `responses-wire.ts` was extracted to end for the grok adapter, and
 * the fix is the same one: a leaf with no runtime imports, which both adapters may depend
 * on and which depends on neither.
 *
 * ONE import, ONE re-export of the bound names — never also `export … from`, which does
 * not bind locally and would declare each name twice (Bun rejects the whole module). The
 * historical names stay exported, so `rememberToolSig`'s caller in api.ts is unchanged.
 */
import { geminiSchema, rememberToolSig, recallToolSig, toGeminiContent } from "./gemini-wire.ts";
export { geminiSchema, rememberToolSig, recallToolSig, toGeminiContent };

// Providers in their own files import HERE, beside the map they join, so adding one touches
// a single place instead of two. ESM hoists imports; the position changes nothing at
// runtime. ollama is the local vendor and shares no helper with the subscription adapters;
// grok is a subscription adapter that DOES — its endpoint's own catalog reports
// `api_backend: "responses"`, so it imports this file's Responses helpers rather than
// forking a second parser for one wire shape. gemini is the same vendor as `google`
// reached by API KEY instead of the Antigravity OAuth: a different credential, endpoint,
// body envelope and catalog, so a separate provider — but it shares this file's
// `geminiSchema` and `rememberToolSig`, which are facts about the vendor rather than
// about either route.
import { ollama } from "./providers-ollama.ts";
import { grok } from "./providers-grok.ts";
import { gemini } from "./providers-gemini.ts";
// zen is the OpenCode Zen gateway on an API key. Like grok it speaks the Responses wire and so
// imports responses-wire.ts rather than forking a second parser for one shape; unlike every
// other adapter here it is a RESELLER, which is why its registry ids carry a `zen-` prefix
// (parseZen says why) and why models() lists it last.
import { zen } from "./providers-zen.ts";
import { online } from "./providers-online.ts";
export const PROVIDERS: Record<ProviderId, Provider> = { anthropic, openai, google, ollama, grok, gemini, zen, online };
export const providerFor = (m: Model): Provider => PROVIDERS[m.provider];
