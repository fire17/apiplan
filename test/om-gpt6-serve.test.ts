// om-gpt6-serve.test.ts — GPT-6 through `apiplan serve` the way OM drives it (P2, 2026-09-29).
//
// Raw HTTP at a real api.serve() in a CHILD process (its own APIPLAN_HOME, stub Codex creds,
// APIPLAN_OPENAI_BASE pointed at a loopback stub that plays scripted Responses events and
// records every body it was sent). A child, not an import: bun runs test files in one
// process, and api.ts/registry.ts read APIPLAN_HOME at import time.
//
// Covers: A4 (signed thinking out, ordered replay in, one-retry fallback), the GPT-6 effort
// clamp, tool-result images, and the Codex fault/capacity mapping OM's retry policy reads.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAnthropic, clampEffort } from "../src/api.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DIR = mkdtempSync(join(tmpdir(), "ap-om-gpt6-"));
const HOME = join(DIR, "home");
const CODEX_CRED = join(DIR, "codex.json");
mkdirSync(HOME, { recursive: true });
const eff = ["low", "medium", "high", "xhigh", "max"];
writeFileSync(join(HOME, "models.openai.json"), JSON.stringify({ fetched_at: Date.now(), models: [
  { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: eff, contextWindow: 272000 },
  { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: eff, contextWindow: 272000 },
  { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: eff, contextWindow: 272000 },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: eff, contextWindow: 272000 },
] }));
writeFileSync(CODEX_CRED, JSON.stringify({
  tokens: { access_token: "AT-om-gpt6", refresh_token: "RT-om-gpt6", account_id: "acct-om-gpt6" },
  last_refresh: new Date().toISOString(),
}));

/** The child: a scripted Responses stub + api.serve(). Prints one READY line. */
const HOST = `
const queue = [], captured = [];
const sse = (evs) => evs.map((e) => "event: " + e.type + "\\ndata: " + JSON.stringify(e) + "\\n\\n").join("");
const DEFAULT = [
  { type: "response.created", response: { model: "stub" } },
  { type: "response.output_text.delta", delta: "ok" },
  { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 1 } } },
];
const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/__script") { queue.push(...(await req.json())); return new Response("ok"); }
  if (u.pathname === "/__captured") return Response.json(captured);
  if (u.pathname === "/__reset") { queue.length = 0; captured.length = 0; return new Response("ok"); }
  if (u.pathname.endsWith("/responses")) {
    captured.push(await req.json());
    const r = queue.shift() ?? { kind: "events", events: DEFAULT };
    if (r.kind === "http") return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
    return new Response(sse(r.events), { headers: { "content-type": "text/event-stream" } });
  }
  return new Response("no", { status: 404 });
} });
process.env.APIPLAN_OPENAI_BASE = "http://127.0.0.1:" + stub.port;
const { serve } = await import(${JSON.stringify(ROOT + "src/api.ts")});
const s = serve({ port: 0, host: "127.0.0.1" });
console.log("READY " + JSON.stringify({ api: "http://127.0.0.1:" + s.port, stub: "http://127.0.0.1:" + stub.port }));
`;

let proc: { kill(): void; stdout: ReadableStream<Uint8Array> } | null = null;
let API = "", STUB = "";

beforeAll(async () => {
  const hostFile = join(DIR, "host.ts");
  writeFileSync(hostFile, HOST);
  proc = Bun.spawn(["bun", hostFile], {
    cwd: ROOT,
    env: {
      ...process.env, APIPLAN_HOME: HOME, APIPLAN_API_KEY: "", APIPLAN_CODEX_AUTH: CODEX_CRED,
      APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_CRED_FILE: join(DIR, "no-such-google.json"),
      APIPLAN_ANTHROPIC_CRED_FILE: join(DIR, "no-such-anthropic.json"),
    },
    stdout: "pipe", stderr: "ignore",
  }) as any;
  const reader = proc!.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    const m = buf.match(/READY (\{.*\})/);
    if (m) { const j = JSON.parse(m[1]); API = j.api; STUB = j.stub; break; }
  }
  reader.releaseLock();
  if (!API) throw new Error("host never became ready: " + buf.slice(0, 500));
}, 30_000);
afterAll(() => { try { proc?.kill(); } catch {} });
beforeEach(async () => { if (STUB) await fetch(STUB + "/__reset", { method: "POST" }); });

const script = (...r: any[]) => fetch(STUB + "/__script", { method: "POST", body: JSON.stringify(r) });
const captured = async (): Promise<any[]> => (await fetch(STUB + "/__captured")).json();
const post = (body: any) => fetch(API + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
const sseEvents = (txt: string) => txt.split("\n").filter((l) => l.startsWith("data: ")).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);

