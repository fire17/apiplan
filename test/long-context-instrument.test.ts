/**
 * THE INSTRUMENT'S OWN TEST — can the long-context billing lane's money-signal detector be
 * trusted to say "no vendor cost field here"?
 *
 * WHY THIS FILE EXISTS. The long-context lane answers one question no earlier lane could:
 * the `longContext` rate card is proven to survive OM's parse and to be selected by
 * pi-catalog's arithmetic, but was never observed BILLED by a vendor. Its verdict per vendor
 * is therefore one of "billed-at-tier", "not observable", or "rejected" — and two of those
 * three are NEGATIVE claims about the absence of a vendor cost field. A negative claim is
 * only as good as the detector's ability to have found the thing, so the detector is the
 * load-bearing part, and this repo's oracle names the discipline (I-13): distrust the
 * instrument before the system.
 *
 * THE SPECIFIC FAILURE BEING PINNED. `moneyKeys` walks the parsed JSON of every SSE frame
 * and reports scalar keys whose NAME looks like money. The tempting implementation — a
 * regex over the raw SSE text — is catastrophically wrong here and would pass a careless
 * review, because the probe's own fixture ships sixteen tool descriptions of English prose
 * and a policy paragraph, and any of those may contain the words "cost", "price", "billing"
 * or "charge". A text regex then reports a vendor money signal that does not exist, which
 * would flip a truthful "NOT OBSERVABLE" into a fabricated "billed at tier" — a receipt
 * inventing a vendor fact, which is the worst outcome this whole repo guards against.
 *
 * So both directions are asserted, because either alone is worthless:
 *   · a REAL cost key, nested where vendors actually put it, MUST be found — otherwise the
 *     lane's negative results are manufactured absences and prove nothing about any vendor;
 *   · money WORDS inside string VALUES must NOT be found — otherwise its positive results
 *     are its own fixture's prose read back to it.
 *
 * Costs nothing and dials nobody: pure functions over frames built here.
 */
import { expect, test, describe } from "bun:test";
import {
  TICKS_PER_USD, frontBuckets, grokBuckets, moneyKeys, omPricing, price,
} from "../.deify/cache-proof/scripts/long-context-lib.ts";
import { probeBody } from "./helpers/cache-probe-fixture.ts";
import { harnessRoster } from "../src/roster.ts";

const cost = (id: string) => {
  const card = harnessRoster().find((e) => e.id === id)?.cost;
  if (!card) throw new Error(`no roster card for ${id}`);
  return card;
};

