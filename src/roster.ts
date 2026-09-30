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
// The capability, from the one place that decides it — never a second copy of the rule.
import { honoursMidConversationInstruction } from "./providers.ts";

/** What the local API calls its credential-free llama (api.ts JIMMY_MODEL). */
export const JIMMY_ID = "llama3.1-8B";

/**
 * The default order, as fire17 set it (2026-09-05): Astra, Fable 5.1, Sol, Fable 5,
 * Opus 5, Opus 4.8, Opus 4.6, Terra, Luna, Jimmy, Gemini (all variants), Sonnet 5,
 * [2026-09-30: Opus 5.5 leads the Opus block, Sonnet 5.5 the Sonnet block]
 * Haiku (latest), then everything else in a logical order. A `*` entry expands to every
 * registry model of that prefix, newest first; a missing id is simply skipped.
 * 2026-09-29: GPT-6 Sol/Luna take the head of their family's slot; the 5.6 ids follow them.
 */
export const HARNESS_ORDER = [
  "gpt-6-astra", "claude-fable-5-1", "gpt-6-sol", "gpt-5.6-sol", "claude-fable-5", "claude-opus-5-5",
  "claude-opus-5", "claude-opus-4-8", "claude-opus-4-6", "gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-luna", JIMMY_ID,
  "gemini-*", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-*",
];
/** Labelled so nobody — human or agent — picks them for real work. */
export const DUMB_LABEL = "(dumb - do not use)";
const isDumb = (m: Model) => m.provider === "anthropic" && (m.family === "sonnet" || m.family === "haiku");

/**
 * Rates that replace the base card for the WHOLE request once the prompt crosses
 * `inputThreshold` input tokens. Shape and semantics are the harness's own
 * (`pi-catalog` `LongContextTokenCost`): the threshold is STRICT by default —
 * `promptInput > inputThreshold` — and the prompt total counts uncached input + cache reads
 * + cache writes + orchestration, not uncached input alone.
 *
 * `inputThresholdInclusive` exists because not every vendor draws the line the same way,
 * and the harness already models the difference. Its own doc (pi-catalog
 * `types.d.ts`): "Rates applied to the full request when its prompt exceeds
 * `inputThreshold`, or REACHES it when `inputThresholdInclusive` is true."
 *   · OpenAI's pages say ">272K", so their rows leave it ABSENT and the strict default
 *     holds. Setting or defaulting it to true anywhere would move Astra's boundary by one
 *     token in the wrong direction — the same off-by-one, mirrored.
 *   · xAI's pages say "requests whose prompt REACHES 200k tokens are billed at the higher
 *     rate for all tokens", i.e. `>=`, so the grok rows set it and carry the TRUE 200,000.
 * Emulating `>=` by encoding 199,999 against the strict comparator was considered and
 * REJECTED: it prices the boundary turn correctly but makes the field itself false, so
 * anyone reading `inputThreshold` learns a number xAI never published, and a later refactor
 * to a `>=` comparator would shift the boundary silently with no test to catch it. The
 * field name is the HARNESS's, so if pi-catalog ever renames it the emitted key stops
 * matching and the tier reverts to strict — which is why roster.test.ts asserts the key by
 * name rather than only asserting a number.
 */
export type LongContextCost = ModelCostRates & { inputThreshold: number; inputThresholdInclusive?: true };
type ModelCostRates = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type ModelCost = ModelCostRates & { longContext?: LongContextCost };
/**
 * The reasoning levels OM's models.yml schema accepts — pi-coding-agent
 * src/config/models-config-schema-bundle.ts:88 `EffortSchema`. A vendor level outside this
 * set (zen advertises "none", a real Responses-API effort apiplan itself still sends —
 * providers-zen.ts:447, bin/apiplan.ts:70) makes OM reject the WHOLE apiplan provider row
 * (arktype fails the file, `parsed.providers` comes back []), so every ladder is narrowed to
 * this set at the harness boundary; the catalog keeps the vendor's full list for apiplan's
 * own wire.
 */
export const OM_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * A model's effort ladder as a harness may see it: the catalog's list (anthropic's documented
 * ladder when the registry states none), narrowed to OM_EFFORTS in catalog order. An id whose
 * only advertised level is outside the set gets [] — i.e. no thinking block, reasoning:false.
 */
export function harnessEfforts(m: Pick<Model, "provider" | "efforts">): string[] {
  const raw = m.provider === "anthropic" ? (m.efforts ?? ANTHROPIC_EFFORTS) : (m.efforts ?? []);
  return raw.filter((e) => (OM_EFFORTS as readonly string[]).includes(e));
}

