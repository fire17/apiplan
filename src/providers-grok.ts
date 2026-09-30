// providers-grok.ts — xAI Grok on the user's PAID SUBSCRIPTION, through the session the
// official `grok` CLI already holds.
//
// WHY THIS IS NOT AN API-KEY PROVIDER. xAI sells two different things under one brand: API
// credits at api.x.ai (billed per token, reached with an XAI_API_KEY), and a Grok
// subscription, whose entitlement is an OIDC SESSION and whose inference is served by a
// separate proxy. The user here has the subscription, and the `grok` CLI v1.0.13 has
// already signed it in — so the honest backend for this provider is the one the CLI itself
// uses, not the metered one. Read live from ~/.grok/models_cache.json on this machine:
//
//   { "auth_method": "session", "origin": "https://cli-chat-proxy.grok.com/v1/models",
//     "models": { "grok-4.6": { "info": {
//        "base_url": "https://cli-chat-proxy.grok.com/v1",
//        "api_backend": "responses", "auth_scheme": "bearer",
//        "context_window": 500000, "supported_in_api": true, … } } } }
//
// `api_backend: "responses"` is the load-bearing fact: this endpoint speaks the OpenAI
// RESPONSES shape, exactly like the Codex subscription endpoint the `openai` provider
// drives, and xAI's own docs name the same three usage fields for it. So the build/parse
// work is genuinely SHARED rather than re-invented — `toResponsesItems`, `responsesUsage`,
// `responsesStop`, `fnRef`, `stripSchemaMeta` and `responsesErrType` all come from
// `./responses-wire.ts`, the leaf module that OWNS this wire shape for both backends, and
// this file adds only what differs: the credential well, the xAI header family, and the
// catalog. A second divergent parser for one wire shape is how two backends drift into
// disagreeing about what the same event meant.
//
// APIPLAN NEVER WRITES ~/.grok/auth.json. Token refresh belongs to the CLI, which owns the
// file and its lock, and says so in its own documentation (~/.grok/docs/user-guide/
// 02-authentication.md): "Grok refreshes access tokens automatically in the background."
// This provider therefore does what the `openai` provider does with ~/.codex/auth.json —
// READS the freshest token on every credential read and fails loudly once it has expired,
// so a stale session becomes an honest 401 with a fix-it line instead of a silent
// half-authenticated call. AccountTracker's own lane owns capture and refresh; a second
// writer racing the CLI for that file is precisely the collision this avoids.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { HOME } from "./platform.ts";
import type { Model } from "./registry.ts";
import type { Provider, Turn, CallOpts, Creds, Built, Delta, CredFp, ToolDef } from "./providers.ts";
// The Responses wire shape, from the LEAF that owns it. NOT from providers.ts: that file
// imports this one to put `grok` in PROVIDERS, so importing values back from it is a real
// cycle and a temporal-dead-zone crash at import time, not merely untidy. The type-only
// import above is erased by ESM and is therefore safe in either direction.
import {
  stampZ, toResponsesItems, responsesUsage, responsesStop, fnRef, stripSchemaMeta, responsesErrType,
} from "./responses-wire.ts";
import type { StreamShape } from "./stream-shape.ts";

const env = (k: string, d: string) => (process.env[k]?.length ? process.env[k]! : d);

// ── the credential well ───────────────────────────────────────────────────────

/** Where the `grok` CLI keeps its session. The env override exists for tests, which must
 *  never read — let alone depend on — the operator's real login. */
export const grokAuthFile = () => env("APIPLAN_GROK_AUTH", join(HOME, ".grok", "auth.json"));
/** The CLI's model catalog, written when it authenticates. Overridable for the same reason. */
export const grokModelsFile = () => env("APIPLAN_GROK_MODELS", join(HOME, ".grok", "models_cache.json"));

