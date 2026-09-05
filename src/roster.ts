// roster.ts — the model list a HARNESS should show, generated from the registry.
//
// omp / OM read a static `models.yml`; before this they carried two apiplan providers
// (one per wire dialect) plus canary copies, hand-edited whenever the roster moved. The
// picker shows a provider's models in file order, so the order and the labels people
// and agents see are decided HERE, once, and written into every harness the same way.
//
// One provider: `apiplan`, speaking `anthropic-messages` for EVERY backend. The dialect
// and the backend are independent on the server (round 21), and the Anthropic shape is
// the one that keeps Claude's native cache markers, thinking and tool blocks intact.
import { models, ANTHROPIC_EFFORTS, type Model } from "./registry.ts";

/** What the local API calls its credential-free llama (api.ts JIMMY_MODEL). */
export const JIMMY_ID = "llama3.1-8B";

/**
 * The default order, as fire17 set it (2026-09-05): Astra, Fable 5.1, Sol, Fable 5,
 * Opus 5, Opus 4.8, Opus 4.6, Terra, Luna, Jimmy, Gemini (all variants), Sonnet 5,
 * Haiku (latest), then everything else in a logical order. A `*` entry expands to every
 * registry model of that prefix, newest first; a missing id is simply skipped.
 */
export const HARNESS_ORDER = [
  "gpt-6-astra", "claude-fable-5-1", "gpt-5.6-sol", "claude-fable-5", "claude-opus-5",
  "claude-opus-4-8", "claude-opus-4-6", "gpt-5.6-terra", "gpt-5.6-luna", JIMMY_ID,
  "gemini-*", "claude-sonnet-5", "claude-haiku-*",
];
/** Labelled so nobody — human or agent — picks them for real work. */
export const DUMB_LABEL = "(dumb - do not use)";
const isDumb = (m: Model) => m.provider === "anthropic" && (m.family === "sonnet" || m.family === "haiku");

export type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type RosterEntry = {
  id: string; name: string; reasoning: boolean; input: string[];
  efforts?: string[]; defaultLevel?: string; contextWindow: number; maxTokens: number;
  /** USD per 1M tokens, the provider's published list price (a subscription bills none of it). */
  cost?: ModelCost;
};

/**
 * What the providers PUBLISH for these models (read 2026-09-05 from developers.openai.com
 * /api/docs/models/<id> and platform.claude.com/docs/en/about-claude/pricing). The Codex
 * catalog's `context_window` (272000) is its operating default, not the model's window:
 * gpt-6-astra took a 916,284-token prompt on the subscription endpoint and refused ~962k
 * with `context_length_exceeded` — exactly the documented 922k input cap inside 1.05M.
 * Prices are the standard tier; OpenAI's >272K-input requests bill 2x input and cache rates and
 * 1.5x output for the full request (Astra included — the model page says so verbatim, verified
 * 2026-09-05), which no harness cost schema can express, so the short-context
 * rate is what is written. Anthropic's 5m cache write is 1.25x input; Fable 5.1 reads at 0.025x.
 */
type Documented = { contextWindow: number; maxTokens: number; cost: ModelCost };
const oai = (ctx: number, input: number, output: number): Documented =>
  ({ contextWindow: ctx, maxTokens: 128_000, cost: { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 } });
const claude = (ctx: number, input: number, output: number, cacheRead = input / 10, maxTokens = 128_000): Documented =>
  ({ contextWindow: ctx, maxTokens, cost: { input, output, cacheRead, cacheWrite: input * 1.25 } });
export const DOCUMENTED: Record<string, Documented> = {
  "gpt-6-astra": oai(1_050_000, 10, 50),
  "gpt-5.6-sol": oai(1_050_000, 4, 20),
  "gpt-5.6-luna": oai(1_050_000, 0.2, 1.2),
  "gpt-5.6-terra": oai(1_050_000, 2, 12),
  "gpt-5.5": oai(1_050_000, 5, 30),
  "gpt-5.4-mini": oai(400_000, 0.75, 4.5),
  "claude-fable-5-1": claude(1_000_000, 10, 50, 0.25),
  "claude-fable-5": claude(1_000_000, 10, 50),
  "claude-opus-5": claude(1_000_000, 5, 25),
  "claude-opus-4-8": claude(1_000_000, 5, 25),
  "claude-opus-4-7": claude(1_000_000, 5, 25),
  "claude-opus-4-6": claude(1_000_000, 5, 25),
  "claude-opus-4-5-20251101": claude(200_000, 5, 25),
  "claude-sonnet-5": claude(1_000_000, 2, 10),
  "claude-sonnet-4-6": claude(1_000_000, 3, 15),
  "claude-sonnet-4-5-20250929": claude(200_000, 3, 15),
  "claude-haiku-4-5-20251001": claude(200_000, 1, 5, 0.1, 64_000),
};

