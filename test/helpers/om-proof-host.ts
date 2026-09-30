/**
 * A fresh-process host for the OM LIVE PROOF test — the one test in this repo where the
 * client is not written here.
 *
 * WHY A SUBPROCESS. Identical reasoning to test/helpers/usage-dialect-probe.ts: the
 * provider base URLs, the credential wells and STATE_DIR are read from the environment —
 * some at module import, some on every call — and `bun test` runs every test file in ONE
 * process. Declaring this world inside a test file would leak the fixture URLs into
 * contract.test.ts and astra.test.ts, which legitimately assert the REAL upstream URLs.
 * A host declares its world when it starts, so the world gets its own process.
 *
 * WHAT IS DIFFERENT FROM THE USAGE-DIALECT PROBE. That probe only needed to make an
 * upstream *answer*. This one has to prove what APIPlan SENDS, so the stub upstream
 * RECORDS every request body it is handed and hands the list back on `GET /__captured`.
 * Three of the proofs in om-live-proof.test.ts are assertions about the outgoing body
 * rather than the reply — the prompt-cache identity surviving the crossing, the billing
 * attestation being stripped before it can churn the cached prefix, and the caller's
 * cache_control breakpoints not being dropped — and none of them are observable from a
 * reply. Recording is therefore the point of this file, not a convenience.
 *
 * This process stands up two things on loopback and nothing else:
 *   · a FIXTURE server impersonating BOTH upstreams — `/v1/messages` answers in
 *     Anthropic's wire shape, `/responses` in the Responses shape — plus a small control
 *     surface: `POST /__fixture` (what the next call reports), `GET /__captured` (every
 *     request seen, in order), `POST /__reset` (forget them).
 *   · the real api.serve(), pointed at that fixture by APIPLAN_*_BASE.
 * It prints `READY <apiPort> <fixturePort>` and serves until the parent kills it.
 *
 * No credential of the operator's is read (the wells are stub files the parent passes in),
 * no vendor is ever dialled, and nothing outside the scratch dir is written.
 */

/** What the next upstream call should report, in each vendor's OWN field names. */
type AnthropicCounters = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Anthropic's cache-write TTL breakdown. Present-and-zero is a DIFFERENT input from
   *  absent, and the difference is destructive — see `anthropicStart` below. */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};
type OpenAICounters = {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
};
type Fixture = {
  anthropic?: AnthropicCounters;
  openai?: OpenAICounters;
  /** Anthropic's terminal stop word, so a test can drive a non-`end_turn` turn. */
  stopReason?: string;
  /** The assistant text both shapes emit. Kept short: no test here reads it for length. */
  text?: string;
  /** See the note below: usage for `message_start` when it must differ from the delta. */
  anthropicStart?: AnthropicCounters;
};
/**
 * A DIFFERENT usage object for `message_start`, when a test needs the two frames to
 * disagree. Anthropic reports usage twice per turn — an opening frame and a `message_delta`
 * correction — and pi-ai folds them in order, so some faults are only observable across
 * the pair. The one this exists for: a `message_start` carrying a genuine TTL split
 * followed by a `message_delta` carrying all zeroes makes pi-ai's
 * `applyAnthropicUsageExtras` DELETE the split it already recorded. On a single-frame
 * fixture that deletion is invisible, because "suppressed" and "forwarded then deleted"
 * both end at `cttl === undefined`. Defaults to the same counters, so every existing test
 * is unaffected.
 */
let fx: Fixture = {};

/** Every request this fixture was handed, in order, exactly as it arrived. */
type Captured = { path: string; body: unknown; raw: string; headers: Record<string, string> };
const captured: Captured[] = [];

/** The SSE frame shape both vendors use. Nine call sites below must agree on it byte for
 *  byte — the `event:` line is optional on the Responses shape and mandatory on
 *  Anthropic's, and that difference is the reason this is one function rather than nine
 *  template literals. */