export type RosterEntry = {
  id: string; name: string; reasoning: boolean; input: string[];
  efforts?: string[]; defaultLevel?: string; contextWindow: number; maxTokens: number;
  /** USD per 1M tokens, the provider's published list price (a subscription bills none of it). */
  cost?: ModelCost;
  /**
   * Capabilities a harness cannot DERIVE from this route, because the route is local.
   *
   * A harness derives its mid-conversation opt-in from the base URL being the first-party
   * Anthropic API. apiplan serves from `127.0.0.1`, so that derivation is false for EVERY model
   * here — and a harness that believes it DEMOTES the operator instruction to `role:"user"`
   * before the request is even sent. apiplan's intake only tags a non-leading `system`/`developer`
   * message, so a pre-demoted turn is indistinguishable from an ordinary user turn: the
   * instruction is lost UPSTREAM of every backend mapping, and no gateway code can recover it.
   *
   * So this key states what THE GATEWAY accepts and forwards — not what api.anthropic.com
   * accepts. It is therefore true for every backend that carries the turn as a distinct role
   * (`system` on qualifying Anthropic models, `developer` on the Responses API), and false where
   * the turn is flattened to `user` (Gemini, ollama, non-qualifying Anthropic ids). Only `true`
   * is ever emitted: a `false` is indistinguishable from the derived default and would be noise
   * in a generated file.
   */
  compat?: { supportsMidConversationSystem?: true };
};

/**
 * What the providers PUBLISH for these models (read 2026-09-05 from developers.openai.com
 * /api/docs/models/<id> and platform.claude.com/docs/en/about-claude/pricing). The Codex
 * catalog's `context_window` (272000) is its operating default, not the model's window:
 * gpt-6-astra took a 916,284-token prompt on the subscription endpoint and refused ~962k
 * with `context_length_exceeded` — exactly the documented 922k input cap inside 1.05M.
 *
 * LONG CONTEXT. OpenAI bills a prompt over 272K input tokens at a premium for the FULL request.
 * This used to be written off as inexpressible and only the short-context rate was emitted — the
 * estimate was therefore silently LOW, by roughly 2x, on exactly the long sessions where the
 * number matters most. It is expressible: the harness schema carries `cost.longContext`
 * (`LongContextTokenCost`, pi-catalog), and `calculateUsageCost` swaps the whole rate card once
 * the prompt crosses the threshold. Measured against the real function (2026-09-06) on the
 * observed live turn — input 589,146 / cacheRead 10,368 / output 238 — the estimate moves from
 * $5.95 to $11.88. So the tiers are emitted, per model, from that model's own page.
 *
 * Two properties of the harness's semantics decide what may be written here:
 *   · the threshold is STRICT (`prompt > inputThreshold`), matching OpenAI's own ">272K" wording;
 *   · the prompt total counts cache reads and cache writes, not uncached input alone — which is
 *     what OpenAI means by "input tokens" for the tier, since a cached prefix is still prompt.
 *
 * Written ONLY for models whose own page states the tier, with the rates taken from the pricing
 * page's explicit long-context columns (developers.openai.com/api/docs/pricing) rather than
 * derived from a multiplier — a derivation would be a guess wherever a page is silent:
 *   · gpt-6-astra — "2x input AND CACHE rates and 1.5x output"; 20 / 2 / 25 / 75.
 *   · gpt-5.6-sol, -terra, -luna — ">272K … 2x input and 1.5x output". Their pages do not spell
 *     out the cache columns, so the rates come from the pricing table, which does.
 *   · gpt-5.5 — ">272K … for the full session"; the table gives input/cached/output but NO cache
 *     write column (`-`), so its base cache-write scalar is carried into the tier unchanged
 *     rather than invented.
 * NOT written for gpt-5.4-mini: its page states no tier, and its maximum input is 272,000 — it
 * cannot reach a threshold it can never exceed. Anthropic publishes no equivalent tier, so no
 * Claude entry carries one.
 */
type Documented = { contextWindow: number; maxTokens: number; cost: ModelCost };
/** A tier row: the published long-context rates, at OpenAI's one documented boundary. */
const OAI_LONG_CONTEXT_THRESHOLD = 272_000;
const tier = (input: number, output: number, cacheRead: number, cacheWrite: number): LongContextCost =>
  ({ inputThreshold: OAI_LONG_CONTEXT_THRESHOLD, input, output, cacheRead, cacheWrite });
const oai = (ctx: number, input: number, output: number, longContext?: LongContextCost): Documented =>
  ({ contextWindow: ctx, maxTokens: 128_000,
     cost: { input, output, cacheRead: input / 10, cacheWrite: input * 1.25, ...(longContext ? { longContext } : {}) } });
const claude = (ctx: number, input: number, output: number, cacheRead = input / 10, maxTokens = 128_000): Documented =>
  ({ contextWindow: ctx, maxTokens, cost: { input, output, cacheRead, cacheWrite: input * 1.25 } });
