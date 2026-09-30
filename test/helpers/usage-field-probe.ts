/**
 * A fresh-process host for the USAGE-FIELD COMPLETENESS tests: the real `api.serve()`,
 * pointed at the stub upstream that runs beside it (test/helpers/usage-field-upstream.ts).
 *
 * WHY A SUBPROCESS AT ALL. Provider base URLs, credential wells and STATE_DIR come from the
 * environment — some read at module import, some on every call — and `bun test` runs every
 * file in ONE process, so setting them from inside a test file leaks into the others.
 * Pointing a base URL at a fixture is exactly what made contract.test.ts and astra.test.ts
 * fail before: they legitimately assert the REAL upstream URLs. Same reasoning as
 * test/helpers/usage-dialect-probe.ts and test/helpers/grok-stub.ts — a host declares its
 * world when it starts, so the world gets its own process.
 *
 * WHY THE UPSTREAM IS A THIRD PROCESS rather than a Bun.serve() in this one: the ollama
 * provider establishes daemon liveness with a BLOCKING `Bun.spawnSync(["curl", …])`, which
 * stops this thread until curl exits — so a fixture served from here could never answer it,
 * and the request would fail 401 at the credential step instead of reaching the code under
 * test. The upstream file's header documents the measurement. Every other vendor would have
 * been fine either way; one upstream for all of them beats two mechanisms.
 *
 * This process therefore does exactly three things: spawn the upstream, point every
 * provider at it, and serve. It prints `READY <apiPort> <fixturePort>` and serves until the
 * parent kills it.
 *
 * Zero spend, zero contact with the operator's world: the parent passes stub credential
 * files it wrote itself, no vendor is ever dialled, and nothing outside the parent's
 * scratch dir is written.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const up = Bun.spawn(["bun", join(HERE, "usage-field-upstream.ts")], { stdout: "pipe", stderr: "inherit" });
// THE UPSTREAM MUST NOT OUTLIVE US. The parent kills this process, not its children, so
// without these handlers the upstream survives as an orphan holding a loopback port — and
// a `bun test` run that leaves a stray server behind on every invocation is a leak the next
// run inherits. Verified: killing only the probe left one live `usage-field-upstream`.
// SIGTERM is what a `.kill()` sends; `exit` covers a throw on the path below, which would
// otherwise strand the child before READY is even printed.
const reap = () => { try { up.kill(); } catch {} };
process.on("SIGTERM", () => { reap(); process.exit(0); });
process.on("SIGINT", () => { reap(); process.exit(0); });
process.on("exit", reap);
// The READY line is the only synchronisation point: a port that is merely allocated is not
// a server that answers, and polling a guessed port would race the boot.
const reader = up.stdout.getReader();
const dec = new TextDecoder();
let buf = "";
const deadline = Date.now() + 30_000;
while (!buf.includes("\n") && Date.now() < deadline) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
}
const ready = /READY (\d+)/.exec(buf);
if (!ready) throw new Error(`upstream never became ready: ${buf}`);
const base = `http://127.0.0.1:${ready[1]}`;

// Set BEFORE api.ts is imported: STATE_DIR and the credential wells are read at import time,
// the base URLs on every call. In this process only — that is the whole point of the process.
process.env.APIPLAN_ANTHROPIC_BASE = base;
process.env.APIPLAN_OPENAI_BASE = base;
process.env.APIPLAN_RESPONSES_PATH = "/responses";
process.env.APIPLAN_GOOGLE_BASE = base;
// The three providers exercised only for their explain() lines. Ollama's daemon URL, the
// grok proxy's base (its Responses path is left at the default, which the upstream serves),
// and the Gemini API-key endpoint — each pointed at loopback so no real host is dialled even
// by a probe() that runs during model resolution.
process.env.APIPLAN_OLLAMA_BASE = base;
process.env.APIPLAN_GROK_BASE = base;
process.env.APIPLAN_GEMINI_API_BASE = base;
process.env.APIPLAN_API_KEY = "";
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete process.env[k];

// DYNAMIC ON PURPOSE — a static import cannot work here, and this is the line the whole
// subprocess exists for. `src/api.ts` reads STATE_DIR and the credential wells at MODULE
// EVALUATION time, and ESM hoists every static import above all statements, so a static form
// would evaluate api.ts BEFORE the assignments above and the server would come up pointed at
// the real vendors with the operator's real wells. Importing after the environment is
// declared is what makes this host's world its own.
const { serve } = await import("../../src/api.ts");
// token: "" — never inherit the operator's APIPLAN_API_KEY, or the probe 401s on itself.
const api = serve({ port: 0, host: "127.0.0.1", token: "" });
const apiPort = (api as { port?: number }).port ?? new URL(api.url).port;

// Ollama has NO static catalog — its model list is whatever the daemon reports — so the one
// model this world offers must be discovered before READY, or a test naming it gets a 404
// from `pick()` instead of reaching the provider whose explain() is under test. Reads
// /api/tags + /api/show off the upstream. Same reason for the dynamic import as the
// server's: the base URL must already be set.
const { refreshOllama } = await import("../../src/providers-ollama.ts");
await refreshOllama();

/**
 * ── OBSERVING THE `recover()` HOOK, which no provider can be asked to demonstrate ──
 *
 * `recover()` is a SIDE EFFECT on a provider's own private state — an evicted cache name
 * being forgotten — so a real implementation's success is invisible from the front: the
 * reply is the same honest refusal either way, and the repair only shows as a LATER request
 * working. That makes the ENGINE's half of the contract (is it called at all, with the raw
 * body, with the right status, and is the error path undisturbed when it throws) untestable
 * through any real provider without reaching into that provider's internals, which would
 * test the adapter rather than the wiring.
 *
 * So this host installs a RECORDER on one provider and publishes what it saw. Not a mock of
 * the code under test: the engine, the request path, the error handling and the real
 * provider object are all untouched — one optional method is added to an object that
 * declares none, which is precisely what a provider author writes. `?record=throw` makes it
 * throw, so the "a throwing recover() changes nothing" clause is a fact rather than a hope.
 */
const { PROVIDERS } = await import("../../src/providers.ts");
type Seen = { status: number; body: string; model: string };
let seen: Seen[] = [];
let recoverThrows = false;
PROVIDERS.anthropic.recover = (status, body, m) => {
  seen.push({ status, body, model: m.id });
  if (recoverThrows) throw new Error("a provider's recover() threw — the engine must not care");
};
const recorder = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch: (req) => {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === "/reset") { seen = []; recoverThrows = searchParams.get("mode") === "throw"; return new Response("ok"); }
    return Response.json(seen);
  },
});

console.log(`READY ${apiPort} ${ready[1]} ${recorder.port}`);
// Stay alive; the parent kills us. Nothing ever resolves this — it is a park, not a wait.
await Promise.withResolvers<never>().promise;
