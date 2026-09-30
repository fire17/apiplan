/**
 * THE INSTRUMENT for the long-context billing lane — stream parsing, money-signal detection
 * and the two prices, in ONE place so both vendor probes, the free pre-validation and the
 * suite's own test use the same code.
 *
 * WHY THIS IS A MODULE AND NOT THREE COPIES. The lane's whole claim rests on a comparison
 * between what a vendor reports and what OM would charge. Two probes with two hand-rolled
 * copies of that arithmetic can disagree, and then the receipt records a discrepancy that
 * exists only between its own recorders — the exact "distrust the instrument before the
 * system" failure this repo's oracle names (I-13). One implementation, exercised against
 * PLANTED counters at known values before a single paid call goes out, is the only version
 * of this that is worth anything.
 *
 * ── WHY THE TOKENIZER IS NOT IN HERE (and lives in long-context-sizing.ts) ──
 * This repo vendors NOTHING: there is no `node_modules`, `package.json` declares no
 * dependencies, and every one of the 150+ suite files imports only `bun:test`, `node:*` and
 * relative paths. Request SIZING needs a real BPE encoder (`gpt-tokenizer`), which is a
 * third-party package — so a top-level import of it HERE made this module unloadable under
 * `bun test` on a clean checkout, and `test/long-context-instrument.test.ts` died with
 * "Cannot find module" before its first assertion. That is not a lint preference: it would
 * have failed the integration run for a dependency the assertions never touch.
 *
 * So the split is by REQUIREMENT, not by taste. This file stays dependency-free and is
 * therefore importable from the suite; sizing — which only a paid probe ever needs, and
 * which those probes run with the package present — lives next door in
 * `long-context-sizing.ts`. Nothing that runs under `bun test` may import that file.
 *
 * Everything here is pure or reads only its arguments: no socket, no credential, no clock.
 */
import type { LongContextCost, ModelCost } from "../../../src/roster.ts";

/**
 * The sizing types are re-exported as TYPES ONLY, which erase at runtime — so a consumer can
 * still name `PlannedTokens` from here without this module gaining a dependency. The
 * `plannedTokens` FUNCTION is deliberately not re-exported: doing so would pull
 * `gpt-tokenizer` back into every importer, which is the exact breakage this split fixes.
 * Paid probes import it directly from `./long-context-sizing.ts`.
 */
export type { PlannedTokens } from "./long-context-sizing.ts";

/**
 * Every cost/tier-shaped key ANYWHERE in a set of parsed frames, by path.
 *
 * Walked over the parsed objects, never regexed over the raw text. A regex across 3 MB of
 * prose matches the word "cost" inside a tool description and reports a vendor money signal
 * that does not exist — an instrument manufacturing its own finding. Walking keys means a
 * hit is a real KEY at a real path. Scalars only: a container whose NAME matches would
 * otherwise be reported as though it were a value.
 */
const MONEY_KEY = /cost|tier|ticks|price|billing|usd|charge/i;
export function moneyKeys(frames: readonly unknown[]): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (MONEY_KEY.test(k) && (typeof val !== "object" || val === null)) found[p] = val;
      walk(val, p, depth + 1);
    }
  };
  for (const f of frames) walk(f, "", 0);
  return found;
}

/** The Anthropic front's usage spelling — a DISJOINT partition, `input_tokens` EXCLUDING cache. */
export type FrontUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** What one SSE stream carried. `frames` is kept so the money walk sees everything. */
export type ParsedStream = {
  /** message_start's usage — a MARKED estimate on this front. Recorded, never a verdict. */
  startUsage: FrontUsage | null;
  /** message_delta's usage — the corrected counters. THIS is the instrument. */
  deltaUsage: FrontUsage | null;
  eventTypes: string[];
  text: string;
  moneySignals: Record<string, unknown>;
  frameCount: number;
};

/** Split an SSE body into frames and read the Anthropic front's two usage objects out of it. */
export function parseAnthropicStream(raw: string): ParsedStream {
  const frames: unknown[] = [];
  const eventTypes = new Set<string>();
  let startUsage: FrontUsage | null = null, deltaUsage: FrontUsage | null = null, text = "";
  for (const block of raw.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    let ev: unknown;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
    frames.push(ev);
    if (!ev || typeof ev !== "object") continue;
    const f = ev as { type?: unknown; usage?: FrontUsage; message?: { usage?: FrontUsage }; delta?: { type?: unknown; text?: unknown } };
    if (typeof f.type === "string") eventTypes.add(f.type);
    if (f.type === "message_start") startUsage = f.message?.usage ?? null;
    if (f.type === "message_delta") deltaUsage = f.usage ?? null;
    if (f.type === "content_block_delta" && f.delta?.type === "text_delta" && typeof f.delta.text === "string") text += f.delta.text;
  }
  return { startUsage, deltaUsage, eventTypes: [...eventTypes].sort(), text, moneySignals: moneyKeys(frames), frameCount: frames.length };
}

/** xAI's Responses `usage`, in that vendor's own field names — including the money one. */
export type GrokUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
  num_sources_used?: number;
  num_server_side_tools_used?: number;
  /**
   * THE ONLY DIRECT MONEY SIGNAL ANY VENDOR ON THIS RIG PUBLISHES. Calibrated against the
   * three already-recorded grok calls in .deify/grok/receipt.json: one tick is exactly
   * 1e-10 USD, and the vendor's own arithmetic reproduces to the integer under
   * {input 2, output 6, cacheRead 0.5} with an INCLUSIVE input basis (cached subtracted out
   * of input before pricing). That is a calibration, not an assumption — see the receipt.
   */
  cost_in_usd_ticks?: number;
  context_details?: { input_tokens?: number; output_tokens?: number };
};

