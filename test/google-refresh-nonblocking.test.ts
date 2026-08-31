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
import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "apiplan-p2-refresh-"));
const CRED = join(DIR, "google-cred.json");
const HELPER = join(dirname(fileURLToPath(import.meta.url)), "helpers", "google-refresh-probe.ts");

writeFileSync(CRED, JSON.stringify({
  auth_method: "consumer",
  token: { access_token: "AT-stale", refresh_token: "RT-stub", token_type: "Bearer",
           expiry: new Date(Date.now() + 60_000).toISOString() },
}));

/** Bun executes test files concurrently. Mutating process.env or providerRuntime in this
 * process races siblings importing providers.ts, so the behavioral probe owns a child. */
async function probe(): Promise<any> {
  const p = Bun.spawn([process.execPath, "run", HELPER], {
    env: {
      ...process.env,
      APIPLAN_GOOGLE_CRED_FILE: CRED,
      APIPLAN_GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      APIPLAN_GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-test-secret",
      APIPLAN_GOOGLE_REFRESH_TIMEOUT_S: "8",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  if (code !== 0) throw new Error(`google refresh probe exited ${code}: ${err || out}`);
  return JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
}

afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("google self-refresh", () => {
  test("an in-flight request is served while the token refresh is still running", async () => {
    const r = await probe();
    expect(r.pong).toBe("pong");
    expect(r.pongMs).toBeLessThan(800);
    expect(r.token).toBeTruthy();
    expect(r.oauthHits).toBe(1);
  }, 30_000);

  test("the server declares the non-blocking posture — a CLI may mint in line, a server may not", async () => {
    const r = await probe();
    expect(r.runtimeBefore).toBe(true);
    expect(r.runtimeAfter).toBe(false);
  }, 30_000);
});
