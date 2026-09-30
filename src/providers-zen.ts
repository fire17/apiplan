// providers-zen.ts — OpenCode Zen, the model gateway at opencode.ai/zen, reached with an
// API KEY.
//
// WHY THIS PROVIDER EXISTS AND WHAT IT IS NOT. OpenCode ships a CLI (`opencode`) and, behind
// it, a first-party model gateway it calls "Zen". Zen republishes other vendors' models under
// its own billing — `muse-spark-1.3`, but also `gpt-6-astra`, `claude-opus-5`, `grok-4.6` —
// so it is a fourth way to reach names this registry already serves by other credentials.
// That is the whole reason every id here carries a `zen-` prefix: see parseZen in registry.ts.
//
// THE FREE TIER IS NOT PORTED, DELIBERATELY. Zen serves a contributor tier priced at zero
// (`muse-spark-1.3-contributor-free`), and the opencode client reaches it by sending its own
// client identity — `x-opencode-session` / `x-opencode-request` / `x-opencode-client`, stamped
// only when `providerID.startsWith("opencode")` (read out of the opencode 1.18.30 binary at
// byte offset 65_841_546: `headers:{...e.model.providerID.startsWith("opencode")?{...,
// "x-opencode-session":e.sessionID,"x-opencode-request":e.user.id,"x-opencode-client":
// e.flags.client,"User-Agent":_i}:{...}}`). The vendor states the boundary in its own refusal
// text — a keyless call from outside opencode is answered 400 `MissingSessionID` "OpenCode's
// free tier can only be used in OpenCode" — so sending those headers from here would be
// impersonating another client to take a tier its vendor says is not ours. That is a decision
// for the operator, not for this file, and test/zen.test.ts fails if anyone adds them.
// Consequently `zenScan()` also drops every zero-priced id: offering a name this route
// cannot serve is the silent-truncation fault `unparseable()` exists to prevent, inverted.
//
// WITHOUT A KEY, OPENCODE ITSELF DISABLES EVERY PAID MODEL. Same binary, byte offset
// 72_673_601: `let p=Boolean(process.env.OPENCODE_API_KEY||a||f.provider.request.body.apiKey);
// …if(!p)u.request.body.apiKey="public" …if(p)return; for(let u of f.models.values()){
// if(!u.cost.some((m)=>m.input>0))continue; …m.enabled=!1}`. So "public" is not a credential
// this gateway may borrow — it is the marker of a keyless client, and the paid catalogue is
// switched off beside it. A key is the only route, and creds() says so by name.
//
// THE WIRE IS THE OPENAI *RESPONSES* SHAPE for the subset ported here, and that is a per-model
// fact rather than a provider-wide one: the Zen provider's own npm dialect is
// `@ai-sdk/openai-compatible` (chat-completions), and 28 of its 102 models OVERRIDE it with
// `provider.npm: "@ai-sdk/openai"` (~/.cache/opencode/models.json, read 2026-09-12). Those 28
// are the ones this file serves, because the Responses wire already exists here and is owned
// by ONE module: `toResponsesItems`, `responsesUsage`, `responsesStop`, `fnRef`,
// `stripSchemaMeta` and `responsesErrType` all come from ./responses-wire.ts, exactly as the
// grok adapter takes them. A second parser for one wire shape is how two backends drift into
// disagreeing about what the same event meant. The other 74 ids (46 chat-completions, 20
// anthropic-dialect, 8 google-dialect) are NOT addressable after this lane, and
// `refreshZenCatalog()` reports their counts so the gap is visible rather than quiet.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { HOME } from "./platform.ts";
import type { Model } from "./registry.ts";
import type { Provider, Turn, CallOpts, Creds, Built, Delta, CredFp, ToolDef } from "./providers.ts";
// From the LEAF that owns the Responses wire — never from providers.ts, which imports this
// file to put `zen` in PROVIDERS and would therefore be a real import cycle (the
// temporal-dead-zone crash documented at the top of responses-wire.ts). The type-only import
// above is erased by ESM and is safe in either direction.
import {
  toResponsesItems, responsesUsage, responsesStop, fnRef, stripSchemaMeta, responsesErrType,
} from "./responses-wire.ts";
import type { StreamShape } from "./stream-shape.ts";

const env = (k: string, d: string) => (process.env[k]?.length ? process.env[k]! : d);
/** Truncated sha256 — the 12-hex form every other provider fingerprints with, so one
 *  comparable shape reaches the outcome memory. */