/**
 * xAI's ONE documented boundary, and it is INCLUSIVE: every grok model page states
 * "Requests whose prompt reaches 200k tokens are billed at the higher rate for all tokens
 * in the request." REACHES, not exceeds — hence `inputThresholdInclusive` on every tier
 * below, and the true 200,000 rather than a 199,999 workaround (see LongContextCost).
 */
const XAI_LONG_CONTEXT_THRESHOLD = 200_000;
/** A grok tier row. No cacheWrite argument: xAI has no cache-write price to state, and
 *  every row is 0 at both tiers — see the comment on the grok block in DOCUMENTED. */
const xaiTier = (input: number, output: number, cacheRead: number): LongContextCost =>
  ({ inputThreshold: XAI_LONG_CONTEXT_THRESHOLD, inputThresholdInclusive: true, input, output, cacheRead, cacheWrite: 0 });
/**
 * A grok row. Unlike `oai`, cacheRead is REQUIRED rather than derived as input/10: xAI's
 * cached rate is not a fixed fraction of input across the family (grok-4.6 is 0.5 of 2 =
 * 1/4, grok-4.5 is 0.3 of 2 = 3/20, grok-4.3 is 0.2 of 1.25 = 4/25), so every page's own
 * printed number is passed in and nothing is inferred. maxTokens matches the context window
 * because that is what the harness catalog states for these ids.
 */
const xai = (ctx: number, input: number, output: number, cacheRead: number, longContext: LongContextCost): Documented =>
  ({ contextWindow: ctx, maxTokens: ctx, cost: { input, output, cacheRead, cacheWrite: 0, longContext } });
/**
 * Google's ONE documented boundary, on the Pro line only, and it is EXCLUSIVE: those pages
 * state "$X, prompts <= 200k tokens" beside "$2X, prompts > 200k" — 200,000 itself is the
 * cheap side. That is exactly the harness's default strict `inputThreshold` semantics, so
 * these rows carry NO `inputThresholdInclusive` (unlike grok's, whose vendor says REACHES).
 * The difference is one token wide and it is the vendor's wording, not a preference.
 */
const GEMINI_LONG_CONTEXT_THRESHOLD = 200_000;
/** A gemini tier row. cacheWrite 0 for the same reason as the base row below. */
const gemTier = (input: number, output: number, cacheRead: number): LongContextCost =>
  ({ inputThreshold: GEMINI_LONG_CONTEXT_THRESHOLD, input, output, cacheRead, cacheWrite: 0 });
/**
 * A gemini row. cacheRead is REQUIRED, not derived: it only looks like a constant 0.1x —
 * 2.5 Flash-Lite reads at 0.01 of 0.10 and 3.1 Flash-Lite at 0.025 of 0.25, and the Live
 * ids publish no cached column at all. Every number is its own page's printed one.
 *
 * cacheWrite is ALWAYS 0, and that is a statement about the vendor rather than a gap:
 * Google charges nothing per written token. Explicit caching is billed by STORAGE instead
 * — dollars per 1M tokens per HOUR — which is a rate over time that a per-token field
 * cannot express. So 0 is the true per-token write price; the storage cost is real, lives
 * in a dimension this schema does not model, and is why the provider's explicit-cache path
 * is opt-in rather than automatic.
 *
 * maxTokens defaults to the catalog's 65,536 output limit for the HTTP chat ids; the Live
 * ids state their own and pass it.
 */
const gem = (ctx: number, input: number, output: number, cacheRead: number,
             longContext?: LongContextCost, maxTokens = 65_536): Documented =>
  ({ contextWindow: ctx, maxTokens,
     cost: { input, output, cacheRead, cacheWrite: 0, ...(longContext ? { longContext } : {}) } });
/**
 * ── OPENCODE ZEN (the `zen` provider) ──────────────────────────────────────────────────
 *
 * A zen row. EVERY number is copied literally out of opencode's own catalog file
 * (`~/.cache/opencode/models.json`, the `opencode` provider block, mtime 2026-09-12 13:35)
 * — nothing is derived, because zen is a RESELLER and its rates are its own, not the
 * upstream vendor's. Two examples from that same file, which is why a derivation would be
 * wrong rather than merely lazy: zen serves `gpt-5.6-sol` at $2/$10 against OpenAI's own
 * $4/$20 (its catalog label even says "50% Off"), and it publishes NO cache-write price for
 * `gpt-5.5` while OpenAI charges 1.25x input for one. Borrowing either number from the rows
 * above would invent a charge on this route.
 *
 * cacheRead is REQUIRED and cacheWrite defaults to 0, and the 0 is an ABSENCE, not a
 * measured zero: of the 26 paid ids, only the five gpt-5.6-* / gpt-6-astra rows print a
 * `cache_write` at all. Where the catalog states none, nothing is billed that this file can
 * state — exactly the `documented-or-absent` rule the cache contract suite already applies
 * to minTokens/ttlMs.
 *
 * WHAT THIS TABLE IS, said precisely: a SNAPSHOT of that file, taken 2026-09-12. It is not
 * an independent reading of opencode.ai's pricing page (nobody read one for this lane), so
 * it corroborates nothing on its own. Its value is over TIME — opencode rewrites that file
 * on launch, and `test/roster.test.ts` R2 compares every row here against the live file, so
 * a price or window that moves under us becomes a RED TEST instead of a silently stale
 * estimate. Drift is a finding: re-read the vendor, never pick a side.
 */
