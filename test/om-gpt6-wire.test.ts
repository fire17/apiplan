// om-gpt6-wire.test.ts — the Responses wire pieces OM needs on GPT-6 (P2, 2026-09-29).
// Pure: no server, no network. Covers G-a (images inside tool results) and the A4
// reasoning envelope + ordered replay in responses-wire.ts.
import { describe, expect, test } from "bun:test";
import {
  toResponsesItems, toolOutputOf, encodeReasoningSig, decodeReasoningSig, reasoningItemOf,
  isForeignThinking, isApiplanThinking, withReasoningInclude, REASONING_SIG_PREFIX,
} from "../src/responses-wire.ts";

const IMG = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };

describe("tool-result images (G-a)", () => {
  test("tool result with an Anthropic image becomes an input_image array", () => {
    const items = toResponsesItems({ role: "user", text: "", toolResults: [{ toolUseId: "c1", content: [{ type: "text", text: "shot" }, IMG] }] });
    expect(items[0]).toEqual({ type: "function_call_output", call_id: "c1",
      output: [{ type: "input_text", text: "shot" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] });
  });
  test("OpenAI image_url parts in a tool result", () => {
    expect(toolOutputOf([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } }]))
      .toEqual([{ type: "input_image", image_url: "data:image/jpeg;base64,BBB" }]);
    expect(toolOutputOf([{ type: "image", source: { type: "url", url: "https://x/y.png" } }]))
      .toEqual([{ type: "input_image", image_url: "https://x/y.png" }]);
  });
  test("text-only tool result stays the exact old string", () => {
    expect(toolOutputOf([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(toolOutputOf("x")).toBe("x");
    const items = toResponsesItems({ role: "user", text: "", toolResults: [{ toolUseId: "c1", content: "plain" }] });
    expect(items[0].output).toBe("plain");
  });
});

describe("A4 reasoning envelope", () => {
  const item = { encrypted_content: "gAAA", summary: [{ type: "summary_text", text: "s" }] };
  test("round-trips with the versioned prefix", () => {
    const sig = encodeReasoningSig(item, "gpt-6-luna");
    expect(sig.startsWith(REASONING_SIG_PREFIX)).toBe(true);
    expect(sig.startsWith("apiplan.rs.v1.")).toBe(true);
    expect(decodeReasoningSig(sig)).toEqual({ ...item, model: "gpt-6-luna" });
    expect(decodeReasoningSig("EqQBsig")).toBeUndefined();
    expect(decodeReasoningSig(REASONING_SIG_PREFIX + "!!notbase64json")).toBeUndefined();
    expect(decodeReasoningSig(undefined)).toBeUndefined();
  });
  test("reasoningItemOf reads only a completed reasoning item", () => {
    expect(reasoningItemOf({ type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "gAAA", summary: [] } }))
      .toEqual({ encrypted_content: "gAAA", summary: [] });
    expect(reasoningItemOf({ type: "response.output_item.added", item: { type: "reasoning", encrypted_content: "gAAA" } })).toBeUndefined();
    expect(reasoningItemOf({ type: "response.output_item.done", item: { type: "reasoning" } })).toBeUndefined();
    expect(reasoningItemOf({ type: "response.output_item.done", item: { type: "function_call" } })).toBeUndefined();
  });
  test("assistant turn with a minted thinking block replays in order, without id", () => {
    const sig = encodeReasoningSig(item, "gpt-6-luna");
    const native = [{ type: "thinking", thinking: "s", signature: sig }, { type: "text", text: "a" }, { type: "tool_use", id: "t1", name: "shot", input: { q: 1 } }];
    const items = toResponsesItems({ role: "assistant", text: "a", toolUses: [{ id: "t1", name: "shot", input: { q: 1 } }], nativeAnthropicContent: native });
    expect(items).toEqual([
      { type: "reasoning", summary: item.summary, encrypted_content: "gAAA" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { type: "function_call", call_id: "t1", name: "shot", arguments: JSON.stringify({ q: 1 }) },
    ]);
    expect(JSON.stringify(items)).not.toContain('"id"');
  });
  test("foreign thinking is skipped, legacy turn unchanged", () => {
    const base = { role: "assistant" as const, text: "a", toolUses: [{ id: "t1", name: "shot", input: {} }] };
    const native = [{ type: "thinking", thinking: "x", signature: "EqQBsig" }, { type: "text", text: "a" }, { type: "tool_use", id: "t1", name: "shot", input: {} }];
    expect(toResponsesItems({ ...base, nativeAnthropicContent: native })).toEqual(toResponsesItems(base));
  });
  test("kill switch APIPLAN_REASONING_REPLAY=0 → legacy output", () => {
    const sig = encodeReasoningSig(item, "gpt-6-luna");
    const base = { role: "assistant" as const, text: "a" };
    const prev = process.env.APIPLAN_REASONING_REPLAY;
    process.env.APIPLAN_REASONING_REPLAY = "0";
    try {
      expect(toResponsesItems({ ...base, nativeAnthropicContent: [{ type: "thinking", thinking: "", signature: sig }, { type: "text", text: "a" }] }))
        .toEqual(toResponsesItems(base));
    } finally { if (prev === undefined) delete process.env.APIPLAN_REASONING_REPLAY; else process.env.APIPLAN_REASONING_REPLAY = prev; }
  });
  test("isForeignThinking / isApiplanThinking", () => {
    const minted = { type: "thinking", thinking: "", signature: encodeReasoningSig(item, "m") };
    expect(isApiplanThinking(minted)).toBe(true);
    expect(isForeignThinking(minted)).toBe(true);
    expect(isForeignThinking({ type: "thinking", thinking: "x", signature: "" })).toBe(true);
    expect(isForeignThinking({ type: "thinking", thinking: "x" })).toBe(true);
    expect(isForeignThinking({ type: "thinking", thinking: "x", signature: "EqQBsig" })).toBe(false);
    expect(isForeignThinking({ type: "text", text: "x" })).toBe(false);
  });
  test("withReasoningInclude is idempotent and keeps others", () => {
    const b: any = { include: ["x"] };
    withReasoningInclude(b); withReasoningInclude(b);
    expect(b.include).toEqual(["x", "reasoning.encrypted_content"]);
    const c: any = {}; withReasoningInclude(c);
    expect(c.include).toEqual(["reasoning.encrypted_content"]);
  });
});