const h12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// ── the credential well ───────────────────────────────────────────────────────

/** Where `opencode auth login` keeps its keys. The env override exists for tests, which must
 *  never read — let alone depend on — the operator's real login. */
export const zenAuthFile = () => env("APIPLAN_ZEN_AUTH", join(HOME, ".local", "share", "opencode", "auth.json"));
/** opencode's own model catalog, rewritten when it launches. Overridable for the same reason. */
export const zenModelsFile = () => env("APIPLAN_ZEN_MODELS", join(HOME, ".cache", "opencode", "models.json"));

/**
 * ~/.local/share/opencode/auth.json, as opencode writes it — the BOUNDARY TYPE for that file.
 * An OBJECT KEYED BY PROVIDER ID, each entry a discriminated union on `type`: `"api"` carries
 * `key`, `"oauth"` carries refresh/access/expires (read live 2026-09-12: this machine holds a
 * `google` entry of type `oauth` and no `opencode` entry at all). Only the `opencode` entry of
 * type `api` is a Zen credential, and every field is optional because another program owns the
 * file: a shape declaring them required would turn one missing key into a confident
 * `undefined` halfway down a call chain instead of a checked absence at the read.
 *
 * The write path is opencode's login: `if("key"in z)yield*iu(X,{type:"api",key:z.key,…})`
 * (opencode 1.18.30, byte offset 65_116_698).
 */
type ZenAuthFile = Record<string, ZenAuthEntry | undefined>;
type ZenAuthEntry = { type?: string; key?: string };

/** Where a Zen key came from, for `apiplan status` — never the key itself. */
export type ZenKey = { key: string; source: string };

/**
 * The key a Zen call would use right now, or null when there is none. NEVER throws and never
 * dials: a credential read must not become a way for this provider to fail loudly about
 * another program's file.
 *
 * ORDER IS THE VENDOR'S OWN. opencode reads `process.env.OPENCODE_API_KEY` FIRST and only then
 * the stored credential (`Boolean(process.env.OPENCODE_API_KEY||a||…)`, offset 72_673_601), so
 * an operator exporting a key for one shell gets that key here too rather than silently
 * keeping the stored one.
 */
