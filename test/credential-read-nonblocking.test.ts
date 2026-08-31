/**
 * GATES 1-2 — THE CREDENTIAL READ SURFACE MAY NOT BLOCK A RESIDENT REQUEST PATH.
 *
 * THE SHAPE, ONE ROUND LATER. Wave 9 gated the MINT: no synchronous OAuth call inside a
 * request (test/resident-nonblocking.test.ts). Round six found the same shape underneath
 * it, in the PLAIN READS — the ones that happen on every single /health, no vendor
 * involved:
 *
 *   readAnthropicRaw()  Bun.spawnSync(["security", …])   the Keychain, untimed
 *   readGoogleOnce()    Bun.spawnSync(["security", …])   the Keychain, untimed
 *   readGoogle()        Bun.sleepSync(80) × 2            a retry sleep, on the request path
 *
 * On a single-threaded server a synchronous read is not "a few milliseconds each" — it is a
 * QUEUE. Measured on his box before the fix: 10 parallel /health took 0.83 s in a perfect
 * staircase, and /v1/models went from 0.0008 s idle to 0.479 s under that load. And the tens
 * of milliseconds are the GOOD case: `security` has no timeout, so a locked Keychain (or one
 * putting up a prompt) turns every request behind it into seconds of total stall.
 *
 * TWO GATES, deliberately of different kinds, because each catches what the other cannot:
 *
 *   1 STATIC — no `Bun.sleepSync` and no UNBOUNDED `Bun.spawnSync` anywhere reachable from
 *     the credential-read surface a resident request touches (every provider's probe() and
 *     credFp(), plus /health's own verdict machinery). A static gate is the kind that
 *     survives: it fails for the NEXT read added, on the machine of whoever adds it, without
 *     needing that reader to be slow on the day the suite runs. It matches the ACT (the call
 *     site, and whether that call site carries a bound) — never a token, never a comment.
 *
 *   2 BEHAVIOURAL — N parallel /health against a real server whose `security` binary is a
 *     STUB that sleeps. Serialised reads staircase; a cached read does not. The stub is a
 *     script on PATH: his real Keychain is never touched, never unlocked, never disabled.
 *
 * NOTHING REACHES A VENDOR AND NOTHING TOUCHES THE REAL KEYCHAIN. Every probe subprocess
 * runs with HTTPS_PROXY/HTTP_PROXY at a dead port, NO_PROXY=127.0.0.1, credential paths
 * pointed at stub files under a temp dir, both Keychain service names pointed at a service
 * that does not exist, and PATH prefixed with the stub `security`.
 */
import { expect, test, describe, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "src");
const PROBE = join(HERE, "helpers", "apiplan-probe.ts");
const DIR = mkdtempSync(join(tmpdir(), "ap-m2-read-"));
const HOME = join(DIR, "home"); mkdirSync(HOME, { recursive: true });
const BIN = join(DIR, "bin"); mkdirSync(BIN, { recursive: true });
const MODE = join(DIR, "security-mode");          // fast | slow | hang — read per invocation
const CRED = join(DIR, "g.json");
const ACRED = join(DIR, "a.json");
const ABSENT = join(DIR, "no-such-credential.json");

// ── GATE 1: the static sweep ────────────────────────────────────────────────────────────
/**
 * A crude but honest call graph over the three files a resident request actually reads
 * credentials through. Comments are STRIPPED first, so neither this rule's own docs nor a
 * comment mentioning `Bun.sleepSync` can satisfy or trip it; only real call sites count.
 * Definitions are top-level functions/consts and the 2-space-indented provider methods —
 * the shapes this codebase is written in.
 */
const GRAPH_FILES = ["providers.ts", "providers-ollama.ts", "api.ts"];
/** Everything a resident host runs on the way to answering /health, and on the way to
 *  deciding WHICH credential a verdict belongs to. The mint/refresh path is not here: it is
 *  gated at runtime by `providerRuntime.syncRefresh` and is already covered, behaviourally
 *  and structurally, by resident-nonblocking.test.ts. */
const ROOTS = ["probe", "credFp", "health", "credOf", "verdictFor"];
const KEYWORD = new Set(["if", "for", "while", "switch", "catch", "return", "function", "typeof", "new", "await", "do", "else", "try"]);

type Def = { name: string; file: string; body: string };

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
}
/** The BODY brace — not a return-type object literal (`function f(): { a: b } | null {`).
 *  A body brace is followed by a newline in this codebase; an inline type literal is not. */
function braceBody(code: string, from: number): string | null {
  let open = -1;
  for (let i = from; i < code.length; i++) {
    if (code[i] !== "{") continue;
    if (/^[ \t]*\n/.test(code.slice(i + 1))) { open = i; break; }
  }
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return code.slice(open, i + 1); }
  }
  return null;
}
/**
 * `const readAnthropicRaw = residentCache(readAnthropicRawSync, readAnthropicRawFresh)`.
 * A resident host reads through the SECOND half — the async one — because the first is the
 * CLI's direct path and the one cold fill that warmCreds() does before the host accepts
 * anything. The graph follows the resident half, so a reader added behind this wrapper is
 * still swept; the behavioural gates below are what catch a wrapper that stops meaning this.
 */
