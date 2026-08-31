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
import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "apiplan-p2-fingerprint-"));
const CRED = join(DIR, "google-cred.json");
const HELPER = join(dirname(fileURLToPath(import.meta.url)), "helpers", "credential-fingerprint-probe.ts");

/** providers.ts and its resident credential caches are process-wide. This test owns a
 * child so another concurrently loaded test file cannot redirect its credential well. */
async function probe(): Promise<{ detail: string; before: string; after: string; stable: string }> {
  const p = Bun.spawn([process.execPath, "run", HELPER], {
    env: { ...process.env, APIPLAN_GOOGLE_CRED_FILE: CRED },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  if (code !== 0) throw new Error(`credential fingerprint probe exited ${code}: ${err || out}`);
  return JSON.parse(out.trim().split(/\r?\n/).at(-1) ?? "{}");
}

afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("credential rendering", () => {
  test("a rendered expiry carries an explicit zone", async () => {
    const { detail } = await probe();
    expect(detail).toContain("expires");
    const rendered = detail.slice(detail.indexOf("expires"));
    expect(rendered).toMatch(/(Z\b|UTC|GMT|[+-]\d{2}:?\d{2})/);
  });

  test("the fingerprint changes when the access token is swapped inside the same minute", async () => {
    const { before, after } = await probe();
    expect(before).toBeTruthy();
    expect(after).not.toBe(before);
    for (const d of [before, after]) {
      expect(d).not.toContain("AT-one");
      expect(d).not.toContain("AT-two");
      expect(d).not.toContain("RT-same-account");
    }
  });

  test("an unchanged credential keeps a stable fingerprint", async () => {
    const { after, stable } = await probe();
    expect(after).toBe(stable);
  });
});
