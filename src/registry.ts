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

export type ProviderId = "anthropic" | "openai" | "google" | "ollama";
export type Model = {
  id: string;             // the wire id, e.g. "claude-opus-5"
  provider: ProviderId;
  family: string;         // "opus" | "sonnet" | "haiku" | "fable" | "gpt"
  version: number[];      // [5] or [4,8] — compared left to right
  variant?: string;        // "sol" | "luna" | "terra" | "mini"
  label: string;          // "Claude Opus 5"
  efforts?: string[];     // reasoning levels the provider advertises
};

/**
 * Verified snapshot (Anthropic /v1/models + Codex models_cache, both read live on
 * 2026-07-28). Only a FALLBACK: discovery prefers the provider's own live list, so
 * this file never has to be edited when models ship. Kept so a fresh machine with
 * no network still resolves every alias.
 */
/** Google serves exactly three, and they ride in the WIRE ID rather than the body. */
export const GOOGLE_EFFORTS = ["low", "medium", "high"];

const FALLBACK: Record<ProviderId, { id: string; label: string; efforts?: string[] }[]> = {
  anthropic: [
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
  openai: [
    { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.4", label: "GPT-5.4", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.4-mini", label: "GPT-5.4-mini", efforts: ["low", "medium", "high"] },
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
 * One parser per provider, in a TABLE.
 *
 * Both call sites below used to pick the parser with a two-way conditional on the provider id.
 * Adding a third provider without changing both would have routed every gemini id to the
 * OpenAI parser, which returns null for them — so Google would have listed ZERO models with no
 * error at all: exactly the silent truncation `unparseable()` exists to report. A table cannot
 * fail that way, because a new ProviderId with no entry here is a compile error.
 */
const PARSERS: Record<ProviderId, (id: string, label: string, efforts?: string[]) => Model | null> = {
  anthropic: parseAnthropic,
  openai: parseOpenai,
  google: parseGoogle,
  ollama: parseOllama,
};

/** Which of these ids this registry can actually address (exported so callers can
 *  report what was dropped instead of silently truncating a provider's list). */
export function unparseable(p: ProviderId, raw: { id: string }[]): string[] {
  const parse = PARSERS[p];
  return raw.filter((r) => !parse(r.id, "")).map((r) => r.id);
}

function normalizeList(p: ProviderId, raw: { id: string; label: string; efforts?: string[] }[]): Model[] {
  const parse = PARSERS[p];
  return raw.map((r) => parse(r.id, r.label, r.efforts)).filter(Boolean) as Model[];
}
const cmpVersion = (a: Model, b: Model) => {
  // Named products with no version are real and exactly addressable, but they never
  // outrank a numbered flagship for a family alias (`gpt` remains GPT-5.6-Sol).
  if (!a.version.length && b.version.length) return 1;
  if (a.version.length && !b.version.length) return -1;
  const n = Math.max(a.version.length, b.version.length);
  for (let i = 0; i < n; i++) { const d = (b.version[i] ?? -1) - (a.version[i] ?? -1); if (d) return d; }
  return 0; // same version: keep provider order (first listed is the flagship, e.g. sol)
};

/**
 * Every known model, newest first. Reads the on-disk cache written by
 * `refresh()`; falls back to the baked snapshot. NEVER touches the network —
 * a model lookup must not add latency to a call.
 */
export function models(p?: ProviderId): Model[] {
  const ps: ProviderId[] = p ? [p] : ["anthropic", "openai", "google", "ollama"];
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
  const a = cacheAge(p);
  return a === null || a > TTL_MS;
}
export function saveModels(p: ProviderId, list: { id: string; label: string; efforts?: string[] }[]) {
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
  const all = models();
  const v = m.version.join("");
  const out = new Set<string>();
  if (m.family !== "codex" && all.filter((x) => x.family === m.family && x.provider === m.provider)[0]?.id === m.id) out.add(m.family);
  out.add(m.family + v + (m.variant ?? ""));
  if (m.variant) out.add(m.variant);
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