function aliases(srcDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of GRAPH_FILES) {
    const code = stripComments(readFileSync(join(srcDir, f), "utf8").replace(/\r\n?/g, "\n"));
    for (const m of code.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*residentCache\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\s*\)/gm)) {
      out.set(m[1], [m[2]]);
    }
  }
  return out;
}
function definitions(srcDir: string): Def[] {
  const defs: Def[] = [];
  for (const f of GRAPH_FILES) {
    const code = stripComments(readFileSync(join(srcDir, f), "utf8").replace(/\r\n?/g, "\n"));
    const add = (name: string, body: string | null) => { if (body && !KEYWORD.has(name)) defs.push({ name, file: f, body }); };
    for (const m of code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/gm)) add(m[1], braceBody(code, m.index!));
    for (const m of code.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm)) {
      const arrow = code.indexOf("=>", m.index!); if (arrow < 0) continue;
      const rest = code.slice(arrow + 2);
      add(m[1], /^\s*\{\s*\n/.test(rest) ? braceBody(code, arrow + 2) : rest.slice(0, Math.max(rest.search(/;\s*\n/), 0) + 1));
    }
    for (const m of code.matchAll(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{\n]+)?\{/gm)) add(m[1], braceBody(code, m.index!));
  }
  return defs;
}
function reachable(srcDir: string): Def[] {
  const defs = definitions(srcDir);
  const alias = aliases(srcDir);
  const seen = new Set<string>(); const out: Def[] = [];
  const expand = (n: string): string[] => alias.get(n) ?? [n];
  const queue: { name: string; from?: string }[] = ROOTS.flatMap((n) => expand(n)).map((name) => ({ name }));
  while (queue.length) {
    const { name, from } = queue.pop()!;
    const local = defs.filter((d) => d.name === name && d.file === from);
    for (const d of (local.length ? local : defs.filter((d) => d.name === name))) {
      const k = `${d.file}:${d.name}:${d.body.length}`;
      if (seen.has(k)) continue; seen.add(k); out.push(d);
      for (const line of d.body.split("\n")) {
        // A call the CLI-vs-resident switch guards is not on a resident path — that flag IS
        // the mechanism (R-1) by which a blocking read stays in the one-shot process.
        if (/providerRuntime\s*\.\s*syncRefresh/.test(line)) continue;
        for (const c of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
          if (!KEYWORD.has(c[1])) for (const n of expand(c[1])) queue.push({ name: n, from: d.file });
        }
      }
    }
  }
  return out;
}
/** The text of one call, from `Bun.spawnSync(` to its matching `)`, so a bound is judged on
 *  the CALL rather than on the file it happens to live in. */
