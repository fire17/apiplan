// registry.ts — which providers exist, which models they serve, and how a short
// name the user types becomes a concrete model id.
//
// Two rules the vision demands:
//   1. a FAMILY name always means the newest member of that family  (opus → Opus 5)
//   2. an EXPLICIT version is always still reachable                (opus48 → Opus 4.8)
// Both are derived from the provider's own model list, so the day Opus 6 ships,
// `opus` follows it with no code change (and `opus5` keeps working).
import { join } from "node:path";
import { STATE_DIR, readJson, writeJson } from "./platform.ts";
// The zen fallback catalog, from the adapter that owns it. Runtime import, and cycle-free:
// providers-zen.ts imports THIS file only as `import type`, which ESM erases.
import { ZEN_FALLBACK } from "./providers-zen.ts";

export type ProviderId = "anthropic" | "openai" | "google" | "ollama" | "grok" | "gemini" | "zen" | "online";
export type Model = {
  id: string;             // the wire id, e.g. "claude-opus-5"
  provider: ProviderId;
  family: string;         // "opus" | "sonnet" | "haiku" | "fable" | "gpt"
  version: number[];      // [5] or [4,8] — compared left to right
  variant?: string;        // "sol" | "luna" | "terra" | "mini"
  label: string;          // "Claude Opus 5"
  efforts?: string[];     // reasoning levels the provider advertises
  contextWindow?: number; // when the provider's catalog states one (Codex does)
  // Catalog facts the Codex catalog states per model (2026-09-29). All optional: absent = the
  // catalog did not say, and callers keep their own rule rather than guessing.
  maxContextWindow?: number; // catalog max_context_window (872000 for GPT-6) — the roster decides use
  input?: string[];          // catalog input_modalities, e.g. ["text","image"]; see acceptsImages()
  defaultEffort?: string;    // catalog default_reasoning_level (varies by fetch — never hard-code it)
  rank?: number;             // catalog priority (lower = flagship); breaks same-version ties
};
/** One row of a provider's model list as cached in models.<provider>.json. */
export type CatalogEntry = {
  id: string; label: string; efforts?: string[]; contextWindow?: number;
  maxContextWindow?: number; input?: string[]; defaultEffort?: string; rank?: number;
};

/**
 * The Codex catalog (`GET /backend-api/codex/models?client_version=…`) HIDES every model whose
 * `minimal_client_version` is above the version the client asks as. THE single floor constant:
 * the lowest version that lists every model known today — gpt-6-sol and gpt-6-luna need 0.155.0
 * (observed live 2026-09-29: absent at 0.153.4 and 0.154.9, listed from 0.155.0 up to 99.0.0),
 * gpt-6-astra 0.153.0 (2026-09-05). The refresh asks as the max of this, the installed Codex's
 * stamps and APIPLAN_CODEX_CLIENT_VERSION (bin/apiplan.ts) — it only ever moves UP.
 */
export const CODEX_CLIENT_VERSION_FLOOR = "0.155.0";
/** A far-future client version the catalog answers (HTTP 200 at 99.0.0, 2026-09-29). Asking as it
 *  shows every row the server has, so its answer is used only to LEARN the version to ask as —
 *  never stored: metadata is version-sensitive (gpt-6-sol's default effort read `low` at 0.155.0
 *  and `medium` at 1.0.0 the same morning). */
export const CODEX_CATALOG_PROBE_VERSION = "99.0.0";
const SEMVER = /^\d+\.\d+\.\d+$/;
const semverCmp = (a: string, b: string) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
};
/**
 * The client version a catalog says it needs to list every API-capable row: the highest
 * `minimal_client_version` among them (null when none is stated). Derived from the catalog so the
 * next model is seen without a code edit: read once as CODEX_CATALOG_PROBE_VERSION, then re-read
 * as max(CODEX_CLIENT_VERSION_FLOOR, this, known stamps, env).
 */
export function neededClientVersion(raw: any): string | null {
  const vs = (raw?.models ?? []).filter((m: any) => m && m.supported_in_api !== false)
    .map((m: any) => m.minimal_client_version).filter((v: any): v is string => typeof v === "string" && SEMVER.test(v));
  return vs.length ? vs.sort(semverCmp).at(-1)! : null;
}
/** `ultra` is a Codex CLI delegation mode, not a reasoning effort: the Responses endpoint 400s it
 *  (live 2026-09-05), so it is dropped. */
const RESPONSES_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** A raw Codex catalog → the rows this registry caches, with every per-model fact it states. */
export function fromCodexCatalog(raw: any): CatalogEntry[] {
  return (raw?.models ?? []).filter((m: any) => m && m.supported_in_api !== false && (m.slug ?? m.id)).map((m: any) => ({
    id: m.slug ?? m.id, label: m.display_name ?? m.slug ?? m.id,
    efforts: (m.supported_reasoning_levels ?? []).map((e: any) => e?.effort).filter((e: any) => typeof e === "string" && RESPONSES_EFFORTS.has(e)),
    ...(typeof m.context_window === "number" ? { contextWindow: m.context_window } : {}),
    ...(typeof m.max_context_window === "number" ? { maxContextWindow: m.max_context_window } : {}),
    ...(Array.isArray(m.input_modalities) ? { input: m.input_modalities.filter((x: any) => typeof x === "string") } : {}),
    ...(typeof m.default_reasoning_level === "string" && RESPONSES_EFFORTS.has(m.default_reasoning_level) ? { defaultEffort: m.default_reasoning_level } : {}),
    ...(typeof m.priority === "number" ? { rank: m.priority } : {}),
  }));
}
/** True when the catalog says the model takes images; null when it does not say (caller decides). */
export function acceptsImages(m: Pick<Model, "input">): boolean | null {
  return Array.isArray(m.input) ? m.input.includes("image") : null;
}

