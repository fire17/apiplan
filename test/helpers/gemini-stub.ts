/**
 * A fresh-process host that impersonates Google's Generative Language API, with the real
 * api.serve() in front of it.
 *
 * WHY A SUBPROCESS. The provider base URLs, the credential wells and STATE_DIR are all read
 * from the environment — some at module import, some on every call — and `bun test` runs
 * every test file in ONE process. Setting those variables from inside a test file therefore
 * leaks into the other files: pointing a base URL at a local fixture made contract.test.ts
 * and astra.test.ts fail, because they legitimately assert the REAL upstream URLs. Same
 * reasoning as test/helpers/usage-dialect-probe.ts — a host declares its world when it
 * starts, so the world gets its own process.
 *
 * WHAT IT STANDS UP:
 *   · a FIXTURE server impersonating the vendor: `…/models/{model}:streamGenerateContent`
 *     answers SSE in the Gemini proto, `POST …/cachedContents` mints a CachedContent, and
 *     `POST /__fixture` lets the parent say what the next call should report and how the
 *     next cache operation should behave;
 *   · the real api.serve(), pointed at that fixture, so a request is exercised through BOTH
 *     caller dialects (`/v1/messages` and `/v1/chat/completions`) and the whole usage
 *     normalisation path — not just the adapter in isolation.
 *   · `GET /__calls` reports what the fixture actually received, so a test can assert on the
 *     BODIES that went upstream (did a `cachedContent` reference go out? was the system
 *     instruction omitted beside it?) rather than only on what came back.
 *
 * The API key is a STUB the parent passes in via APIPLAN_GEMINI_API_KEY. No credential of
 * the operator's is read, no vendor is ever dialled, and nothing outside the scratch dir is
 * written.
 *
 * It prints `READY <apiPort> <fixturePort>` and serves until the parent kills it.
 */

/** What the next generateContent call should report in usageMetadata. */
type UsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};
type Fixture = {
  usage?: UsageMetadata;
  /** Omit usageMetadata entirely, the way a response reporting nothing does. */
  silent?: boolean;
  /** Text the model "says". */
  text?: string;
  /**
   * How the NEXT cachedContents create should answer. `tokens` becomes the create
   * response's usageMetadata.totalTokenCount — the only place this vendor states a cache
   * WRITE cost.
   */
  create?: { status?: number; tokens?: number; body?: unknown };
  /**
   * Make the next N requests that CARRY a `cachedContent` reference fail the way a dead
   * entry does — 403 PERMISSION_DENIED "CachedContent not found (or permission denied)",
   * which is what this vendor actually answers for an expired name (measured; it is NOT a
   * 404). Decremented per rejection, so `1` exercises recreate-once.
   */
  rejectCachedContent?: number;
};
let fx: Fixture = {};

/** Every request the fixture served, for assertions about what went UPSTREAM. */
type Seen = { path: string; model?: string; cachedContent?: string; hasSystem: boolean; hasTools: boolean; thinking?: unknown };
const calls: Seen[] = [];
/** Names minted by this fixture, so a reference to an unknown one can be told apart. */
let minted = 0;

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const eventStream = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

/** The vendor's error envelope, in the shape its adapter parses. */
const apiError = (status: number, message: string, statusName: string) =>
  json({ error: { code: status, message, status: statusName } }, status);

/**
 * The Gemini SSE shape: one frame carrying the text, then a terminal frame carrying the
 * finishReason and usageMetadata. Two frames rather than one because that is what the live
 * endpoint does, and because it proves the reader accumulates rather than reading only the
 * last frame.
 */
function streamReply(model: string): Response {
  const um = fx.usage ?? {};
  const text = fx.text ?? "ok";
  return eventStream(
    sse({ candidates: [{ content: { role: "model", parts: [{ text }] }, index: 0 }], modelVersion: model }) +
    sse({
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
      modelVersion: model,
      ...(fx.silent ? {} : { usageMetadata: { ...um, ...(um.totalTokenCount === undefined
        ? { totalTokenCount: (um.promptTokenCount ?? 0) + (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0) }
        : {}) } }),
    }),
  );
}

const fixture = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/__fixture") { fx = (await req.json()) as Fixture; return new Response("ok"); }
    if (pathname === "/__calls") return json(calls);
    if (pathname === "/__reset") { calls.length = 0; return new Response("ok"); }

    // The key must reach the vendor as x-goog-api-key, never as a bearer or a query param.
    if (!req.headers.get("x-goog-api-key")) return apiError(401, "API key not valid. Please pass a valid API key.", "UNAUTHENTICATED");

    let body: Record<string, unknown> = {};
    try { body = (await req.json()) as Record<string, unknown>; } catch {}

    // POST /v1beta/cachedContents — mint a named entry.
    if (pathname.endsWith("/cachedContents")) {
      const want = fx.create ?? {};
      if (want.status && want.status >= 400) return apiError(want.status, want.body ? String(want.body) : "cache refused", "PERMISSION_DENIED");
      minted += 1;
      const name = `cachedContents/stub${minted}`;
      calls.push({ path: pathname, model: typeof body.model === "string" ? body.model : undefined,
        hasSystem: body.systemInstruction !== undefined, hasTools: body.tools !== undefined });
      return json({
        name, model: body.model, createTime: new Date().toISOString(), updateTime: new Date().toISOString(),
        expireTime: new Date(Date.now() + 300_000).toISOString(),
        usageMetadata: { totalTokenCount: want.tokens ?? 8000 },
      });
    }

    // POST /v1beta/models/{model}:streamGenerateContent
    const m = pathname.match(/\/models\/([^:]+):streamGenerateContent$/);
    if (m) {
      const cachedContent = typeof body.cachedContent === "string" ? body.cachedContent : undefined;
      const generationConfig = body.generationConfig as Record<string, unknown> | undefined;
      calls.push({
        path: pathname, model: m[1],
        ...(cachedContent ? { cachedContent } : {}),
        hasSystem: body.systemInstruction !== undefined,
        hasTools: body.tools !== undefined,
        ...(generationConfig?.thinkingConfig !== undefined ? { thinking: generationConfig.thinkingConfig } : {}),
      });
      if (cachedContent && fx.rejectCachedContent && fx.rejectCachedContent > 0) {
        fx.rejectCachedContent -= 1;
        return apiError(403, "CachedContent not found (or permission denied)", "PERMISSION_DENIED");
      }
      return streamReply(m[1]);
    }
    return apiError(404, `no such stub path: ${pathname}`, "NOT_FOUND");
  },
});

// Set BEFORE api.ts is imported: STATE_DIR and the credential wells are read at import
// time, the base URLs on every call. In this process only — that is the whole point of it.
process.env.APIPLAN_GEMINI_API_BASE = `http://127.0.0.1:${fixture.port}`;
// A STUB key. The provider reads it through geminiApiKey(), which prefers the env var over
// the key file, so the operator's real key at ~/.config/gemini/api_key is never touched.
process.env.APIPLAN_GEMINI_API_KEY = "stub-key-not-a-real-credential";
process.env.APIPLAN_API_KEY = "";
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete process.env[k];

const { serve } = await import("../../src/api.ts");
// token: "" — never inherit the operator's APIPLAN_API_KEY, or the probe 401s on itself.
const api = serve({ port: 0, host: "127.0.0.1", token: "" });
const apiPort = new URL(api.url).port;

console.log(`READY ${apiPort} ${fixture.port}`);
// Stay alive; the parent kills us. Nothing ever resolves this — it is a park, not a wait.
await Promise.withResolvers<never>().promise;
