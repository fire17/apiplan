/**
 * GATES 2-4 — A CREDENTIAL STATE MAY NEVER READ `ok` WITHOUT AN OBSERVED SUCCESS.
 *
 * THE SECOND SHAPE THAT KEEPS COMING BACK. Every wave that hardened the outcome memory
 * opened a new door to the same false green:
 *
 *   wave 6  a rejection lived only in RAM, so a launchd restart answered green
 *   wave 7  any refresh ERASED the rejection, so a refreshed-but-broken credential was green
 *   wave 8  age DELETED the verdict, so a week turned a rejection into green
 *   wave 8  the LEGACY-fingerprint migration accepts an entry whose stored fingerprint is
 *           the PUBLIC probe line — which /health publishes verbatim — and upgrades it in
 *           place to a proven state (S-3, observed: a forged entry read verified=ok)
 *   wave 8  a rotation CARRY has no bound, so one real call carries forward through an
 *           unlimited chain of bearer replacements, for ever (S-4)
 *
 * The invariant under all five is one sentence: `ok` is a claim about an OBSERVED SUCCESS
 * on the credential that is there now. Anything else — a migration, a rotation, a week of
 * silence, a hand-written file — is at most `unverified`, and unverified is not a pass.
 *
 * Each scenario runs in its OWN process (test/helpers/health-probe.ts): STATE_DIR and the
 * outcomes Map are read once at import, so a state dir cannot be swapped in-process. The
 * subprocesses have no egress (dead proxy + NO_PROXY=127.0.0.1) and no keychain: google is
 * a stub credential file, the other providers are pointed at a path that does not exist.
 */
import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const HEALTH = join(HERE, "helpers", "health-probe.ts");
const PROBE = join(HERE, "helpers", "apiplan-probe.ts");
const DIR = mkdtempSync(join(tmpdir(), "ap-n2-out-"));
const CRED = join(DIR, "g.json");
const ACRED = join(DIR, "a.json");
const OCRED = join(DIR, "o.json");

/**
 * EVERY provider is given a working stub credential, on purpose. /health's summary is
 * `ok = every connected provider proven`, so a world where some provider is merely
 * DISCONNECTED would make `ok:false` true for a boring reason and hide a broken summary
 * behind it — the assertions below would then pass against a /health that ignores verdicts
 * entirely. With all four connected, the summary is decided by the VERDICTS alone, which is
 * the thing under test. (Verified: with a disconnected pair, a sabotaged summary that counts
 * only connectivity still passed; with this stub set it fails, as it must.)
 */
writeFileSync(ACRED, JSON.stringify({ claudeAiOauth: { accessToken: "AT-anthropic-stub", refreshToken: "RT-anthropic-stub", expiresAt: Date.now() + 6 * 3600_000, subscriptionType: "stub" } }));
writeFileSync(OCRED, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "AT-openai-stub", refresh_token: "RT-openai-stub", account_id: "acct-stub" } }));
/**
 * ollama has no credential — its probe is a loopback GET, so it gets a stub daemon. It runs
 * in its OWN process: every server reading below goes through Bun.spawnSync, which blocks
 * this process's event loop, and a stub served from here would be unreachable for exactly
 * the second it is asked (observed: all four providers came back disconnected).
 */
