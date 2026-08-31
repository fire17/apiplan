/**
 * GATE 5 — /health AND apiplan-doctor MUST DESCRIBE THE SAME WORLD.
 *
 * Two surfaces read the same evidence: the JSON at GET /health, and the operator's
 * one-command checker `bringup/apiplan-doctor`, which parses that JSON and turns it into
 * PASS / NOTE / FAIL lines. Every false green in this project's history was survivable only
 * because ONE of the two surfaces still told the truth — and the failure mode nobody has
 * gated yet is the two of them DISAGREEING: /health green while the doctor FAILs, or the
 * doctor green while /health says nothing was ever proven. A watchdog polls one, a human
 * runs the other; when they disagree, one of them is lying and nobody knows which.
 *
 * The doctor is deliberately re-pointed (APIPLAN_DOCTOR_BASE) at a scratch server whose
 * outcome world this file writes, so agreement is checked across several worlds and not
 * merely on whatever the machine happens to be in today. Its launchd/port/claudish checks
 * are about the real installation and are ignored here BY NAME: only the lines the /health
 * section emits are read.
 *
 * Zero model spend: the doctor's default run is config reads and zero-token HTTP probes.
 * The scratch server has no egress (dead proxy) and a stub google credential.
 */
import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROBE = join(HERE, "helpers", "apiplan-probe.ts");
const DOCTOR = process.env.APIPLAN_DOCTOR_BIN ?? join(homedir(), "Creations", "LiveMind", "bringup", "apiplan-doctor");
const HAVE_DOCTOR = existsSync(DOCTOR);

const DIR = mkdtempSync(join(tmpdir(), "ap-n2-agree-"));
const CRED = join(DIR, "g.json");
const ABSENT = join(DIR, "no-such-credential.json");
const RT = "RT-agree-account";
let expiry = Date.now() + 6 * 3600_000;

const bearer = (access: string, expMs = expiry) => writeFileSync(CRED, JSON.stringify({
  auth_method: "consumer",
  token: { access_token: access, refresh_token: RT, token_type: "Bearer", expiry: new Date(expMs).toISOString() },
}));
bearer("AT-agree-0");

const env = (home: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  APIPLAN_HOME: home, APIPLAN_API_KEY: "",
  APIPLAN_GOOGLE_CRED_FILE: CRED,
  APIPLAN_ANTHROPIC_CRED_FILE: ABSENT, APIPLAN_CODEX_AUTH: ABSENT,
  APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
  APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
  HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  ...extra,
});

const home = (name: string) => { const d = join(DIR, name); mkdirSync(d, { recursive: true }); return d; };
const write = (h: string, o: any) => writeFileSync(join(h, "outcomes.json"), JSON.stringify(o));
const credfp = (h: string) => {
  const r = Bun.spawnSync(["bun", "run", PROBE, "credfp"], { cwd: ROOT, env: env(h), stderr: "pipe" });
  return JSON.parse(r.stdout.toString().trim().split("\n").filter(Boolean).at(-1) ?? "{}").google;
};

