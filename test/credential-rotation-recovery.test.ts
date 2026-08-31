/**
 * U-1 — THE RESIDENT CREDENTIAL CACHE MAY NOT REFUSE A CREDENTIAL THAT IS ALREADY GOOD.
 *
 * WHAT HAPPENED (2026-08-28, ~02:00, observed on his box). Wave 10 put a snapshot in front
 * of every credential well so a `security` read could not serialise the request path
 * (F9-2, test/credential-read-nonblocking.test.ts). The snapshot is served for a window and
 * refreshed behind the request — which is right for LATENCY and wrong for CORRECTNESS the
 * moment the well changes from OUTSIDE this process: he runs `claude`, or codex renews its
 * own login, and for one whole window the server keeps answering out of the credential the
 * rotation replaced. Observed: three consecutive
 *   401 "Claude OAuth token expired, run claude once"
 * with an hour-good token sitting in the well, recovering on the 4th call ~100 ms later.
 *
 * And the refusal did not merely fail — it CONDEMNED. run() records every auth failure as a
 * verdict (noteCall(id,false)), so a refusal invented by our own stale copy was written into
 * outcomes.json as a vendor REJECTION and turned /health red until a real call re-proved the
 * provider. A cache that is allowed to lie about a credential must never also be allowed to
 * testify about it.
 *
 * THE TWO GATES, and the counter-gate that stops the cheap way out:
 *
 *   A  ROTATION RECOVERY. The well is rotated externally mid-flight; the very next call
 *      succeeds, on the NEW bearer, and nothing is recorded against the provider. A 401 is
 *      the one signal that says "the credential you are holding is wrong" — it must
 *      INVALIDATE the snapshot and force one fresh read before the caller is told no.
 *
 *   B1 A GENUINELY EXPIRED CREDENTIAL STILL 401s, AND STILL RECORDS REJECTED. Nothing here
 *      may be satisfied by swallowing auth failures or by never writing a verdict again.
 *   B2 A VENDOR 401 ON A FRESH CREDENTIAL STILL 401s, AND STILL RECORDS REJECTED. Same
 *      counter-gate, one layer out: the refusal that comes from the VENDOR is real evidence
 *      and must survive the fix, however many times the fix re-reads the well first.
 *
 * NOTHING REACHES A VENDOR AND NOTHING TOUCHES THE REAL KEYCHAIN. `security` is a stub on
 * PATH answering 44 ("no such item"), both keychain service names point at a service that
 * does not exist, the credential well is a file under a temp dir, APIPLAN_ANTHROPIC_BASE is
 * a stub server in this process with a hit counter, and every proxy variable points at a
 * dead port with 127.0.0.1 excluded.
 *
 * WHY EACH SCENARIO GETS ITS OWN SERVER PROCESS: the snapshot, STATE_DIR and the outcomes
 * Map are all filled once, at start-up (serve() calls warmCreds() before it listens). A
 * scenario that wants a DIFFERENT world therefore cannot reuse a process that already
 * warmed against this one.
 */
import { expect, test, describe, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROBE = join(HERE, "helpers", "apiplan-probe.ts");
const DIR = mkdtempSync(join(tmpdir(), "ap-u1-rot-"));
const BIN = join(DIR, "bin"); mkdirSync(BIN, { recursive: true });
const ABSENT = join(DIR, "no-such-credential.json");

/** The stub `security`: his Keychain is never read. 44 is the one code that means "signed
 *  out", so every anthropic read falls through to the FILE well this test controls. */
writeFileSync(join(BIN, "security"), "#!/bin/sh\nexit 44\n");
chmodSync(join(BIN, "security"), 0o755);

/** A Claude Code credential well, at whatever expiry the scenario needs. */
const wellJson = (token: string, expiresAt: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `RT-${token}`, expiresAt, subscriptionType: "stub" } });
const GOOD = () => Date.now() + 6 * 3600_000;
const DEAD = () => Date.now() - 60_000;

// ── the stub vendor ─────────────────────────────────────────────────────────────────────
/**
 * Anthropic's /v1/messages, in this process, with a hit counter — so a claim about WHICH
 * bearer the server sent is read off the wire rather than inferred. `mode` is flipped per
 * scenario: "ok" answers a complete SSE turn, "401" refuses like a vendor that has revoked
 * the credential.
 */
let mode: "ok" | "401" = "ok";
const seen: string[] = [];
const SSE = [
  `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-5", usage: { input_tokens: 3, output_tokens: 0 } } })}`,
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}`,
  `data: ${JSON.stringify({ type: "message_stop" })}`,
].join("\n\n") + "\n\n";

const vendor = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    seen.push((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (mode === "401") return new Response(JSON.stringify({ error: { message: "stub vendor: credential revoked" } }), { status: 401, headers: { "content-type": "application/json" } });
    return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
  },
});
const VENDOR = `http://127.0.0.1:${vendor.port}`;

