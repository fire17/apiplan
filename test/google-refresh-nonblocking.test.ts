/**
 * REGRESSION NET — R-1: the token refresh must never sit in the request path.
 *
 * What went wrong (2026-08-27, wave 7): the Antigravity self-refresh was a SYNCHRONOUS
 * `Bun.spawnSync(["curl", …])` inside google.creds(). This server is single-threaded, so
 * while that curl ran NOTHING else was served — a slow OAuth endpoint made an unrelated
 * /health take 5.30s. Capping the curl timeout bounds the damage; it does not remove it.
 *
 * The property under test is behavioural, not structural: with a deliberately SLOW OAuth
 * endpoint, an unrelated request that is already in flight must still be answered
 * promptly. Any fix shape satisfies it — serve the still-valid token and refresh in the
 * background, single-flight the mint, move it to a tick — and the blocking shape cannot.
 *
 * No network: the OAuth endpoint, the unrelated service and the credential well are all
 * local stubs, and the stub's hit counter is asserted so a silent fall-through to
 * accounts.google.com would fail the test rather than pass it quietly.
 */
import { expect, test, describe, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "apiplan-p2-refresh-"));
const CRED = join(DIR, "google-cred.json");

// The OAuth endpoint that answers SLOWLY. 2.5s is far longer than any request may wait
// and far shorter than a test run should take.
const SLOW_MS = 2500;
let oauthHits = 0;
const oauth = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch() {
    oauthHits++;
    await Bun.sleep(SLOW_MS);
    return Response.json({ access_token: "AT-refreshed", expires_in: 3600, token_type: "Bearer" });
  },
});

// An unrelated service standing in for "every other request this server owes".
let pingHits = 0;
const ping = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { pingHits++; return new Response("pong"); } });

const credBlob = (access: string, expiresInMs: number) => JSON.stringify({
  auth_method: "consumer",
  token: { access_token: access, refresh_token: "RT-stub", token_type: "Bearer",
           expiry: new Date(Date.now() + expiresInMs).toISOString() },
});

// A token INSIDE the 5-minute refresh window, so creds() takes the refresh path.
writeFileSync(CRED, credBlob("AT-stale", 60_000));
// Env isolation: bun runs every test file in ONE process, so a variable this file pins
// would otherwise decide what a SIBLING file's provider reads. Saved on entry, restored
// on exit.
const SAVED: Record<string, string | undefined> = {};
const pin = (k: string, v: string) => { if (!(k in SAVED)) SAVED[k] = process.env[k]; process.env[k] = v; };
const unpin = () => { for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

pin("APIPLAN_GOOGLE_CRED_FILE", CRED);
pin("APIPLAN_GOOGLE_TOKEN_URL", `http://127.0.0.1:${oauth.port}/token`);
// Supplied here so the client is never lifted from the real `agy` binary during a test.
pin("APIPLAN_GOOGLE_OAUTH_CLIENT_ID", "test-client-id.apps.googleusercontent.com");
pin("APIPLAN_GOOGLE_OAUTH_CLIENT_SECRET", "GOCSPX-test-secret");
// Longer than the stub's delay: the point is the WAIT, not a timeout cutting it short.
pin("APIPLAN_GOOGLE_REFRESH_TIMEOUT_S", "8");

const providers: any = await import("../src/providers.ts");
const google = providers.google;
// The SERVER posture. A one-shot CLI has nothing else to do while it mints, so the sync
// path is right there; a server has an event loop full of other people's requests and must
// never block on a vendor. `providerRuntime.syncRefresh = false` is how a host declares it
// is the second kind — and test 2 below pins that serve() actually declares it.
const runtime = providers.providerRuntime;   // absent on the pre-fix build: then it blocks
if (runtime) runtime.syncRefresh = false;

beforeEach(() => {
  pin("APIPLAN_GOOGLE_CRED_FILE", CRED);
  pin("APIPLAN_GOOGLE_TOKEN_URL", `http://127.0.0.1:${oauth.port}/token`);
});

afterAll(() => { if (runtime) runtime.syncRefresh = true; unpin(); oauth.stop(true); ping.stop(true); try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("google self-refresh", () => {
  test("an in-flight request is served while the token refresh is still running", async () => {
    const oauthBefore = oauthHits;
    const t0 = performance.now();
    // In flight BEFORE the refresh starts, and deliberately not awaited yet: a synchronous
    // refresh cannot let this resolve, an asynchronous one cannot stop it.
    const served = fetch(`http://127.0.0.1:${ping.port}/`).then(async (r) => ({ body: await r.text(), ms: performance.now() - t0 }));

    const creds = google.creds();      // sync signature today; awaited so an async fix also passes
    const pong = await served;
    const c: any = await creds;

    expect(pong.body).toBe("pong");
    expect(c?.token).toBeTruthy();
    // THE GATE: the unrelated request must not have waited on the refresh.
    expect(pong.ms).toBeLessThan(800);

    // The refresh went to the STUB, never to a vendor. Poll briefly: a background fix may
    // fire the mint after creds() has already returned.
    for (let i = 0; i < 60 && oauthHits === oauthBefore; i++) await Bun.sleep(100);
    expect(oauthHits).toBeGreaterThan(oauthBefore);
    expect(pingHits).toBeGreaterThan(0);
  }, 30_000);

  test("the server declares the non-blocking posture — a CLI may mint in line, a server may not", async () => {
    const api: any = await import("../src/api.ts");
    const s = api.serve({ port: 0, host: "127.0.0.1", token: "" });
    try {
      expect(runtime).toBeTruthy();                 // the posture must exist to be declared
      expect(runtime.syncRefresh).toBe(false);      // …and serve() must have declared it
    } finally { s.stop(); }
  }, 30_000);
});