const kids: any[] = [];
afterAll(() => { for (const k of kids) { try { k.kill(); } catch {} } try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

/** Start a scratch server on the given world, ask BOTH surfaces, return both answers. */
async function bothSurfaces(h: string, extra: Record<string, string> = {}) {
  const kid = Bun.spawn(["bun", "run", PROBE, "serve"], { cwd: ROOT, env: env(h, extra), stdout: "pipe", stderr: "pipe" });
  kids.push(kid);
  const rd = kid.stdout.getReader(); let buf = "", port = 0;
  for (let i = 0; i < 60 && !port; i++) {
    const { value } = await rd.read();
    buf += new TextDecoder().decode(value ?? new Uint8Array());
    const m = buf.match(/READY (\d+)/); if (m) port = +m[1];
  }
  if (!port) throw new Error("scratch server never printed READY");
  const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  const r = Bun.spawnSync(["bash", DOCTOR], {
    env: { ...process.env, APIPLAN_DOCTOR_BASE: `http://127.0.0.1:${port}`,
           // The claudish/sol checks are about the real install; point them somewhere inert
           // so their failures are unambiguous noise rather than a confusing near-miss.
           APIPLAN_DOCTOR_CFG: join(DIR, "no-such-claudish.json") },
    stderr: "pipe",
  });
  const out = r.stdout.toString() + r.stderr.toString();
  kid.kill();
  return { body, lines: out.split("\n") };
}

/** Only the provider verdict lines the /health section emits. */
const provLines = (lines: string[]) => lines.filter((l) => /^(PASS|NOTE|FAIL): provider /.test(l));
const okLine = (lines: string[]) => lines.find((l) => /(PASS|NOTE|FAIL): GET .*\/health -> 200/.test(l)) ?? "";

const D = HAVE_DOCTOR ? describe : describe.skip;

D("the two surfaces agree", () => {
  test("a provider is green in the doctor if and only if /health says its last real call was ACCEPTED", async () => {
    const worlds: Array<[string, () => void, Record<string, string>]> = [
      // cold: nothing has ever been proven
      ["cold", () => bearer("AT-agree-cold"), {}],
      // forged legacy entry: the S-3 shape — an entry whose fingerprint is the public probe line
      ["forged", () => { bearer("AT-agree-forged"); }, {}],
      // an honest rejection on the credential that is there
      ["rejected", () => { bearer("AT-agree-rej"); }, {}],
    ];
    for (const [name, prep] of worlds.map(([a, b, c]) => [a, b, c] as const)) {
      const h = home(`w-${name}`); prep();
      if (name === "rejected") {
        const fp = credfp(h);
        write(h, { google: { ok: false, at: Date.now(), detail: "HTTP 401 invalid_grant", cred: fp.cred, ident: fp.ident, exp: fp.exp } });
      }
      const { body, lines } = await bothSurfaces(h);
      const pl = provLines(lines);
      expect(pl.length).toBeGreaterThan(0);              // premise: the doctor read the providers block

      for (const p of body.providers) {
        const mine = pl.filter((l) => l.includes(`provider ${p.id} `));
        if (!mine.length) continue;
        const green = mine.some((l) => l.startsWith("PASS: "));
        // THE GATE: the doctor's green and /health's `verified: ok` are the same fact.
        expect(green).toBe(p.connected === true && p.verified === "ok");
      }
      // And the summary lines cannot disagree about the world either.
      const summary = okLine(lines);
      expect(summary).toBeTruthy();
      expect(/ok=true/.test(summary)).toBe(body.ok === true);
      // A not-ok world must be visible in the doctor as something other than passes.
      if (body.ok === false) expect(pl.some((l) => !l.startsWith("PASS: "))).toBe(true);
    }
  }, 180_000);

  test("the doctor states the REASON /health actually gave — a stale verdict is not 'never exercised'", async () => {
    const h = home("w-stale");
    bearer("AT-agree-stale");
    const fp = credfp(h);
    // A real, observed SUCCESS, older than the TTL: /health calls this `stale` and carries
    // the prior verdict. A reader told "no call has exercised this credential yet" is being
    // told the opposite of what happened — the same evidence, described two different ways.
    write(h, { google: { ok: true, at: Date.now() - 300_000, detail: "200 OK (long ago)", cred: fp.cred, ident: fp.ident, exp: fp.exp } });
    const { body, lines } = await bothSurfaces(h, { APIPLAN_OUTCOME_TTL_MS: "60000" });
    const p = body.providers.find((x: any) => x.id === "google");
    expect(p.verified).toBe("unverified");
    expect(p.verified_reason).toBe("stale");             // premise: /health says stale
    const mine = provLines(lines).filter((l) => l.includes("provider google "));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((l) => l.startsWith("PASS: "))).toBe(false);
    // THE GATE: the doctor may not describe a stale verdict as a credential nothing ever touched.
    expect(mine.join(" ")).not.toContain("no call has exercised this credential yet");
  }, 120_000);
});
