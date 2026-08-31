/**
 * GATE 1 — NO SYNCHRONOUS NETWORK MINT ON ANY RESIDENT PATH.
 *
 * THE SHAPE THAT KEEPS COMING BACK. Three waves running, a blocking call reached a request
 * path. Wave 7 put a `Bun.spawnSync(["curl", …])` OAuth mint inside google.creds(); wave 8
 * took it off serve() with an async single-flight — and left it on the OTHER resident host.
 * `apiplan` has TWO long-lived servers, not one:
 *
 *   src/api.ts   serve()      the HTTP API on 8787 (claudish, /health, every watchdog)
 *   src/engine.ts runDaemon() the WARM DAEMON behind the CLI shims — same single thread,
 *                             same event loop, same duty to everyone already queued on it
 *
 * A one-shot CLI may mint in line: nothing else is waiting on that process, so blocking is
 * the correct behaviour. A RESIDENT host may not, ever. This file gates the property on
 * both hosts and adds a structural sweep so a THIRD resident host cannot be added without
 * declaring the same posture.
 *
 * HOW THE PROPERTY IS OBSERVED (behavioural, not structural): a deliberately SLOW local
 * OAuth stub, a credential inside its refresh window, one /call fired at the daemon to make
 * it take the mint path, and — while that is still in flight — an unrelated /health on the
 * same daemon. A synchronous mint cannot answer it; an asynchronous one cannot fail to.
 *
 * NOTHING REACHES A VENDOR. The daemon subprocess runs with HTTPS_PROXY/HTTP_PROXY pointed
 * at a dead port and NO_PROXY=127.0.0.1 (verified: bun's fetch and curl both honour these),
 * so the ONLY reachable network is this file's own stubs. Their hit counters are read
 * before and after every matrix and asserted, so a silent fall-through would fail the test
 * rather than pass it quietly. The credentials are stub files; no keychain is touched.
 */
import { expect, test, describe, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const HELPER = join(HERE, "helpers", "apiplan-probe.ts");
const DIR = mkdtempSync(join(tmpdir(), "ap-n2-res-"));
const HOME = join(DIR, "home"); mkdirSync(HOME, { recursive: true });
const SOCK = join(DIR, "d.sock");
const CRED = join(DIR, "g.json");
const ABSENT = join(DIR, "no-such-credential.json");

/** The OAuth endpoint that answers SLOWLY — the whole point of the test. */
const SLOW_MS = 2500;
let oauthHits = 0;
const oauth = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() {
  oauthHits++; await Bun.sleep(SLOW_MS);
  return Response.json({ access_token: "AT-minted", expires_in: 3600, token_type: "Bearer" });
} });

/** The vendor API, stubbed. Answers instantly: the mint is the only slow thing here. */
let apiHits = 0;
const vendor = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
  apiHits++;
  return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n',
    { headers: { "content-type": "text/event-stream" } });
} });

// A token INSIDE the 5-minute refresh window, so creds() takes the refresh path — and
// still VALID, so a correct host serves it now and mints behind the request.
writeFileSync(CRED, JSON.stringify({
  auth_method: "consumer",
  token: { access_token: "AT-stale", refresh_token: "RT-stub", token_type: "Bearer",
           expiry: new Date(Date.now() + 60_000).toISOString() },
}));

/** Env for every probe subprocess: our stubs, no keychain, no egress. */
const ENV = () => ({
  ...process.env,
  APIPLAN_HOME: HOME, APIPLAN_SOCK: SOCK, APIPLAN_API_KEY: "",
  APIPLAN_GOOGLE_CRED_FILE: CRED,
  APIPLAN_GOOGLE_TOKEN_URL: `http://127.0.0.1:${oauth.port}/token`,
  APIPLAN_GOOGLE_BASE: `http://127.0.0.1:${vendor.port}`,
  APIPLAN_GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  APIPLAN_GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-test-secret",
  APIPLAN_GOOGLE_REFRESH_TIMEOUT_S: "8",
  // The other two providers are made DISCONNECTED on purpose: the daemon's warm() pre-opens
  // TLS to their real hosts for any connected provider, and this test reaches no vendor.
  APIPLAN_ANTHROPIC_CRED_FILE: ABSENT, APIPLAN_CODEX_AUTH: ABSENT,
  APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
  APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
  APIPLAN_KEEPALIVE_MS: "0", APIPLAN_TALK_PARK: "0",
  // Self-reaping: if this file ever dies before afterAll runs, the daemon still goes away.
  APIPLAN_DAEMON_IDLE_MS: "60000",
  // Egress seal. Verified on this machine: bun fetch and curl both honour these.
  HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
});