const zenCost = (ctx: number, maxOut: number, input: number, output: number, cacheRead: number,
                 cacheWrite = 0, longContext?: LongContextCost): Documented =>
  ({ contextWindow: ctx, maxTokens: maxOut,
     cost: { input, output, cacheRead, cacheWrite, ...(longContext ? { longContext } : {}) } });
/**
 * A zen tier row. STRICT — no `inputThresholdInclusive` — and that is MEASURED from
 * opencode's own biller rather than assumed from a silent page. opencode.ai/docs/zen states
 * no boundary wording at all, but the client that bills this route compares strictly:
 *
 *   F = K(usage.inputTokens ?? 0)                                  // the INCLUSIVE input total
 *   R = cost.tiers.filter((G) => G.tier.type === "context" && F > G.tier.size)…[0] ?? cost
 *   (~/.opencode/bin/opencode v1.18.30, byte offset 67539101 — the embedded token writer)
 *
 * `F > size`, and F is the full inclusive input (uncached + cache read + cache write), which
 * is EXACTLY the harness's own `prompt > inputThreshold` semantics over the same quantity.
 * So the strict default is parity with the route's own arithmetic, not a coin flip.
 *
 * ONE HONEST GAP, stated rather than smoothed: that is the CLIENT's local estimate. What
 * opencode.ai's invoice does at the boundary token is unpublished, and nobody here has a key
 * to measure it (see docs/ZEN.md). The two `zen-grok-*` rows are where this could bite —
 * xAI's OWN pages say a prompt that REACHES 200k is billed at the higher rate (which is why
 * the `grok-*` rows above set `inputThresholdInclusive`), and the zen route inherits the
 * model, not necessarily the wording. Strict is what this route's own code does; the
 * one-token disagreement with xAI's page is a FINDING for whoever gets a key, not a
 * preference this file settles.
 */
const zenTier = (size: number, input: number, output: number, cacheRead: number, cacheWrite = 0): LongContextCost =>
  ({ inputThreshold: size, input, output, cacheRead, cacheWrite });