const REASON_THEN_TOOL = { kind: "events", events: [
  { type: "response.created", response: { model: "gpt-6-luna" } },
  { type: "response.reasoning_summary_text.delta", delta: "plan" },
  { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", encrypted_content: "gAAAX", summary: [{ type: "summary_text", text: "plan" }] } },
  { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "screenshot" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" },
  { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "screenshot", arguments: "{}" } },
  { type: "response.completed", response: { usage: { input_tokens: 50, output_tokens: 9, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } } } },
] };
const TOOLS = [{ name: "screenshot", description: "Take a screenshot", input_schema: { type: "object", properties: {} } }];
const base = (extra: any = {}) => ({ model: "gpt-6-luna", max_tokens: 1024, thinking: { type: "adaptive" }, output_config: { effort: "low" },
  metadata: { user_id: "om-gpt6-test" }, tools: TOOLS, messages: [{ role: "user", content: "shoot" }], ...extra });

describe("A4 reasoning replay through the Anthropic front", () => {
  test("stream: reasoning becomes a signed thinking block before the tool call", async () => {
    await script(REASON_THEN_TOOL);
    const r = await post(base({ stream: true }));
    expect(r.status).toBe(200);
    const evs = sseEvents(await r.text());
    const starts = evs.filter((e) => e.type === "content_block_start");
    expect(starts.map((e) => [e.index, e.content_block.type])).toEqual([[0, "thinking"], [1, "tool_use"]]);
    const think = evs.find((e) => e.type === "content_block_delta" && e.delta.type === "thinking_delta");
    expect(think.delta.thinking).toBe("plan");
    const sig = evs.find((e) => e.type === "content_block_delta" && e.delta.type === "signature_delta");
    expect(sig.delta.signature.startsWith("apiplan.rs.v1.")).toBe(true);
    // thinking block closes before the tool_use opens
    const iStop0 = evs.findIndex((e) => e.type === "content_block_stop" && e.index === 0);
    const iStart1 = evs.findIndex((e) => e.type === "content_block_start" && e.index === 1);
    expect(iStop0).toBeLessThan(iStart1);
    const md = evs.find((e) => e.type === "message_delta");
    expect(md.delta.stop_reason).toBe("tool_use");
    const [body] = await captured();
    expect(body.include).toContain("reasoning.encrypted_content");
    expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(body.prompt_cache_key).toBe("om-gpt6-test");
  });

  test("non-stream: the same thinking block comes first", async () => {
    await script(REASON_THEN_TOOL);
    const r = await post(base({ stream: false }));
    const j: any = await r.json();
    expect(j.content.map((b: any) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(j.content[0].thinking).toBe("plan");
    expect(j.content[0].signature.startsWith("apiplan.rs.v1.")).toBe(true);
    expect(j.stop_reason).toBe("tool_use");
    expect(j.usage.input_tokens).toBe(50);
  });

  test("turn 2 replays the item, in order, without id; the tool-result image rides as input_image", async () => {
    await script(REASON_THEN_TOOL);
    const j: any = await (await post(base({ stream: false }))).json();
    await fetch(STUB + "/__reset", { method: "POST" });
    const toolUse = j.content.find((b: any) => b.type === "tool_use");
    await post(base({ stream: false, messages: [
      { role: "user", content: "shoot" },
      { role: "assistant", content: j.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] }] },
    ] }));
    const [body] = await captured();
    expect(body.input.map((i: any) => i.type)).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
    expect(body.input[1]).toEqual({ type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "gAAAX" });
    expect(body.input[2].call_id).toBe("call_1");
    expect(body.input[3].output).toEqual([{ type: "input_image", image_url: "data:image/png;base64,AAA" }]);
  });

  test("replay refused (invalid_encrypted_content) → one retry without it", async () => {
    await script(REASON_THEN_TOOL);
    const j: any = await (await post(base({ stream: false }))).json();
    await fetch(STUB + "/__reset", { method: "POST" });
    await script({ kind: "http", status: 400, body: { error: { type: "invalid_request_error", code: "invalid_encrypted_content", message: "The encrypted content gAAA could not be verified." } } });
    const hist = [{ role: "user", content: "shoot" }, { role: "assistant", content: j.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] }];
    const r = await post(base({ stream: false, messages: hist }));
    expect(r.status).toBe(200);
    const bodies = await captured();
    expect(bodies.length).toBe(2);
    expect(bodies[0].input.some((i: any) => i.type === "reasoning")).toBe(true);
    expect(bodies[1].input.some((i: any) => i.type === "reasoning")).toBe(false);
  });

  test("a second refusal is not retried again", async () => {
    await script(REASON_THEN_TOOL);
    const j: any = await (await post(base({ stream: false }))).json();
    await fetch(STUB + "/__reset", { method: "POST" });
    const refuse = { kind: "http", status: 400, body: { error: { type: "invalid_request_error", code: "invalid_encrypted_content", message: "The encrypted content gAAA could not be verified." } } };
    await script(refuse, refuse);
    const r = await post(base({ stream: false, messages: [{ role: "user", content: "shoot" }, { role: "assistant", content: j.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] }] }));
    expect(r.status).toBe(400);
    const e: any = await r.json();
    expect(e.error.type).toBe("invalid_request_error");
    expect((await captured()).length).toBe(2);
  });
});

