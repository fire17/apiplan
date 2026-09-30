/**
 * THE STUB UPSTREAM for the usage-field completeness tests — every vendor this server can
 * talk to, impersonated on one loopback port, in a process of its OWN.
 *
 * ── WHY IT IS A SEPARATE PROCESS FROM api.serve() ──
 *
 * Not tidiness; the tests cannot pass otherwise, and the reason is worth writing down
 * because it will catch the next person too. The ollama provider establishes daemon
 * liveness with a BLOCKING `Bun.spawnSync(["curl", …, "/api/version"])` — deliberately, so
 * that probe(), status and doctor can stay synchronous. A synchronous spawn stops the single
 * JavaScript thread until curl exits. If the fixture answering that request lives in the
 * same process, its `fetch` handler cannot run until the thread is released, and the thread
 * is not released until curl gives up: curl exits 28 (timeout), the daemon reads as absent,
 * and the request fails 401 at the credential step without ever reaching the provider whose
 * behaviour was under test. Measured, not theorised — `curl -sf -m 1` against a Bun.serve
 * in its own process returns exit 28 with empty output.
 *
 * So the upstream gets its own process and the deadlock cannot form. Every other vendor
 * here is answered over plain fetch and would have been fine either way; ollama decides the
 * architecture, and one upstream for all of them is better than two mechanisms.
 *
 * ── WHAT IT SERVES ──
 *
 *   POST /__fixture                  the parent declares what the next call reports
 *   POST /v1/messages                Anthropic's wire shape (message_start … message_stop)
 *   POST /responses                  the Responses shape (Codex and the grok proxy both)
 *   POST /…streamGenerateContent     Gemini, on both Google routes
 *   GET  /api/version|tags, /api/show   ollama's liveness and catalog reads
 *
 * The fixture speaks each vendor's FULL documented usage object, including the fields this
 * server deliberately does not carry — a test that never sends them cannot prove they are
 * dropped on purpose rather than by accident.
 *
 * It prints `READY <port>` and serves until the parent kills it. No vendor is ever dialled
 * and nothing outside the parent's scratch dir is written.
 */

/** Anthropic's documented `Usage`, in that vendor's OWN field names. */
export type AnthropicCounters = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** The TTL breakdown of the write — the P-23 field. */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  /** Per-REQUEST vendor tool invocations, not tokens. */
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
};
/** The Responses shape, as Codex and the xAI proxy both document it. */
export type ResponsesCounters = {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  /** `output_tokens_details.reasoning_tokens` — already INSIDE output_tokens. */
  reasoning_tokens?: number;
  /** Deliberately-dropped fields, sent so a test can prove they are not republished. */
  total_tokens?: number;
  orchestration_input_tokens?: number;
  orchestration_input_cached_tokens?: number;
  orchestration_output_tokens?: number;
};
/** Gemini's documented `UsageMetadata`. */
export type GoogleCounters = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  /** Containment relative to promptTokenCount is undocumented — never carried. */
  toolUsePromptTokenCount?: number;
};
export type Fixture = {
  anthropic?: AnthropicCounters;
  /** Anthropic reports a count on message_start and CORRECTS it on message_delta. */
  anthropicStart?: AnthropicCounters;
  openai?: ResponsesCounters;
  google?: GoogleCounters;
  /** Omit the usage object entirely, the way a backend reporting nothing does. */
  silent?: boolean;
  /** Refuse the call instead of answering it, with a real vendor error body. */
  reject?: { status: number; body: string };
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
  const inDetails: Record<string, number> = {};
  if (o.cached_tokens !== undefined) inDetails.cached_tokens = o.cached_tokens;
  if (o.cache_write_tokens !== undefined) inDetails.cache_write_tokens = o.cache_write_tokens;
  if (o.orchestration_input_tokens !== undefined) inDetails.orchestration_input_tokens = o.orchestration_input_tokens;
  if (o.orchestration_input_cached_tokens !== undefined) inDetails.orchestration_input_cached_tokens = o.orchestration_input_cached_tokens;
  const outDetails: Record<string, number> = {};
  if (o.reasoning_tokens !== undefined) outDetails.reasoning_tokens = o.reasoning_tokens;
  if (o.orchestration_output_tokens !== undefined) outDetails.orchestration_output_tokens = o.orchestration_output_tokens;
  const usage = {
    ...(o.input_tokens !== undefined ? { input_tokens: o.input_tokens } : {}),
    ...(o.output_tokens !== undefined ? { output_tokens: o.output_tokens } : {}),
    ...(o.total_tokens !== undefined ? { total_tokens: o.total_tokens } : {}),
    ...(Object.keys(inDetails).length ? { input_tokens_details: inDetails } : {}),
    ...(Object.keys(outDetails).length ? { output_tokens_details: outDetails } : {}),
  };
  const response = { id: "resp_up", model: "gpt-6-astra", output: [], status: "completed", ...(fx.silent ? {} : { usage }) };
  return eventStream(
    sse({ type: "response.created", response }) +
    sse({ type: "response.output_text.delta", delta: "hi" }) +
    sse({ type: "response.completed", response }),
  );
}

/**
 * The Google wire shape. Two details are load-bearing and were measured rather than assumed
 * (see the `google` provider's own notes): the Cloud Code endpoint WRAPS the Gemini payload
 * as `{ response: GenerateContentResponse }`, and the turn terminates on a candidate
 * `finishReason` rather than on any envelope field. The API-key route sends the payload
 * unwrapped, and the provider's delta() reads `ev.response ?? ev`, so one body serves both.
 */
function googleReply(): Response {
  const um = fx.google ?? {};
  const response = {
    modelVersion: "gemini-3.8-flash",
    candidates: [{ content: { parts: [{ text: "hi" }], role: "model" }, finishReason: "STOP", index: 0 }],
    ...(fx.silent ? {} : { usageMetadata: um }),
  };
  return eventStream(sse({ response }));
}

const fixture = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/__fixture") { fx = (await req.json()) as Fixture; return new Response("ok"); }
    // Ollama's LIVENESS and CATALOG reads. Answered BEFORE the `reject` gate on purpose: a
    // refusal fixture describes the chat call, and this provider treats a silent
    // /api/version as "there is no daemon here" — which fails the request at the credential
    // step, 401, without ever reaching the code under test. It also has no static catalog,
    // so its model list IS whatever the daemon reports.
    if (pathname === "/api/version") return Response.json({ version: "0.0.0-usage-fields" });
    if (pathname === "/api/tags") {
      return Response.json({ models: [{ name: "usage-fields:latest", size: 4.2e9, modified_at: new Date().toISOString(), details: { parameter_size: "8B" } }] });
    }
    if (pathname === "/api/show") return Response.json({ capabilities: ["tools"], model_info: { "llama.context_length": 8192 } });
    // Drain the body so the upstream behaves like a real one that read the request.
    try { await req.json(); } catch {}
    // A refusal is answered on ANY vendor path: explain() is per-provider, so each
    // provider's fix-it line has to be reachable through its own route.
    if (fx.reject) return new Response(fx.reject.body, { status: fx.reject.status, headers: { "content-type": "application/json" } });
    if (pathname.startsWith("/v1/messages")) return anthropicReply();
    if (pathname === "/responses") return responsesReply();
    if (pathname.includes("streamGenerateContent")) return googleReply();
    return new Response("no such upstream path", { status: 404 });
  },
});

console.log(`READY ${fixture.port}`);
// Stay alive; the parent kills us. Nothing ever resolves this — it is a park, not a wait.
await Promise.withResolvers<never>().promise;
