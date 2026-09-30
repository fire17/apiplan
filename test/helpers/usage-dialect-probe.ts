/**
 * A fresh-process host for the usage-dialect tests.
 *
 * WHY A SUBPROCESS. The provider base URLs, the credential wells and STATE_DIR are all read
 * from the environment — some at module import, some on every call — and `bun test` runs
 * every test file in ONE process. Setting those variables from inside a test file therefore
 * leaks into the other files: pointing the Anthropic and Responses base URLs at a local
 * fixture made contract.test.ts and astra.test.ts fail, because they legitimately assert the
 * REAL upstream URLs. The same reasoning as test/helpers/apiplan-probe.ts — a host declares
 * its world when it starts, so the world gets its own process.
 *
 * This process stands up three things on loopback and nothing else:
 *   · a FIXTURE server that impersonates BOTH upstreams — `/v1/messages` answers in
 *     Anthropic's wire shape and `/responses` in the Responses shape — plus `POST /__fixture`
 *     so the parent can say what the next call should report.
 *   · the real api.serve(), pointed at that fixture by APIPLAN_*_BASE.
 * It prints `READY <apiPort> <fixturePort>` and serves until the parent kills it.
 *
 * No credential of the operator's is read (the wells are stub files the parent passes in),
 * no vendor is ever dialled, and nothing outside the scratch dir is written.
 */

/** What the next upstream call should report. Replaced wholesale by POST /__fixture. */
type Counters = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type Fixture = {
  anthropic?: Counters;
  openai?: { input_tokens?: number; output_tokens?: number; cached_tokens?: number; cache_write_tokens?: number };
  /** Anthropic reports a count on message_start and CORRECTS it on message_delta. */
  anthropicStart?: Counters;
  /** Omit the usage object entirely, the way a backend reporting nothing does. */
  silent?: boolean;
};
let fx: Fixture = {};

const sse = (o: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(o)}\n\n`;
const eventStream = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });

/** Anthropic's wire shape: message_start, one text block, message_delta, message_stop. */
function anthropicReply(): Response {
  const u = fx.anthropic ?? {};
  const start = fx.anthropicStart ?? u;
  return eventStream(
    sse({ type: "message_start", message: { id: "msg_up", type: "message", role: "assistant", model: "claude-opus-5", content: [], ...(fx.silent ? {} : { usage: start }) } }, "message_start") +
    sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start") +
    sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }, "content_block_delta") +
    sse({ type: "content_block_stop", index: 0 }, "content_block_stop") +
    sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, ...(fx.silent ? {} : { usage: u }) }, "message_delta") +
    sse({ type: "message_stop" }, "message_stop"),
  );
}

/** The Responses wire shape: created, a text delta, then response.completed carrying usage. */
function responsesReply(): Response {
  const o = fx.openai ?? {};
  const details: Record<string, number> = {};
  if (o.cached_tokens !== undefined) details.cached_tokens = o.cached_tokens;
  if (o.cache_write_tokens !== undefined) details.cache_write_tokens = o.cache_write_tokens;
  const usage = {
    ...(o.input_tokens !== undefined ? { input_tokens: o.input_tokens } : {}),
    ...(o.output_tokens !== undefined ? { output_tokens: o.output_tokens } : {}),
    ...(Object.keys(details).length ? { input_tokens_details: details } : {}),
  };
  const response = { id: "resp_up", model: "gpt-6-astra", output: [], status: "completed", ...(fx.silent ? {} : { usage }) };
  return eventStream(
    sse({ type: "response.created", response }) +
    sse({ type: "response.output_text.delta", delta: "hi" }) +
    sse({ type: "response.completed", response }),
  );
}

const fixture = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/__fixture") { fx = (await req.json()) as Fixture; return new Response("ok"); }
    // Drain the body so the upstream behaves like a real one that read the request.
    try { await req.json(); } catch {}
    if (pathname.startsWith("/v1/messages")) return anthropicReply();
    if (pathname === "/responses") return responsesReply();
    return new Response("no such upstream path", { status: 404 });
  },
});

// Set BEFORE api.ts is imported: STATE_DIR and the credential wells are read at import time,
// the base URLs on every call. In this process only — that is the whole point of the process.
const base = `http://127.0.0.1:${fixture.port}`;
process.env.APIPLAN_ANTHROPIC_BASE = base;
process.env.APIPLAN_OPENAI_BASE = base;
process.env.APIPLAN_RESPONSES_PATH = "/responses";
process.env.APIPLAN_API_KEY = "";
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete process.env[k];

const { serve } = await import("../../src/api.ts");
// token: "" — never inherit the operator's APIPLAN_API_KEY, or the probe 401s on itself.
const api = serve({ port: 0, host: "127.0.0.1", token: "" });
const apiPort = (api as any).port ?? new URL(api.url).port;

console.log(`READY ${apiPort} ${fixture.port}`);
// Stay alive; the parent kills us. Nothing ever resolves this — it is a park, not a wait.
await Promise.withResolvers<never>().promise;
