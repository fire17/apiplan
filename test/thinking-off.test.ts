// The `thinkOff` wire contract for Anthropic, per model.
//
// `thinking: {type: "disabled"}` is not a universal field: the vendor's per-model
// configuration table lists, for each model, the `thinking.type` values it "rejects with a
// 400 error", and for the Fable/Mythos line that list contains `"disabled"` — those models
// are "Always on" and "cannot turn thinking off". Sending it anyway is a hard 400, observed
// live through this gateway on claude-fable-5-1 (see the receipt under .deify/thinking-off/).
//
// These run with no network and no credentials: they assert the BODY this gateway would
// send, which is the only place the mistake was visible before the 400 came back.
import { expect, test, describe } from "bun:test";
import { anthropic } from "../src/providers.ts";
import type { CallOpts } from "../src/providers.ts";
import { resolve } from "../src/registry.ts";
import type { Model } from "../src/registry.ts";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const CREDS = { token: "T", account: "ACC", source: "test" };
const TURNS = [{ role: "user" as const, text: "hi" }];
/** The three fields these tests read, out of the provider-shaped request body. */
type ThinkingBody = {
  model: string;
  max_tokens: number;
  thinking?: { type: string; display?: string; budget_tokens?: number };
  output_config?: { effort: string };
};
const build = (name: string, opts: CallOpts = {}) => anthropic.build(resolve(name)!, TURNS, opts, CREDS).body as ThinkingBody;
// Ids this machine's catalog does not carry (Mythos, and anything newer than today's
// newest). The table is a claim about the vendor's models, not about one catalog snapshot,
// so the forward-looking half of it has to be checkable without waiting for a release.
const buildId = (id: string, opts: CallOpts = {}) => {
  const m: Model = { id, provider: "anthropic", family: "x", version: [0], label: id };
  return anthropic.build(m, TURNS, opts, CREDS).body as ThinkingBody;
};

describe("thinking cannot be turned off on always-on models", () => {
  // "Claude Fable 5.1 · Adaptive only · Always on · Rejected with 400: `enabled`,
  // `disabled`" — and identically for Mythos 5.1, Fable 5, Mythos 5, Mythos Preview.
  // `toBeUndefined()` alone cannot carry this claim. A key ASSIGNED undefined and a key
  // that was never set are indistinguishable to it — and indistinguishable after
  // JSON.stringify too, which drops both. But they are NOT the same to the vendor's
  // validator downstream of a proxy that re-serializes differently, and only one of them
  // is what "omit the `thinking` parameter" means. So assert key EXISTENCE, which no
  // serializer can fake, and assert the wire text as it actually goes out.
  test("an always-on id omits `thinking` entirely instead of sending the rejected shape", () => {
    for (const n of ["fable", "fable5"]) {
      const b = build(n, { thinkOff: true });
      expect("thinking" in b).toBe(false);
      expect(Object.keys(b)).not.toContain("thinking");
      expect(JSON.stringify(b)).not.toContain("thinking");
      expect(b.model).toMatch(/fable/);
    }
    for (const id of ["claude-mythos-5", "claude-mythos-5-1", "claude-mythos-preview"]) {
      expect("thinking" in buildId(id, { thinkOff: true })).toBe(false);
    }
  });
  // The remedy the vendor names for exactly this case: "Omit the `thinking` parameter …
  // If your integration must keep thinking disabled … use lower `effort` levels to control
  // token cost instead." Omitting `thinking` alone would silently leave the request at the
  // backend's DEFAULT effort, which is not what a thinkOff caller asked for.
  test("thinkOff becomes the lowest effort, so the ask survives as cost control", () => {
    expect(build("fable", { thinkOff: true }).output_config).toEqual({ effort: "low" });
  });
  test("the synthesized effort holds even when the caller paired thinkOff with a high one", () => {
    // Contradictory ask; thinkOff is the more specific half, so it wins outright.
    const b = build("fable", { thinkOff: true, effort: "max" });
    expect(b.thinking).toBeUndefined();
    expect(b.output_config).toEqual({ effort: "low" });
    // And max_tokens follows the EFFECTIVE effort — a body reserving 32000 for `max` while
    // its output_config says `low` would bill a ceiling the request can no longer reach.
    expect(b.max_tokens).toBe(8192);
  });
  test("an explicit maxTokens still wins over the effort-derived default", () => {
    expect(build("fable", { thinkOff: true, maxTokens: 16 }).max_tokens).toBe(16);
  });
  // The rule is stated of the Fable and Mythos lines as such, so a future member inherits
  // the SAFETY half of it — the rejected shape is never emitted — no matter which branch
  // the id lands in. It does not inherit the effort substitute, because the branch above
  // this one is chosen by MODERN_THINKING, which is version-pinned (`fable-5` matches
  // claude-fable-5-1 by prefix but not claude-fable-6) and is not this lane's to widen.
  // A future Fable therefore takes the LEGACY branch, where thinkOff means budget 0 and
  // emits no thinking field: still safe, but the request loses output_config entirely.
  // Recorded as a known edge rather than asserted as correct, in .deify/thinking-off/.
  test("a future member of an always-on family still never sends the rejected shape", () => {
    for (const id of ["claude-fable-6", "claude-mythos-6", "claude-fable-5-2"]) {
      expect(buildId(id, { thinkOff: true }).thinking).toBeUndefined();
    }
    // The one that stays on the modern branch keeps the full substitute.
    expect(buildId("claude-fable-5-2", { thinkOff: true }).output_config).toEqual({ effort: "low" });
  });
});