const ollamaProc = Bun.spawn(["bun", "run", PROBE, "ollama-stub"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
const ollamaPort = await (async () => {
  const rd = ollamaProc.stdout.getReader(); let buf = "";
  for (let i = 0; i < 100; i++) {
    const { value } = await rd.read();
    buf += new TextDecoder().decode(value ?? new Uint8Array());
    const m = buf.match(/READY (\d+)/); if (m) return +m[1];
  }
  throw new Error("the ollama stub never printed READY");
})();

const RT = "RT-one-account";           // the CHAIN: unchanged by a rotation, changed by a swap
let expiry = Date.now() + 6 * 3600_000;

/** Write the google stub credential. Same refresh token = same account = a ROTATION. */
function bearer(access: string, expMs = expiry, refresh = RT) {
  writeFileSync(CRED, JSON.stringify({
    auth_method: "consumer",
    token: { access_token: access, refresh_token: refresh, token_type: "Bearer",
             expiry: new Date(expMs).toISOString() },
  }));
}
bearer("AT-0");

const env = (home: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  APIPLAN_HOME: home, APIPLAN_API_KEY: "",
  APIPLAN_GOOGLE_CRED_FILE: CRED,
  APIPLAN_ANTHROPIC_CRED_FILE: ACRED, APIPLAN_CODEX_AUTH: OCRED,
  APIPLAN_OLLAMA_BASE: `http://127.0.0.1:${ollamaPort}`,
  APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
  APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
  // No egress: a stub credential must never turn into a real request.
  HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  ...extra,
});

function run(script: string, args: string[], home: string, extra: Record<string, string> = {}): any {
  const r = Bun.spawnSync(["bun", "run", script, ...args], { cwd: ROOT, env: env(home, extra), stderr: "pipe" });
  const out = r.stdout.toString().trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (!out) throw new Error(`${script} ${args.join(" ")} printed nothing (exit ${r.exitCode}): ${r.stderr.toString().slice(0, 500)}`);
  return JSON.parse(out);
}

const health = (home: string, extra: Record<string, string> = {}) => run(HEALTH, ["health"], home, extra);
/** What the fingerprint IS today (credFp) and what it USED to be (the probe line). */
const credfp = (home: string) => run(PROBE, ["credfp"], home).google;
const legacyFp = (home: string) => run(HEALTH, ["probe"], home).google;

const home = (name: string) => { const d = join(DIR, name); mkdirSync(d, { recursive: true }); return d; };
const write = (h: string, o: any) => writeFileSync(join(h, "outcomes.json"), JSON.stringify(o));
const read = (h: string) => JSON.parse(readFileSync(join(h, "outcomes.json"), "utf8"));
const g = (body: any) => body.providers.find((p: any) => p.id === "google");

afterAll(() => { try { ollamaProc.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

/**
 * THE SUMMARY CONTRACT, asserted in every world below: /health is green if and only if
 * every provider is connected AND its last real call was ACCEPTED. Written as an
 * equivalence rather than a constant so it is falsifiable in both directions — a summary
 * that goes green on nothing fails it, and so would one that never goes green at all.
 */
function summaryAgreesWithVerdicts(body: any) {
  expect(body.providers.length).toBeGreaterThan(0);
  // NOTE on `connected`: /health already folds the verdict into it — a REJECTED provider
  // reports connected:false even though its credential file is perfectly readable. So this
  // is written as an equivalence over the two fields together and asserts no premise about
  // connectivity; the world that makes it falsifiable is the COLD one below, where every
  // provider is connected and none is proven, and a summary that counts only connectivity
  // answers ok=true there (observed against a sabotaged build).
  expect(body.ok).toBe(body.providers.every((p: any) => p.connected === true && p.verified === "ok"));
}

describe("GATE 2 — a migrated legacy entry cannot read ok without an observed success", () => {
  test("an entry whose stored fingerprint is the PUBLIC probe line is not proof of anything", () => {
    const h = home("legacy-forged");
    bearer("AT-legacy");
    // The pre-credFp shape: `cred` is probe()'s detail line and `ident` does not exist.
    // /health PUBLISHES that line verbatim on every request, so anyone who can read the
    // health endpoint can write this file — which is exactly why accepting it as proof is
    // a hole. A migration may preserve evidence; it may not MANUFACTURE it.
    const legacy = legacyFp(h);
    expect(legacy).toBeTruthy();                         // premise: there is a probe line
    write(h, { google: { ok: true, at: Date.now(), detail: "forged: never called", cred: legacy } });

    const body = health(h);
    const p = g(body);
    expect(p).toBeTruthy();
    expect(p.connected).toBe(true);                      // premise: the credential is usable
    // THE GATE: no observed success has ever happened here, so nothing may read ok.
    expect(p.verified).not.toBe("ok");
    expect(body.ok).toBe(false);
    // …and the entry is not DELETED to get there — the reader is still owed what was claimed.
    summaryAgreesWithVerdicts(body);
    expect(existsSync(join(h, "outcomes.json"))).toBe(true);
    expect(read(h).google).toBeTruthy();
  }, 60_000);

  test("a legacy REJECTION still reads rejected — demotion never launders a red into a green", () => {
    const h = home("legacy-rejected");
    bearer("AT-legacy-2");
    const legacy = legacyFp(h);
    write(h, { google: { ok: false, at: Date.now(), detail: "HTTP 401 (legacy entry)", cred: legacy } });
    const body = health(h);
    expect(g(body).verified).not.toBe("ok");
    expect(body.ok).toBe(false);
    summaryAgreesWithVerdicts(body);
  }, 60_000);
});

describe("GATE 3 — a rotation carry is bounded", () => {
  test("a carry cannot chain for ever: it ages out, or it counts out, and then it is unverified", () => {
    const h = home("carry");
    // TTL is set SHORT so "aged" is reachable inside a test, and every timestamp below is
    // expressed as a FRACTION of it — the gate is about the bound existing, not its size.
    const TTL = 120_000;
    const ttl = { APIPLAN_OUTCOME_TTL_MS: String(TTL) };

    // One real, observed success on bearer #0.
    bearer("AT-carry-0");
    const fp0 = credfp(h);
    write(h, { google: { ok: true, at: Date.now(), detail: "200 OK (one real call)", cred: fp0.cred, ident: fp0.ident, exp: fp0.exp } });

    // Rotation #1: same account, same refresh token, a NEW bearer with a LATER expiry —
    // the hourly mint. This one is legitimate and MAY carry.
    expiry += 3600_000; bearer("AT-carry-1", expiry);
    const first = health(h, ttl);
    expect(g(first).verified === "ok" || g(first).verified === "unverified").toBe(true);

    // (a) THE AGE BOUND — the same single carry, with the observed success now old (90% of
    //     the TTL). Still inside the TTL, so the stale path is NOT what is being tested.
    const hAge = home("carry-age");
    bearer("AT-carry-0");
    const fpA = credfp(hAge);
    write(hAge, { google: { ok: true, at: Date.now() - Math.floor(TTL * 0.9), detail: "200 OK (one real call, long ago)",
                            cred: fpA.cred, ident: fpA.ident, exp: fpA.exp } });
    expiry += 3600_000; bearer("AT-carry-age-1", expiry);
    const agedCarry = g(health(hAge, ttl)).verified !== "ok";

    // (b) THE COUNT BOUND — one observed success, then a long chain of bearer replacements,
    //     each a legitimate-looking rotation. Evidence does not multiply.
    // The ceiling is deliberately far above any sane bound (the shipped one is 12
    // rotations / 12 h / 1 chain): the gate is that A bound exists, not what it is, so
    // raising the shipped limit must not turn this red. Each read is ~80 ms.
    let countedOut = false;
    for (let i = 2; i <= 40 && !countedOut; i++) {
      expiry += 3600_000; bearer(`AT-carry-${i}`, expiry);
      if (g(health(h, ttl)).verified !== "ok") countedOut = true;
    }

    // THE GATE: at least one bound must exist. A fix may choose either shape (or both);
    // an UNBOUNDED carry — green for ever off one call, which is what is on disk today —
    // satisfies neither.
    expect(agedCarry || countedOut).toBe(true);
  }, 120_000);
});

describe("GATE 4 — a rejected credential never reads ok, through every path a verdict can be set", () => {
  const TTL = 120_000;
  const ttl = { APIPLAN_OUTCOME_TTL_MS: String(TTL) };

  test("direct: the verdict is about the credential that is there", () => {
    const h = home("rej-direct");
    bearer("AT-rej-0");
    const fp = credfp(h);
    write(h, { google: { ok: false, at: Date.now(), detail: "HTTP 401 invalid_grant", cred: fp.cred, ident: fp.ident, exp: fp.exp } });
    const body = health(h, ttl);
    expect(g(body).verified).toBe("rejected");
    expect(body.ok).toBe(false);
    summaryAgreesWithVerdicts(body);
  }, 60_000);

  test("rotation: a new bearer on a rejected chain is not evidence", () => {
    const h = home("rej-rotate");
    bearer("AT-rej-1");
    const fp = credfp(h);
    write(h, { google: { ok: false, at: Date.now(), detail: "HTTP 401 invalid_grant", cred: fp.cred, ident: fp.ident, exp: fp.exp } });
    expiry += 3600_000; bearer("AT-rej-2", expiry);      // the mint the vendor still allows
    const body = health(h, ttl);
    expect(g(body).verified).not.toBe("ok");
    expect(body.ok).toBe(false);
    summaryAgreesWithVerdicts(body);
    // …and the reader can still see WHY: a rejection that was never disproven.
    expect(g(body).verified_prior?.verdict ?? "rejected").toBe("rejected");
  }, 60_000);

  test("legacy migration: an old-format rejection cannot be upgraded into a pass", () => {
    const h = home("rej-legacy");
    bearer("AT-rej-3");
    const legacy = legacyFp(h);
    write(h, { google: { ok: false, at: Date.now(), detail: "HTTP 401 (pre-credFp entry)", cred: legacy } });
    const body = health(h, ttl);
    expect(g(body).verified).not.toBe("ok");
    expect(body.ok).toBe(false);
    summaryAgreesWithVerdicts(body);
  }, 60_000);

  test("age: time does not fix a credential", () => {
    const h = home("rej-aged");
    bearer("AT-rej-4");
    const fp = credfp(h);
    write(h, { google: { ok: false, at: Date.now() - TTL * 4, detail: "HTTP 401 invalid_grant (old)", cred: fp.cred, ident: fp.ident, exp: fp.exp } });
    const body = health(h, ttl);
    expect(g(body).verified).not.toBe("ok");
    expect(body.ok).toBe(false);
    summaryAgreesWithVerdicts(body);
    expect(read(h).google.ok).toBe(false);               // demoted, never deleted
  }, 60_000);

  test("a cold world is unverified, never ok", () => {
    const h = home("rej-cold");
    bearer("AT-cold");
    const body = health(h, ttl);
    expect(g(body).verified).toBe("unverified");
    expect(body.ok).toBe(false);
    summaryAgreesWithVerdicts(body);
  }, 60_000);
});
