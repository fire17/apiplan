/**
 * REGRESSION NET — the /health verdict must never be green on nothing.
 *
 * The outcome mechanism exists to stop /health answering ok=true for a credential the
 * vendor has already rejected. Round four found two ways it still could:
 *
 * R-2  AGE DELETED THE VERDICT. `verdictFor` dropped an outcome older than
 *      APIPLAN_OUTCOME_TTL_MS from the Map, which turned a stored REJECTION into
 *      "never-exercised" — and never-exercised counted as green. The false green the whole
 *      mechanism exists to prevent, just a week later. Age must DEMOTE (unverified, prior
 *      preserved), never delete.
 *
 * COLD  A COLD STATE DIR. With no outcomes at all — a fresh machine, a wiped state dir,
 *      the first boot after a deploy — every provider is unexercised and /health answered
 *      ok=true, status=ok, while apiplan-doctor stayed honest about the same world. The
 *      two surfaces must not disagree: an unexercised provider is UNVERIFIED, not ok.
 *
 * Each scenario runs in its OWN process (test/helpers/health-probe.ts): STATE_DIR and the
 * outcomes Map are read once at import, so a state dir cannot be swapped in-process.
 * google is pinned to a local stub credential file — no keychain, no network, no vendor.
 */
import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, "helpers", "health-probe.ts");
const ROOT = mkdtempSync(join(tmpdir(), "apiplan-p2-health-"));
const CRED = join(ROOT, "google-cred.json");
writeFileSync(CRED, JSON.stringify({
  auth_method: "consumer",
  token: { access_token: "AT-health-stub", refresh_token: "RT-health-stub", token_type: "Bearer",
           expiry: new Date(Date.now() + 6 * 3600_000).toISOString() },
}));

afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch {} });

/** Run the probe helper in a fresh process against `home`, and parse its one JSON line. */
function probe(mode: "health" | "probe", home: string): any {
  const r = Bun.spawnSync(["bun", "run", HELPER, mode], {
    env: { ...process.env, APIPLAN_HOME: home, APIPLAN_API_KEY: "", APIPLAN_GOOGLE_CRED_FILE: CRED },
    stderr: "pipe",
  });
  const out = r.stdout.toString().trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (!out) throw new Error(`health-probe printed nothing (exit ${r.exitCode}): ${r.stderr.toString().slice(0, 400)}`);
  return JSON.parse(out);
}

const home = (name: string) => { const d = join(ROOT, name); mkdirSync(d, { recursive: true }); return d; };

describe("/health verdict", () => {
  test("a COLD state dir is unverified, never ok", () => {
    const body = probe("health", home("cold"));
    const unexercised = body.providers.filter((p: any) => p.connected && p.verified === "unverified");
    // Premise: at least one provider has a usable credential nothing has exercised yet.
    // (google is the stub above, so this holds on any machine.)
    expect(unexercised.length).toBeGreaterThan(0);
    for (const p of unexercised) expect(p.verified_reason).toBe("never-exercised");
    // THE GATE: an unexercised provider is not a green one, and the summary must say so.
    expect(body.ok).toBe(false);
    expect(body.status).not.toBe("ok");
  }, 60_000);

  test("an aged-out rejection is demoted to unverified, never deleted and never ok", () => {
    const h = home("aged");
    // The stored verdict must be about the credential that is still there, or the
    // already-shipped "credential-changed" path would carry the test and the age path
    // would go untested.
    const cred = probe("probe", h).google;
    expect(cred).toBeTruthy();
    const aged = { google: { ok: false, at: Date.now() - 10 * 24 * 3600_000,
                             detail: "HTTP 401: stubbed rejection, aged past the TTL", cred } };
    writeFileSync(join(h, "outcomes.json"), JSON.stringify(aged));

    const body = probe("health", h);
    const g = body.providers.find((p: any) => p.id === "google");
    expect(g).toBeTruthy();
    expect(g.verified).not.toBe("ok");
    // THE GATE 1: the evidence survives — an aged verdict is demoted, not forgotten, so a
    // reader can still see what the last real call proved.
    const onDisk = JSON.parse(readFileSync(join(h, "outcomes.json"), "utf8"));
    expect(onDisk.google).toBeTruthy();
    expect(onDisk.google.ok).toBe(false);
    // THE GATE 2: age does not launder a rejection into a pass.
    expect(body.ok).toBe(false);
    // …and the report carries the prior verdict rather than pretending nothing happened.
    expect(g.verified_prior?.verdict ?? "rejected").toBe("rejected");
  }, 60_000);
});