/**
 * Verified snapshot (Anthropic /v1/models + Codex models_cache, both read live on
 * 2026-07-28). Only a FALLBACK: discovery prefers the provider's own live list, so
 * this file never has to be edited when models ship. Kept so a fresh machine with
 * no network still resolves every alias.
 */
/** Google serves exactly three, and they ride in the WIRE ID rather than the body. */
export const GOOGLE_EFFORTS = ["low", "medium", "high"];
/**
 * The four reasoning efforts the grok subscription catalog advertises for grok-4.6, in its
 * own order (`reasoning_efforts[].value` in ~/.grok/models_cache.json, read live
 * 2026-09-06). Unlike Google's, a grok effort is a REQUEST FIELD (`reasoning.effort`), not
 * part of the wire id — so it never appears in a model id here, and providers-grok.ts
 * prefers the live per-model list over this constant whenever the CLI's catalog is present.
 */
export const GROK_EFFORTS = ["xhigh", "high", "medium", "low"];
/**
 * The thinking levels the API-KEY route documents
 * (ai.google.dev/gemini-api/docs/thinking, "Controlling thinking", read 2026-09-06).
 *
 * SEPARATE FROM GOOGLE_EFFORTS above, and they are not interchangeable even though the
 * words match: a `google` effort is appended to the WIRE ID (gemini-3.6-flash-low) by the
 * Antigravity endpoint's convention, while a `gemini` effort is a request field. Which
 * FIELD also depends on the family, and sending the wrong one is a 400 rather than a
 * downgrade (measured 2026-09-06: gemini-2.5-flash answers `Thinking level is not
 * supported for this model.` to `thinkingLevel`, and 200 to `thinkingBudget`) — that split
 * lives in providers-gemini.ts, which is the only place that has to know it.
 */
export const GEMINI_EFFORTS = ["low", "medium", "high"];
/** The ids whose docs ALSO list `minimal`: 3.6, 3.5-flash, 3.5-flash-lite, 3-flash-preview.
 *  Sending a level a model does not serve is a 400, so the narrower set is the default. */
export const GEMINI_EFFORTS_MINIMAL = ["minimal", "low", "medium", "high"];

