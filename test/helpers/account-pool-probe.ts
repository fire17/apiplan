/**
 * A fresh-process host for the account-pool tests (test/account-pool.test.ts).
 *
 * Same reasoning as test/helpers/usage-dialect-probe.ts: base URLs, credential wells, pool dirs
 * and STATE_DIR come from the environment, and `bun test` shares one process across files, so
 * this world gets its own process. The parent passes the stub credential files + pool dirs in
 * the environment; this process stands up:
 *   · a FIXTURE upstream speaking Anthropic `/v1/messages` and Codex `/responses`, whose answer
 *     per BEARER is set by `POST /__fixture` ({mode: {<bearer>: "ok"|"429"|"midstream429"},
 *     usage: {<bearer>: [fiveHourFraction, sevenDayFraction]}}), and which records every real
 *     (non usage-probe) call's bearer, read back by `GET /__hits`;
 *   · the real api.serve(), pointed at it.
 * Prints `READY <apiPort> <fixturePort>`. Only fake tokens ever exist in this world.
 */
// No vendor is ever dialled: the usage poller's Codex endpoint is a fixed vendor URL, so any
// non-loopback fetch is refused here rather than leaking a fake bearer to the internet.
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") return Promise.reject(new Error("fixture denied non-loopback fetch"));
  return nativeFetch(input, init);
}) as typeof fetch;

type Mode = "ok" | "429" | "midstream429";
let mode: Record<string, Mode> = {};
let usage: Record<string, [number, number]> = {};
let hits: string[] = [];

const sse = (o: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(o)}\n\n`;
const stream = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const RESET_S = Math.floor(Date.now() / 1000) + 3 * 3600;

function anthropic(m: Mode): Response {
  if (m === "429") {
    return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "fixture: account limit" } }),
      { status: 429, headers: { "content-type": "application/json", "anthropic-ratelimit-unified-reset": String(RESET_S) } });
  }
  const start = sse({ type: "message_start", message: { id: "msg_up", type: "message", role: "assistant", model: "claude-opus-5", content: [], usage: { input_tokens: 3, output_tokens: 0 } } }, "message_start")
    + sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start")
    + sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }, "content_block_delta");
  if (m === "midstream429") return stream(start + sse({ type: "error", error: { type: "rate_limit_error", message: "fixture: limit mid-stream" } }, "error"));
  return stream(start
    + sse({ type: "content_block_stop", index: 0 }, "content_block_stop")
    + sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, "message_delta")
    + sse({ type: "message_stop" }, "message_stop"));
}
function responses(m: Mode): Response {
  if (m === "429") {
    return new Response(JSON.stringify({ error: { type: "usage_limit_reached", code: "usage_limit_reached", message: "fixture: usage limit", resets_in_seconds: 7200 } }),
      { status: 429, headers: { "content-type": "application/json" } });
  }
  const response = { id: "resp_up", model: "gpt-6-astra", output: [], status: "completed", usage: { input_tokens: 3, output_tokens: 1 } };
  return stream(sse({ type: "response.created", response }) + sse({ type: "response.output_text.delta", delta: "hi" }) + sse({ type: "response.completed", response }));
}

const fixture = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/__fixture") { const b: any = await req.json(); mode = b.mode ?? {}; usage = b.usage ?? usage; hits = []; return new Response("ok"); }
    if (pathname === "/__hits") return Response.json(hits);
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    let body: any = {};
    try { body = await req.json(); } catch {}
    if (pathname.startsWith("/v1/messages")) {
      // The usage poller's max_tokens:1 header probe: answer windows, never count it as a call.
      if (body?.max_tokens === 1) {
        const [h5, d7] = usage[bearer] ?? [0.01, 0.01];
        return new Response("{}", { headers: {
          "anthropic-ratelimit-unified-5h-utilization": String(h5), "anthropic-ratelimit-unified-5h-reset": String(RESET_S),
          "anthropic-ratelimit-unified-7d-utilization": String(d7), "anthropic-ratelimit-unified-7d-reset": String(RESET_S + 86400),
        } });
      }
      hits.push(bearer);
      return anthropic(mode[bearer] ?? "ok");
    }
    if (pathname === "/responses") { hits.push(bearer); return responses(mode[bearer] ?? "ok"); }
    return new Response("no such upstream path", { status: 404 });
  },
});

const base = `http://127.0.0.1:${fixture.port}`;
process.env.APIPLAN_ANTHROPIC_BASE = base;
process.env.APIPLAN_OPENAI_BASE = base;
process.env.APIPLAN_RESPONSES_PATH = "/responses";
process.env.APIPLAN_API_KEY = "";
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete process.env[k];

const { serve } = await import("../../src/api.ts");
const api = serve({ port: 0, host: "127.0.0.1", token: "" });
console.log(`READY ${api.port} ${fixture.port}`);
await Promise.withResolvers<never>().promise;