describe("GPT-6 effort clamp on the wire", () => {
  const effortSent = async (extra: any) => { await post(base({ stream: false, tools: undefined, ...extra })); const [b] = await captured(); return b.reasoning?.effort; };
  test("minimal → low, disabled → none, max → max, bogus → backend default", async () => {
    expect(await effortSent({ output_config: { effort: "minimal" } })).toBe("low");
    await fetch(STUB + "/__reset", { method: "POST" });
    expect(await effortSent({ thinking: { type: "disabled" }, output_config: undefined })).toBe("none");
    await fetch(STUB + "/__reset", { method: "POST" });
    expect(await effortSent({ output_config: { effort: "max" } })).toBe("max");
    await fetch(STUB + "/__reset", { method: "POST" });
    expect(await effortSent({ output_config: { effort: "bogus" } })).toBeUndefined();
  });
});

describe("Codex faults → the vocabulary OM's retry policy reads", () => {
  test("usage_limit_reached 429 → rate_limit_error + retry-after + reset in x-apiplan-failure", async () => {
    await script({ kind: "http", status: 429, body: { error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 120 } } });
    const r = await post(base({ stream: false }));
    expect(r.status).toBe(429);
    const e: any = await r.json();
    expect(e.error.type).toBe("rate_limit_error");
    expect(e.error.message).toContain("usage_limit_reached");
    const ra = Number(r.headers.get("retry-after"));
    expect(ra).toBeGreaterThan(110); expect(ra).toBeLessThanOrEqual(121);
    const f = JSON.parse(r.headers.get("x-apiplan-failure") ?? "{}");
    expect(Math.abs(f.resetAt - (Date.now() + 120_000))).toBeLessThan(5_000);
  });
  test("a 429 with no reset fact carries no invented retry-after", async () => {
    await script({ kind: "http", status: 429, body: { error: { type: "rate_limit_exceeded", message: "slow down" } } });
    const r = await post(base({ stream: false }));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeNull();
    expect(((await r.json()) as any).error.type).toBe("rate_limit_error");
  });
  test("mid-stream server_is_overloaded → overloaded_error", async () => {
    await script({ kind: "events", events: [
      { type: "response.created", response: { model: "gpt-6-luna" } },
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.failed", response: { error: { code: "server_is_overloaded", message: "busy" } } },
    ] });
    const r = await post(base({ stream: true, tools: undefined }));
    const txt = await r.text();
    expect(txt).toContain("overloaded_error");
  });
  test("context overflow keeps OM's regex words", async () => {
    await script({ kind: "http", status: 400, body: { error: { type: "invalid_request_error", code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } } });
    const r = await post(base({ stream: false }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.message).toMatch(/exceeds the context window/);
  });
});

describe("pure helpers", () => {
  const sig = "apiplan.rs.v1.eyJ2IjoxLCJtIjoibSIsImUiOiJnQSIsInMiOltdfQ";
  const hist = { messages: [{ role: "user", content: "q" }, { role: "assistant", content: [
    { type: "thinking", thinking: "", signature: sig }, { type: "thinking", thinking: "t", signature: "EqQBsig" },
    { type: "thinking", thinking: "u" }, { type: "text", text: "a" }] }] };
  test("a Claude target never sees our thinking; Anthropic-signed kept", () => {
    const { turns } = fromAnthropic(hist, "anthropic");
    expect(turns[1].nativeAnthropicContent).toEqual([{ type: "thinking", thinking: "t", signature: "EqQBsig" }, { type: "text", text: "a" }]);
  });
  test("the openai target keeps the minted block", () => {
    const { turns } = fromAnthropic(hist, "openai");
    expect(turns[1].nativeAnthropicContent!.length).toBe(4);
  });
  test("clampEffort leaves non-openai alone", () => {
    const o: any = { effort: "minimal" };
    clampEffort({ id: "claude-opus-5", provider: "anthropic" } as any, o);
    expect(o.effort).toBe("minimal");
  });
  test("clampEffort on a 5.6 model: thinking off → lowest listed", () => {
    const o: any = { thinkOff: true };
    clampEffort({ id: "gpt-5.6-luna", provider: "openai", efforts: ["low", "medium"] } as any, o);
    expect(o.effort).toBe("low");
  });
  // VERIFY 2026-09-29: gpt-6-astra REFUSES 'none' live ("Supported values are: 'low', 'medium',
  // 'high', 'xhigh', and 'max'"), so the model's own ladder decides, not the gpt-6 family name.
  test("clampEffort on gpt-6-astra: none → lowest listed, thinking off → lowest listed", () => {
    const astra = { id: "gpt-6-astra", provider: "openai", efforts: ["low", "medium", "high", "xhigh", "max"] } as any;
    const o1: any = { effort: "none" }; clampEffort(astra, o1); expect(o1.effort).toBe("low");
    const o2: any = { thinkOff: true }; clampEffort(astra, o2); expect(o2.effort).toBe("low");
  });
  test("clampEffort on gpt-6-luna keeps none (its ladder lists it)", () => {
    const luna = { id: "gpt-6-luna", provider: "openai", efforts: ["none", "low", "medium", "high", "xhigh", "max"] } as any;
    const o1: any = { effort: "none" }; clampEffort(luna, o1); expect(o1.effort).toBe("none");
    const o2: any = { thinkOff: true }; clampEffort(luna, o2); expect(o2.effort).toBe("none");
  });
});