const unix = (path: string, init: RequestInit = {}) =>
  fetch(`http://apiplan${path}`, { ...init, unix: SOCK } as any);

let daemon: any = null;
beforeAll(async () => {
  daemon = Bun.spawn(["bun", "run", HELPER, "daemon"], { cwd: ROOT, env: ENV(), stdout: "pipe", stderr: "pipe" });
  // Wait for the listener rather than for a line of text: the socket answering /health is
  // the only proof that matters, and it is what every client uses.
  for (let i = 0; i < 100; i++) {
    try { const r = await unix("/health"); if (r.ok) break; } catch {}
    await Bun.sleep(100);
  }
});

afterAll(() => {
  try { daemon?.kill(); } catch {}
  oauth.stop(true); vendor.stop(true);
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("resident hosts never mint synchronously", () => {
  test("the WARM DAEMON answers an unrelated request while a token mint is in flight", async () => {
    const r0 = await unix("/health");
    expect(r0.ok).toBe(true);                        // premise: the daemon is up
    const oauthBefore = oauthHits, apiBefore = apiHits;

    const { models } = await import("../src/registry.ts");
    const m = models("google")[0];
    expect(m).toBeTruthy();                          // premise: there is a google model to call

    // Fired and NOT awaited: this is the request that makes the daemon touch creds().
    const call = unix("/call", {
      method: "POST",
      headers: { "content-type": "application/json", "x-apiplan-version": (await import("../src/engine.ts")).VERSION },
      body: JSON.stringify({ model: m, turns: [{ role: "user", text: "ping" }], opts: {} }),
    }).catch(() => null);

    await Bun.sleep(120);                            // let the call reach the mint
    const t0 = performance.now();
    const health = await unix("/health");
    const ms = performance.now() - t0;
    const body = await health.text();

    expect(health.ok).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // THE GATE: an unrelated request must not have queued behind a vendor token mint.
    expect(ms).toBeLessThan(800);

    await call;
    // The mint went to the STUB, and so did the model call — never to a vendor.
    for (let i = 0; i < 60 && oauthHits === oauthBefore; i++) await Bun.sleep(100);
    expect(oauthHits).toBeGreaterThan(oauthBefore);
    expect(apiHits).toBeGreaterThan(apiBefore);
  }, 60_000);

  test("the warm daemon DECLARES the resident posture", async () => {
    const r = Bun.spawnSync(["bun", "run", HELPER, "posture", "daemon"], {
      cwd: ROOT, env: { ...ENV(), APIPLAN_SOCK: join(DIR, "d2.sock") }, stderr: "pipe",
    });
    const line = r.stdout.toString().trim().split("\n").filter(Boolean).at(-1) ?? "";
    expect(line).toBeTruthy();
    // A CLI may mint in line; a resident host may not. `syncRefresh` is how a host says
    // which one it is, and the daemon is the second kind.
    expect(JSON.parse(line).syncRefresh).toBe(false);
  }, 60_000);

  test("the HTTP API declares the resident posture", async () => {
    const r = Bun.spawnSync(["bun", "run", HELPER, "posture", "serve"], { cwd: ROOT, env: ENV(), stderr: "pipe" });
    const line = r.stdout.toString().trim().split("\n").filter(Boolean).at(-1) ?? "";
    expect(line).toBeTruthy();
    expect(JSON.parse(line).syncRefresh).toBe(false);
  }, 60_000);

  test("EVERY resident host in src/ declares it — a new server cannot be added without one", () => {
    // Structural, and deliberately so: the two tests above prove the property on the hosts
    // that exist TODAY. This one is about the host somebody adds next — it matches the ACT
    // (a Bun.serve call, an assignment of the posture), never a token, and it reads code
    // with comments stripped so neither this rule nor its own docs can satisfy it.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const offenders: string[] = [];
    for (const f of readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts"))) {
      const code = strip(readFileSync(join(ROOT, "src", f), "utf8"));
      if (!/\bBun\.serve\s*\(/.test(code)) continue;
      if (!/providerRuntime\s*\.\s*syncRefresh\s*=\s*false/.test(code)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
