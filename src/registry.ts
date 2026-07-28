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

export type ProviderId = "anthropic" | "openai";
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
/** "gpt-5.6-sol" → family gpt, version [5,6], variant sol. */
function parseOpenai(id: string, label: string, efforts?: string[]): Model | null {
  const m = id.match(/^(gpt|o)-?([\d.]+)(?:-([a-z]+))?$/);
  if (!m) return null;
  return { id, provider: "openai", family: "gpt", version: m[2].split(".").map(Number), variant: m[3], label, efforts };
}

/** Which of these ids this registry can actually address (exported so callers can
 *  report what was dropped instead of silently truncating a provider's list). */
export function unparseable(p: ProviderId, raw: { id: string }[]): string[] {
  const parse = p === "anthropic" ? parseAnthropic : parseOpenai;
  return raw.filter((r) => !parse(r.id, "")).map((r) => r.id);
}

function normalizeList(p: ProviderId, raw: { id: string; label: string; efforts?: string[] }[]): Model[] {
  const parse = p === "anthropic" ? parseAnthropic : parseOpenai;
  return raw.map((r) => parse(r.id, r.label, r.efforts)).filter(Boolean) as Model[];
}
const cmpVersion = (a: Model, b: Model) => {
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
  const ps: ProviderId[] = p ? [p] : ["anthropic", "openai"];
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
 * name → model. Resolution order, most specific first:
 *   exact wire id · explicit family+version (opus48) · variant (sol) · family (opus → newest)
 * Returns null for an unknown name, so callers can pass a raw id straight through.
 */
export function resolve(name: string): Model | null {
  const all = models();
  const n = norm(name);
  const exact = all.find((m) => norm(m.id) === n || m.id === name);
  if (exact) return exact;
  // family + version, with or without a variant: opus48, gpt56sol, gpt54mini
  for (const m of all) {
    const v = m.version.join("");
    if (n === norm(m.family + v + (m.variant ?? ""))) return m;
    if (m.variant && n === norm(m.family + v)) return m; // gpt56 → first 5.6 (sol)
  }
  // variant alone: sol / luna / terra / mini
  const byVariant = all.find((m) => m.variant && norm(m.variant) === n);
  if (byVariant) return byVariant;
  // family alone → newest member (the rule the vision asks for)
  const fam = all.filter((m) => norm(m.family) === n);
  if (fam.length) return fam[0];
  if (n === "codex") return all.find((m) => m.provider === "openai") ?? null;
  return null;
}

/** Every alias we can offer for a model — used by `apiplan models` and completions. */
export function aliasesFor(m: Model): string[] {
  const all = models();
  const v = m.version.join("");
  const out = new Set<string>();
  if (all.filter((x) => x.family === m.family && x.provider === m.provider)[0]?.id === m.id) out.add(m.family);
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