// `contextWindow` is optional and only some providers state one; normalizeList() already
// carries it through when a list has it, so a fallback that knows a model's window no longer
// has to throw that fact away until the first refresh.
/** GPT-6 facts shared by every row of the 2026-09-29 Codex catalog (0.155.0 read). */
const GPT6 = { contextWindow: 272_000, maxContextWindow: 872_000, input: ["text", "image"] };
const FALLBACK: Record<ProviderId, CatalogEntry[]> = {
  anthropic: [
    // Opus 5.5 (2026-09-21) and Sonnet 5.5 (2026-09-28): read live from /v1/models on
    // 2026-09-30 (created_at stamps), ids confirmed in platform.claude.com models overview.
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-opus-4-1-20250805", label: "Claude Opus 4.1" },
  ],
  google: [
    // Read live from `agy models` on 2026-08-27 against the Antigravity subscription.
    // The EFFORT is part of Google's wire id (gemini-3.7-flash-low), unlike OpenAI where it
    // is a request field — so these ids carry family/variant only and the provider appends
    // the effort in build(). Baking it in here would break the alias law: `gemini` must mean
    // the newest gemini, not one arbitrary effort of it.
    { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", efforts: GOOGLE_EFFORTS },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", efforts: GOOGLE_EFFORTS },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", efforts: GOOGLE_EFFORTS },
    { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", efforts: ["low", "high"] },
  ],
  // Nothing is baked for ollama on purpose: its library is whatever THIS machine pulled,
  // so a snapshot from another machine would advertise models that answer 404. An empty
  // fallback means `apiplan models` lists nothing until the first `--refresh` — which is
  // the truth, and that refresh is a loopback GET needing no login.
  ollama: [],
  // Read from docs.x.ai on 2026-09-06. A fallback only: the `grok` CLI writes a live
  // catalog for THIS subscription (~/.grok/models_cache.json), and providers-grok.ts's
  // grokCatalog() prefers it — the live file states what this account may actually
  // address, including per-model context windows and reasoning efforts. The efforts here
  // are the four the live catalog advertises for grok-4.6 (`reasoning_efforts`), in its
  // own order, and grok-4 is deliberately absent: its docs page answers 404, so listing
  // it would offer a name nothing supports.
  grok: [
    { id: "grok-4.6", label: "Grok 4.6", efforts: GROK_EFFORTS },
    { id: "grok-4.5", label: "Grok 4.5", efforts: GROK_EFFORTS },
    { id: "grok-4.3", label: "Grok 4.3", efforts: GROK_EFFORTS },
    // The documented id of the model whose older aliases are grok-code-fast-1 /
    // grok-code-fast / grok-code-fast-1-0825; its docs page is titled "Grok Build 0.1".
    { id: "grok-build-0.1", label: "Grok Build 0.1", efforts: GROK_EFFORTS },
  ],
  // The API-KEY route, read live from GET /v1beta/models on 2026-09-06 (54 ids, of which
  // these are the chat + live ones this provider serves). A DIFFERENT catalog from
  // `google` above, which is the Antigravity subscription: same vendor, different
  // entitlement, different billing, and only this one exposes `cachedContents`. Both may
  // be present on one machine at once.
  //
  // THE IDS CARRY `-key-` AND THE VENDOR'S DO NOT. Both routes publish the same names, so
  // the route has to live in the id — see parseGemini for why sharing a name breaks
  // resolve(), the roster's uniqueness rule, and the caller's ability to choose a
  // credential at all. `geminiWireId()` strips it back off for the wire.
  //
  // A gemini effort is a REQUEST FIELD, not part of the wire id (unlike `google`, which
  // bakes it in), and WHICH field depends on the family — 3.x takes `thinkingLevel`, 2.5
  // takes `thinkingBudget`. providers-gemini.ts owns that split; the registry only carries
  // the level NAMES, and `minimal` appears only on the ids whose docs list it.
  gemini: [
    { id: "gemini-key-3.8-flash", label: "Gemini 3.8 Flash (API key)", efforts: GEMINI_EFFORTS },
    { id: "gemini-key-3.7-flash", label: "Gemini 3.7 Flash (API key)", efforts: GEMINI_EFFORTS },
    { id: "gemini-key-3.6-flash", label: "Gemini 3.6 Flash (API key)", efforts: GEMINI_EFFORTS_MINIMAL },
    { id: "gemini-key-3.5-flash", label: "Gemini 3.5 Flash (API key)", efforts: GEMINI_EFFORTS_MINIMAL },
    { id: "gemini-key-3.5-flash-lite", label: "Gemini 3.5 Flash Lite (API key)", efforts: GEMINI_EFFORTS_MINIMAL },
    { id: "gemini-key-3.1-pro-preview", label: "Gemini 3.1 Pro Preview (API key)", efforts: GEMINI_EFFORTS },
    { id: "gemini-key-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (API key)", efforts: GEMINI_EFFORTS },
    // The 2.5 family is the only one that serves EXPLICIT caching as well as implicit
    // (`createCachedContent` in its supportedGenerationMethods, live catalog 2026-09-06)
    // and the only one whose documented implicit floor is 2,048 rather than 4,096 — which
    // is why the provider's cache contract declares 2,048 as the lowest active floor.
    { id: "gemini-key-2.5-pro", label: "Gemini 2.5 Pro (API key)", efforts: GEMINI_EFFORTS },
    { id: "gemini-key-2.5-flash", label: "Gemini 2.5 Flash (API key)", efforts: GEMINI_EFFORTS },
    { id: "gemini-key-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (API key)", efforts: GEMINI_EFFORTS },
    // LIVE (bidiGenerateContent) — a WebSocket transport, not this streaming HTTP one, so
    // they carry NO efforts: a chat request to one of these ids does not apply. They are
    // listed because the roster and `apiplan live-models` must be able to name them, and
    // because their caching story is the vendor's implicit prefix cache like everything
    // else on 2.5+. See live-models.ts for the transport each one needs.
    { id: "gemini-key-3.1-flash-live-preview", label: "Gemini 3.1 Flash Live (API key)", efforts: [] },
    { id: "gemini-key-2.5-flash-native-audio-preview-12-2025", label: "Gemini 2.5 Flash Native Audio (API key)", efforts: [] },
    { id: "gemini-key-3.5-live-translate-preview", label: "Gemini 3.5 Live Translate (API key)", efforts: [] },
    { id: "gemini-key-3.5-transcribe-live", label: "Gemini 3.5 Transcribe Live (API key)", efforts: [] },
  ],
  // Signed-in ChatGPT website routes. These are deliberately route-prefixed so a
  // website model can never steal the established API/subscription aliases.
  online: [
    { id: "online-gpt-6-astra", label: "ChatGPT website — Astra", efforts: ["low"], contextWindow: 32_000 },
    { id: "online-chat-latest", label: "ChatGPT website — Latest", efforts: ["low"], contextWindow: 32_000 },
  ],
  // OpenCode Zen, the API-key gateway at opencode.ai/zen. The list lives in
  // providers-zen.ts (ZEN_FALLBACK) rather than being copied here, because it is the SAME
  // list the adapter's catalog falls back to and two copies of one vendor snapshot drift
  // silently — the grok pair above is already two copies of one thing. The import is
  // runtime but CYCLE-FREE: providers-zen.ts reaches this file only through
  // `import type { Model }`, which ESM erases, and nothing else on its import chain
  // (platform.ts, responses-wire.ts → wire.ts) imports the registry at runtime.
  //
  // Only the PAID, Responses-dialect ids are here; see providers-zen.ts for why the free
  // tier and the other three dialects are deliberately not addressable.
  zen: ZEN_FALLBACK,
  openai: [
    // GPT-6 (read live from the Codex catalog): Astra lists from `client_version` 0.153.0
    // (2026-09-05), Sol and Luna from 0.155.0 (2026-09-29) — see CODEX_CLIENT_VERSION_FLOOR above.
    // In the catalog's own priority order (astra 1, sol 2, luna 3), which keeps `gpt` on Astra.
    // Efforts are the catalog's, minus `ultra`: that one is a Codex CLI delegation mode the
    // Responses endpoint rejects as a reasoning effort (400, live). `none` on sol/luna is added
    // in ONE place for cache and fallback alike — WIRE_EFFORTS below.
    { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", rank: 1, ...GPT6 },
    { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "low", rank: 2, ...GPT6 },
    { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", rank: 3, ...GPT6 },
    { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"] },
    // gpt-5.4 left the live catalog by 2026-09-05; only its -mini sibling is still served.
    { id: "gpt-5.4-mini", label: "GPT-5.4-mini", efforts: ["low", "medium", "high", "xhigh"] },
    // API-capable named products from the live Codex catalog. Keep them in the offline
    // fallback too: a clean install has no models.openai.json yet, but exact model names
    // must remain addressable before the first authenticated refresh.
    { id: "gpt-reserve", label: "GPT Reserve", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "codex-auto-review", label: "Codex Auto Review", efforts: ["low", "medium", "high", "xhigh"] },
  ],
};

/** Anthropic effort levels are model-dependent; OpenAI advertises its own per model. */
export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const CACHE = (p: ProviderId) => join(STATE_DIR, `models.${p}.json`);
const TTL_MS = 24 * 60 * 60 * 1000;

/** "claude-opus-4-5-20251101" → family opus, version [4,5]; a trailing date is not a version. */
function parseAnthropic(id: string, label: string, efforts?: string[]): Model | null {
  const m = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(.+)$/);
  if (!m) return null;
  const nums = m[2].split("-").filter((p) => /^\d+$/.test(p) && p.length <= 2).map(Number);
  return { id, provider: "anthropic", family: m[1], version: nums.length ? nums : [0], label, efforts: efforts ?? ANTHROPIC_EFFORTS };
}
/**
 * Codex's live catalog also carries named products (`gpt-reserve`, `codex-auto-review`)
 * without a numeric version. They are real subscription models when `supported_in_api`
 * is true; rejecting them because their names are not version-shaped silently drops
 * eligible capacity. Hidden affects UI prominence, not addressability.
 */
function parseOpenai(id: string, label: string, efforts?: string[]): Model | null {
  const numbered = id.match(/^(gpt|o)-?([\d.]+)(?:-([a-z][a-z0-9-]*))?$/);
  if (numbered) return { id, provider: "openai", family: numbered[1] === "o" ? "o" : "gpt", version: numbered[2].split(".").map(Number), variant: numbered[3], label, efforts };
  const named = id.match(/^(gpt|codex)-([a-z][a-z0-9-]*)$/);
  if (!named) return null;
  return { id, provider: "openai", family: named[1], version: [], variant: named[2], label, efforts };
}
/** "gemini-3.7-flash" → family gemini, version [3,7], variant flash. A trailing effort
 *  (…-low) is NOT part of the model identity — the provider appends it at call time. */
function parseGoogle(id: string, label: string, efforts?: string[]): Model | null {
  const m = id.match(/^gemini-([\d.]+)-(flash|pro)(?:-(?:low|medium|high))?$/);
  if (!m) return null;
  return { id: `gemini-${m[1]}-${m[2]}`, provider: "google", family: "gemini",
           version: m[1].split(".").map(Number), variant: m[2], label,
           efforts: efforts ?? (m[2] === "pro" ? ["low", "high"] : GOOGLE_EFFORTS) };
}

/**
 * "heretic:latest" / "qwen3:0.6b" / "hoangquan456/qwen3-nothink:0.6b" → family = the model
 * name with its registry namespace and its tag removed. Deliberately NO version and NO
 * variant:
 *   · a tag is not a version — "latest", "q4_K_M" and "0.6b" do not order,
 *   · so aliasesFor() would otherwise mint junk like `qwen3060.6b`, and a bare variant
 *     alias `0.6b` would collide across every model that has a 0.6b tag.
 * With an empty version, every tag of a name aliases to the name and resolve() returns the
 * FIRST one listed — which is why refresh writes them newest-modified first, so `heretic`
 * means the newest heretic exactly the way `opus` means the newest Opus. Any tag is still
 * reachable by its exact id (`heretic:q4_K_M`).
 */
function parseOllama(id: string, label: string, efforts?: string[]): Model | null {
  const m = id.match(/^(?:[^/\s]+\/)?([^\s:]+)(?::([^\s:]+))?$/);
  if (!m) return null;
  return { id, provider: "ollama", family: m[1].toLowerCase(), version: [], label, efforts };
}
/**
 * "grok-4.6" → family grok, version [4,6]. "grok-build-0.1" → family grokbuild,
 * version [0,1].
 *
 * TWO NAME SHAPES, because xAI ships both: a numbered flagship (`grok-4.6`, `grok-4.5`,
 * `grok-4.3`) and a NAMED line whose version follows the name (`grok-build-0.1`, whose
 * older aliases are `grok-code-fast-1` and friends). Both are real subscription models, so
 * rejecting the second because its version does not sit directly after "grok-" would
 * silently drop eligible capacity — the same fault parseOpenai's `named` branch exists to
 * avoid, and the one `unparseable()` reports rather than hides.
 *
 * WHY THE NAMED LINE IS ITS OWN FAMILY RATHER THAN A VARIANT OF `grok`. Two laws collide
 * if it is a variant, and both break:
 *   · resolve() matches a bare VARIANT before a family, and aliasesFor()/
 *     defaultCommandNames() would mint the bare word `build` as a top-level alias and a
 *     command on PATH. "build" is far too generic to own — it collides with the most
 *     ordinary word in a developer's shell, and RESERVED exists precisely because that
 *     class of name must not be taken.
 *   · a variant shares its family's version ordering, so `grok-build-0.1` at [0,1] would
 *     sit in the same ranking as `grok-4.6` at [4,6]. Harmless today only because 0.1 is
 *     lowest; the day the named line reaches 5.0 it would silently steal the bare `grok`
 *     alias from the numbered flagship, which is exactly what the alias law forbids.
 * As its own family the line is addressed by `grokbuild` (family + version → `grokbuild01`,
 * family alone → the newest one), the numbered flagship keeps `grok`, and the exact id
 * always resolves. No generic word is claimed.
 */
function parseGrok(id: string, label: string, efforts?: string[]): Model | null {
  const m = id.match(/^grok-(?:([a-z][a-z0-9]*)-)?(\d[\d.]*)$/);
  if (!m) return null;
  return {
    id, provider: "grok",
    family: m[1] ? `grok${m[1]}` : "grok",
    version: m[2].split(".").map(Number),
    label, efforts: efforts ?? GROK_EFFORTS,
  };
}

/**
 * One parser per provider, in a TABLE.
 *
 * Both call sites below used to pick the parser with a two-way conditional on the provider id.
 * Adding a third provider without changing both would have routed every gemini id to the
 * OpenAI parser, which returns null for them — so Google would have listed ZERO models with no
 * error at all: exactly the silent truncation `unparseable()` exists to report. A table cannot
 * fail that way, because a new ProviderId with no entry here is a compile error.
 */

/**
 * "gemini-key-3.8-flash" → family geminikey, version [3,8], variant flash.
 *
 * WHY THE ID CARRIES A `-key-` SEGMENT INSTEAD OF BEING THE VENDOR'S OWN NAME. Both
 * Google routes serve the SAME published names — `gemini-3.8-flash` is a real id on the
 * Antigravity subscription (`google`) and on the API-key endpoint (`gemini`) — and a
 * registry that listed it twice would break three things at once:
 *   · resolve() returns the FIRST match, so one of the two routes would be unreachable by
 *     id while still appearing in every listing: the silent truncation this file's
 *     `unparseable()` exists to prevent, wearing a different hat.
 *   · the harness roster asserts its ids are unique (a picker showing one name twice
 *     cannot tell a human which credential pays), so the second copy would be dropped —
 *     again silently, and again route-dependently.
 *   · a model id is the ONLY thing a caller sends. Two routes behind one name means a
 *     request cannot express which credential it wants, and the two are not
 *     interchangeable: they bill differently, and only the key route can address a cache.
 * So the route is IN THE NAME, once, and providers-gemini.ts maps it back to the vendor's
 * spelling in build() — the same shape as `google`, which likewise builds a wire id its
 * public model ids do not carry (it appends the effort). `gemini` still means the
 * subscription's newest Gemini, because models() lists `google` first; the key route is
 * `geminikey` (newest), `geminikey38flash` (exact), or the full id.
 *
 * Accepts the whole published id space rather than a flash|pro enum: this catalog also
 * carries -flash-lite, -pro-preview and the four bidi LIVE ids, and an id the parser
 * rejects is a model the registry silently cannot address.
 */
function parseGemini(id: string, label: string, efforts?: string[]): Model | null {
  const m = id.match(/^gemini-key-(\d[\d.]*)-(.+)$/);
  if (!m) return null;
  return {
    id, provider: "gemini", family: "geminikey",
    version: m[1].split(".").map(Number),
    // The remainder, folded to an alias-safe word: "flash-lite" → flashlite,
    // "flash-live-preview" → flashlivepreview. Long ones are unlovely as aliases and are
    // meant to be: those models are addressed by their exact id.
    variant: m[2].replace(/[^a-z0-9]/g, ""),
    label, efforts,
  };
}
/** The vendor's own spelling of a `gemini` model id — what goes on the wire. The route
 *  marker is a registry-side fact (see parseGemini) and must never reach the endpoint,
 *  which answers 404 for an id it does not publish. */
export const geminiWireId = (id: string) => id.replace(/^gemini-key-/, "gemini-");

/**
 * "zen-muse-spark-1.3" → family zenmuse, version [1,3], variant spark.
 * "zen-gpt-6-astra"    → family zengpt,  version [6],   variant astra.
 * "zen-grok-build-0.1" → family zengrokbuild, version [0,1].
 *
 * WHY EVERY ZEN ID CARRIES A `zen-` PREFIX — the same fault parseGemini's `-key-` marker
 * exists to prevent, one vendor further out. OpenCode Zen is a GATEWAY: it republishes other
 * vendors' models under THEIR OWN PUBLISHED NAMES (`gpt-6-astra`, `grok-4.6`, and — in the
 * dialects this lane does not yet serve — `claude-opus-5`). An unprefixed registry entry
 * would break three things at once:
 *   · resolve() returns the FIRST match, so one of the two routes to a shared name becomes
 *     unreachable by id while still appearing in every listing — the silent truncation
 *     `unparseable()` exists to report, wearing a different hat.
 *   · the harness roster asserts its ids are unique, so the second copy is dropped, again
 *     silently and again route-dependently.
 *   · a model id is the ONLY thing a caller sends, so two routes behind one name means a
 *     request cannot express WHICH CREDENTIAL IT WANTS — and these are not interchangeable:
 *     a Zen call bills the operator's Zen key, a `gpt-6-astra` call bills their ChatGPT
 *     subscription.
 * The FAMILY is prefixed for the same reason: an unprefixed `gpt` family here would put zen's
 * copies into the same family ranking as the subscription's, so the day Zen published a
 * higher version number the bare `gpt` alias — and the `gpt` command on PATH — would silently
 * change which credential pays. providers-zen.ts's `zenWireId()` strips the prefix back off
 * for the wire, which does not publish it.
 *
 * THREE NAME SHAPES, because Zen ships all three:
 *   · the MUSE line, whose product word is the variant (`muse-spark-1.3`) — matched first so
 *     `spark` is a real variant alias rather than half of a family name. Its `-contributor`
 *     / `-contributor-free` siblings parse too (they are filtered out of the catalog for a
 *     different reason — see providers-zen.ts — and a parser that could not name them would
 *     make that filter invisible);
 *   · the ORDINARY numbered shape (`gpt-5.1-codex-max`, `grok-4.6`, `grok-build-0.1`), where
 *     the leading words are the family and a trailing word is the variant;
 *   · a NAMED product with no version at all, which cmpVersion already ranks below every
 *     numbered model so it can never steal a family alias.
 * An id matching none of them returns null and is REPORTED by unparseable() rather than
 * quietly dropped.
 */
function parseZen(id: string, label: string, efforts?: string[]): Model | null {
  const outer = id.match(/^zen-(.+)$/);
  if (!outer) return null;
  const inner = outer[1];
  const muse = inner.match(/^muse-spark-(\d[\d.]*)(?:-(contributor(?:-free)?))?$/);
  if (muse) {
    return {
      id, provider: "zen", family: "zenmuse",
      version: muse[1].split(".").map(Number),
      // The free/contributor siblings are DIFFERENT products at different prices, so they are
      // different variants — never one variant with a footnote.
      variant: muse[2] === "contributor-free" ? "sparkfree" : muse[2] === "contributor" ? "sparkcontributor" : "spark",
      label, efforts,
    };
  }
  const numbered = inner.match(/^([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*?)-(\d[\d.]*)(?:-([a-z][a-z0-9-]*))?$/);
  if (numbered) {
    return {
      id, provider: "zen", family: `zen${numbered[1].replace(/[^a-z0-9]/g, "")}`,
      version: numbered[2].split(".").map(Number),
      // Folded to an alias-safe word the way parseGemini folds its remainder:
      // "codex-max" → codexmax. Long ones are unlovely as aliases and are meant to be —
      // those models are addressed by their exact id.
      ...(numbered[3] ? { variant: numbered[3].replace(/[^a-z0-9]/g, "") } : {}),
      label, efforts,
    };
  }
  const named = inner.match(/^([a-z][a-z0-9-]*)$/);
  if (!named) return null;
  return { id, provider: "zen", family: `zen${named[1].replace(/[^a-z0-9]/g, "")}`, version: [], label, efforts };
}

function parseOnline(id: string, label: string, efforts?: string[]): Model | null {
  if (id === "online-gpt-6-astra") return { id, provider: "online", family: "onlinegpt", version: [6], variant: "astra", label, efforts: efforts ?? ["low"] };
  if (id === "online-chat-latest") return { id, provider: "online", family: "onlinechat", version: [], label, efforts: efforts ?? ["low"] };
  return null;
}

const PARSERS: Record<ProviderId, (id: string, label: string, efforts?: string[]) => Model | null> = {
  anthropic: parseAnthropic,
  openai: parseOpenai,
  google: parseGoogle,
  ollama: parseOllama,
  grok: parseGrok,
  gemini: parseGemini,
  zen: parseZen,
  online: parseOnline,
};

/** Which of these ids this registry can actually address (exported so callers can
 *  report what was dropped instead of silently truncating a provider's list). */
export function unparseable(p: ProviderId, raw: { id: string }[]): string[] {
  const parse = PARSERS[p];
  return raw.filter((r) => !parse(r.id, "")).map((r) => r.id);
}

/**
 * Efforts the Responses WIRE accepts that the Codex catalog does not list. Each row is a receipt,
 * not a guess: a 400 for effort 'minimal' names the model's real set (live 2026-09-29, scratchpad
 * p1/effort-probe.txt): gpt-6-sol / gpt-6-luna → 'none','low','medium','high','xhigh','max';
 * gpt-6-astra → no 'none'. `none` on gpt-6-luna answered an image correctly with no reasoning.
 * Prepended so the ladder still reads least → most. OM never sees it (harnessEfforts filters).
 */
const WIRE_EFFORTS: Record<string, string[]> = { "gpt-6-sol": ["none"], "gpt-6-luna": ["none"] };
function withWireEfforts(p: ProviderId, id: string, efforts?: string[]): string[] | undefined {
  const extra = p === "openai" ? WIRE_EFFORTS[id] : undefined;
  if (!extra || !efforts) return efforts;
  return [...extra.filter((e) => !efforts.includes(e)), ...efforts];
}
function normalizeList(p: ProviderId, raw: CatalogEntry[]): Model[] {
  const parse = PARSERS[p];
  return raw.map((r) => {
    const m = parse(r.id, r.label, withWireEfforts(p, r.id, r.efforts));
    if (!m) return null;
    if (r.contextWindow) m.contextWindow = r.contextWindow;
    if (r.maxContextWindow) m.maxContextWindow = r.maxContextWindow;
    if (Array.isArray(r.input) && r.input.length) m.input = r.input;
    if (r.defaultEffort) m.defaultEffort = r.defaultEffort;
    if (typeof r.rank === "number") m.rank = r.rank;
    return m;
  }).filter(Boolean) as Model[];
}
const cmpVersion = (a: Model, b: Model) => {
  // Named products with no version are real and exactly addressable, but they never
  // outrank a numbered flagship for a family alias (`gpt` stays the newest numbered GPT —
  // GPT-6-Astra since 2026-09-05).
  if (!a.version.length && b.version.length) return 1;
  if (a.version.length && !b.version.length) return -1;
  const n = Math.max(a.version.length, b.version.length);
  for (let i = 0; i < n; i++) { const d = (b.version[i] ?? -1) - (a.version[i] ?? -1); if (d) return d; }
  // Same version: the catalog's own priority (astra 1, sol 2, luna 3), so `gpt`/`gpt6`/`codex`
  // cannot silently move if the catalog ever reorders its list. No rank on either → list order.
  if (typeof a.rank === "number" && typeof b.rank === "number" && a.rank !== b.rank) return a.rank - b.rank;
  return 0;
};

/**
 * Every known model, newest first. Reads the on-disk cache written by
 * `refresh()`; falls back to the baked snapshot. NEVER touches the network —
 * a model lookup must not add latency to a call.
 */
export function models(p?: ProviderId): Model[] {
  // NOT derived from ProviderId: the ORDER is meaningful. resolve() returns the first
  // match, so `gemini` (family alone) means the Antigravity subscription's newest Gemini
  // because `google` is listed before `gemini` — the API-key route is reached as
  // `geminikey`. A provider missing from this array is silently invisible everywhere
  // (roster, /v1/models, resolve) while still compiling, so adding a union member means
  // adding it here too.
  // `zen` is LAST on purpose: it is a GATEWAY that republishes other vendors' models, so for
  // any name two providers share, the direct route must win the alias and the zen copy stays
  // reachable by its own prefixed id (`gpt-6-astra` → the ChatGPT subscription;
  // `zen-gpt-6-astra` → the Zen key). Moving it up would silently re-point an alias at a
  // different credential and a different bill.
  const ps: ProviderId[] = p ? [p] : ["anthropic", "openai", "google", "ollama", "grok", "gemini", "zen", "online"];
  const out: Model[] = [];
  for (const id of ps) {
    const cached = readJson<{ fetched_at?: number; models?: any[] }>(CACHE(id), {});
    const raw = cached.models?.length ? cached.models : FALLBACK[id];
    out.push(...normalizeList(id, raw).sort(cmpVersion));
  }
  return out;
}
export function cacheAge(p: ProviderId): number | null {
  const c = readJson<{ fetched_at?: number }>(CACHE(p), {});
  return c.fetched_at ? Date.now() - c.fetched_at : null;
}
export function cacheStale(p: ProviderId): boolean {
  // Online routes are a fixed local capability table; there is no remote model catalog to refresh.
  if (p === "online") return false;
  const a = cacheAge(p);
  return a === null || a > TTL_MS;
}
export function saveModels(p: ProviderId, list: CatalogEntry[]) {
  writeJson(CACHE(p), { fetched_at: Date.now(), models: list });
}

/** Fold "Opus-4.8" / "opus4.8" / "opus_48" all onto one key: "opus48". */
export const norm = (s: string) => s.toLowerCase().replace(/[\s._\-]/g, "");

/**
 * Names an Anthropic client sends that this registry has never heard of: dated wire ids
 * (claude-3-5-haiku-20241022), undated aliases (claude-sonnet-4-5), and the small fast
 * background model Claude Code uses for titles and summaries. A 404 there kills a turn the
 * human never asked for, so fall back to the newest sibling of the same family this machine
 * CAN serve — and say so on stderr, once per name.
 */
const SUBSTITUTED = new Set<string>();
function announceSubstitution(asked: string, got: Model): Model {
  if (!SUBSTITUTED.has(asked)) {
    SUBSTITUTED.add(asked);
    console.error(`apiplan: model '${asked}' is not in the registry — serving '${got.id}' instead`);
  }
  return got;
}
function anthropicFallback(name: string, all: Model[]): Model | null {
  if (!/^claude/i.test(name)) return null;
  const undate = (s: string) => s.replace(/-\d{8}$/, "");
  // 1. a trailing -YYYYMMDD is a snapshot date, not an identity: match without it
  const n = norm(undate(name));
  const dated = all.find((m) => m.provider === "anthropic" && norm(undate(m.id)) === n);
  if (dated) return announceSubstitution(name, dated);
  // 2. family-wise: any claude-*haiku* → the newest haiku this machine has
  const fam = ["opus", "sonnet", "haiku", "fable", "mythos"].find((f) => name.toLowerCase().includes(f));
  if (!fam) return null;
  const newest = all.find((m) => m.provider === "anthropic" && m.family === fam);
  return newest ? announceSubstitution(name, newest) : null;
}

/**
 * name → model. Resolution order, most specific first:
 *   exact wire id · explicit family+version (opus48) · variant (sol) · family (opus → newest)
 * Returns null for an unknown name, so callers can pass a raw id straight through.
 */
export function resolve(name: string): Model | null {
  // A trailing parenthetical is a LABEL, not identity: a harness roster may list
  // "claude-sonnet-5 (dumb - do not use)" so the warning travels in the one field every
  // picker actually shows — the id. Stripped here, it still reaches claude-sonnet-5.
  name = name.replace(/\s*\([^()]*\)\s*$/, "").trim();
  const onlineRoute = name.toLowerCase();
  if (onlineRoute === "online/astra" || onlineRoute === "online/chat") {
    const id = onlineRoute === "online/astra" ? "online-gpt-6-astra" : "online-chat-latest";
    return models("online").find((m) => m.id === id) ?? null;
  }
  const all = models();
  const n = norm(name);
  const exact = all.find((m) => norm(m.id) === n || m.id === name);
  if (exact) return exact;
  // `codex` is the established alias for the OpenAI coding flagship. It is checked
  // before the named `codex-auto-review` family, whose exact id / auto-review alias still
  // reach it without stealing the long-standing command.
  if (n === "codex") return all.find((m) => m.provider === "openai" && m.family === "gpt") ?? all.find((m) => m.provider === "openai") ?? null;
  // family + version, with or without a variant: opus48, gpt56sol, gpt54mini
  for (const m of all) {
    const v = m.version.join("");
    if (n === norm(m.family + v + (m.variant ?? ""))) return m;
    if (m.variant && v && n === norm(m.family + v)) return m; // gpt56 → first 5.6 (sol); named gpt-reserve never steals `gpt`
  }
  // variant + version, on OpenAI's own line only: luna6 → gpt-6-luna, sol56 → gpt-5.6-sol.
  // The variant word follows the newest (`luna` → GPT-6-Luna since 2026-09-29), so the previous
  // generation needs a short explicit name; `gpt56luna` still works too. OpenAI-only so gateway
  // copies (zen-gpt-5.6-luna) and other vendors' variants (flash, spark) mint no new words.
  for (const m of all) {
    if (m.provider === "openai" && m.variant && m.version.length && n === norm(m.variant + m.version.join(""))) return m;
  }
  // variant alone: sol / luna / terra / mini
  const byVariant = all.find((m) => m.variant && norm(m.variant) === n);
  if (byVariant) return byVariant;
  // family alone → newest member (the rule the vision asks for)
  const fam = all.filter((m) => norm(m.family) === n);
  if (fam.length) return fam[0];
  return anthropicFallback(name, all);
}

/** Every alias we can offer for a model — used by `apiplan models` and completions. */
export function aliasesFor(m: Model): string[] {
  if (m.provider === "online") return m.id === "online-gpt-6-astra" ? ["online/astra"] : m.id === "online-chat-latest" ? ["online/chat"] : [];
  const all = models();
  const v = m.version.join("");
  const out = new Set<string>();
  if (m.family !== "codex" && all.filter((x) => x.family === m.family && x.provider === m.provider)[0]?.id === m.id) out.add(m.family);
  out.add(m.family + v + (m.variant ?? ""));
  // A BARE VARIANT IS ONLY AN ALIAS IF IT ACTUALLY LANDS HERE. resolve() returns the FIRST
  // model carrying a variant word, so when several models share one — `nano` across zen's
  // gpt-5-nano and gpt-5.4-nano, `sol` across the ChatGPT subscription and the zen gateway's
  // copy of it — exactly one of them owns the word and every other row was printing it as
  // though it were reachable. `apiplan models` shows this list to a human who then TYPES one
  // of these words, and a listing that offers a name answering with a different model (on a
  // different credential, and a different bill) is worse than a listing that omits it.
  // Checked against resolve() itself rather than re-deriving the rule, so the two can never
  // disagree — the same reason the family branch above compares against models() order.
  if (m.variant && resolve(m.variant)?.id === m.id) out.add(m.variant);
  // luna6 / luna56 — the variant+version names resolve() accepts on OpenAI's line. Listed only
  // where the bare word spans generations (luna, sol: 6 and 5.6), since only there does a reader
  // need the explicit name; astra6 / terra56 still resolve, they are just not advertised.
  if (m.provider === "openai" && m.variant && v && all.filter((x) => x.provider === "openai" && x.variant === m.variant && x.version.length).length > 1) {
    const vv = m.variant + v; if (resolve(vv)?.id === m.id) out.add(vv);
  }
  return [...out];
}

/** The alias set we install by default: one per family + one per current variant. */
export function defaultCommandNames(): { name: string; model: string }[] {
  const out: { name: string; model: string }[] = [];
  const seen = new Set<string>();
  for (const m of models()) {
    const fam = m.family;
    const key = `${m.provider}:${fam}`;
    if (!seen.has(key)) { seen.add(key); out.push({ name: fam, model: fam }); }
    if (m.variant && m.version.join("") === models(m.provider)[0].version.join("")) {
      out.push({ name: m.variant, model: m.variant });
    }
  }
  return out;
}
