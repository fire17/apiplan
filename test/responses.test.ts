// /v1/responses — the OpenAI Responses dialect, served by translation onto the chat path.
// Credential-free: the request mapping and the event grammar are tested with a scripted
// Delta source; the route itself only with requests rejected before any backend call.
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { serve, responsesToChat, renderResponses } from "../src/api.ts";

let base = "";
let stop = () => {};
beforeAll(() => { const s = serve({ port: 0, host: "127.0.0.1" }); base = s.url; stop = s.stop; });
afterAll(() => stop());
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function* scripted(ds: any[]) { for (const d of ds) yield d; }
const meta = (body: any = {}) => ({ model: "gpt-test", body, turns: [{ role: "user" as const, text: "hi" }] });
const frames = (raw: string) => raw.split("\n\n").filter(Boolean).map((f) => {
  const ev = f.match(/^event: (.+)$/m)?.[1];
  const data = JSON.parse(f.match(/^data: (.+)$/m)![1]);
  return { ev, data };
});

describe("a Responses request is restated as the chat body it means", () => {
  test("string input + instructions → system + user", () => {
    const c = responsesToChat({ model: "m", instructions: "be brief", input: "hello", max_output_tokens: 50, reasoning: { effort: "low" } });
    expect(c.messages).toEqual([{ role: "system", content: "be brief" }, { role: "user", content: "hello" }]);
    expect(c.max_output_tokens).toBe(50);
    expect(c.reasoning).toEqual({ effort: "low" });
    expect(c.stream).toBe(false);
  });
  test("items: parts, parallel function calls on one assistant turn, their outputs as tool messages", () => {
    const c = responsesToChat({
      model: "m",
      input: [
        { role: "developer", content: "dev note" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "low" }] },
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "function_call", call_id: "call_a", name: "f", arguments: "{\"x\":1}" },
        { type: "function_call", call_id: "call_b", name: "g", arguments: { y: 2 } },
        { type: "function_call_output", call_id: "call_a", output: "A" },
        { type: "function_call_output", call_id: "call_b", output: { ok: true } },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      ],
      tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }, { type: "web_search" }],
      tool_choice: { type: "function", name: "f" },
    });
    expect(c.messages[0]).toEqual({ role: "developer", content: "dev note" });
    expect(c.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } });
    expect(c.messages[2].role).toBe("assistant");
    expect(c.messages[2].tool_calls.map((t: any) => t.id)).toEqual(["call_a", "call_b"]);
    expect(c.messages[2].tool_calls[1].function.arguments).toBe("{\"y\":2}");
    expect(c.messages[3]).toEqual({ role: "tool", tool_call_id: "call_a", content: "A" });
    expect(c.messages[4].content).toBe("{\"ok\":true}");
    expect(c.messages[5]).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }] });
    // built-in tools are not forwarded; function tools take the chat shape
    expect(c.tools).toEqual([{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }]);
    expect(c.tool_choice).toEqual({ type: "function", name: "f" });
  });
  test("previous_response_id and a missing input are refused, with a reason", () => {
    expect(() => responsesToChat({ model: "m", input: "x", previous_response_id: "resp_1" })).toThrow(/stores no responses/);
    expect(() => responsesToChat({ model: "m" })).toThrow(/`input` is required/);
  });
});

describe("the reply is rendered in Responses' own shape", () => {
  test("non-stream: message + function_call items, inclusive usage", async () => {
    const r = renderResponses(() => scripted([
      { text: "Hel" }, { text: "lo" },
      { toolStart: { ref: "1", id: "call_1", name: "get_weather" } },
      { toolArgs: { ref: "1", json: "{\"city\":" } }, { toolArgs: { ref: "1", json: "\"Paris\"}" } }, { toolStop: { ref: "1" } },
      { usage: { input: 10, output: 5 }, stopReason: "tool_use" },
    ]), meta({ instructions: "sys" }));
    const j = await r.collect();
    expect(j.object).toBe("response");
    expect(j.id).toMatch(/^resp_/);
    expect(j.status).toBe("completed");
    expect(j.instructions).toBe("sys");
    expect(j.output[0]).toMatchObject({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] });
    expect(j.output[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" });
    expect(j.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });
  test("a max_tokens stop is `incomplete`, not completed", async () => {
    const j = await renderResponses(() => scripted([{ text: "cut" }, { stopReason: "max_tokens", usage: { input: 3, output: 1 } }]), meta()).collect();
    expect(j.status).toBe("incomplete");
    expect(j.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });
  test("stream: the documented event order, sequence numbers, and a terminal event", async () => {
    let raw = "";
    const r = renderResponses(() => scripted([
      { text: "A" }, { text: "B" },
      { toolStart: { ref: "t", id: "call_9", name: "f" } }, { toolArgs: { ref: "t", json: "{}" } }, { toolStop: { ref: "t" } },
      { usage: { input: 4, output: 2 } },
    ]), meta());
    for await (const s of r.events()) raw += s;
    const f = frames(raw);
    expect(f.map((x) => x.ev)).toEqual([
      "response.created", "response.in_progress",
      "response.output_item.added", "response.content_part.added",
      "response.output_text.delta", "response.output_text.delta",
      "response.output_text.done", "response.content_part.done", "response.output_item.done",
      "response.output_item.added", "response.function_call_arguments.delta",
      "response.function_call_arguments.done", "response.output_item.done",
      "response.completed",
    ]);
    expect(f.every((x) => x.data.type === x.ev)).toBe(true);
    expect(f.map((x) => x.data.sequence_number)).toEqual(f.map((_, i) => i));
    const done = f.at(-1)!.data.response;
    expect(done.status).toBe("completed");
    expect(done.output.map((o: any) => o.type)).toEqual(["message", "function_call"]);
    expect(done.output[0].content[0].text).toBe("AB");
    expect(done.usage.total_tokens).toBe(6);
    expect(f[9].data.output_index).toBe(1);
  });
  test("a fault mid-stream ends in response.failed, never a silent stop", async () => {
    async function* broken() { yield { text: "par" } as any; throw new Error("upstream fell over"); }
    let raw = "";
    for await (const s of renderResponses(broken, meta()).events()) raw += s;
    const last = frames(raw).at(-1)!;
    expect(last.ev).toBe("response.failed");
    expect(last.data.response.status).toBe("failed");
    expect(last.data.response.error.message).toContain("upstream fell over");
  });
});

describe("the route exists and answers in OpenAI's error shape", () => {
  test("unknown model → 404 (not 'no route')", async () => {
    const r = await post("/v1/responses", { model: "no-such-model-xyz", input: "hi" });
    expect(r.status).toBe(404);
    const j: any = await r.json();
    expect(j.error.message).toContain("unknown model");
  });
  test("previous_response_id → 400 invalid_request_error", async () => {
    const r = await post("/v1/responses", { model: "no-such-model-xyz", input: "hi", previous_response_id: "resp_x" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.type).toBe("invalid_request_error");
  });
});