const sse = (o: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(o)}\n\n`;

/** Anthropic's wire shape: message_start, one text block, message_delta, message_stop. */
function anthropicReply(): Response {
  const u = fx.anthropic ?? {};
  // The opening frame defaults to the same counters, so every test that does not ask for a
  // disagreement is byte-for-byte unaffected.
  const start = fx.anthropicStart ?? u;
  const text = fx.text ?? "hi";
  return new Response(
    sse({ type: "message_start", message: { id: "msg_up", type: "message", role: "assistant", model: "claude-opus-5", content: [], usage: start } }, "message_start") +
    sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start") +
    sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, "content_block_delta") +
    sse({ type: "content_block_stop", index: 0 }, "content_block_stop") +
    sse({ type: "message_delta", delta: { stop_reason: fx.stopReason ?? "end_turn", stop_sequence: null }, usage: u }, "message_delta") +
    sse({ type: "message_stop" }, "message_stop"),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** The Responses wire shape: created, a text delta, then response.completed carrying usage. */
function responsesReply(): Response {
  const o = fx.openai ?? {};
  const text = fx.text ?? "hi";
  const details: Record<string, number> = {};
  if (o.cached_tokens !== undefined) details.cached_tokens = o.cached_tokens;
  if (o.cache_write_tokens !== undefined) details.cache_write_tokens = o.cache_write_tokens;
  const usage = {
    ...(o.input_tokens !== undefined ? { input_tokens: o.input_tokens } : {}),
    ...(o.output_tokens !== undefined ? { output_tokens: o.output_tokens } : {}),
    ...(Object.keys(details).length ? { input_tokens_details: details } : {}),
  };
  const response = { id: "resp_up", model: "gpt-6-astra", output: [], status: "completed", usage };
  return new Response(
    sse({ type: "response.created", response }) +
    sse({ type: "response.output_text.delta", delta: text }) +
    sse({ type: "response.completed", response }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const fixture = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/__fixture") {
      // Loopback control surface, spoken only by the parent test in this same repo, so the
      // shape is owned rather than external. Recorded as an unchecked cast deliberately:
      // validating it would test the test harness instead of APIPlan.
      const next = (await req.json()) as unknown as Fixture;
      fx = next;
      return new Response("ok");
    }
    if (pathname === "/__captured") return new Response(JSON.stringify(captured), { headers: { "content-type": "application/json" } });
    if (pathname === "/__reset") { captured.length = 0; return new Response("ok"); }
    // Read the body BEFORE answering, both because a real upstream does and because the
    // recording is the whole reason this fixture exists. A body that will not parse is
    // still recorded — `raw` is what a byte-level assertion needs, and a malformed
    // payload is itself a finding rather than something to swallow silently.
    const raw = await req.text();
    let body: unknown;
    try { body = JSON.parse(raw); } catch { body = undefined; }
    captured.push({ path: pathname, body, raw, headers: Object.fromEntries(req.headers) });
    if (pathname.startsWith("/v1/messages")) return anthropicReply();
    if (pathname === "/responses") return responsesReply();
    return new Response("no such upstream path", { status: 404 });
  },
});

// Set BEFORE api.ts is imported: STATE_DIR and the credential wells are read at import
// time, the base URLs on every call. In this process only — that is the whole point.
const base = `http://127.0.0.1:${fixture.port}`;
process.env.APIPLAN_ANTHROPIC_BASE = base;
process.env.APIPLAN_OPENAI_BASE = base;
process.env.APIPLAN_RESPONSES_PATH = "/responses";
process.env.APIPLAN_API_KEY = "";
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete process.env[k];

// Dynamic import, deliberately: api.ts reads STATE_DIR and the credential wells at MODULE
// IMPORT time, so a static import would hoist above the process.env writes and bind the
// operator's real world instead of this scratch one. Same reason as usage-dialect-probe.ts.
const { serve } = await import("../../src/api.ts");
// token: "" — never inherit the operator's APIPLAN_API_KEY, or the host 401s on itself.
const api = serve({ port: 0, host: "127.0.0.1", token: "" });

// `api.port` is the port the server actually got; `port: 0` above means "any free one",
// so the requested number would be a lie.
const apiPort = api.port;

console.log(`READY ${apiPort} ${fixture.port}`);
// Stay alive; the parent kills us. Nothing ever resolves this — it is a park, not a wait.
await Promise.withResolvers<never>().promise;
