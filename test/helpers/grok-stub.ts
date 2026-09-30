/**
 * A fresh-process host for the GROK provider tests.
 *
 * WHY A SUBPROCESS. The grok credential well and the endpoint base come from the
 * environment, and `bun test` runs every test file in ONE process: setting them from inside
 * a test file leaks into the others, and pointing a base URL at a fixture is exactly what
 * made contract.test.ts and astra.test.ts fail before — they legitimately assert the REAL
 * upstream URLs. The same reasoning as test/helpers/usage-dialect-probe.ts and
 * test/helpers/apiplan-probe.ts: a host declares its world when it starts, so the world
 * gets its own process.
 *
 * This process stands up two things on loopback and nothing else:
 *   · a FIXTURE server impersonating the grok subscription proxy — `POST /responses`
 *     answers in the genuine Responses SSE shape, and `POST /__fixture` lets the parent say
 *     what the next call should report (counters, or a rejection status + body). It also
 *     RECORDS the last request's headers and body, so a test can assert the OUTGOING wire
 *     shape rather than trusting build() in isolation.
 *   · the real api.serve(), pointed at that fixture by APIPLAN_GROK_BASE.
 * It prints `READY <apiPort> <fixturePort>` and serves until the parent kills it.
 *
 * NO CREDENTIAL OF THE OPERATOR'S IS READ: the parent passes APIPLAN_GROK_AUTH and
 * APIPLAN_GROK_MODELS pointing at stub files it wrote itself. xAI is never dialled and
 * nothing outside the parent's scratch dir is written.
 */

/** What the next upstream call should report, in xAI's OWN field names. */
type GrokCounters = {
  input_tokens?: number;
  output_tokens?: number;
  /** `usage.input_tokens_details.cached_tokens` — the field xAI documents for Responses. */
  cached_tokens?: number;
  cache_write_tokens?: number;
};
type Fixture = {
  grok?: GrokCounters;
  /** Omit the usage object entirely, the way a backend reporting nothing does. */
  silent?: boolean;
  /** Refuse the call instead of answering it: the 401/403/429 paths. */
  reject?: { status: number; body: string };
};
let fx: Fixture = {};

/** The last request this fixture saw, so a test can assert what actually went on the wire. */
type Seen = { path: string; headers: Record<string, string>; body: unknown };
let seen: Seen | null = null;

const sse = (o: unknown, event: string) => `event: ${event}\ndata: ${JSON.stringify(o)}\n\n`;

/**
 * The grok proxy's real Responses stream, as observed live on 2026-09-06: named SSE events
 * (`event:` line present), a reasoning item, a text item, and `response.completed` carrying
 * the usage object. The usage field names are xAI's documented ones.
 */
function grokReply(): Response {
  const g = fx.grok ?? {};
  const details: Record<string, number> = {};
  if (g.cached_tokens !== undefined) details.cached_tokens = g.cached_tokens;
  if (g.cache_write_tokens !== undefined) details.cache_write_tokens = g.cache_write_tokens;
  const usage = {
    ...(g.input_tokens !== undefined ? { input_tokens: g.input_tokens } : {}),
    ...(g.output_tokens !== undefined ? { output_tokens: g.output_tokens } : {}),
    ...(Object.keys(details).length ? { input_tokens_details: details } : {}),
    // The real endpoint carries these too; harmless extras a reader must tolerate.
    total_tokens: (g.input_tokens ?? 0) + (g.output_tokens ?? 0),
    cost_in_usd_ticks: 1,
  };
  const response = {
    id: "f09f69bb-0194-9e2b-9095-b585a9094d2b",
    object: "response",
    model: "grok-4.6",
    status: "completed",
    output: [],
    incomplete_details: null,
    ...(fx.silent ? {} : { usage }),
  };
  return new Response(
    sse({ sequence_number: 0, type: "response.created", response: { ...response, status: "in_progress", usage: null } }, "response.created") +
    sse({ sequence_number: 1, type: "response.output_text.delta", delta: "ok", item_id: "msg_1", output_index: 1 }, "response.output_text.delta") +
    sse({ sequence_number: 2, type: "response.completed", response }, "response.completed"),
    { headers: { "content-type": "text/event-stream" } },
  );
}

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
    if (pathname === "/responses") return grokReply();
    return new Response("no such upstream path", { status: 404 });
  },
});

// Set BEFORE api.ts is imported: STATE_DIR and the credential wells are read at import
// time, the base URLs on every call. In this process only — that is the whole point.
process.env.APIPLAN_GROK_BASE = `http://127.0.0.1:${fixture.port}`;
process.env.APIPLAN_GROK_RESPONSES_PATH = "/responses";
process.env.APIPLAN_API_KEY = "";
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