describe("thinking can still be turned off where the vendor accepts it", () => {
  // "Claude Opus 4.8 · Adaptive only · Off · Rejected with 400: `enabled`" — `disabled` is
  // absent from that list, and "any value not listed as rejected is accepted".
  test("opus 4.8 keeps the explicit disabled field", () => {
    const b = build("opus48", { thinkOff: true });
    expect(b.model).toBe("claude-opus-4-8");
    expect(b.thinking).toEqual({ type: "disabled" });
  });
  test("and keeps it at every effort, since only Opus 5 and later carry the ceiling", () => {
    for (const e of ["low", "high", "xhigh", "max"]) {
      const b = build("opus48", { thinkOff: true, effort: e });
      expect(b.thinking).toEqual({ type: "disabled" });
      expect(b.output_config).toEqual({ effort: e });
    }
  });
  // Sonnet 5's row rejects `enabled` only, and the Opus 5 effort footnote sits on the Opus
  // row alone — so a gen-5 non-Opus id is left exactly as the table has it.
  test("sonnet 5 disables thinking even at max effort", () => {
    const b = build("sonnet5", { thinkOff: true, effort: "max" });
    expect(b.thinking).toEqual({ type: "disabled" });
    expect(b.output_config).toEqual({ effort: "max" });
  });
  test("legacy budget models are untouched: no thinking field, no output_config", () => {
    const b = build("haiku", { thinkOff: true });
    expect(b.thinking).toBeUndefined();
    expect(b.output_config).toBeUndefined();
  });
});