// ── one server per scenario ─────────────────────────────────────────────────────────────
const procs: any[] = [];
afterAll(() => {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { vendor.stop(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

type World = { home: string; well: string; base: string };

/**
 * A resident api server whose whole world is this scenario's temp dir.
 * `cacheMs` is deliberately far longer than the test: the bug is "for one refresh window
 * after a rotation", and pinning the window open is what makes that window observable
 * rather than a race the suite would fail intermittently on. Nothing about the fix depends
 * on the window's length — an auth failure must not wait for it.
 */
async function world(name: string, token: string, expiresAt: number, cacheMs = 600_000): Promise<World> {
  const home = join(DIR, name); mkdirSync(home, { recursive: true });
  const well = join(home, "claude-credentials.json");
  writeFileSync(well, wellJson(token, expiresAt));
  const proc = Bun.spawn(["bun", "run", PROBE, "serve"], {
    cwd: ROOT, stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH ?? ""}`,
      APIPLAN_HOME: home, APIPLAN_API_KEY: "",
      APIPLAN_ANTHROPIC_CRED_FILE: well,
      APIPLAN_ANTHROPIC_BASE: VENDOR,
      APIPLAN_CRED_CACHE_MS: String(cacheMs),
      APIPLAN_CODEX_AUTH: ABSENT,
      APIPLAN_GOOGLE_CRED_FILE: ABSENT,
      APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_OLLAMA_BASE: "http://127.0.0.1:9",
      APIPLAN_KEEPALIVE_MS: "0", APIPLAN_TALK_PARK: "0",
      HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    },
  });
  procs.push(proc);
  const rd = proc.stdout.getReader(); let buf = "";
  for (let i = 0; i < 200; i++) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += new TextDecoder().decode(value ?? new Uint8Array());
    const m = buf.match(/READY (\d+)/);
    if (m) return { home, well, base: `http://127.0.0.1:${m[1]}` };
  }
  throw new Error(`the api server never printed READY for ${name}`);
}

/** One non-streaming completion against the anthropic subscription path. */
const call = (w: World) => fetch(`${w.base}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "opus", messages: [{ role: "user", content: "hi" }] }),
});
const health = (w: World) => fetch(`${w.base}/health`).then((r) => r.json());
const anthropicOf = (body: any) => body.providers.find((p: any) => p.id === "anthropic");
/** The verdict ledger as it stands on disk. `{}` while nothing has ever been recorded. */
function outcomes(w: World): any {
  const f = join(w.home, "outcomes.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; }
}

// ── GATE A ──────────────────────────────────────────────────────────────────────────────
describe("GATE A — an externally rotated credential is honoured by the next call", () => {
  test("the call after the rotation succeeds on the new bearer, and nothing is condemned", async () => {
    mode = "ok";
    const w = await world("rotate", "AT-old", DEAD());
    // The snapshot is now filled with the DEAD credential (warmCreds ran before the server
    // listened). One /health proves the premise: this is the world the cache is holding.
    const before = anthropicOf(await health(w));
    expect(before.connected).toBe(false);

    // THE ROTATION, from outside this process — `claude` refreshing its own login.
    writeFileSync(w.well, wellJson("AT-rotated", GOOD()));
    const at = seen.length;
    const r = await call(w);

    // THE GATE: a credential that is valid on disk is not refused because our copy is old.
    expect(r.status).toBe(200);
    // …and it was the NEW bearer that went out, read off the wire, not merely a 200.
    expect(seen.slice(at)).toContain("AT-rotated");
    // THE SECOND GATE: a refusal invented by a stale snapshot is not evidence about the
    // vendor. Whatever the ledger says, it may not say this provider was rejected.
    expect(outcomes(w).anthropic?.ok).not.toBe(false);
    expect(anthropicOf(await health(w)).verified).not.toBe("rejected");
  }, 120_000);
});

// ── GATE B — the counter-gates ──────────────────────────────────────────────────────────
describe("GATE B — a real auth failure is still a 401 and still a recorded rejection", () => {
  test("B1 a genuinely expired credential 401s and records rejected", async () => {
    mode = "ok";                                   // the vendor is fine; the credential is not
    const w = await world("expired", "AT-dead", DEAD());
    const at = seen.length;
    const r = await call(w);

    // THE GATE: no re-read can rescue a credential that is expired in the well, and the
    // fix may not answer 200 by skipping the check.
    expect(r.status).toBe(401);
    // …nothing was ever sent upstream on it.
    expect(seen.length).toBe(at);
    // THE GATE 2: the verdict survives. A fix that stops recording auth failures would pass
    // GATE A and leave /health green on a dead login — the exact false green the outcome
    // mechanism exists to prevent.
    const o = outcomes(w);
    expect(o.anthropic).toBeTruthy();
    expect(o.anthropic.ok).toBe(false);
    expect(anthropicOf(await health(w)).verified).toBe("rejected");
  }, 120_000);

  test("B2 a vendor 401 on a fresh credential 401s and records rejected", async () => {
    mode = "401";                                  // the credential is good; the vendor refuses
    const w = await world("revoked", "AT-revoked", GOOD());
    const at = seen.length;
    const r = await call(w);
    mode = "ok";

    expect(r.status).toBe(401);
    // The vendor was really asked — a re-read may repeat the call, it may not skip it.
    expect(seen.length).toBeGreaterThan(at);
    const o = outcomes(w);
    expect(o.anthropic).toBeTruthy();
    expect(o.anthropic.ok).toBe(false);
    expect(anthropicOf(await health(w)).verified).toBe("rejected");
  }, 120_000);
});
