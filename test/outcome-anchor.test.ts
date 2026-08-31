/**
 * GATES 3-4 — A VERDICT THIS PROCESS NEVER OBSERVED IS NOT EVIDENCE.
 *
 * THE OTHER SHAPE THAT KEEPS COMING BACK, one round on. Wave 9 closed the LEGACY forgery
 * (an entry whose fingerprint was the public probe line) and bounded the rotation CARRY.
 * Round six found the carry itself is an unanchored door: an outcomes entry written BY HAND
 * whose fingerprint matches NOTHING — no credential this machine has, no credential it ever
 * had — still reads `verified=ok`, because the carry path treats "the fingerprint moved" as
 * "the bearer was rotated" and carries the hand-written success onto the live credential.
 *
 *   { ok: true, cred: "nothing-ever-had-this", ident: "nor-this", exp: 0 }   →  verified: ok
 *
 * No token, model or answer changes — writing that file already means owning the box. What
 * changes is that /health and apiplan-doctor LIE, and they are the two surfaces every
 * watchdog here is built on. A green that survives a forged file is not a green.
 *
 * THE INVARIANT: `ok` is a claim about an observed success on the credential in hand. An
 * entry the running process cannot attribute to anything it has seen is UNVERIFIED — which
 * is not a pass, and which one real call clears.
 *
 * GATE 4 IS THE COUNTER-TEST, and it is not optional: an anchor that also kills the GENUINE
 * hourly rotation would turn every mint into a red /health — the S-HEALTHFLAP the carry was
 * built to absorb. So the same file proves both directions: a forged entry never goes green,
 * and a real success carried across a real mint stays green. It is written INSIDE ONE
 * RUNNING SERVER (a real call, then a real rotation under it), so it holds whichever anchor
 * shape ships — "a fingerprint this process observed" or a machine-local signature.
 *
 * NOTHING REACHES A VENDOR: google is pointed at a local stub whose hit counter is asserted,
 * the other providers at a path that does not exist, both Keychain services at a service
 * that does not exist, and every subprocess has no egress (dead proxy + NO_PROXY).
 */
import { expect, test, describe, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const HEALTH = join(HERE, "helpers", "health-probe.ts");
const PROBE = join(HERE, "helpers", "apiplan-probe.ts");
const DIR = mkdtempSync(join(tmpdir(), "ap-m2-anchor-"));
const CRED = join(DIR, "g.json");
const ABSENT = join(DIR, "no-such-credential.json");

/** The vendor, stubbed. One SSE frame, a finish reason, and a counter that proves every
 *  call in this file went HERE. */
let apiHits = 0;
const vendor = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
  apiHits++;
  return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}}\n\n',
    { headers: { "content-type": "text/event-stream" } });
} });

const RT = "RT-one-account";
/** Write the google credential. Same refresh token = same account = a ROTATION, which is
 *  exactly what the hourly mint does. */
function bearer(access: string, expMs: number) {
  writeFileSync(CRED, JSON.stringify({
    auth_method: "consumer",
    token: { access_token: access, refresh_token: RT, token_type: "Bearer", expiry: new Date(expMs).toISOString() },
  }));
}
bearer("AT-0", Date.now() + 6 * 3600_000);

const ENV = (home: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  APIPLAN_HOME: home, APIPLAN_API_KEY: "",
  APIPLAN_GOOGLE_CRED_FILE: CRED,
  APIPLAN_GOOGLE_BASE: `http://127.0.0.1:${vendor.port}`,
  APIPLAN_ANTHROPIC_CRED_FILE: ABSENT, APIPLAN_CODEX_AUTH: ABSENT,
  APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
  APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
  APIPLAN_OLLAMA_BASE: "http://127.0.0.1:9",
  APIPLAN_KEEPALIVE_MS: "0", APIPLAN_TALK_PARK: "0",
  HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  ...extra,
});

const home = (name: string) => { const d = join(DIR, name); mkdirSync(d, { recursive: true }); return d; };
const write = (h: string, o: any) => writeFileSync(join(h, "outcomes.json"), JSON.stringify(o));
const g = (body: any) => body.providers.find((p: any) => p.id === "google");

/** One /health from a FRESH process: STATE_DIR and the outcomes Map are read once at import,
 *  so a state dir cannot be swapped in-process. */
function health(h: string, extra: Record<string, string> = {}): any {
  const r = Bun.spawnSync(["bun", "run", HEALTH, "health"], { cwd: ROOT, env: ENV(h, extra), stderr: "pipe" });
  const out = r.stdout.toString().trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (!out) throw new Error(`health-probe printed nothing (exit ${r.exitCode}): ${r.stderr.toString().slice(0, 400)}`);
  return JSON.parse(out);
}