export const DOCUMENTED: Record<string, Documented> = {
  // Astra's page is the explicit one: 2x input AND cache, 1.5x output.
  "gpt-6-astra": oai(1_050_000, 10, 50, tier(20, 75, 2, 25)),
  // developers.openai.com/api/docs/models/gpt-6-sol, -luna (read 2026-09-29 by the P2 plan
  // lane): 1,050,000 ctx, 922,000 max input, 128,000 out; sol $2 / $0.20 cached / $2.50 cache
  // write / $10 out, luna $0.10 / $0.01 / $0.125 / $0.50; ">272K … 2x input and cache rates
  // and 1.5x output for the full request". oai() derives cacheRead = input/10 and
  // cacheWrite = input×1.25, which match both pages exactly.
  "gpt-6-sol": oai(1_050_000, 2, 10, tier(4, 15, 0.4, 5)),
  "gpt-6-luna": oai(1_050_000, 0.1, 0.5, tier(0.2, 0.75, 0.02, 0.25)),
  "gpt-5.6-sol": oai(1_050_000, 4, 20, tier(8, 30, 0.8, 10)),
  "gpt-5.6-luna": oai(1_050_000, 0.2, 1.2, tier(0.4, 1.8, 0.04, 0.5)),
  "gpt-5.6-terra": oai(1_050_000, 2, 12, tier(4, 18, 0.4, 5)),
  // The pricing table prints no long-context cache-write for 5.5, so its base scalar carries.
  "gpt-5.5": oai(1_050_000, 5, 30, tier(10, 45, 1, 5 * 1.25)),
  // No tier: the page states none, and 272,000 is its maximum input — it cannot exceed it.
  "gpt-5.4-mini": oai(400_000, 0.75, 4.5),
  /**
   * GROK — read from docs.x.ai/developers/models/<id> on 2026-09-06, one page per model, and
   * corroborated by TWO independent sources that agree byte-identically: the pi-catalog
   * bundle (`xai` / `xai-oauth`) and the LIVE authoritative catalog OM bills from
   * (~/.om/flavors/unleashed/models.db, model_cache, provider_id `xai`, authoritative=1).
   * The third is a separate claim worth making: a bundle can disagree with what is actually
   * charged, so "the docs say it" and "the biller says it" were checked apart.
   *
   * Every model's page prints BOTH tiers explicitly — "< 200k prompt tokens" and
   * "≥ 200k prompt tokens" — so nothing here is derived from a multiplier. It happens to be
   * a clean doubling, but a derivation would be a guess the day one page stops doubling.
   *
   * THE TIER IS ROUTE-SCOPED, NOT ID-SCOPED. In that same live catalog the long-context
   * block exists only under provider_id `xai`; every reseller route serving the same model
   * NAMES carries the base rates and NO tier at all (checked: github-copilot,
   * cloudflare-ai-gateway, nanogpt). These rows are correct for the route this provider
   * actually drives — the xAI subscription proxy — and must not be read as a property of the
   * string "grok-4.6" wherever it appears.
   *
   * cacheWrite 0 AT BOTH TIERS, and the REASON matters more than the number, because three
   * different vendor facts produce the same zero and a reader cannot tell them apart from
   * the field alone:
   *   · xAI (here)  — there is no write counter and no write price. The usage object carries
   *     no `cache_write_tokens` field at all (measured live: nine fields arrive and that is
   *     not among them, .deify/grok/receipt.json), and the pricing tables print only Input /
   *     Cached input / Output. Nothing to count, nothing to bill.
   *   · Google       — a real vendor statement of zero PER TOKEN, because explicit caching is
   *     billed by STORAGE ($/1M tokens/hour) in a dimension this schema cannot express (see
   *     the gemini rows above).
   *   · OpenAI       — genuinely nonzero (1.25x input), which is why the `oai` builder derives
   *     it and this one does not.
   * So a 1.25x scalar borrowed from the OpenAI rows would be a fabricated charge here, and
   * `cacheWrite: 0` is asserted rather than defaulted.
   */
  "grok-4.6": xai(500_000, 2, 6, 0.5, xaiTier(4, 12, 1)),
  "grok-4.5": xai(500_000, 2, 6, 0.3, xaiTier(4, 12, 0.6)),
  "grok-4.3": xai(1_000_000, 1.25, 2.5, 0.2, xaiTier(2.5, 5, 0.4)),
  "grok-build-0.1": xai(256_000, 1, 2, 0.2, xaiTier(2, 4, 0.4)),
  "claude-fable-5-1": claude(1_000_000, 10, 50, 0.25),
  "claude-fable-5": claude(1_000_000, 10, 50),
  // Opus 5.5 / Sonnet 5.5 read 2026-09-30 from the same pricing page: Opus 5.5 is $4/$20
  // with cache hits at 0.05x ($0.20); Sonnet 5.5 is $2/$10, standard 0.1x cache hits.
  "claude-opus-5-5": claude(1_000_000, 4, 20, 0.2),
  "claude-opus-5": claude(1_000_000, 5, 25),
  "claude-opus-4-8": claude(1_000_000, 5, 25),
  "claude-opus-4-7": claude(1_000_000, 5, 25),
  "claude-opus-4-6": claude(1_000_000, 5, 25),
  "claude-opus-4-5-20251101": claude(200_000, 5, 25),
  "claude-sonnet-5-5": claude(1_000_000, 2, 10),
  "claude-sonnet-5": claude(1_000_000, 2, 10),
  "claude-sonnet-4-6": claude(1_000_000, 3, 15),
  "claude-sonnet-4-5-20250929": claude(200_000, 3, 15),
  "claude-haiku-4-5-20251001": claude(200_000, 1, 5, 0.1, 64_000),

  // ── gemini (the API-KEY route) ──────────────────────────────────────────────────────
  // Every rate read from ai.google.dev/gemini-api/docs/pricing on 2026-09-06, STANDARD
  // tier, paid, text/image/video column. Rates that step up on 2027-01-01 (the whole 3.x
  // Flash line doubles) are recorded at their CURRENT value: a rate card states what is
  // billed today, and a future step nobody is paying yet would make every estimate wrong
  // until the date arrives.
  "gemini-key-3.8-flash": gem(1_048_576, 0.75, 3.75, 0.075),
  "gemini-key-3.7-flash": gem(1_048_576, 0.75, 3.75, 0.075),
  "gemini-key-3.6-flash": gem(1_048_576, 0.75, 3.75, 0.075),
  // 3.5 Flash is the one Flash with stable (undated) pricing, and it is the dearest.
  "gemini-key-3.5-flash": gem(1_048_576, 1.50, 9.00, 0.15),
  "gemini-key-3.5-flash-lite": gem(1_048_576, 0.30, 2.50, 0.03),
  "gemini-key-3.1-flash-lite": gem(1_048_576, 0.25, 1.50, 0.025),
  // The Pro line is the only one with a published long-context tier, and its pages state
  // it for input, output AND cached read: "$2.00, prompts <= 200k / $4.00, prompts > 200k".
  "gemini-key-3.1-pro-preview": gem(1_048_576, 2.00, 12.00, 0.20, gemTier(4.00, 18.00, 0.40)),
  "gemini-key-2.5-pro": gem(1_048_576, 1.25, 10.00, 0.125, gemTier(2.50, 15.00, 0.25)),
  "gemini-key-2.5-flash": gem(1_048_576, 0.30, 2.50, 0.03),
  "gemini-key-2.5-flash-lite": gem(1_048_576, 0.10, 0.40, 0.01),
  // LIVE (bidiGenerateContent). Their pages price audio and text SEPARATELY and this
  // schema has one input rate, so the TEXT rate is recorded — the only rate a text-token
  // count can be priced with. An audio-heavy session costs more than these rows imply
  // (3.1 Flash Live audio is $3.00 in / $12.00 out against $0.75 / $4.50 for text), which
  // is stated here rather than smuggled into a blended number nothing published. Windows
  // are the live catalog's own, not the 1M the HTTP ids carry, and no cached-read column is
  // published for any of them — so 0 means "no published discount", not a measured zero.
  "gemini-key-3.1-flash-live-preview": gem(131_072, 0.75, 4.50, 0),
  "gemini-key-2.5-flash-native-audio-preview-12-2025": gem(131_072, 0.50, 2.00, 0, undefined, 8_192),
  "gemini-key-3.5-live-translate-preview": gem(16_384, 3.50, 21.00, 0, undefined, 32_768),
  "gemini-key-3.5-transcribe-live": gem(131_072, 3.50, 21.00, 0, undefined, 32_768),

  // ── zen (OpenCode Zen, the API-KEY route) ───────────────────────────────────────────
  // The 26 PAID ids opencode's catalog serves in the `@ai-sdk/openai` (Responses) dialect —
  // the subset `src/providers-zen.ts` can actually speak. The other 76 ids in that provider
  // block are NOT listed anywhere: 46 openai-compatible chat, 20 anthropic-dialect, 8
  // google-dialect (counted from the file, not the docs), plus the 2 zero-cost
  // `-contributor-free` ids, which the vendor serves only inside opencode itself.
  //
  // Every row: `limit.context` → contextWindow, `limit.output` → maxTokens, `cost.{input,
  // output,cache_read,cache_write}` → the rate card, `cost.tiers[0]` (type "context") → the
  // long-context card at that tier's own `size`. Nothing is derived; see `zenCost` above for
  // why a reseller's numbers must never be borrowed from the upstream vendor's rows.
  "zen-gpt-5": zenCost(400_000, 128_000, 1.07, 8.5, 0.107),
  "zen-gpt-5-codex": zenCost(400_000, 128_000, 1.07, 8.5, 0.107),
  "zen-gpt-5-nano": zenCost(400_000, 128_000, 0.05, 0.4, 0.005),
  "zen-gpt-5.1": zenCost(400_000, 128_000, 1.07, 8.5, 0.107),
  "zen-gpt-5.1-codex": zenCost(400_000, 128_000, 1.07, 8.5, 0.107),
  "zen-gpt-5.1-codex-max": zenCost(400_000, 128_000, 1.25, 10, 0.125),
  "zen-gpt-5.1-codex-mini": zenCost(400_000, 128_000, 0.25, 2, 0.025),
  "zen-gpt-5.2": zenCost(400_000, 128_000, 1.75, 14, 0.175),
  "zen-gpt-5.2-codex": zenCost(400_000, 128_000, 1.75, 14, 0.175),
  "zen-gpt-5.3-codex": zenCost(400_000, 128_000, 1.75, 14, 0.175),
  "zen-gpt-5.3-codex-spark": zenCost(128_000, 128_000, 1.75, 14, 0.175),
  "zen-gpt-5.4": zenCost(1_050_000, 128_000, 2.5, 15, 0.25, 0, zenTier(272_000, 5, 22.5, 0.5)),
  "zen-gpt-5.4-mini": zenCost(400_000, 128_000, 0.75, 4.5, 0.075),
  "zen-gpt-5.4-nano": zenCost(400_000, 128_000, 0.2, 1.25, 0.02),
  "zen-gpt-5.4-pro": zenCost(1_050_000, 128_000, 30, 180, 30),
  "zen-gpt-5.5": zenCost(1_050_000, 128_000, 5, 30, 0.5, 0, zenTier(272_000, 10, 45, 1)),
  "zen-gpt-5.5-pro": zenCost(1_050_000, 128_000, 30, 180, 30),
  "zen-gpt-5.6-luna": zenCost(1_050_000, 128_000, 0.2, 1.2, 0.02, 0.25, zenTier(272_000, 0.4, 1.8, 0.04, 0.5)),
  "zen-gpt-5.6-sol": zenCost(1_050_000, 128_000, 2, 10, 0.2, 2.5, zenTier(272_000, 4, 15, 0.4, 5)),
  "zen-gpt-5.6-terra": zenCost(1_050_000, 128_000, 2.5, 15, 0.25, 3.125, zenTier(272_000, 5, 22.5, 0.5, 6.25)),
  "zen-gpt-6-astra": zenCost(1_050_000, 128_000, 10, 50, 1, 12.5, zenTier(272_000, 20, 75, 2, 25)),
  "zen-grok-4.5": zenCost(500_000, 500_000, 2, 6, 0.3, 0, zenTier(200_000, 4, 12, 0.6)),
  "zen-grok-4.6": zenCost(500_000, 500_000, 2, 6, 0.5, 0, zenTier(200_000, 4, 12, 1)),
  "zen-grok-build-0.1": zenCost(256_000, 256_000, 1, 2, 0.2),
  "zen-muse-spark-1.2": zenCost(1_048_576, 131_072, 1.25, 4.25, 0.15),
  "zen-muse-spark-1.3": zenCost(1_048_576, 131_072, 1.25, 4.25, 0.15),
};