/**
 * ~/.grok/auth.json, as the CLI writes it — the BOUNDARY TYPE for that file. Read live
 * 2026-09-06.
 *
 * THE FILE IS PLURAL: an OBJECT KEYED BY ISSUER+CLIENT, the key being
 * `"<oidc_issuer>::<oidc_client_id>"` (here `https://auth.x.ai::b1a00492-…`). Today it
 * holds exactly one entry, but the shape is plural by construction — a second issuer, a
 * re-login under a new client id, or a devbox login each add a SIBLING rather than
 * replacing what was there.
 *
 * Every field is optional (and every VALUE possibly absent) because this is external data
 * owned by another program: a shape declaring them required would let one missing key
 * become a confident `undefined` halfway down a call chain instead of a checked absence at
 * the read. Each field below is `typeof`-checked before it is used.
 */
type GrokAuthFile = Record<string, GrokEntry | undefined>;
type GrokEntry = {
  /** The access token — a JWT. The CLI spells it `key`, not `access_token`. */
  key?: string;
  refresh_token?: string;
  /** RFC3339, e.g. "2026-09-06T15:11:59.855539Z". */
  expires_at?: string;
  /** "oidc" for a subscription session. */
  auth_mode?: string;
  email?: string;
  user_id?: string;
  principal_id?: string;
  team_id?: string;
  oidc_client_id?: string;
};

/** The session a `grok` invocation would serve from right now. `key` is the one field
 *  proven present — readGrokRaw() rejects an entry without it. */
export type GrokSession = { entry: GrokEntry; key: string; expiresAt?: number };

/**
 * The session a `grok` invocation would use, or null when there is none. NEVER throws and
 * never dials — a credential read must not become a way for this provider to fail loudly
 * about another program's file.
 *
 * Because the file is plural (see GrokAuthFile), this never assumes the first entry is the
 * live one: it picks the entry whose token lives LONGEST, which is the session the CLI
 * itself would serve from. An entry with no readable expiry sorts below every dated one but
 * stays eligible — a session that does not say when it ends is not thereby a session that
 * has ended.
 */