describe("Opus 5's thinking-off effort ceiling", () => {
  // "Claude Opus 5 accepts `"disabled"` at effort `high` or below; combining it with effort
  // `xhigh` or `max` returns a 400 error. This restriction applies to Claude Opus 5 and
  // later models and is enforced on each request."
  //
  // CONFIRMED LIVE on claude-opus-5 (receipt: .deify/thinking-off/receipt.json,
  // opus5EffortCeiling). Sending disabled+max returns HTTP 400 invalid_request_error,
  // verbatim: `output_config.effort 'max' is not supported when thinking is disabled on
  // this model. Use effort 'high' or below, or enable thinking.` That sentence names both
  // remedies; the first keeps the caller's explicit ask (no thinking) and relaxes only the
  // implicit one, so effort steps down to `high` — the exact level the vendor names.
  test("xhigh and max step down to high, keeping thinking disabled", () => {
    for (const e of ["xhigh", "max"]) {
      const b = build("opus5", { thinkOff: true, effort: e });
      expect(b.thinking).toEqual({ type: "disabled" });
      expect(b.output_config).toEqual({ effort: "high" });
    }
  });
  test("high and below are already legal and pass through unchanged", () => {
    for (const e of ["low", "medium", "high"]) {
      const b = build("opus5", { thinkOff: true, effort: e });
      expect(b.thinking).toEqual({ type: "disabled" });
      expect(b.output_config).toEqual({ effort: e });
    }
  });
  test("no effort at all is legal too — the model's own default is high", () => {
    const b = build("opus5", { thinkOff: true });
    expect(b.thinking).toEqual({ type: "disabled" });
    expect(b.output_config).toBeUndefined();
  });
  test("the ceiling does not reach back to Opus 4.6, whose -6 is not a generation", () => {
    // The one id that a naive "generation 6 or newer" pattern reads as gen 6.
    const b = build("opus46", { thinkOff: true, effort: "max" });
    expect(b.model).toBe("claude-opus-4-6");
    expect(b.output_config).toEqual({ effort: "max" });
  });
  // "and later models" is forward-looking, so NO_DISABLED_ABOVE_HIGH answers true for a
  // later Opus and the clamp is ready for it. It is not yet REACHABLE, though: the branch
  // is gated by the version-pinned MODERN_THINKING, so claude-opus-6 takes the legacy
  // branch today and never reaches the clamp at all. Assert the predicate directly, so
  // this states what is actually true instead of a body the gateway cannot produce.
  test("the ceiling predicate is ready for a later Opus, as `and later models` says", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "providers.ts"), "utf8");
    const fn = src.slice(src.indexOf("const NO_DISABLED_ABOVE_HIGH"), src.indexOf("* Only these first-party Anthropic models"));
    expect(fn).toContain("major > 5");
    // And the legacy branch a future id lands in is still safe: no rejected shape.
    expect(buildId("claude-opus-6", { thinkOff: true, effort: "max" }).thinking).toBeUndefined();
  });
});

describe("nothing changes when thinkOff is false", () => {
  // The regression guard for the fix itself: a body with thinking left on must be
  // byte-identical to what it was before thinkOff learned the per-model table.
  test("adaptive thinking and the caller's effort are untouched on every modern id", () => {
    for (const n of ["opus", "opus5", "opus48", "sonnet", "fable", "fable5"]) {
      for (const e of ["low", "high", "xhigh", "max"]) {
        const b = build(n, { effort: e });
        expect(b.thinking).toEqual({ type: "adaptive" });
        expect(b.output_config).toEqual({ effort: e });
        expect(b.max_tokens).toBe(e === "low" ? 8192 : 32000);
      }
    }
  });
  test("showThinking still asks for the summary", () => {
    expect(build("fable", { effort: "high", showThinking: true }).thinking).toEqual({ type: "adaptive", display: "summarized" });
  });
  test("no effort and no thinkOff sends neither field", () => {
    const b = build("fable");
    expect(b.thinking).toBeUndefined();
    expect(b.output_config).toBeUndefined();
    expect(b.max_tokens).toBe(8192);
  });
  test("legacy budgets are unchanged", () => {
    expect(build("haiku", { effort: "high" }).thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });
});

describe("no request this gateway can build carries a rejected thinking shape", () => {
  // The saturation check: the table is a claim about EVERY id crossed with EVERY effort,
  // and a single surviving combination is a live 400 for whoever sends it.
  test("across every anthropic model and effort, thinking.disabled never reaches a rejecting id", () => {
    const efforts = [undefined, "low", "medium", "high", "xhigh", "max"];
    const ids = ["claude-fable-5-1", "claude-fable-5", "claude-mythos-5", "claude-mythos-5-1", "claude-mythos-preview",
      "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-opus-4-6", "claude-sonnet-4-6"];
    for (const id of ids) {
      for (const effort of efforts) {
        const b = buildId(id, { thinkOff: true, ...(effort ? { effort } : {}) });
        if (b.thinking?.type !== "disabled") continue;
        // Reached only by ids the table says accept it.
        expect(id).not.toMatch(/fable|mythos/);
        // And never above the Opus 5 ceiling.
        if (/opus-5/.test(id)) expect(["low", "medium", "high", undefined]).toContain(b.output_config?.effort);
      }
    }
  });
});