afterAll(() => { vendor.stop(true); try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("GATE 3 — an outcome the running process never observed cannot read ok", () => {
  const cases: Array<[string, any]> = [
    // The exact shape round six found: a fingerprint matching NOTHING, and an `exp` of 0 so
    // the "a mint only moves the expiry forward" test passes trivially. Pre-fix this reads
    // `verified: ok, verified_carried: rotated`.
    ["a fingerprint that matches nothing at all", { cred: "forged-cred-nobody-has-ever-held", ident: "forged-chain", exp: 0 }],
    // The same forgery wearing the CHAIN of the credential in hand would be the strongest
    // version an attacker could write without the token itself; `ident` is a hash of the
    // refresh token, and matching it must still not manufacture a success.
    ["a forged bearer on a plausible chain", { cred: "forged-cred-second-shape", ident: "g:0000000000ab", exp: 1 }],
  ];
  for (const [what, fp] of cases) {
    test(`${what} is UNVERIFIED, never ok`, () => {
      const h = home(`forged-${fp.cred.slice(7, 17)}`);
      const before = apiHits;
      write(h, { google: { ok: true, at: Date.now(), detail: "forged: no call ever happened", ...fp } });
      const body = health(h);
      const p = g(body);
      expect(p).toBeTruthy();
      expect(p.connected).toBe(true);                 // premise: the credential itself is fine
      // THE GATE: nothing here was ever observed, so nothing here may read green.
      expect(p.verified).not.toBe("ok");
      expect(body.ok).toBe(false);
      // …and nothing was spent finding that out: /health never calls a vendor.
      expect(apiHits).toBe(before);
    }, 60_000);
  }

  test("a forged entry does not become ok merely because the credential ROTATES under it", () => {
    const h = home("forged-rotate");
    write(h, { google: { ok: true, at: Date.now(), detail: "forged", cred: "forged-cred-rotating", ident: "forged-chain", exp: 0 } });
    expect(g(health(h)).verified).not.toBe("ok");
    bearer("AT-rotated-under-forgery", Date.now() + 7 * 3600_000);   // the hourly mint happens
    const p = g(health(h));
    // A real rotation is not evidence FOR a forgery — it is one more bearer the forged
    // success was never earned on.
    expect(p.verified).not.toBe("ok");
    expect(health(h).ok).toBe(false);
    bearer("AT-0", Date.now() + 6 * 3600_000);
  }, 60_000);
});

/**
 * GATE 4 — THE COUNTER-TEST. A REAL success, then a REAL rotation, inside ONE running
 * server: this is the hourly mint on a live box, and it must stay green. Without this, an
 * anchor that simply refused every carry would satisfy gate 3 and hand him a /health that
 * goes red once an hour for no reason.
 */
describe("GATE 4 — a genuine rotation carry still reads ok", () => {
  const h = home("genuine");
  let server: any = null, base = "";

  beforeAll(async () => {
    bearer("AT-genuine-0", Date.now() + 6 * 3600_000);
    server = Bun.spawn(["bun", "run", PROBE, "serve"], { cwd: ROOT, env: ENV(h), stdout: "pipe", stderr: "pipe" });
    const rd = server.stdout.getReader(); let buf = "";
    for (let i = 0; i < 200; i++) {
      const { value } = await rd.read();
      buf += new TextDecoder().decode(value ?? new Uint8Array());
      const m = buf.match(/READY (\d+)/); if (m) { base = `http://127.0.0.1:${m[1]}`; break; }
    }
    if (!base) throw new Error("the api server never printed READY");
  });
  afterAll(() => { try { server?.kill(); } catch {} });

  const live = () => fetch(`${base}/health`).then((r) => r.json() as any);

  test("one real call, then a mint on the same chain — the verdict is carried, and says so", async () => {
    const cold = g(await live());
    expect(cold.verified).toBe("unverified");            // premise: nothing proven yet
    expect(cold.connected).toBe(true);

    const { models } = await import("../src/registry.ts");
    const m = models("google")[0];
    expect(m).toBeTruthy();                              // premise: there is a google model
    const hitsBefore = apiHits;
    const call = await fetch(`${base}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: m.id, max_tokens: 64, messages: [{ role: "user", content: "ping" }] }),
    });
    expect(call.status).toBe(200);                       // premise: the call was ACCEPTED
    expect(apiHits).toBe(hitsBefore + 1);                // …by the STUB, never by a vendor

    const proven = g(await live());
    expect(proven.verified).toBe("ok");                  // premise: the success was recorded

    // THE ROTATION: same account, same refresh token, a new bearer with a later expiry —
    // exactly what the hourly mint writes.
    bearer("AT-genuine-1", Date.now() + 7 * 3600_000);

    // THE GATE: through the whole mint the verdict stays green, and once the server sees
    // the new bearer it says out loud that the evidence was CARRIED onto it.
    //
    // Polled rather than read once, because a fix that caches the credential read (the
    // shape F9-2 asks for) sees the rotation when its cache turns over rather than on the
    // next request. The ceiling is deliberately far above any sane credential cache: a
    // server that has not noticed a new bearer 25 s after it was written is still serving
    // the old one to real calls, which is its own defect.
    let carried: any = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 25_000) {
      const p = g(await live());
      expect(p.verified).toBe("ok");                     // a mint NEVER turns /health red
      if (p.verified_carried) { carried = p; break; }
      await Bun.sleep(500);
    }
    expect(carried).toBeTruthy();
    expect(carried.verified_carried).toBe("refreshed");
    expect(carried.carry?.rotations).toBeGreaterThanOrEqual(1);
    // The stored entry is the process's own — not a hand-written one — and it survived.
    expect(JSON.parse(readFileSync(join(h, "outcomes.json"), "utf8")).google.ok).toBe(true);
  }, 120_000);
});