describe("money-signal detector", () => {
  /**
   * xAI's real shape: `cost_in_usd_ticks` sits on `response.usage`, two levels down inside a
   * `response.completed` frame. A detector that only inspected a top-level usage object, or
   * only the frame root, would miss it — and would then report "this vendor publishes no
   * cost field" about the ONE vendor on this rig that does.
   */
  test("finds a real vendor cost key nested inside response.completed", () => {
    const frames = [
      { type: "response.created", response: { id: "r", model: "grok-4.6" } },
      { type: "response.completed", response: { usage: { input_tokens: 205_000, cost_in_usd_ticks: 8_200_000_000 } } },
    ];
    expect(moneyKeys(frames)).toEqual({ "response.usage.cost_in_usd_ticks": 8_200_000_000 });
  });

  /** Anthropic's `service_tier` is a TIER signal rather than a price, and is equally wanted. */
  test("finds a tier signal, not only a price", () => {
    const found = moneyKeys([{ type: "message_start", message: { usage: { input_tokens: 42, service_tier: "standard" } } }]);
    expect(found).toEqual({ "message.usage.service_tier": "standard" });
  });

  /**
   * THE FALSE-POSITIVE GUARD, with the adversarial input the lane actually sends: the
   * fixture's OWN sixteen tool descriptions, unmodified, carrying money words planted into
   * the description STRING. A raw-text regex reports a signal here; a key walk must not.
   */
  test("money words inside a tool DESCRIPTION string are not a vendor cost signal", () => {
    const tools = probeBody({ key: "instrument-test", cycles: 1 }).tools;
    tools[0] = {
      ...tools[0],
      description: "Reports the cost and price of an operation, including any billing charge in usd, per service tier.",
    };
    // The frame carries the tools verbatim, exactly as an echoing upstream might.
    const found = moneyKeys([{ type: "request.echo", tools }]);
    expect(found).toEqual({});
  });

  /** The same guard on assistant TEXT, which is the other place vendor prose arrives. */
  test("money words in streamed text are not a vendor cost signal", () => {
    const frames = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "the cost of this tier is priced in usd and billed per charge" } },
      { type: "message_delta", usage: { input_tokens: 7520, output_tokens: 5, cache_read_input_tokens: 0 } },
    ];
    expect(moneyKeys(frames)).toEqual({});
  });

  /**
   * A CONTAINER whose name matches must not be reported as though it were a value: an empty
   * `{}` at a path reads in a receipt as "the vendor sent a cost field", and a reader cannot
   * tell that from a real one. Its scalar CHILDREN are the finding, and they are still found.
   */
  test("reports scalar leaves, not the matching container itself", () => {
    const found = moneyKeys([{ type: "response.completed", response: { cost_details: { input_usd: 0.5, output_usd: 1.25 } } }]);
    expect(found).toEqual({ "response.cost_details.input_usd": 0.5, "response.cost_details.output_usd": 1.25 });
  });

  /** A stream with no money field anywhere is the Astra case, and must read as exactly empty. */
  test("a complete Anthropic-front stream with no cost field yields no signal", () => {
    const frames = [
      { type: "message_start", message: { usage: { input_tokens: 1693, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "message_delta", usage: { input_tokens: 298_000, output_tokens: 8, cache_read_input_tokens: 6144, cache_creation_input_tokens: 0 } },
      { type: "message_stop" },
    ];
    expect(moneyKeys(frames)).toEqual({});
  });
});

