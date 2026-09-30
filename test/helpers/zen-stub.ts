/**
 * A fresh-process host for the ZEN provider tests.
 *
 * WHY A SUBPROCESS. The zen credential well and the endpoint base come from the environment,
 * and `bun test` runs every test file in ONE process: setting them from inside a test file
 * leaks into the others, and pointing a base URL at a fixture is exactly what made
 * contract.test.ts and astra.test.ts fail before — they legitimately assert the REAL upstream
 * URLs. The same reasoning as test/helpers/grok-stub.ts: a host declares its world when it
 * starts, so the world gets its own process.
 *
 * This process stands up two things on loopback and nothing else:
 *   · a FIXTURE server impersonating the Zen gateway — `POST /responses` answers in the
 *     genuine Responses SSE shape, and `POST /__fixture` lets the parent say what the next
 *     call should report (counters, or a rejection status + body). It also RECORDS the last
 *     request's headers and body, so a test can assert the OUTGOING wire shape rather than
 *     trusting build() in isolation.
 *   · the real api.serve(), pointed at that fixture by APIPLAN_ZEN_BASE.
 * It prints `READY <apiPort> <fixturePort>` and serves until the parent kills it.
 *
 * NO CREDENTIAL OF THE OPERATOR'S IS READ: the parent passes APIPLAN_ZEN_AUTH and
 * APIPLAN_ZEN_MODELS pointing at stub files it wrote itself, and OPENCODE_API_KEY is blanked
 * so an exported key on the developer's machine can never be the one under test.
 * opencode.ai is never dialled and nothing outside the parent's scratch dir is written.
 */

/** What the next upstream call should report, in the Responses API's OWN field names. */
type ZenCounters = {
  input_tokens?: number;
  output_tokens?: number;
  /** `usage.input_tokens_details.cached_tokens` — the field this dialect documents. */
  cached_tokens?: number;
  cache_write_tokens?: number;
  /** `usage.output_tokens_details.reasoning_tokens` — a SUB-DIVISION of output_tokens. */
  reasoning_tokens?: number;
};
type Fixture = {
  zen?: ZenCounters;
  /** Omit the usage object entirely, the way a backend reporting nothing does. */
  silent?: boolean;
  /** Refuse the call instead of answering it: the 400/401/429 paths. */
  reject?: { status: number; body: string };
};
let fx: Fixture = {};

/** The last request this fixture saw, so a test can assert what actually went on the wire. */
type Seen = { path: string; headers: Record<string, string>; body: unknown };
let seen: Seen | null = null;

const sse = (o: unknown, event: string) => `event: ${event}\ndata: ${JSON.stringify(o)}\n\n`;

/**
 * The Responses stream this dialect speaks: named SSE events, a reasoning delta, a text delta,
 * and `response.completed` carrying the usage object. The usage field names are the ones
 * opencode's own Responses reader reads (`input_tokens`, `output_tokens`,
 * `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`).
 *
 * EXPORTED AS DATA (`zenEvents`) as well as served, because the delta-parity leg in
 * zen.test.ts must feed the SAME events through both adapters — a parity test written against
 * a second, hand-made event list would prove the two parsers agree about a shape neither
 * endpoint sends.
 */
export function zenEvents(fixture: Fixture = fx): Record<string, unknown>[] {
  const g = fixture.zen ?? {};
  const inDetails: Record<string, number> = {};
  if (g.cached_tokens !== undefined) inDetails.cached_tokens = g.cached_tokens;
  if (g.cache_write_tokens !== undefined) inDetails.cache_write_tokens = g.cache_write_tokens;
  const outDetails: Record<string, number> = {};
  if (g.reasoning_tokens !== undefined) outDetails.reasoning_tokens = g.reasoning_tokens;
  const usage = {
    ...(g.input_tokens !== undefined ? { input_tokens: g.input_tokens } : {}),
    ...(g.output_tokens !== undefined ? { output_tokens: g.output_tokens } : {}),
    ...(Object.keys(inDetails).length ? { input_tokens_details: inDetails } : {}),
    ...(Object.keys(outDetails).length ? { output_tokens_details: outDetails } : {}),
    // The real endpoint carries this too; a harmless extra a reader must tolerate.
    total_tokens: (g.input_tokens ?? 0) + (g.output_tokens ?? 0),
  };
  const response = {
    id: "resp_zen_fixture_0001",
    object: "response",
    model: "muse-spark-1.3",
    status: "completed",
    output: [],
    incomplete_details: null,
    ...(fixture.silent ? {} : { usage }),
  };
  return [
    { sequence_number: 0, type: "response.created", response: { ...response, status: "in_progress", usage: null } },
    { sequence_number: 1, type: "response.reasoning_summary_text.delta", delta: "thinking", item_id: "rs_1", output_index: 0 },
    { sequence_number: 2, type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file" } },
    { sequence_number: 3, type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path"' },
    { sequence_number: 4, type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"x"}' } },
    { sequence_number: 5, type: "response.output_text.delta", delta: "ok", item_id: "msg_1", output_index: 2 },
    { sequence_number: 6, type: "response.completed", response },
  ];
}

const EVENT_NAME = (e: Record<string, unknown>) => String(e.type ?? "message");

function zenReply(): Response {
  return new Response(
    zenEvents().map((e) => sse(e, EVENT_NAME(e))).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

// Importable as a module (for zenEvents) WITHOUT standing up a server: the parity leg imports
// this file into the test process, and a stray Bun.serve there would leak a port per run.
if (import.meta.main) {
  const fixture = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/__fixture") { fx = (await req.json()) as Fixture; seen = null; return new Response("ok"); }
      if (pathname === "/__seen") return Response.json(seen);
      // Record what arrived BEFORE answering, so a refusal case still yields the wire shape.
      let body: unknown = null;
      try { body = await req.json(); } catch {}
      seen = { path: pathname, headers: Object.fromEntries(req.headers), body };
      if (fx.reject) {
        return new Response(fx.reject.body, { status: fx.reject.status, headers: { "content-type": "application/json" } });
      }
      if (pathname === "/responses") return zenReply();
      return new Response("no such upstream path", { status: 404 });
    },
  });

  // Set BEFORE api.ts is imported: STATE_DIR and the credential wells are read at import time,
  // the base URLs on every call. In this process only — that is the whole point.
  process.env.APIPLAN_ZEN_BASE = `http://127.0.0.1:${fixture.port}`;
  process.env.APIPLAN_API_KEY = "";
  // Never let a key exported on the developer's machine be the one under test.
  process.env.OPENCODE_API_KEY = "";
  process.env.NO_PROXY = "127.0.0.1,localhost";
  process.env.no_proxy = "127.0.0.1,localhost";
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete process.env[k];

  // DYNAMIC IMPORT IS REQUIRED HERE, and a static one would break the fixture: api.ts reads
  // STATE_DIR and the credential wells at MODULE-EVALUATION time, so a static import would be
  // hoisted above the assignments just made and the server would come up pointed at the real
  // vendor with the operator's real credential. The specifier is a literal; the ORDER is the
  // runtime fact that makes this the exception the rule allows for.
  const { serve } = await import("../../src/api.ts");
  // token: "" — never inherit the operator's APIPLAN_API_KEY, or the probe 401s on itself.
  const api = serve({ port: 0, host: "127.0.0.1", token: "" });
  const apiPort = api.port ?? new URL(api.url).port;

  console.log(`READY ${apiPort} ${fixture.port}`);
  // Stay alive; the parent kills us. Nothing resolves this — it is a park, not a wait.
  await Promise.withResolvers<never>().promise;
}