function callSite(code: string, from: number): string {
  let d = 0;
  for (let i = code.indexOf("(", from); i < code.length; i++) {
    if (code[i] === "(") d++;
    else if (code[i] === ")") { d--; if (d === 0) return code.slice(from, i + 1); }
  }
  return code.slice(from);
}
function blockingOffenders(srcDir: string): string[] {
  const bad: string[] = [];
  for (const d of reachable(srcDir)) {
    if (/\bBun\.sleepSync\s*\(/.test(d.body)) bad.push(`${d.file}:${d.name} — Bun.sleepSync on the read surface`);
    for (const m of d.body.matchAll(/\bBun\.spawnSync\s*\(/g)) {
      const site = callSite(d.body, m.index!);
      // BOUNDED means bounded, however it is expressed: a `timeout:` in the spawn options,
      // or the child's own hard deadline flag (`-m` — what the ollama probe's curl uses).
      if (!/\btimeout\s*:/.test(site) && !/["']-m["']/.test(site)) {
        bad.push(`${d.file}:${d.name} — unbounded Bun.spawnSync :: ${site.slice(0, 72).replace(/\s+/g, " ")}`);
      }
    }
  }
  return bad;
}

describe("GATE 1 — nothing on the credential READ surface blocks without a bound", () => {
  test("the sweep actually reaches the readers (a graph that reaches nothing proves nothing)", () => {
    const reach = reachable(SRC);
    const names = new Set(reach.map((d) => `${d.file}:${d.name}`));
    // PREMISES, written about the WORK the graph must reach rather than the names it is
    // reached under — a reader may be renamed or wrapped, and a gate that pins names goes
    // quietly dead the day it is. Without these a walker that resolved nothing would report
    // an empty offender list and pass for ever.
    for (const must of ["api.ts:health", "api.ts:verdictFor", "api.ts:credOf", "providers.ts:probe", "providers.ts:credFp"]) {
      expect([...names].join(" ")).toContain(must);
    }
    const bodies = reach.map((d) => d.body).join("\n");
    expect(bodies).toContain("readFileSync");          // it reaches the file wells
    expect(bodies).toContain('"security"');            // …and the Keychain machinery
    expect(names.size).toBeGreaterThan(12);
  });

  test("no Bun.sleepSync and no unbounded Bun.spawnSync is reachable from probe()/credFp()/health()", () => {
    // THE GATE. Pre-fix this reports three: readGoogle's sleepSync retry and the two untimed
    // `security` reads. A read that must stay synchronous may keep its spawnSync — with a
    // hard timeout, so a locked Keychain costs a bounded wait instead of the process.
    expect(blockingOffenders(SRC)).toEqual([]);
  });
});

// ── GATE 2: the behavioural half ────────────────────────────────────────────────────────
/**
 * A STUB `security` on PATH. His real Keychain is never read, never unlocked, never
 * disabled — the stub simply is what the child process finds first. It answers 44
 * ("no such item", the one exit code that means signed out) after a delay it reads from a
 * file, so the same running server can be made slow, or made to hang, mid-life.
 */
writeFileSync(MODE, "slow");
writeFileSync(join(BIN, "security"), `#!/bin/sh
# test stub — never touches the real Keychain
case "$(cat ${JSON.stringify(MODE)} 2>/dev/null)" in
  hang) sleep 120 ;;
  slow) sleep 0.30 ;;
esac
exit 44
`);
chmodSync(join(BIN, "security"), 0o755);

// A perfectly usable anthropic credential FILE, so the keychain miss falls through to it and
// the provider is connected: the point of measurement is the READ, not a red provider.
writeFileSync(ACRED, JSON.stringify({ claudeAiOauth: { accessToken: "AT-anthropic-stub", refreshToken: "RT-anthropic-stub", expiresAt: Date.now() + 6 * 3600_000, subscriptionType: "stub" } }));
writeFileSync(CRED, JSON.stringify({ auth_method: "consumer", token: { access_token: "AT-google-stub", refresh_token: "RT-google-stub", token_type: "Bearer", expiry: new Date(Date.now() + 6 * 3600_000).toISOString() } }));

const ENV = () => ({
  ...process.env,
  PATH: `${BIN}:${process.env.PATH ?? ""}`,
  APIPLAN_HOME: HOME, APIPLAN_API_KEY: "",
  APIPLAN_ANTHROPIC_CRED_FILE: ACRED,
  APIPLAN_CODEX_AUTH: ABSENT,
  // google reads the KEYCHAIN when no cred file is set — which is the read under test on
  // both providers. The stub answers 44, so google is simply disconnected here; /health
  // still performs the read, which is the whole point.
  APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
  APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
  APIPLAN_OLLAMA_BASE: "http://127.0.0.1:9",
  APIPLAN_KEEPALIVE_MS: "0", APIPLAN_TALK_PARK: "0",
  HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
});

let server: any = null;
let base = "";
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", PROBE, "serve"], { cwd: ROOT, env: ENV(), stdout: "pipe", stderr: "pipe" });
  const rd = server.stdout.getReader(); let buf = "";
  for (let i = 0; i < 200; i++) {
    const { value } = await rd.read();
    buf += new TextDecoder().decode(value ?? new Uint8Array());
    const m = buf.match(/READY (\d+)/); if (m) { base = `http://127.0.0.1:${m[1]}`; break; }
  }
  if (!base) throw new Error("the api server never printed READY");
});
afterAll(() => {
  try { server?.kill(); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

const ms = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return performance.now() - t; };
const hit = (path = "/health") => fetch(`${base}${path}`).then((r) => r.text());

describe("GATE 2 — concurrent requests do not serialise behind a credential read", () => {
  test("10 parallel /health finish in a small multiple of one, not in a staircase", async () => {
    writeFileSync(MODE, "slow");
    for (let i = 0; i < 3; i++) await hit();                 // warm: the first request of any
    const singles: number[] = [];                            // process pays for module load
    for (let i = 0; i < 3; i++) singles.push(await ms(hit));
    const one = singles.sort((a, b) => a - b)[1];            // median of three

    const N = 10;
    const wall = await ms(() => Promise.all(Array.from({ length: N }, () => hit())));

    // THE GATE, written as a MULTIPLE of this machine's own single-request time rather than
    // as a constant: a slow box does not fail it and a fast box does not excuse a staircase.
    // Serialised, N requests cost N × one (pre-fix: 10 × ~0.32 s = 3.2 s). Concurrent, they
    // cost about one. The floor keeps a machine whose reads are already instant from being
    // held to a microsecond budget.
    const bar = Math.max(600, one * 3);
    expect(wall).toBeLessThan(bar);
  }, 120_000);

  test("a Keychain that HANGS mid-life cannot stall the server", async () => {
    writeFileSync(MODE, "slow");
    await hit();                                             // the server has read once, warm
    writeFileSync(MODE, "hang");                             // …and now `security` never returns
    try {
      const t = await ms(hit);
      // THE GATE: a credential source that stops answering is not this service's latency.
      // A cached read answers now and refreshes behind the request; a bounded one waits for
      // its bound. Neither is 120 s.
      expect(t).toBeLessThan(15_000);
    } finally { writeFileSync(MODE, "slow"); }
  }, 60_000);
});