export type ParsedResponsesStream = {
  usage: GrokUsage | null;
  eventTypes: string[];
  text: string;
  moneySignals: Record<string, unknown>;
  frameCount: number;
};

/** The Responses wire shape: usage rides on `response.completed`'s `response.usage`. */
export function parseResponsesStream(raw: string): ParsedResponsesStream {
  const frames: unknown[] = [];
  const eventTypes = new Set<string>();
  let usage: GrokUsage | null = null, text = "";
  for (const block of raw.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    let ev: unknown;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
    frames.push(ev);
    if (!ev || typeof ev !== "object") continue;
    const f = ev as { type?: unknown; delta?: unknown; response?: { usage?: GrokUsage } };
    if (typeof f.type === "string") eventTypes.add(f.type);
    if (f.type === "response.output_text.delta" && typeof f.delta === "string") text += f.delta;
    if (f.type === "response.completed") usage = f.response?.usage ?? null;
  }
  return { usage, eventTypes: [...eventTypes].sort(), text, moneySignals: moneyKeys(frames), frameCount: frames.length };
}

/** One tick is 1e-10 USD. CALIBRATED, not assumed — see GrokUsage.cost_in_usd_ticks. */
export const TICKS_PER_USD = 1e10;

export type PriceBreakdown = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
/** A DISJOINT token partition — the shape pi-catalog's calculateUsageCost sums. */
export type Buckets = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function price(rates: ModelCost | LongContextCost, u: Buckets): PriceBreakdown {
  const input = (rates.input / 1e6) * u.input;
  const output = (rates.output / 1e6) * u.output;
  const cacheRead = (rates.cacheRead / 1e6) * u.cacheRead;
  const cacheWrite = (rates.cacheWrite / 1e6) * u.cacheWrite;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

export type OmPricing = {
  usage: Buckets;
  /** `input + cacheRead + cacheWrite` — pi-catalog's own tier selector. */
  promptInputTokens: number;
  threshold: number;
  inputThresholdInclusive: boolean;
  /** Whether pi-catalog's resolveTokenCost would swap the rate card for these counters. */
  tierSelectedByArithmetic: boolean;
  withTier: PriceBreakdown;
  withoutTier: PriceBreakdown;
  /** How much the tier costs, as a multiple. NaN when the base price is zero. */
  ratio: number;
  withTierTicks: number;
  withoutTierTicks: number;
};

/**
 * WHAT OM WOULD CHARGE, with the tier and with it suppressed — pi-catalog's own arithmetic,
 * re-derived from `resolveTokenCost` / `calculateUsageCost`
 * (~/.om/runtime-current/node_modules/@oh-my-pi/pi-catalog/src/models.ts:46-73).
 *
 * This is ARITHMETIC, and every receipt that prints it says so. It becomes evidence about
 * BILLING only where a vendor's own money signal agrees with one of the two numbers.
 */
export function omPricing(cost: ModelCost, u: Buckets): OmPricing | null {
  const lc = cost.longContext;
  if (!lc) return null;
  const promptInputTokens = u.input + u.cacheRead + u.cacheWrite;
  const inclusive = lc.inputThresholdInclusive === true;
  const withTier = price(lc, u), withoutTier = price(cost, u);
  return {
    usage: u,
    promptInputTokens,
    threshold: lc.inputThreshold,
    inputThresholdInclusive: inclusive,
    tierSelectedByArithmetic: promptInputTokens > lc.inputThreshold || (inclusive && promptInputTokens === lc.inputThreshold),
    withTier, withoutTier,
    ratio: withoutTier.total > 0 ? withTier.total / withoutTier.total : Number.NaN,
    withTierTicks: Math.round(withTier.total * TICKS_PER_USD),
    withoutTierTicks: Math.round(withoutTier.total * TICKS_PER_USD),
  };
}

/**
 * xAI's usage object → the DISJOINT partition pi-catalog prices.
 *
 * `cached_tokens` is a breakdown OF `input_tokens` on this vendor (declared
 * `usageBasis: "inclusive"`, and REFUTED-not-merely-disfavoured live: call 3 of
 * .deify/grok/receipt.json held input at 6,197 while 6,144 of it read from cache, where an
 * exclusive reading predicts 53). So the uncached share is the difference, and clamping at
 * zero is deliberate: a vendor that ever reported cached > input would otherwise produce a
 * NEGATIVE input bucket, which prices as a discount and would be the worst possible failure.
 */
export function grokBuckets(u: GrokUsage): Buckets {
  const total = u.input_tokens ?? 0;
  const cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, total - cacheRead),
    output: u.output_tokens ?? 0,
    cacheRead,
    // xAI publishes NO write counter at all — an ABSENCE, not a zero we measured. Priced at
    // zero because the tier's cacheWrite rate is itself zero, so the bucket cannot matter.
    cacheWrite: u.input_tokens_details?.cache_write_tokens ?? 0,
  };
}

/** The Anthropic front already publishes a disjoint partition, so this is a rename with defaults. */
export function frontBuckets(u: FrontUsage): Buckets {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}