/** Registry model → the fields a harness needs. Context sizes are the providers' own. */
export function entryFor(m: Model): RosterEntry {
  const dumb = isDumb(m);
  const id = dumb ? `${m.id} ${DUMB_LABEL}` : m.id;
  const name = `${m.label}${dumb ? " " + DUMB_LABEL : ""}`;
  const efforts = harnessEfforts(m);
  // THE TWO GOOGLE ROUTES DISAGREE ABOUT REASONING, and the difference is real rather than
  // a copy-paste divergence — `gemini-3.8-flash` (subscription) is false while
  // `gemini-key-3.8-flash` (API key) is true for the SAME underlying vendor model:
  //   · google — the effort rides the WIRE ID (gemini-3.6-flash-low), the Antigravity
  //     adapter has been observed to 400 on an effort it does not serve, and there is no
  //     request field for a harness to set. So omp is told not to send one and apiplan's
  //     own default holds.
  //   · gemini — thinking is a real REQUEST FIELD on the public endpoint, and it was
  //     measured, not assumed (2026-09-06): `thinkingConfig.thinkingLevel: "LOW"` on
  //     gemini-3.8-flash answered 200 with `usageMetadata.thoughtsTokenCount: 29`, and
  //     `thinkingConfig.thinkingBudget: 512` on gemini-2.5-flash answered 200 with
  //     `thoughtsTokenCount: 25`. A harness that sets an effort here changes what the model
  //     does and pays for it (thinking tokens bill as output), so `reasoning: true` is the
  //     capability the picker must show. The LIVE ids carry no efforts and stay false.
  const reasoning = m.provider !== "google" && efforts.length > 0;
  const image = m.provider !== "ollama" && m.provider !== "online";
  const doc = DOCUMENTED[m.id];
  // A provider with no branch here would silently inherit the bare 32,000 / 8,000 local
  // defaults rather than fail, so every non-ollama provider states its own. The documented
  // numbers live in DOCUMENTED (so `doc` wins for every documented id); a branch is the
  // floor for an id the live catalog offers before this file has heard of it, and each is
  // the SMALLEST window that vendor currently documents — the conservative choice, since
  // over-stating a window invites a request the backend refuses. gemini's floor is the
  // live catalog's smallest (16,384, the translate model) rather than the 1M its Flash ids
  // carry, because an unknown new id is as likely to be a live/preview one as a chat one.
  const ctx = doc?.contextWindow ?? (m.provider === "anthropic" ? (m.family === "haiku" ? 200_000 : 1_000_000)
    : m.provider === "openai" ? (m.contextWindow ?? 272_000)
    : m.provider === "google" ? 1_048_576
    : m.provider === "gemini" ? (m.contextWindow ?? 16_384)
    : m.provider === "grok" ? (m.contextWindow ?? 256_000)
    // A local safety cap for the website adapter, not a claim about ChatGPT's vendor limit.
    : m.provider === "online" ? 32_000
    // zen: every LISTED id is in DOCUMENTED, so `doc` wins and this is reached only by an
    // id opencode's catalog started serving before this file heard of it. 128,000 is the
    // SMALLEST context in that provider block today (gpt-5.3-codex-spark) — the
    // conservative floor, since over-stating a window invites a request the gateway refuses.
    : m.provider === "zen" ? (m.contextWindow ?? 128_000) : 32_000);
  const max = doc?.maxTokens ?? (m.provider === "anthropic" ? (m.family === "haiku" ? 64_000 : 128_000)
    : m.provider === "openai" ? 128_000 : m.provider === "google" ? 65_535
    : m.provider === "gemini" ? 65_536
    : m.provider === "grok" ? (m.contextWindow ?? 256_000)
    // Local output guard until the website route has a measured, enforceable limit.
    : m.provider === "online" ? 4_096
    // Same fallback-only role. 128,000 is what every Responses-dialect zen id publishes as
    // `limit.output` except the muse-spark pair (131,072) — so the floor under-states
    // rather than over-promises for an id nobody has read yet.
    : m.provider === "zen" ? 128_000 : 8_000);
  // Asked of the GATEWAY, per backend — never of the Anthropic id alone, which would miss every
  // Responses-API model. Keyed on the RAW registry id, not the display id: a dumb-labelled entry
  // carries a suffix for humans, while the capability belongs to the model the backend serves.
  const midSystem = honoursMidConversationInstruction(m.provider, m.id);
  return { id, name, reasoning, input: image ? ["text", "image"] : ["text"],
    ...(reasoning ? { efforts, defaultLevel: efforts.includes("medium") ? "medium" : efforts[0] } : {}),
    contextWindow: ctx, maxTokens: max, ...(doc ? { cost: doc.cost } : m.provider === "ollama" ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}),
    ...(midSystem ? { compat: { supportsMidConversationSystem: true } } : {}) };
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
  // The rest, in a logical order: by provider as the registry lists them, newest first. A
  // provider missing from THIS list reaches the roster only if HARNESS_ORDER names it
  // explicitly, so a new backend is invisible until it is added here too. `gemini` is in
  // both — HARNESS_ORDER's `gemini-*` glob already catches its route-marked ids, and it is
  // named here so a future id that stops matching that glob still appears.
  // `zen` is LAST on purpose. It republishes other vendors' models under their own names
  // (claude-opus-5, gpt-5.4, gemini-3-pro), so a zen id must never be the first match for
  // a family alias — and HARNESS_ORDER, which is fire17's 2026-09-05 picker order, is left
  // untouched: zen ids land after every subscription model, never among them.
  for (const p of ["anthropic", "openai", "google", "grok", "gemini", "online", "zen"]) pool.filter((m) => m.provider === p).forEach(take);
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
    if (e.cost) {
      // One flow map per model, as before. `longContext` is a NESTED flow map inside it — YAML
      // permits that, and it keeps a rate card on one line so the generated file stays readable
      // and diffs stay one-per-model. Emitted only where a tier is documented.
      const rates = (c: ModelCostRates) =>
        `input: ${c.input}, output: ${c.output}, cacheRead: ${c.cacheRead}, cacheWrite: ${c.cacheWrite}`;
      const lc = e.cost.longContext;
      // `inputThresholdInclusive` is emitted ONLY when the tier sets it, so the OpenAI rows
      // stay byte-identical and keep the harness's strict `>` default. Dropping it for a
      // vendor that needs it would be silent MISPRICING, not a missing nicety: xAI bills
      // the higher rate from exactly 200,000, and without the flag the emitted tier reverts
      // to `> 200,000` and under-charges the whole boundary request. roster.test.ts asserts
      // this key BY NAME for that reason — the field name is pi-catalog's, so if the harness
      // ever renames it the assertion fails loudly here instead of the flag vanishing into a
      // key nothing reads.
      const inclusive = lc?.inputThresholdInclusive ? `, inputThresholdInclusive: true` : "";
      const tail = lc ? `, longContext: { inputThreshold: ${lc.inputThreshold}${inclusive}, ${rates(lc)} }` : "";
      lines.push(`        cost: { ${rates(e.cost)}${tail} }`);
    }
    // The one capability a local route cannot derive. A harness computes the mid-conversation
    // opt-in from the base URL being the first-party Anthropic API; this route is 127.0.0.1, so
    // that derivation is false for EVERY model here. A harness that believes it demotes the
    // operator instruction to `role:"user"` BEFORE sending, and the gateway's intake cannot tell
    // that apart from an ordinary user turn — so the role is lost upstream of every backend
    // mapping and no gateway code can recover it. An explicit key overrides the derivation, so
    // the gateway declares what it will actually forward. Emitted only where true; the rule lives
    // in `honoursMidConversationInstruction` (providers.ts), the single source of this fact.
    if (e.compat?.supportsMidConversationSystem) lines.push(`        compat: { supportsMidConversationSystem: true }`);
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