export function readGrokRaw(): GrokSession | null {
  const f = grokAuthFile();
  if (!existsSync(f)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  // The one assertion, at the boundary and named: parsed is a non-array object, and every
  // field read out of it below is `typeof`-checked before use. GrokAuthFile says only
  // "string keys to possibly-absent entries", which is exactly what has been established.
  const file = parsed as GrokAuthFile;
  let best: GrokSession | null = null;
  for (const entry of Object.values(file)) {
    if (typeof entry !== "object" || entry === null) continue;
    const key = typeof entry.key === "string" ? entry.key : undefined;
    if (!key) continue;
    const stamp = typeof entry.expires_at === "string" ? entry.expires_at : undefined;
    // An unparseable stamp must never become a confident expiry — or, worse, a NaN that
    // compares false against every clock and so reads as "never expires".
    const ms = stamp ? Date.parse(stamp) : Number.NaN;
    const expiresAt = Number.isFinite(ms) ? ms : undefined;
    if (best && (expiresAt ?? -Infinity) <= (best.expiresAt ?? -Infinity)) continue;
    best = { entry, key, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  }
  return best;
}

/** `grok login` is the ONE way this credential is created — APIPlan never mints it. */
const LOGIN_HINT = "run `grok login`";
/**
 * What to tell an operator whose session has gone stale. The CLI documents that it
 * "refreshes access tokens automatically in the background", so the CHEAP fix is to let it
 * do exactly that — a browser login is only needed once the refresh chain itself is spent.
 * Leading with `grok login` would send a healthy account through re-authentication it does
 * not need, which is the trap google's explain() exists to avoid.
 */
const STALE_HINT = "run `grok` once to let it refresh the token in the background, or `grok login`";

// ── the model catalog ─────────────────────────────────────────────────────────

/** A model as the registry and roster need it, sourced from the CLI's own catalog. */
export type GrokCatalogEntry = { id: string; label: string; efforts?: string[]; contextWindow?: number; baseUrl?: string };

/**
 * ~/.grok/models_cache.json, as the CLI writes it — the BOUNDARY TYPE for that file. Read
 * live 2026-09-06. Optional throughout for the same reason GrokAuthFile is: another program
 * owns this file, so each field is `typeof`-checked at the read rather than trusted here.
 */
type GrokModelsFile = { models?: Record<string, { info?: GrokModelInfo } | undefined> };
type GrokModelInfo = {
  id?: string; model?: string; name?: string; base_url?: string;
  context_window?: number;
  /** false means the proxy will not serve this id at all — see grokCatalog(). */
  supported_in_api?: boolean;
  /** `[{ id, value, label, description, default }, …]`; `value` is what the wire takes. */
  reasoning_efforts?: ({ id?: string; value?: string } | string)[];
};

/**
 * The STATIC fallback: what docs.x.ai documents for this subscription's model family, read
 * 2026-09-06. Only a fallback — a machine whose CLI has authenticated has the live file, and
 * that always wins, because it states what THIS account may address rather than what the
 * public docs list.
 *
 * `grok-build-0.1` is the documented id of the model whose older alias is
 * `grok-code-fast-1`: docs.x.ai/developers/models/grok-code-fast-1 is titled "Grok Build
 * 0.1" and lists `grok-code-fast-1`, `grok-code-fast` and `grok-code-fast-1-0825` among its
 * aliases. The documented id is baked here rather than the alias.
 *
 * `grok-4` is deliberately ABSENT: docs.x.ai/developers/models/grok-4 answers 404, so it is
 * not a currently documented model and listing it would offer a name nothing supports.
 */
export const GROK_FALLBACK: GrokCatalogEntry[] = [
  { id: "grok-4.6", label: "Grok 4.6", efforts: ["xhigh", "high", "medium", "low"], contextWindow: 500_000 },
  { id: "grok-4.5", label: "Grok 4.5", efforts: ["xhigh", "high", "medium", "low"], contextWindow: 500_000 },
  { id: "grok-4.3", label: "Grok 4.3", efforts: ["xhigh", "high", "medium", "low"], contextWindow: 1_000_000 },
  { id: "grok-build-0.1", label: "Grok Build 0.1", efforts: ["xhigh", "high", "medium", "low"], contextWindow: 256_000 },
];

/**
 * Every grok model this account can address, the CLI's live catalog first. Never throws and
 * never dials: a model lookup must not add latency to a call, the same law
 * registry.models() follows.
 *
 * A `hidden` model is still ADDRESSABLE — that flag governs prominence in the CLI's own
 * picker, not entitlement — but one with `supported_in_api: false` is not, and listing it
 * would offer a name that answers 400. This mirrors parseOpenai's treatment of the Codex
 * catalog's named products.
 */
export function grokCatalog(): GrokCatalogEntry[] {
  const f = grokModelsFile();
  if (!existsSync(f)) return GROK_FALLBACK;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(f, "utf8")); } catch { return GROK_FALLBACK; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return GROK_FALLBACK;
  // The one assertion, at the boundary and named — everything read out of it below is
  // `typeof`-checked, and GrokModelsFile promises nothing more than "an object".
  const models = (parsed as GrokModelsFile).models;
  if (typeof models !== "object" || models === null || Array.isArray(models)) return GROK_FALLBACK;
  const out: GrokCatalogEntry[] = [];
  for (const [key, record] of Object.entries(models)) {
    const info = record?.info;
    if (typeof info !== "object" || info === null) continue;
    if (info.supported_in_api === false) continue;
    const id = typeof info.id === "string" ? info.id : typeof info.model === "string" ? info.model : key;
    // Order is the catalog's own, so the model's preferred rung stays first.
    const efforts = Array.isArray(info.reasoning_efforts)
      ? info.reasoning_efforts
          .map((e) => (typeof e === "string" ? e : typeof e?.value === "string" ? e.value : typeof e?.id === "string" ? e.id : undefined))
          .filter((s): s is string => s !== undefined && s.length > 0)
      : [];
    out.push({
      id,
      label: typeof info.name === "string" ? info.name : id,
      ...(efforts.length ? { efforts } : {}),
      ...(typeof info.context_window === "number" ? { contextWindow: info.context_window } : {}),
      ...(typeof info.base_url === "string" && info.base_url.length ? { baseUrl: info.base_url } : {}),
    });
  }
  return out.length ? out : GROK_FALLBACK;
}

/** The subscription endpoint — the proxy the CLI's own catalog was fetched from. NOT
 *  api.x.ai, which is the metered API-key product; a session token is not its currency. */
export const GROK_DEFAULT_BASE = "https://cli-chat-proxy.grok.com/v1";
/**
 * Where to send, most specific first: an explicit override, the `base_url` the CLI's catalog
 * states FOR THIS MODEL, then the subscription proxy. Per-model rather than global because
 * the catalog carries the field per model, and a future entry may legitimately move.
 */
export function grokBase(modelId?: string): string {
  const override = process.env.APIPLAN_GROK_BASE;
  if (override?.length) return override.replace(/\/+$/, "");
  const hit = modelId ? grokCatalog().find((m) => m.id === modelId) : undefined;
  return (hit?.baseUrl ?? GROK_DEFAULT_BASE).replace(/\/+$/, "");
}

// ── the request and the stream, as boundary types ─────────────────────────────

/** The Responses-API body this provider sends. Named so a reader sees the whole request
 *  shape in one place instead of inferring it from the assignments that build it. */
type GrokRequestBody = {
  model: string;
  instructions: string;
  input: unknown[];
  store: false;
  stream: true;
  prompt_cache_key?: string;
  reasoning?: { effort: string; summary?: string };
  tools?: { type: "function"; name: string; description: string; parameters: unknown }[];
  tool_choice?: string | { type: "function"; name: string };
};

/** A fault as the Responses API reports it: a message plus the vendor's own name for it,
 *  which `responsesErrType` reads off `type` or failing that `code`. */
type ResponsesError = { message?: string; type?: string; code?: string };
/**
 * A Responses-API stream event, as much of it as delta() reads — the boundary type for this
 * vendor's wire. The vocabulary is the OpenAI Responses one (`api_backend: "responses"`), so
 * these are that API's field names and the shared helpers consume the same objects.
 */
type ResponsesEvent = {
  type?: string;
  delta?: string;
  message?: string;
  item_id?: string;
  output_index?: number;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  response?: {
    model?: string;
    error?: ResponsesError;
    incomplete_details?: { reason?: string };
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
  };
  error?: ResponsesError;
};

// ── the provider ──────────────────────────────────────────────────────────────

export const grok: Provider & StreamShape = {
  id: "grok",
  label: "xAI Grok (subscription via `grok` CLI)",
  /**
   * INCLUSIVE — MEASURED on this endpoint, then corroborated by xAI's own words. Not
   * inferred from the OpenAI shape it copies: borrowing a wire shape would not guarantee
   * the accounting was borrowed with it, which is the one thing worth checking here.
   *
   * THE MEASUREMENT (2026-09-06, .deify/grok/receipt.json). Three BYTE-IDENTICAL
   * 6,197-token requests under one stable prompt_cache_key — so the only variable in play
   * is what the cache did — reported:
   *     call 1   input_tokens 6197 · cached_tokens 0        (cold)
   *     call 2   input_tokens 6197 · cached_tokens 128
   *     call 3   input_tokens 6197 · cached_tokens 6144     (near-full hit)
   * `input_tokens` did not move. An exclusive reading PREDICTS call 3's input counter falls
   * to ~53 (6197 − 6144); it was observed at 6197, unmoved, so exclusive is REFUTED rather
   * than merely disfavoured, and `cached_tokens` is a breakdown OF the input total. The
   * vendor's billing agrees from the other side: `cost_in_usd_ticks` fell 130,960,000 →
   * 38,980,000 (~3.4x cheaper) for the same-sized prompt, so the cached share was really
   * served from cache and not merely relabelled.
   *
   * WHAT THE DOCS SAY, as corroboration:
   * https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing gives
   * the Responses reading directly — "Cached tokens appear in
   * `usage.input_tokens_details.cached_tokens`" — and its cache-hit table adds the sentence
   * that points the same way: a `cached_tokens` "Equal to `prompt_tokens`" means "Full
   * cache hit — your entire prompt was served from cache". A cached count that can EQUAL
   * the prompt total, rather than driving it to zero, must be contained by it. The same
   * page's worked example is the same arithmetic ("Turn 3: prompt_tokens=200,
   * cached_tokens=120" — 120 OF the 200), and its long-context note says it once more:
   * "long context pricing applies when total prompt tokens (INCLUDING CACHED TOKENS)
   * exceed the model's long context threshold".
   *
   * AN OBSERVATION, STATED AT THE STRENGTH IT ACTUALLY HAS — and deliberately NOT a
   * contract field. Every cached value measured on this endpoint so far has been an exact
   * multiple of 128: 128 (1×128) and 6,144 (48×128) on the calls above, and 128 again on
   * the cache-identity echo probe. Two distinct values is NOT a demonstration that xAI
   * quantizes to 128 — with n=2, one of them the smallest possible non-zero multiple,
   * coincidence is not excluded. What it does do is bear on someone else's finding:
   * CausalCacheProof measured the same grid on openai/gpt-6-astra with more samples
   * (.deify/cache-proof/live-ab.json: 7,424 = 58×128, 6,144 = 48×128, production plateau
   * 10,368 = 81×128) and scoped it explicitly to that one model id. Two vendors sharing
   * this wire shape both reporting cache reads only on that grid shifts the likely
   * explanation away from "a gpt-6-astra reporting quirk" toward "128-token block
   * granularity is a property of implicit-prefix caching on the Responses shape" — a
   * HYPOTHESIS worth recording, with the openai half the better-evidenced one.
   *
   * (6,144 appears in both that run and this one, on different vendors and different
   * prompts. Almost certainly coincidence — 48×128 is an unremarkable landing spot for a
   * few-thousand-token prefix — and noted here only so no later reader rediscovers it as a
   * shared-constant mystery.)
   *
   * None of this becomes a `cache` field below: a measured regularity is not a published
   * number, and a field would read as vendor-stated.
   *
   * So delta() maps `cached_tokens` straight to `usage.cacheRead` and subtracts NOTHING.
   * api.ts's normalizeTally() owns the single conversion for every provider; subtracting
   * here as well would drive the uncached remainder negative on every cache hit and trip
   * its source-inconsistent guard.
   */
  usageBasis: "inclusive",
  /**
   * IMPLICIT PREFIX. xAI places the breakpoint itself and the client never marks one: "The
   * cache works from the start of your messages array. When a request arrives, the system
   * checks how many messages at the beginning match a previous request exactly — that
   * matching portion is the 'prefix' and gets served from cache"
   * (docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works). That is the right
   * mechanism for this gateway, whose clients send a growing conversation rather than a
   * hand-placed marker.
   *
   * identity `prompt_cache_key`, and on this API that field is a ROUTING handle — the same
   * role it plays for OpenAI. xAI documents its two spellings as ONE mechanism: "For the
   * Responses API, use the `prompt_cache_key` field directly in the request body. It
   * functions identically to setting `x-grok-conv-id` — it routes requests to the same
   * server for cache reuse" (…/prompt-caching/maximizing-cache-hits). Routing is what
   * decides whether a prefix is reachable at all, because "cache entries are stored
   * per-server". build() therefore sends the caller's key BOTH ways, body field and header.
   *
   * AND THE ENDPOINT PROVES IT PARSED THE FIELD, rather than this being inferred from the
   * wire shape it shares with Codex. Measured 2026-09-06: a request carrying
   * `prompt_cache_key: "apiplan-grok-echo-proof"` came back with `response.created` quoting
   * `"prompt_cache_key": "apiplan-grok-echo-proof"` verbatim, and the same call reported
   * `cached_tokens: 128`. That is a direct observation, and a stronger one than the sibling
   * Responses route affords — the Codex endpoint echoes no cache key at all across 12
   * measured calls (.deify/cache-proof/live-ab.json), so there the identity can only be
   * asserted at the outbound boundary. Here the vendor confirms receipt.
   *
   * NO CACHE-WRITE PATH IS DECLARED, and the distinction matters because "no write charge"
   * and "no write counter" read identically in a rate table while meaning different things.
   * BOTH are true here, and each is separately established: xAI's Responses usage object
   * carries no `cache_write_tokens` field at all (measured — nine fields arrive and that is
   * not among them), and xAI publishes no cache-write price (its pricing tables print only
   * Input / Cached input / Output; the harness catalog independently records `cacheWrite: 0`
   * for all nine of its xAI models, at both tiers). So there is nothing to count and nothing
   * to bill — which is a coherent implicit-prefix cache, not a gap: a read counter with no
   * write counter is exactly what a cache you do not pay to populate looks like.
   *
   * NO minTokens AND NO ttlMs: xAI publishes neither for this cache, and DOCUMENTED-OR-
   * ABSENT is the law — a floor borrowed from OpenAI's 1,024 would read as measured xAI
   * fact. Absent means "xAI does not say", which is true and useful. What the vendor does
   * say is that neither is a guarantee: "Prompt caching is not 100% guaranteed. Cache
   * entries can be evicted due to memory pressure, and requests may be routed to different
   * servers."
   */
  cache: { kind: "implicit-prefix", identity: "prompt_cache_key" },
  probe() {
    const a = readGrokRaw();
    if (!a) return { connected: false, detail: `no ${grokAuthFile().replace(HOME, "~")}`, loginHint: LOGIN_HINT };
    const stale = a.expiresAt !== undefined && a.expiresAt < Date.now();
    const when = a.expiresAt !== undefined ? stampZ(a.expiresAt) : "unknown";
    // The account, named without being published: a local part is a personal identifier and
    // this string is printed and logged, while the DOMAIN is the part that answers "which
    // account is this" for an operator holding several.
    const email = a.entry.email;
    const who = email?.includes("@") ? `${email.slice(0, 1)}…@${email.split("@")[1]}` : "signed in";
    return {
      connected: !stale,
      detail: stale
        ? `token expired (${when}) · ${who}`
        : `${grokAuthFile().replace(HOME, "~")} · ${a.entry.auth_mode ?? "oidc"} · ${who} · expires ${when}`,
      loginHint: stale ? STALE_HINT : "",
    };
  },
  creds(): Creds {
    const a = readGrokRaw();
    if (!a) throw new Error(`no ${grokAuthFile()} — ${LOGIN_HINT} first.`);
    if (a.expiresAt !== undefined && a.expiresAt < Date.now()) {
      throw new Error(`Grok session expired ${stampZ(a.expiresAt)} — ${STALE_HINT}.`);
    }
    return {
      token: a.key,
      // The TEAM is the billing scope this proxy routes on; the user id identifies the
      // principal and stands in when a login carries no team.
      account: a.entry.team_id ?? a.entry.user_id,
      ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}),
      source: grokAuthFile().replace(HOME, "~"),
    };
  },
  /**
   * The credential the next creds() would use, as a fingerprint — never a token.
   *
   * `cred` folds in the EXPIRY as well as the key, so a background refresh by the CLI (same
   * account, new JWT) reads as a new credential and no verdict recorded against the old one
   * carries over to it. `ident` is the PRINCIPAL and deliberately NOT the refresh token:
   * that value rotates on every refresh, which would make one account look like an endless
   * stream of different ones — while the principal id is stable across every refresh of the
   * same login, which is what identity has to mean here.
   */
  credFp(): CredFp {
    const a = readGrokRaw();
    if (!a) return { cred: "absent", ident: "absent", exp: 0 };
    const exp = a.expiresAt ?? 0;
    const ident = a.entry.user_id ?? a.entry.principal_id ?? a.entry.oidc_client_id ?? a.key;
    // Truncated sha256 — the same 12-hex form providers.ts fingerprints with, so the outcome
    // memory keys on one comparable shape across every provider.
    const h12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
    return { cred: `${h12(a.key)}:${exp}`, ident: h12(ident), exp };
  },
  /** The catalog's own list for this model, else the documented family set. */
  efforts: (m: Model) => m.efforts ?? grokCatalog().find((c) => c.id === m.id)?.efforts ?? ["low", "medium", "high", "xhigh"],
  build(m: Model, turns: Turn[], o: CallOpts, c: Creds): Built {
    const body: GrokRequestBody = {
      model: m.id,
      instructions: o.system ?? "",
      input: turns.flatMap(toResponsesItems),
      store: false,
      stream: true,
      ...(o.promptCacheKey ? { prompt_cache_key: o.promptCacheKey } : {}),
    };
    // Only when this model advertises the effort. `supports_reasoning_effort` and
    // `reasoning_efforts` are PER-MODEL facts in the CLI's catalog, and sending an effort a
    // model does not serve is a 400 — the failure mode the google adapter was observed to
    // hit. Note also that a request-level effort CHANGE resets the cached prefix upstream,
    // so a caller holding one effort per conversation keeps its cache.
    if (o.effort && grok.efforts(m).includes(o.effort)) {
      body.reasoning = { effort: o.effort, ...(o.showThinking ? { summary: "auto" } : {}) };
    }
    // Caller tools ride as Responses-API function tools in the FLAT shape — type/name/
    // description/parameters at the top level — the same shape the openai provider sends to
    // the sibling Responses endpoint. `strict` is never set (Claude Code's schemas use
    // anyOf/const/default, which strict mode forbids) and `$schema` is pruned as
    // JSON-Schema framing rather than a parameter schema.
    if (o.tools?.length) {
      body.tools = o.tools.map((t: ToolDef) => ({
        type: "function" as const, name: t.name, description: t.description ?? "",
        parameters: stripSchemaMeta(t.parameters) ?? { type: "object", properties: {} },
      }));
      if (o.toolChoice) {
        body.tool_choice = typeof o.toolChoice === "object" ? { type: "function", name: o.toolChoice.name } : o.toolChoice;
      }
    }
    // No max_output_tokens: like the Codex subscription endpoint, this is a first-party proxy
    // rather than the public metered API, and an output cap it rejects fails the WHOLE call —
    // which would be every client that sets max_tokens by default, i.e. most of them.
    return {
      url: `${grokBase(m.id)}${env("APIPLAN_GROK_RESPONSES_PATH", "/responses")}`,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        // `auth_scheme: "bearer"` in the catalog: `Bearer ` + the session key is what the
        // CLI's own sampler sends to this proxy.
        authorization: `Bearer ${c.token}`,
        // The xAI header family, spelled as the CLI binary's own header table spells it
        // (strings read out of grok-1.0.13: x-grok-conv-id, x-grok-session-id,
        // x-grok-client-identifier, x-grok-client-version, x-grok-client-mode). Sent because
        // this is the CLI's own proxy rather than the public /v1/responses endpoint — a
        // client it does not recognise is exactly what a first-party proxy may refuse.
        //
        // x-grok-conv-id carries the SAME value as prompt_cache_key on purpose: xAI
        // documents them as one mechanism ("It functions identically to setting
        // x-grok-conv-id"), cache entries are per-server, and a conversation that changes
        // its routing handle mid-thread loses its own prefix. The caching doc names this
        // header as the way to "maximize cache hit rates".
        ...(o.promptCacheKey ? { "x-grok-conv-id": o.promptCacheKey, "x-grok-session-id": o.promptCacheKey } : {}),
        "x-grok-client-identifier": env("APIPLAN_GROK_CLIENT_IDENTIFIER", "grok-shell"),
        "x-grok-client-version": env("APIPLAN_GROK_CLIENT_VERSION", "1.0.13"),
        "user-agent": env("APIPLAN_GROK_USER_AGENT", "grok-cli/1.0.13"),
      },
      body,
    };
  },
  /** Identical framing to the sibling Responses endpoint: the stream ends on the response
   *  object being reported final — completed, cut short, or failed. A body that stopped
   *  before one of these arrived was truncated in transit. */
  terminal: (ev: ResponsesEvent) => ev?.type === "response.completed" || ev?.type === "response.incomplete"
                                 || ev?.type === "response.failed" || ev?.type === "response.done",
  /**
   * The Responses event vocabulary, read through the SAME helpers the openai provider uses.
   *
   * Usage comes off `response.completed` via `responsesUsage`, which reads `input_tokens`,
   * `output_tokens` and `input_tokens_details.cached_tokens` — the exact three fields xAI
   * documents for this API, which is why the helper is reused rather than widened to guess
   * at two vendors' spellings. No subtraction happens here; see usageBasis above.
   *
   * EVERY FIELD THE ENDPOINT REALLY SENDS, and where it goes. Audited against the live
   * response of 2026-09-06 (.deify/grok/receipt.json) rather than against the docs alone,
   * because a field this adapter never reads is dropped SILENTLY — no error, no
   * inconsistency, and no test that could fail:
   *   · input_tokens                            → usage.input      (forwarded)
   *   · output_tokens                           → usage.output     (forwarded)
   *   · input_tokens_details.cached_tokens      → usage.cacheRead  (forwarded, unsubtracted)
   *   · total_tokens                            DROPPED — it is input + output, derivable,
   *     and republishing a vendor's sum invites a reader to add it to the parts.
   *   · output_tokens_details.reasoning_tokens  DROPPED — Delta has no reasoning-token
   *     bucket, and xAI bills reasoning at the ordinary completion rate ("Reasoning tokens
   *     | Full completion token price"), so it is already inside output_tokens. Folding it
   *     in again would double-count the model's thinking.
   *   · context_details.{input,output}_tokens   DROPPED — a restatement of the two totals.
   *   · cost_in_usd_ticks                       DROPPED DELIBERATELY. It is MONEY, and this
   *     gateway re-partitions physical token counts and never turns them into currency —
   *     what a token costs stays the reader's business (the law api.ts states over
   *     normalizeTally). It is quoted in comments as corroboration, never emitted.
   *   · num_sources_used, num_server_side_tools_used  DROPPED — server-tool call COUNTS,
   *     not tokens; there is no bucket for them and inventing one would put a non-token
   *     integer into a token tally.
   * NO CACHE-WRITE COUNTER EXISTS HERE. xAI reports no `cache_write_tokens` at all — not
   * zero, absent — so `usage.cacheWrite` is correctly never set, and normalizeTally() sees
   * a two-bucket partition it can still make exact. An absent counter must never be read as
   * a measured zero.
   */
  delta(ev: ResponsesEvent): Delta {
    switch (ev.type) {
      case "response.created": case "response.in_progress": return { served: ev.response?.model };
      case "response.output_text.delta": return { text: ev.delta ?? "" };
      case "response.output_item.added":
        if (ev.item?.type === "function_call") {
          return { toolStart: { ref: fnRef(ev), id: ev.item.call_id ?? ev.item.id ?? fnRef(ev), name: ev.item.name ?? "" } };
        }
        return {};
      case "response.function_call_arguments.delta":
        return { toolArgs: { ref: fnRef(ev), json: ev.delta ?? "" } };
      case "response.function_call_arguments.done":
        return { toolStop: { ref: fnRef(ev) } };
      case "response.output_item.done":
        // The backend's own complete copy of the arguments. `full` makes it REPLACE a partial
        // accumulation and it is discarded when the fragments already arrived — which is the
        // path xAI's "function calls returned whole in a single chunk" behaviour takes.
        if (ev.item?.type === "function_call") {
          return { toolArgs: { ref: fnRef(ev), json: ev.item.arguments ?? "", full: true }, toolStop: { ref: fnRef(ev) } };
        }
        return {};
      case "response.incomplete":
      case "response.completed": {
        const u = responsesUsage(ev.response);
        return { stopReason: responsesStop(ev.response), ...(u ? { usage: u } : {}) };
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": return { reasoning: ev.delta ?? "" };
      case "response.failed":
        return { error: ev.response?.error?.message ?? "response failed", ...responsesErrType(ev.response?.error) };
      case "response.error": case "error":
        return { error: ev.error?.message ?? ev.message ?? "stream error", ...responsesErrType(ev.error) };
      default: return {};
    }
  },
  /**
   * A 401 here means the SESSION is stale, and the cheap fix is to let the CLI do what it
   * documents rather than send an operator through a browser login they may not need. A 403
   * is a different fault — an authenticated principal WITHOUT the entitlement — and telling
   * that user to re-authenticate would send them to re-auth a healthy account, the same trap
   * google's explain() exists to avoid.
   */
  explain(status: number, body: string): string | undefined {
    if (status === 401) return `Grok refused the session (401) — ${STALE_HINT}. ${body.slice(0, 200)}`;
    if (status === 403) return `Grok accepted the session but refused this request (403) — the subscription may not cover this model. ${body.slice(0, 200)}`;
    return undefined;
  },
};
