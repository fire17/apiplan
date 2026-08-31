import { test, expect } from "bun:test";
import { chatToResponses, chunker, foldChat } from "../src/convert.ts";

test("chat → responses: system folds into instructions, tools and tool results map", () => {
  const b = chatToResponses({
    model: "gpt-5.4-mini",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "42" },
    ],
    tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
    max_tokens: 5, reasoning_effort: "low",
  });
  expect(b.instructions).toBe("be brief");
  expect(b.input[0].content[1].type).toBe("input_image");
  expect(b.input[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "f" });
  expect(b.input[2]).toMatchObject({ type: "function_call_output", call_id: "call_1", output: "42" });
  expect(b.tools[0]).toMatchObject({ type: "function", name: "f" });
  expect(b.max_output_tokens).toBeUndefined();
  expect(b.reasoning).toEqual({ effort: "low" });
  expect(b.stream).toBe(true); expect(b.store).toBe(false);
});

test("responses events → chat chunks → folded completion, incl. tool calls + usage", () => {
  const c = chunker("chatcmpl-x", "m", 1);
  const evs = [
    { type: "response.created", response: { model: "m-2026" } },
    { type: "response.output_text.delta", delta: "Hel" }, { type: "response.output_text.delta", delta: "lo" },
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "get_weather" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"Paris"}' },
    { type: "response.completed", response: { model: "m-2026", status: "completed", usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
  ];
  const chunks = evs.flatMap((e) => c.feed(e));
  expect(chunks[0].choices[0].delta.role).toBe("assistant");
  expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  const full = foldChat(chunks);
  expect(full.model).toBe("m-2026");
  expect(full.choices[0].message.content).toBe("Hello");
  expect(full.choices[0].message.tool_calls[0]).toEqual({ id: "call_9", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } });
  expect(full.usage.total_tokens).toBe(7);
});