export function readZenKey(): ZenKey | null {
  const fromEnv = process.env.OPENCODE_API_KEY;
  if (fromEnv?.length) return { key: fromEnv, source: "env:OPENCODE_API_KEY" };
  const f = zenAuthFile();
  if (!existsSync(f)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  // The one assertion, at the boundary and named: parsed is a non-array object, and every
  // field read out of it below is `typeof`-checked. ZenAuthFile promises nothing more.
  const entry = (parsed as ZenAuthFile)["opencode"];
  if (typeof entry !== "object" || entry === null) return null;
  // `type` is the discriminant. An oauth entry under this key would carry no `key` field, and
  // treating one as a bearer would send a refresh token upstream as an API key.
  if (entry.type !== "api") return null;
  const key = typeof entry.key === "string" && entry.key.length ? entry.key : undefined;
  if (!key) return null;
  return { key, source: `${f.replace(HOME, "~")} (opencode)` };
}

/** The ONE way this credential is created — APIPlan never mints or writes it. */
const LOGIN_HINT = "run `opencode auth login` (choose opencode; key from https://opencode.ai/auth) or export OPENCODE_API_KEY";

// ── the model catalog ─────────────────────────────────────────────────────────

/** A model as the registry, the roster and build() need it, sourced from opencode's catalog. */
export type ZenCatalogEntry = {
  id: string; label: string; efforts?: string[];
  contextWindow?: number; maxOutput?: number;
  /** The vendor's published rates, per 1M tokens, carried verbatim. The roster reads them. */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
};

/** What a scan of opencode's catalog could NOT offer here, by reason. Empty arrays after a
 *  FALLBACK scan mean "nothing was examined", not "nothing was dropped" — see zenScan(). */
export type ZenDropped = { free: string[]; chat: string[]; anthropic: string[]; google: string[] };

/**
 * ~/.cache/opencode/models.json, as opencode writes it — the BOUNDARY TYPE for that file. It
 * is the whole models.dev catalog keyed by PROVIDER, of which `opencode` is the Zen one. Every
 * field optional, for the reason ZenAuthFile is.
 */
type ZenModelsFile = { opencode?: { models?: Record<string, ZenModelRecord | undefined> } };
type ZenModelRecord = {
  name?: string;
  /** The per-model DIALECT OVERRIDE. `@ai-sdk/openai` is the Responses wire this file speaks;
   *  absent/null means the provider default, which for Zen is `@ai-sdk/openai-compatible`. */
  provider?: { npm?: string | null };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
  reasoning_options?: ({ type?: string; values?: string[] } | null)[];
};

/**
 * The STATIC fallback: the 26 PAID Responses-dialect ids Zen published on 2026-09-12, read out
 * of ~/.cache/opencode/models.json on this machine. Only a fallback — a machine with opencode
 * installed has the live file and that always wins, because it states what Zen serves TODAY
 * rather than what it served the day this was written.
 *
 * `zen-gpt-5.3-codex-spark` is listed here and is NOT the model `spark` resolves to: its
 * variant is `codexspark` (see parseZen), while `spark` is the muse line's variant. The two
 * were deliberately kept apart — registry.test.ts asserts the unprefixed
 * `gpt-5.3-codex-spark` stays unresolvable, and that assertion still holds because every id
 * here carries the prefix.
 */
export const ZEN_FALLBACK: ZenCatalogEntry[] = [
  { id: "zen-gpt-5", label: "GPT-5", efforts: ["minimal", "low", "medium", "high"], contextWindow: 400_000 },
  { id: "zen-gpt-5-codex", label: "GPT-5 Codex", efforts: ["low", "medium", "high"], contextWindow: 400_000 },
  { id: "zen-gpt-5-nano", label: "GPT-5 Nano", efforts: ["minimal", "low", "medium", "high"], contextWindow: 400_000 },
  { id: "zen-gpt-5.1", label: "GPT-5.1", efforts: ["none", "low", "medium", "high"], contextWindow: 400_000 },
  { id: "zen-gpt-5.1-codex", label: "GPT-5.1 Codex", efforts: ["low", "medium", "high"], contextWindow: 400_000 },
  { id: "zen-gpt-5.1-codex-max", label: "GPT-5.1 Codex Max", efforts: ["low", "medium", "high", "xhigh"], contextWindow: 400_000 },
  { id: "zen-gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", efforts: ["low", "medium", "high"], contextWindow: 400_000 },
  { id: "zen-gpt-5.2", label: "GPT-5.2", efforts: ["none", "low", "medium", "high", "xhigh"], contextWindow: 400_000 },
  { id: "zen-gpt-5.2-codex", label: "GPT-5.2 Codex", efforts: ["low", "medium", "high", "xhigh"], contextWindow: 400_000 },
  { id: "zen-gpt-5.3-codex", label: "GPT-5.3 Codex", efforts: ["none", "low", "medium", "high", "xhigh"], contextWindow: 400_000 },
  { id: "zen-gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", efforts: ["low", "medium", "high", "xhigh"], contextWindow: 128_000 },
  { id: "zen-gpt-5.4", label: "GPT-5.4", efforts: ["none", "low", "medium", "high", "xhigh"], contextWindow: 1_050_000 },
  { id: "zen-gpt-5.4-mini", label: "GPT-5.4 Mini", efforts: ["none", "low", "medium", "high", "xhigh"], contextWindow: 400_000 },
  { id: "zen-gpt-5.4-nano", label: "GPT-5.4 Nano", efforts: ["none", "low", "medium", "high", "xhigh"], contextWindow: 400_000 },
  { id: "zen-gpt-5.4-pro", label: "GPT-5.4 Pro", efforts: ["medium", "high", "xhigh"], contextWindow: 1_050_000 },
  { id: "zen-gpt-5.5", label: "GPT-5.5", efforts: ["none", "low", "medium", "high", "xhigh"], contextWindow: 1_050_000 },
  { id: "zen-gpt-5.5-pro", label: "GPT-5.5 Pro", efforts: ["medium", "high", "xhigh"], contextWindow: 1_050_000 },
  { id: "zen-gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: ["none", "low", "medium", "high", "xhigh", "max"], contextWindow: 1_050_000 },
  { id: "zen-gpt-5.6-sol", label: "GPT-5.6 Sol (50% Off)", efforts: ["none", "low", "medium", "high", "xhigh", "max"], contextWindow: 1_050_000 },
  { id: "zen-gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: ["none", "low", "medium", "high", "xhigh", "max"], contextWindow: 1_050_000 },
  { id: "zen-gpt-6-astra", label: "GPT-6 Astra", efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1_050_000 },
  { id: "zen-grok-4.5", label: "Grok 4.5", efforts: ["low", "medium", "high"], contextWindow: 500_000 },
  { id: "zen-grok-4.6", label: "Grok 4.6", efforts: ["low", "medium", "high", "xhigh"], contextWindow: 500_000 },
  // The vendor's catalog states no effort list for this id (`reasoning_options` null), so none
  // is invented: an effort a model does not advertise is a 400 on this wire family.
  { id: "zen-grok-build-0.1", label: "Grok Build 0.1", contextWindow: 256_000 },
  { id: "zen-muse-spark-1.2", label: "Muse Spark 1.2", efforts: ["minimal", "low", "medium", "high", "xhigh"], contextWindow: 1_048_576 },
  { id: "zen-muse-spark-1.3", label: "Muse Spark 1.3", efforts: ["minimal", "low", "medium", "high", "xhigh", "max"], contextWindow: 1_048_576 },
];

/** `zen-muse-spark-1.3` → `muse-spark-1.3`. The prefix is a REGISTRY-side fact (parseZen says
 *  why) and must never reach the endpoint, which does not publish it. */
export const zenWireId = (id: string) => id.replace(/^zen-/, "");

/** The effort list Zen states for a model, in the catalog's own order. */
function catalogEfforts(rec: ZenModelRecord): string[] | undefined {
  const opts = rec.reasoning_options;
  if (!Array.isArray(opts)) return undefined;
  for (const o of opts) {
    if (o && typeof o === "object" && o.type === "effort" && Array.isArray(o.values)) {
      const vals = o.values.filter((v): v is string => typeof v === "string" && v.length > 0);
      if (vals.length) return vals;
    }
  }
  return undefined;
}

/**
 * Every Zen model this gateway can address, and — separately — everything it could not, by
 * reason. Never throws and never dials: a model lookup must not add latency to a call, the
 * same law registry.models() follows.
 *
 * TWO FILTERS, EACH FOR ITS OWN REASON:
 *   · `provider.npm !== "@ai-sdk/openai"` — a different WIRE. Zen's chat-completions,
 *     anthropic and google dialects are real models this adapter cannot speak, so listing them
 *     would offer names that fail at the first request.
 *   · `cost.input === 0` — the FREE TIER, which the vendor serves only to its own client (see
 *     the header note at the top of this file). Listing it would offer a name this route is
 *     refused, and hiding it is not the same as pretending it does not exist:
 *     refreshZenCatalog() reports the count.
 *
 * ON A FALLBACK SCAN the dropped lists are EMPTY, and that is an absence rather than a measured
 * zero: nothing was examined, because there was no file to examine.
 */
export function zenScan(): { models: ZenCatalogEntry[]; dropped: ZenDropped; source: "file" | "fallback" } {
  const empty: ZenDropped = { free: [], chat: [], anthropic: [], google: [] };
  const fallback = { models: ZEN_FALLBACK, dropped: empty, source: "fallback" as const };
  const f = zenModelsFile();
  if (!existsSync(f)) return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;
  // The one assertion, at the boundary and named — everything below is `typeof`-checked.
  const models = (parsed as ZenModelsFile).opencode?.models;
  if (typeof models !== "object" || models === null || Array.isArray(models)) return fallback;
  const out: ZenCatalogEntry[] = [];
  const dropped: ZenDropped = { free: [], chat: [], anthropic: [], google: [] };
  for (const [id, rec] of Object.entries(models)) {
    if (typeof rec !== "object" || rec === null) continue;
    const npm = rec.provider?.npm ?? null;
    if (npm !== "@ai-sdk/openai") {
      if (npm === "@ai-sdk/anthropic") dropped.anthropic.push(id);
      else if (npm === "@ai-sdk/google") dropped.google.push(id);
      else dropped.chat.push(id);
      continue;
    }
    const cost = rec.cost;
    const input = typeof cost?.input === "number" ? cost.input : 0;
    if (!(input > 0)) { dropped.free.push(id); continue; }
    const efforts = catalogEfforts(rec);
    out.push({
      id: `zen-${id}`,
      label: typeof rec.name === "string" && rec.name.length ? rec.name : id,
      ...(efforts ? { efforts } : {}),
      ...(typeof rec.limit?.context === "number" ? { contextWindow: rec.limit.context } : {}),
      ...(typeof rec.limit?.output === "number" ? { maxOutput: rec.limit.output } : {}),
      ...(cost ? { cost } : {}),
    });
  }
  // An empty result from a present file is a file that lists no Responses-dialect model — the
  // documented floor is still the honest answer, the same call grokCatalog() makes.
  return out.length ? { models: out, dropped, source: "file" } : fallback;
}

/** Every Zen model this gateway can address. */
export const zenCatalog = (): ZenCatalogEntry[] => zenScan().models;

/**
 * Re-read opencode's local catalog. NO NETWORK IN v1, on purpose: opencode's own source for
 * this file is models.dev (`https://models.dev/api.json`), and fetching it here would make
 * `apiplan models --refresh` depend on a third party whose shape this file has never been
 * tested against. A fetch lane is a later, separate piece of work; until then the truth is
 * "whatever opencode last wrote", and the returned counts say which ids were left behind.
 */
export async function refreshZenCatalog(): Promise<{ count: number; dropped: ZenDropped; source: "file" | "fallback"; list: ZenCatalogEntry[] }> {
  const s = zenScan();
  return { count: s.models.length, dropped: s.dropped, source: s.source, list: s.models };
}

/** The Zen gateway. Read out of opencode's own provider record (`api` field of the `opencode`
 *  provider in ~/.cache/opencode/models.json): "https://opencode.ai/zen/v1". */
export const ZEN_DEFAULT_BASE = "https://opencode.ai/zen/v1";
/** Where to send: an explicit override (tests, a proxy), else the published gateway. */
export const zenBase = (): string => env("APIPLAN_ZEN_BASE", ZEN_DEFAULT_BASE).replace(/\/+$/, "");

/** The user agent this adapter signs with — its OWN name and version, never opencode's. */
let UA: string | null = null;
function userAgent(): string {
  if (UA) return UA;
  let v = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length) v = pkg.version;
  } catch { /* an unreadable package.json is not a reason to fail a call */ }
  return (UA = `apiplan/${v}`);
}

// ── the request and the stream, as boundary types ─────────────────────────────

/** The Responses-API body this provider sends — the same shape the grok adapter sends to the
 *  sibling Responses route, named so a reader sees the whole request in one place. */
type ZenRequestBody = {
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

/** A fault as the Responses API reports it: a message plus the vendor's own name for it. */
type ResponsesError = { message?: string; type?: string; code?: string };
/** A Responses-API stream event, as much of it as delta() reads. */
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

export const zen: Provider & StreamShape = {
  id: "zen",
  label: "OpenCode Zen (API key)",
  /**
   * INCLUSIVE — read out of opencode's OWN reader for this dialect, and corroborated by the
   * arithmetic of a turn it actually recorded. Not inferred from the wire shape: borrowing a
   * shape does not guarantee the accounting came with it, which is the one thing worth
   * checking here.
   *
   * THE CODE (opencode 1.18.30, sha256 2d0c9c339bb91046…, 144,272,354 bytes). The Responses
   * reader at byte offset 66_482_809 maps the wire straight through —
   * `this.createUsage({inputTotal:B.usage?.input_tokens, outputTotal:B.usage?.output_tokens,
   * outputReasoning:B.usage?.output_tokens_details?.reasoning_tokens,
   * cacheRead:B.usage?.input_tokens_details?.cached_tokens, …})` — and the `createUsage` of
   * THAT class, at byte offset 66_477_874, publishes
   * `inputTokens:{ total: X, noCache: X==null?void 0:Math.max(0, X-(J??0)), cacheRead: J, … }`
   * where X is `input_tokens` and J is `cached_tokens`. Subtracting the cached share OUT of the
   * input counter is only correct if the counter CONTAINS it. (The sibling class at offset
   * 66_462_474 — the anthropic-dialect one — does the opposite, `total: X+cacheRead+cacheWrite`
   * with `noCache: X`, i.e. an EXCLUSIVE vendor. Two readers, two bases, in one binary: which
   * is why this was read per dialect rather than per program.)
   *
   * THE ARITHMETIC, on a turn opencode stored (~/.local/share/opencode/opencode.db, message
   * row of 2026-09-09 11:32:54.821, model muse-spark-1.3-contributor-free):
   *   tokens { total 134660, input 889, output 3307, reasoning 1583, cache {read 128881,
   *   write 0} }
   * The persisted `input` is `noCache`, so the WIRE's `input_tokens` was 889 + 128_881 =
   * 129_770, and the persisted `total` checks out independently: 129_770 + 3_307 + 1_583 =
   * 134_660. Both halves agree, which is why 129_770 is a derived number that can be trusted
   * rather than a guess. (That row is the FREE tier — the only Zen traffic on this machine —
   * so it is evidence about the DIALECT's accounting, which is shared across Zen's
   * Responses-dialect ids, not a measurement of the paid route. The paid route is stub-proven
   * only until an operator supplies a key; see test/zen.test.ts.)
   *
   * So delta() passes `cached_tokens` through UNSUBTRACTED. api.ts's normalizeTally() owns the
   * single conversion for every provider; subtracting here as well would drive the uncached
   * remainder negative on every cache hit and trip its source-inconsistent guard.
   */
  usageBasis: "inclusive",
  /**
   * IMPLICIT PREFIX, with `prompt_cache_key` as the handle — the Responses convention, which is
   * the wire Zen serves for these ids.
   *
   * THE IDENTITY IS ASSERTED AT THE OUTBOUND BOUNDARY ONLY, and that is the honest strength of
   * the claim. The grok adapter can say more (its endpoint echoes the key back in
   * `response.created`); the sibling Codex Responses route cannot, and neither can this one —
   * nobody here holds a Zen key, so no live call has ever been made from this gateway and no
   * echo has been observed either way. build() therefore SENDS the caller's key and
   * test/zen.test.ts asserts it on the recorded request; whether Zen routes on it is
   * UNVERIFIED and stays that way until a keyed run says otherwise.
   *
   * NO minTokens AND NO ttlMs: opencode.ai/docs/zen publishes neither for this gateway, and
   * DOCUMENTED-OR-ABSENT is the law — a floor borrowed from OpenAI's 1,024 would read as a
   * measured Zen fact. Absent means "the vendor does not say", which is true and useful.
   *
   * NO CACHE-WRITE PATH IS DECLARED at the contract level, and note the asymmetry the roster
   * lane must keep: Zen's catalog DOES publish a `cache_write` price for some ids (gpt-5.6-sol,
   * gpt-6-astra, …) and none for others, so "no write price" is a per-model fact here, not a
   * provider-wide one. The wire's `input_tokens_details.cache_write_tokens` is forwarded by
   * responsesUsage() when it arrives and stays absent when it does not.
   */
  cache: { kind: "implicit-prefix", identity: "prompt_cache_key" },
  probe() {
    const k = readZenKey();
    if (!k) {
      return {
        connected: false,
        detail: `no OpenCode Zen key (OPENCODE_API_KEY or ${zenAuthFile().replace(HOME, "~")} → "opencode")`,
        loginHint: LOGIN_HINT,
      };
    }
    // The credential NAMED without being published: a 12-hex sha256 prefix tells an operator
    // holding several keys which one is in play and cannot be turned back into the key.
    return { connected: true, detail: `${k.source} · key sha256 ${h12(k.key)}`, loginHint: "" };
  },
  creds(): Creds {
    const k = readZenKey();
    if (!k) throw new Error(`no OpenCode Zen key — ${LOGIN_HINT}.`);
    return { token: k.key, source: k.source };
  },
  /**
   * The credential the next creds() would use, as a fingerprint — never a token.
   *
   * `exp` is 0 and `cred` carries the `:0` suffix every other provider's expiry occupies: a Zen
   * API key states no expiry, so there is nothing to fold in. The SOURCE is the identity,
   * because that is the only stable thing this well knows about whose account a key belongs to
   * — the key itself is the secret and the file records no principal.
   */
  credFp(): CredFp {
    const k = readZenKey();
    if (!k) return { cred: "absent", ident: "absent", exp: 0 };
    return { cred: `${h12(k.key)}:0`, ident: h12(k.source), exp: 0 };
  },
  /** The catalog's own list for this model; an id the catalog states no efforts for gets none,
   *  since an unadvertised effort is a 400 on this wire family. */
  efforts: (m: Model) => m.efforts ?? zenCatalog().find((c) => c.id === m.id)?.efforts ?? [],
  build(m: Model, turns: Turn[], o: CallOpts, c: Creds): Built {
    const body: ZenRequestBody = {
      model: zenWireId(m.id),
      instructions: o.system ?? "",
      input: turns.flatMap(toResponsesItems),
      store: false,
      stream: true,
      ...(o.promptCacheKey ? { prompt_cache_key: o.promptCacheKey } : {}),
    };
    // Only when this model advertises the effort — per-model `reasoning_options` in Zen's
    // catalog, and sending one a model does not serve is a 400 on this family. A request-level
    // effort CHANGE also resets the cached prefix upstream, so it is only ever sent when the
    // caller asked for one.
    if (o.effort && zen.efforts(m).includes(o.effort)) {
      body.reasoning = { effort: o.effort, ...(o.showThinking ? { summary: "auto" } : {}) };
    }
    // Caller tools ride as Responses-API function tools in the FLAT shape — the same shape the
    // openai and grok adapters send. `strict` is never set (Claude Code's schemas use
    // anyOf/const/default, which strict mode forbids) and `$schema` is pruned as JSON-Schema
    // framing rather than a parameter schema.
    if (o.tools?.length) {
      body.tools = o.tools.map((t: ToolDef) => ({
        type: "function" as const, name: t.name, description: t.description ?? "",
        parameters: stripSchemaMeta(t.parameters) ?? { type: "object", properties: {} },
      }));
      if (o.toolChoice) {
        body.tool_choice = typeof o.toolChoice === "object" ? { type: "function", name: o.toolChoice.name } : o.toolChoice;
      }
    }
    return {
      url: `${zenBase()}/responses`,
      // FOUR HEADERS, AND DELIBERATELY NOT A FIFTH. No `x-opencode-*` header of any kind is
      // sent: those are opencode's CLIENT IDENTITY (offset 65_841_546), the free tier is gated
      // on `x-opencode-session`, and wearing another client's identity to take a tier its
      // vendor says is opencode-only is the operator's decision to make, not this file's.
      // test/zen.test.ts fails if one ever appears here.
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${c.token}`,
        "user-agent": userAgent(),
      },
      body,
    };
  },
  /** Identical framing to the sibling Responses endpoints: the stream ends on the response
   *  object being reported final — completed, cut short, or failed. A body that stopped before
   *  one of these arrived was truncated in transit. */
  terminal: (ev: ResponsesEvent) => ev?.type === "response.completed" || ev?.type === "response.incomplete"
                                 || ev?.type === "response.failed" || ev?.type === "response.done",
  /**
   * The Responses event vocabulary, read through the SAME helpers the openai and grok adapters
   * use. Byte-for-byte the grok reading, because it is byte-for-byte the same wire — and that
   * sameness is a TESTED property, not a hope: test/zen.test.ts feeds one recorded event
   * sequence through both adapters and requires deep-equal Deltas. (The proper end state is
   * one shared reader hoisted into responses-wire.ts; that edit touches providers-grok.ts and
   * so belongs to its own lane. Until then the parity leg is what stops the two drifting.)
   *
   * Usage comes off `response.completed` via `responsesUsage`, unsubtracted — see usageBasis.
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
   * Three refusals with DIFFERENT fixes, kept apart because sending an operator to the wrong
   * one costs them a login they did not need.
   *
   * The 400 is the interesting one and its wording is the vendor's own, observed verbatim:
   * `{"type":"MissingSessionID","message":"Error from provider (Console): OpenCode's free tier
   * can only be used in OpenCode"}`. It means the call reached Zen and was refused for WHO is
   * asking, not for what was sent — so "check your request" would be actively misleading.
   */
  explain(status: number, body: string): string | undefined {
    if (status === 400 && body.includes("MissingSessionID")) {
      return `OpenCode Zen refused: "OpenCode's free tier can only be used in OpenCode" — free-tier ids are not served outside opencode; use a paid zen id with an API key (https://opencode.ai/zen). ${body.slice(0, 200)}`;
    }
    if (status === 401) return `OpenCode Zen key rejected (401) — regenerate at https://opencode.ai/auth, then \`opencode auth login\` or export OPENCODE_API_KEY. ${body.slice(0, 200)}`;
    if (status === 402 || /balance|credit/i.test(body)) return `OpenCode Zen balance empty — top up at https://opencode.ai/zen. ${body.slice(0, 200)}`;
    return undefined;
  },
};