describe("tier arithmetic", () => {
  /**
   * The two vendors' boundaries have DIFFERENT semantics and the difference is real money at
   * exactly one token: xAI's tier REACHES 200,000 (`inputThresholdInclusive`), OpenAI's must
   * EXCEED 272,000. A dropped flag under-charges xAI's boundary request; an invented one
   * over-charges Astra's. Asserted at the edges, where a mistake is invisible anywhere else.
   */
  test("xAI's boundary is inclusive: the tier fires AT 200,000, not at 199,999", () => {
    const at = omPricing(cost("grok-4.6"), { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    const below = omPricing(cost("grok-4.6"), { input: 199_999, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(at?.tierSelectedByArithmetic).toBe(true);
    expect(below?.tierSelectedByArithmetic).toBe(false);
  });

  test("OpenAI's boundary is exclusive: 272,000 is still the base card, 272,001 is not", () => {
    const at = omPricing(cost("gpt-6-astra"), { input: 272_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    const above = omPricing(cost("gpt-6-astra"), { input: 272_001, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(at?.tierSelectedByArithmetic).toBe(false);
    expect(above?.tierSelectedByArithmetic).toBe(true);
  });

  /**
   * The selector sums input + cacheRead + cacheWrite, which is pi-catalog's actual rule and
   * a trap worth pinning: a prompt that is almost entirely CACHE READS still crosses the
   * boundary, so a cheap cached turn silently doubles its own rate card. Anyone asserting an
   * expected cost must keep the whole PROMPT under the threshold, not just `input`.
   */
  test("cacheRead counts toward the threshold, so a mostly-cached prompt still tiers", () => {
    const p = omPricing(cost("gpt-6-astra"), { input: 2, output: 8, cacheRead: 271_999, cacheWrite: 0 });
    expect(p?.promptInputTokens).toBe(272_001);
    expect(p?.tierSelectedByArithmetic).toBe(true);
  });

  /** A model with no documented tier must yield no pricing rather than a fabricated one. */
  test("an untiered card returns null instead of inventing a tier", () => {
    expect(omPricing(cost("claude-opus-5"), { input: 900_000, output: 8, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});

describe("usage → priced buckets", () => {
  /**
   * THE TICK CALIBRATION, which is what makes a grok verdict possible at all: one tick is
   * 1e-10 USD, and xAI's own `cost_in_usd_ticks` reproduces to the EXACT integer from its
   * token counters under the base rate card with an INCLUSIVE input basis. Re-derived here
   * from the counters recorded live on 2026-09-06 (.deify/grok/receipt.json), so a change to
   * `grokBuckets`, `price` or the roster's grok row breaks loudly instead of quietly
   * shifting a money claim.
   */
  test("xAI's own cost_in_usd_ticks reproduces exactly from the base card", () => {
    const live = [
      { input_tokens: 6197, output_tokens: 117, input_tokens_details: { cached_tokens: 0 }, cost_in_usd_ticks: 130_960_000 },
      { input_tokens: 6197, output_tokens: 121, input_tokens_details: { cached_tokens: 128 }, cost_in_usd_ticks: 129_280_000 },
      { input_tokens: 6197, output_tokens: 120, input_tokens_details: { cached_tokens: 6144 }, cost_in_usd_ticks: 38_980_000 },
    ];
    for (const u of live) {
      expect(Math.round(price(cost("grok-4.6"), grokBuckets(u)).total * TICKS_PER_USD)).toBe(u.cost_in_usd_ticks);
    }
  });

  /**
   * …and the TIER card must NOT also reproduce them. Without this the instrument cannot tell
   * "billed at base" from "billed at tier" and every grok verdict would be unfalsifiable —
   * a test that cannot fail is not evidence.
   */
  test("the tier card gives a different integer on those same calls, so the hypotheses are separable", () => {
    const u = { input_tokens: 6197, output_tokens: 120, input_tokens_details: { cached_tokens: 6144 }, cost_in_usd_ticks: 38_980_000 };
    const tier = cost("grok-4.6").longContext;
    expect(tier).toBeDefined();
    expect(Math.round(price(tier!, grokBuckets(u)).total * TICKS_PER_USD)).not.toBe(u.cost_in_usd_ticks);
  });

  /**
   * xAI is INCLUSIVE — `cached_tokens` is a share OF `input_tokens`, refuted-not-assumed by
   * call 3 above (input held at 6,197 while 6,144 read from cache; an exclusive reading
   * predicts 53). So the uncached share is the difference.
   */
  test("grok buckets subtract the cached share out of the inclusive input total", () => {
    expect(grokBuckets({ input_tokens: 6197, input_tokens_details: { cached_tokens: 6144 } }))
      .toMatchObject({ input: 53, cacheRead: 6144 });
  });

  /**
   * The guard on the one arithmetic that fails in the dangerous direction: a vendor reporting
   * cached > input would, unclamped, produce a NEGATIVE input bucket, which prices as a
   * discount — a billing error that makes money appear rather than merely being wrong.
   */
  test("cached greater than input clamps to zero rather than pricing a negative", () => {
    const b = grokBuckets({ input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 500 } });
    expect(b.input).toBe(0);
    expect(price(cost("grok-4.6"), b).input).toBe(0);
  });

  /** The Anthropic front already publishes a disjoint partition, so a second subtraction here
   *  would double-count the cached prefix. Taken as-is, deliberately. */
  test("front buckets take input as-is because that dialect already excludes cache", () => {
    expect(frontBuckets({ input_tokens: 1327, output_tokens: 5, cache_read_input_tokens: 6680 }))
      .toEqual({ input: 1327, output: 5, cacheRead: 6680, cacheWrite: 0 });
  });
});
