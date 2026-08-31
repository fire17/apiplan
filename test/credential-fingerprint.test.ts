/**
 * REGRESSION NET — two credential-surface defects found in round four, 2026-08-27.
 *
 * 1. EXPIRY WITH NO ZONE. The expiry was rendered as `new Date(x).toISOString().slice(0,16)`
 *    with the "T" swapped for a space: "expires 21:14" for a token that was good until
 *    00:14 +0300. A wall-clock time with no zone is not a fact — it reads as local time and
 *    is not, so a healthy token looks three hours dead.
 *
 * 2. A FINGERPRINT BLIND TO THE ACCESS TOKEN. The outcome memory is keyed on probe()'s
 *    detail; the detail hashed only the REFRESH token and the expiry-to-the-minute. Swap
 *    the access token inside the same minute and the fingerprint is unchanged, so a green
 *    "ACCEPTED" verdict proven against the OLD access token is silently inherited by a
 *    credential nothing has ever exercised.
 *
 * No network and no keychain: the credential is a local stub file. The token values
 * themselves are asserted ABSENT from the rendered detail — a fingerprint is a hash, and a
 * secret must never reach a log, a probe line, or a bus message.
 */
import { expect, test, describe, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "apiplan-p2-fingerprint-"));
const CRED = join(DIR, "google-cred.json");

// Env isolation: bun runs every test file in ONE process, so a variable this file pins
// would otherwise decide what a SIBLING file's provider reads (it did — it silently
// changed what test/api.test.ts saw on /health). Saved on entry, restored on exit.
const SAVED: Record<string, string | undefined> = {};
const pin = (k: string, v: string) => { if (!(k in SAVED)) SAVED[k] = process.env[k]; process.env[k] = v; };
const unpin = () => { for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
pin("APIPLAN_GOOGLE_CRED_FILE", CRED);

const { google } = await import("../src/providers.ts");

// One fixed expiry for every write, so the ONLY difference between two reads is the field
// under test. Well in the future: an expired stub would add grace-window prose to detail.
const EXPIRY_MS = Date.now() + 6 * 3600_000;
const write = (access: string, refresh = "RT-same-account") => writeFileSync(CRED, JSON.stringify({
  auth_method: "consumer",
  token: { access_token: access, refresh_token: refresh, token_type: "Bearer", expiry: new Date(EXPIRY_MS).toISOString() },
}));

// Re-pinned per test: bun runs the suite in one process, and a sibling file that points
// the same variable elsewhere must not decide what this one reads.
beforeEach(() => { pin("APIPLAN_GOOGLE_CRED_FILE", CRED); });

afterAll(() => { unpin(); try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("credential rendering", () => {
  test("a rendered expiry carries an explicit zone", () => {
    write("AT-one");
    const detail = google.probe().detail;
    expect(detail).toContain("expires");
    const rendered = detail.slice(detail.indexOf("expires"));
    // Z, an explicit UTC/GMT marker, or a numeric offset. Anything else is a bare local-
    // looking timestamp, which is the defect.
    expect(rendered).toMatch(/(Z\b|UTC|GMT|[+-]\d{2}:?\d{2})/);
  });

  // THE FINGERPRINT the outcome memory keys on — credFp() where a provider offers one,
  // and the probe line (what it used to be for everyone) where it does not.
  const fp = () => (google.credFp ? JSON.stringify(google.credFp()) : google.probe().detail);

  test("the fingerprint changes when the access token is swapped inside the same minute", () => {
    write("AT-one");
    const before = fp();
    write("AT-two");           // same account, same refresh token, same expiry — new access token
    const after = fp();
    expect(before).toBeTruthy();
    expect(after).not.toBe(before);
    // …and the swap is still visible as a CHANGE OF CREDENTIAL, not as a different account:
    // both details must stay hashes, never the tokens themselves.
    for (const d of [before, after]) {
      expect(d).not.toContain("AT-one");
      expect(d).not.toContain("AT-two");
      expect(d).not.toContain("RT-same-account");
    }
  });

  test("an unchanged credential keeps a stable fingerprint", () => {
    write("AT-stable");
    const a = fp();
    const b = fp();
    expect(a).toBe(b);          // or every read would look like an account switch
  });
});