/** Registry model → the fields a harness needs. Context sizes are the providers' own. */
function entryFor(m: Model): RosterEntry {
  const dumb = isDumb(m);
  const id = dumb ? `${m.id} ${DUMB_LABEL}` : m.id;
  const name = `${m.label}${dumb ? " " + DUMB_LABEL : ""}`;
  const efforts = m.provider === "anthropic" ? (m.efforts ?? ANTHROPIC_EFFORTS) : (m.efforts ?? []);
  // Google's effort rides its wire id and the local adapter has been observed to 400 on
  // an effort it does not serve; omp is told not to send one, apiplan's own default holds.
  const reasoning = m.provider !== "google" && efforts.length > 0;
  const image = m.provider !== "ollama";
  const doc = DOCUMENTED[m.id];
  const ctx = doc?.contextWindow ?? (m.provider === "anthropic" ? (m.family === "haiku" ? 200_000 : 1_000_000)
    : m.provider === "openai" ? (m.contextWindow ?? 272_000)
    : m.provider === "google" ? 1_048_576 : 32_000);
  const max = doc?.maxTokens ?? (m.provider === "anthropic" ? (m.family === "haiku" ? 64_000 : 128_000)
    : m.provider === "openai" ? 128_000 : m.provider === "google" ? 65_535 : 8_000);
  return { id, name, reasoning, input: image ? ["text", "image"] : ["text"],
    ...(reasoning ? { efforts, defaultLevel: efforts.includes("medium") ? "medium" : efforts[0] } : {}),
    contextWindow: ctx, maxTokens: max, ...(doc ? { cost: doc.cost } : m.provider === "ollama" ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}) };
}

const jimmy = (): Model => ({ id: JIMMY_ID, provider: "ollama", family: "llama", version: [], label: "Jimmy (local llama, no credential)", efforts: [] });

/** Every subscription model the API serves, in HARNESS_ORDER, then the rest newest-first. */
export function harnessRoster(): RosterEntry[] {
  // Ollama's own library is excluded: omp reaches it natively on :11434, and listing it
  // here too would show every local model twice. Jimmy is the one local id apiplan owns.
  const pool: Model[] = [...models().filter((m) => m.provider !== "ollama"), jimmy()];
  const out: Model[] = [];
  const take = (m: Model) => { if (!out.includes(m)) out.push(m); };
  for (const want of HARNESS_ORDER) {
    if (want.endsWith("*")) { const p = want.slice(0, -1); pool.filter((m) => m.id.startsWith(p)).forEach(take); }
    else { const m = pool.find((x) => x.id === want); if (m) take(m); }
  }
  // The rest, in a logical order: by provider as the registry lists them, newest first.
  for (const p of ["anthropic", "openai", "google"]) pool.filter((m) => m.provider === p).forEach(take);
  return out.map(entryFor);
}

const q = (s: string) => JSON.stringify(s);
/** The `apiplan:` provider block for an omp/OM `models.yml`, indented under `providers:`. */
export function rosterYaml(base = "http://127.0.0.1:8787"): string {
  const lines: string[] = [
    `  # Generated by \`apiplan roster omp\` — every subscription model through apiplan serve,`,
    `  # in apiplan's default order. Regenerate after \`apiplan models --refresh\`; do not hand-edit.`,
    `  apiplan:`,
    `    baseUrl: ${base}`,
    `    api: anthropic-messages`,
    `    apiKey: not-needed`,
    `    models:`,
  ];
  for (const e of harnessRoster()) {
    lines.push(`      - id: ${q(e.id)}`, `        name: ${q(e.name)}`, `        reasoning: ${e.reasoning}`, `        input: [${e.input.join(", ")}]`);
    // `anthropic-adaptive`, not `effort`: on the anthropic-messages wire omp turns the
    // `effort` mode into a legacy `thinking.budget_tokens` (its table maps xhigh AND max to
    // 32768, so the two are indistinguishable), while adaptive mode sends the exact level as
    // `output_config.effort` — the field apiplan reads for every backend. Captured live
    // 2026-09-05 on gpt-6-astra through omp.
    if (e.reasoning && e.efforts?.length) lines.push(`        thinking:`, `          mode: anthropic-adaptive`, `          efforts: [${e.efforts.join(", ")}]`, `          defaultLevel: ${e.defaultLevel}`);
    lines.push(`        contextWindow: ${e.contextWindow}`, `        maxTokens: ${e.maxTokens}`);
    if (e.cost) lines.push(`        cost: { input: ${e.cost.input}, output: ${e.cost.output}, cacheRead: ${e.cost.cacheRead}, cacheWrite: ${e.cost.cacheWrite} }`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Put the generated block into an existing models.yml: every provider whose key starts
 * with `apiplan` is replaced (the old split providers, canaries and probes included), any
 * other provider is left exactly as it was, and the new block goes first under `providers:`.
 */
export function applyRoster(text: string, block = rosterYaml()): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const blockLines = block.trimEnd().split("\n");
  let inProviders = false, skipping = false, inserted = false;
  // Comment lines under `providers:` belong to the provider that FOLLOWS them, so they
  // are held back until that key says whether it survives.
  let held: string[] = [];
  const flush = () => { out.push(...held); held = []; };
  for (const ln of lines) {
    if (/^\S/.test(ln)) {
      flush(); skipping = false;
      inProviders = /^providers:\s*(#.*)?$/.test(ln);
      out.push(ln);
      if (inProviders && !inserted) { out.push(...blockLines); inserted = true; }
      continue;
    }
    if (inProviders) {
      const key = ln.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
      if (key) { skipping = key[1].startsWith("apiplan"); if (skipping) held = []; else flush(); }
      else if (/^\s*#/.test(ln) || ln.trim() === "") { if (!skipping) held.push(ln); continue; }
      if (skipping) continue;
    }
    out.push(ln);
  }
  flush();
  while (out.length && out.at(-1)!.trim() === "") out.pop();
  if (!inserted) out.push("providers:", ...blockLines);
  return out.join("\n").replace(/\n+$/, "") + "\n";
}
