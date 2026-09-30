// The request-bound billing attestation arrives in THREE shapes, and every one of them used
// to reach the upstream prompt. Its `cch` hashes the ORIGINAL request body, so it differs on
// every turn — and it sits at the HEAD of the prefix, where a single changed character costs
// the whole cache. Measured on a live Astra session (2026-09-05/06): 1619 of 1774 turns read
// exactly 10368 cached tokens, frozen, while the input grew past 638k.
//
// Only the recognized header LINE is ever removed. These tests pin both halves of that
// promise: the attestation goes, and everything else — including a user instruction that
// merely mentions the header — stays byte-for-byte.
import { expect, test, describe } from "bun:test";
import { fromAnthropic, optsFrom } from "../src/api.ts";

const ATT = (cch: string) => `x-anthropic-billing-header: cc_version=2.1.246; cch=${cch};`;
const STABLE = "STABLE SYSTEM PROMPT";
const ask = [{ role: "user", content: "hi" }];

/** What the upstream prefix is actually keyed on: the joined system string, the block list,
 *  and the derived cache key that rides on the same text. */
const prefixOf = (body: unknown) => {
  const parsed = fromAnthropic(body);
  return { system: parsed.system, blocks: parsed.systemBlocks, key: optsFrom(body, parsed.system).promptCacheKey };
};

describe("the billing attestation never reaches the cached prefix", () => {
  test("system as a BLOCK ARRAY: two turns' attestations rebuild one identical prefix", () => {
    const body = (cch: string) => ({ model: "astra", system: [{ type: "text", text: ATT(cch) }, { type: "text", text: STABLE }], messages: ask });
    const a = prefixOf(body("11111")), b = prefixOf(body("22222"));
    expect(a.system).toBe(STABLE);
    expect(a.blocks).toEqual([{ type: "text", text: STABLE }]);
    expect(b).toEqual(a);
  });

  test("system as a STRING: the attestation line goes, the rest survives verbatim", () => {
    const body = (cch: string) => ({ model: "astra", system: `${ATT(cch)}\n${STABLE}`, messages: ask });
    const a = prefixOf(body("11111")), b = prefixOf(body("22222"));
    expect(a.system).toBe(STABLE);
    expect(b.system).toBe(a.system);
    expect(b.key).toBe(a.key);
  });

  test("a LEADING role:system message: hoisted preamble is cleaned, not dropped", () => {
    const body = (cch: string) => ({
      model: "astra",
      system: [{ type: "text", text: STABLE }],
      messages: [{ role: "system", content: `${ATT(cch)}\nLIVE PREAMBLE` }, ...ask],
    });
    const a = prefixOf(body("11111")), b = prefixOf(body("22222"));
    expect(a.system).toBe(`${STABLE}\n\nLIVE PREAMBLE`);
    expect(b.system).toBe(a.system);
    expect(b.key).toBe(a.key);
  });

  test("a MID-CONVERSATION role:system reminder stays in position and is cleaned there", () => {
    const parsed = fromAnthropic({
      model: "astra",
      system: [{ type: "text", text: STABLE }],
      messages: [{ role: "user", content: "one" }, { role: "system", content: `${ATT("33333")}\n<system-reminder>state</system-reminder>` }, { role: "user", content: "two" }],
    });
    // It must NOT be hoisted: hoisting rewrites the head of the prefix on every turn.
    expect(parsed.system).toBe(STABLE);
    const reminder = parsed.turns.find((t) => t.isSystem);
    expect(reminder?.text).toBe("<system-reminder>state</system-reminder>");
  });

  test("only the recognized header is removed — user text that mentions it is untouched", () => {
    const mentions = `explain the x-anthropic-billing-header: field to me`;   // not a leading match
    const leadingMention = `x-anthropic-billing-header: is what I want to discuss`;
    const stringParsed = fromAnthropic({ model: "astra", system: `${mentions}\n${STABLE}`, messages: ask });
    expect(stringParsed.system).toBe(`${mentions}\n${STABLE}`);
    // A block whose text merely CONTAINS the marker mid-line is preserved whole.
    const blockParsed = fromAnthropic({ model: "astra", system: [{ type: "text", text: mentions }, { type: "text", text: STABLE }], messages: ask });
    expect(blockParsed.blocks ?? blockParsed.systemBlocks).toEqual([{ type: "text", text: mentions }, { type: "text", text: STABLE }]);
    // A line that genuinely STARTS with the header is the attestation, by contract.
    const stripped = fromAnthropic({ model: "astra", system: `${leadingMention}\n${STABLE}`, messages: ask });
    expect(stripped.system).toBe(STABLE);
  });

  test("cache_control and other native block fields survive the filter", () => {
    const cached = { type: "text", text: STABLE, cache_control: { type: "ephemeral" } };
    const parsed = fromAnthropic({ model: "astra", system: [{ type: "text", text: ATT("44444") }, cached], messages: ask });
    expect(parsed.systemBlocks).toEqual([cached]);
  });

  test("an attestation-only system leaves no empty prefix behind", () => {
    const parsed = fromAnthropic({ model: "astra", system: [{ type: "text", text: ATT("55555") }], messages: ask });
    expect(parsed.system).toBeUndefined();
    expect(parsed.systemBlocks).toBeUndefined();
  });
});
