/**
 * Account pool (src/account-pool.ts): several subscription accounts per provider, switching at
 * 95% of the WEEKLY window (Tami, 2026-10-28). Unit tests drive the pure selector and the pool
 * class directly; the request-path tests (failover, /health, ledger, zero-config) drive a real
 * api.serve() in its own process against a fixture upstream (test/helpers/account-pool-probe.ts).
 * Every token here is a fake string; no vendor is dialled.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountPool, choose, memberFiles, poolAccounts, poolFor, poolLease, resetPools, type Candidate, type PoolMember,
} from "../src/account-pool.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const T = mkdtempSync(join(tmpdir(), "ap-pool-"));
const HOUR = 3600_000;
const anth = (at: string, rt: string, exp = Date.now() + 6 * HOUR) => JSON.stringify({ claudeAiOauth: { accessToken: at, refreshToken: rt, expiresAt: exp } });
const codex = (at: string, rt: string, acct: string) => JSON.stringify({ tokens: { access_token: at, refresh_token: rt, account_id: acct } });

afterAll(() => { try { rmSync(T, { recursive: true, force: true }); } catch {} });

// ─────────────────────────── the selector (pure) ───────────────────────────

describe("choose()", () => {
  const M: Candidate[] = [
    { label: "base", ident: "i0", expired: false },
    { label: "b", ident: "i1", expired: false },
    { label: "c", ident: "i2", expired: false },
  ];
  const now = 1_000_000_000;
  const base = { members: M, now, capped: {}, switchPct: 95, minDwellMs: 600_000, switchedAt: now - 3600_000 };
  const u = (seven_day: number, five_hour = 0) => ({ seven_day, five_hour, at: now });

  test("stays on the active member while its weekly % is below 95", () => {
    const r = choose({ ...base, active: "base", usage: { base: u(94.9), b: u(1), c: u(2) } });
    expect(r).toEqual({ label: "base", reason: "stay" });
  });
  test("at ≥95 switches to the member with the LOWEST weekly %", () => {
    const r = choose({ ...base, active: "base", usage: { base: u(95), b: u(40), c: u(12) } });
    expect(r).toEqual({ label: "c", reason: "switch" });
  });
  test("weekly ties break on 5-hour %, then label order", () => {
    expect(choose({ ...base, active: "base", usage: { base: u(99), b: u(10, 50), c: u(10, 5) } }).label).toBe("c");
    expect(choose({ ...base, active: "base", usage: { base: u(99), b: u(10, 5), c: u(10, 5) } }).label).toBe("b");
  });
  test("an unpolled member ranks after every measured one", () => {
    expect(choose({ ...base, active: "base", usage: { base: u(99), c: u(80) } }).label).toBe("c");
  });
  test("a capped member is skipped, then eligible again once its cap has passed", () => {
    const usage = { base: u(99), b: u(5), c: u(60) };
    const capped = { b: now + 1000 };
    expect(choose({ ...base, active: "base", usage, capped }).label).toBe("c");
    expect(choose({ ...base, active: "base", usage, capped, now: now + 1001 }).label).toBe("b");
  });
  test("minimum dwell holds an over-threshold member unless it is capped", () => {
    const usage = { base: u(97), b: u(5), c: u(6) };
    expect(choose({ ...base, active: "base", usage, switchedAt: now - 60_000 })).toEqual({ label: "base", reason: "dwell" });
    expect(choose({ ...base, active: "base", usage, switchedAt: now - 60_000, capped: { base: now + HOUR } }).label).toBe("b");
    expect(choose({ ...base, active: "base", usage, switchedAt: now - 601_000 }).label).toBe("b");
  });
  test("nobody eligible: keep a working active member, else the one whose cap resets soonest", () => {
    const usage = { base: u(97), b: u(98), c: u(99) };
    expect(choose({ ...base, active: "base", usage }).reason).toBe("none-eligible");
    const capped = { base: now + 3 * HOUR, b: now + 2 * HOUR, c: now + HOUR };
    expect(choose({ ...base, active: "base", usage, capped })).toEqual({ label: "c", reason: "soonest" });
  });
  test("an expired credential is never chosen while another is eligible", () => {
    const members = [M[0], { ...M[1], expired: true }, M[2]];
    expect(choose({ ...base, members, active: "base", usage: { base: u(99), b: u(1), c: u(50) } }).label).toBe("c");
  });
});

// ─────────────────────────── the pool class ───────────────────────────

describe("AccountPool", () => {
  const saved = { ...process.env };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(T, "dir-"));
    process.env.APIPLAN_POOL_STATE = join(dir, "state", "pool-state.json");
    resetPools();
  });
  afterEach(() => {
    for (const k of ["APIPLAN_POOL_STATE", "APIPLAN_ANTHROPIC_POOL_DIR", "APIPLAN_CODEX_POOL_DIR"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetPools();
  });
  const fakeBase = (ident = "baseident01"): PoolMember => ({
    label: "base", base: true,
    creds: () => ({ token: "AT-fake-base", source: "fake" }),
    fp: () => ({ cred: "x", ident, exp: Date.now() + HOUR }),
  });

  test("zero-config: no pool dir ⇒ no pool, no lease, no /health accounts, no state file", () => {
    delete process.env.APIPLAN_ANTHROPIC_POOL_DIR;
    delete process.env.APIPLAN_CODEX_POOL_DIR;
    for (const p of ["anthropic", "openai"]) {
      expect(poolFor(p)).toBeNull();
      expect(poolLease(p)).toBeNull();
      expect(poolAccounts(p)).toBeUndefined();
    }
    // A set-but-empty dir is still single-account.
    process.env.APIPLAN_ANTHROPIC_POOL_DIR = dir;
    expect(poolFor("anthropic")).toBeNull();
    expect(existsSync(process.env.APIPLAN_POOL_STATE!)).toBe(false);
  });

  test("members: base first, then sorted *.json minus dotfiles / RECOVER / tmp files", () => {
    for (const n of ["z.json", "a.json", ".hidden.json", "x.json.RECOVER-1.json", "y.json.tmp-9", "notes.txt"]) writeFileSync(join(dir, n), anth("AT-" + n, "RT-" + n));
    expect(memberFiles(dir).map((f) => f.slice(dir.length + 1))).toEqual(["a.json", "z.json"]);
    const p = new AccountPool("anthropic", dir, fakeBase());
    expect(p.members().map((m) => m.label)).toEqual(["base", "a", "z"]);
  });

  test("a member file is re-read when its mtime changes", () => {
    const f = join(dir, "b.json");
    writeFileSync(f, anth("AT-fake-1", "RT-fake-1"));
    const p = new AccountPool("anthropic", dir, fakeBase());
    const m = p.members()[1];
    const before = m.fp().ident;
    expect(m.creds().token).toBe("AT-fake-1");
    writeFileSync(f, anth("AT-fake-2", "RT-fake-2"));
    const later = new Date(Date.now() + 5000);
    utimesSync(f, later, later);
    expect(m.creds().token).toBe("AT-fake-2");
    expect(m.fp().ident).not.toBe(before);
  });

  test("usage at ≥95 weekly moves the active member; a full window caps until its reset", () => {
    process.env.APIPLAN_POOL_MIN_DWELL_S = "0";
    try {
      writeFileSync(join(dir, "b.json"), anth("AT-fake-b", "RT-fake-b"));
      writeFileSync(join(dir, "c.json"), anth("AT-fake-c", "RT-fake-c"));
      const p = new AccountPool("anthropic", dir, fakeBase());
      const [, b, c] = p.members();
      const win = (pct: number, resets: string | null = null) => ({ used_percent: pct, resets_at: resets });
      const usage = (d7: number, h5 = 1) => ({ account: null, five_hour: win(h5), seven_day: win(d7), extra: {}, source: "t", fetched_at: "" });
      expect(p.select().label).toBe("base");
      p.recordUsage("base", usage(96));
      p.recordUsage(b.label, usage(30));
      p.recordUsage(c.label, usage(10));
      expect(p.select().label).toBe("c");
      const reset = new Date(Date.now() + 2 * HOUR).toISOString();
      p.recordUsage(c.label, { ...usage(50), five_hour: win(100, reset) });
      expect(p.select().label).toBe("b");
      const acc = p.accounts();
      expect(acc.find((a) => a.label === "c")!.capped_until).toBe(reset);
      expect(acc.find((a) => a.label === "b")!.active).toBe(true);
      const st = JSON.parse(readFileSync(process.env.APIPLAN_POOL_STATE!, "utf8"));
      expect(st.providers.anthropic.active).toBe("b");
      expect(JSON.stringify(st)).not.toContain("AT-fake");
    } finally { delete process.env.APIPLAN_POOL_MIN_DWELL_S; }
  });
});

describe("pool state is keyed by member label", () => {
  const saved = process.env.APIPLAN_POOL_STATE;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(T, "lbl-"));
    mkdirSync(join(dir, "state"));
    process.env.APIPLAN_POOL_STATE = join(dir, "state", "pool-state.json");
    resetPools();
  });
  afterEach(() => { if (saved === undefined) delete process.env.APIPLAN_POOL_STATE; else process.env.APIPLAN_POOL_STATE = saved; resetPools(); });
  const fakeBase: PoolMember = { label: "base", base: true, creds: () => ({ token: "AT-fake-base", source: "fake" }), fp: () => ({ cred: "x", ident: "baseident01", exp: Date.now() + HOUR }) };

  test("a member whose file is rewritten with a NEW refresh token keeps its capped-until and usage", () => {
    const f = join(dir, "b.json");
    writeFileSync(f, anth("AT-fake-b1", "RT-fake-b1"));
    const p = new AccountPool("anthropic", dir, fakeBase);
    const b = p.members()[1];
    const identBefore = b.fp().ident;
    const until = Date.now() + 2 * HOUR;
    p.markCapped("b", until);
    p.recordUsage("b", { account: null, five_hour: { used_percent: 12, resets_at: null }, seven_day: { used_percent: 41, resets_at: null }, extra: {}, source: "t", fetched_at: "" });
    // The external refresher rotates the refresh token: a new ident, the same member.
    writeFileSync(f, anth("AT-fake-b2", "RT-fake-b2"));
    const later = new Date(Date.now() + 5000);
    utimesSync(f, later, later);
    expect(b.fp().ident).not.toBe(identBefore);
    const a = p.accounts().find((x) => x.label === "b")!;
    expect(a.ident).toBe(b.fp().ident);
    expect(a.capped_until).toBe(new Date(until).toISOString());
    expect(a.seven_day).toBe(41);
    expect(a.five_hour).toBe(12);
    // …and survives a restart (fresh in-memory state, same file).
    resetPools();
    const again = new AccountPool("anthropic", dir, fakeBase).accounts().find((x) => x.label === "b")!;
    expect([again.capped_until, again.seven_day]).toEqual([new Date(until).toISOString(), 41]);
  });

  test("an old ident-keyed (v1) pool-state.json is migrated: active kept, ident entries ignored", () => {
    writeFileSync(join(dir, "b.json"), anth("AT-fake-b", "RT-fake-b"));
    writeFileSync(process.env.APIPLAN_POOL_STATE!, JSON.stringify({ v: 1,
      providers: { anthropic: { active: "b", switched_at: 1 } },
      capped: { baseident01: Date.now() + HOUR }, usage: { baseident01: { seven_day: 99, at: 1 } } }));
    const p = new AccountPool("anthropic", dir, fakeBase);
    const acc = p.accounts();
    expect(acc.map((a) => [a.label, a.active, a.capped_until, a.seven_day])).toEqual([["base", false, null, null], ["b", true, null, null]]);
  });
});

describe("APIPLAN_POOL_STRATEGY", () => {
  const saved = { st: process.env.APIPLAN_POOL_STATE, strat: process.env.APIPLAN_POOL_STRATEGY };
  let dir: string;
  let p: AccountPool;
  const fakeBase: PoolMember = { label: "base", base: true, creds: () => ({ token: "AT-fake-base", source: "fake" }), fp: () => ({ cred: "x", ident: "baseident01", exp: Date.now() + HOUR }) };
  beforeEach(() => {
    dir = mkdtempSync(join(T, "strat-"));
    mkdirSync(join(dir, "state"));
    process.env.APIPLAN_POOL_STATE = join(dir, "state", "pool-state.json");
    resetPools();
    writeFileSync(join(dir, "b.json"), anth("AT-fake-sb", "RT-fake-sb"));
    writeFileSync(join(dir, "c.json"), anth("AT-fake-sc", "RT-fake-sc"));
    p = new AccountPool("anthropic", dir, fakeBase);
  });
  afterEach(() => {
    if (saved.st === undefined) delete process.env.APIPLAN_POOL_STATE; else process.env.APIPLAN_POOL_STATE = saved.st;
    if (saved.strat === undefined) delete process.env.APIPLAN_POOL_STRATEGY; else process.env.APIPLAN_POOL_STRATEGY = saved.strat;
    resetPools();
  });
  const keys = Array.from({ length: 60 }, (_, i) => `conv-${i}`);

  test("default (headroom) is unchanged: every request, every key, the one active member", () => {
    delete process.env.APIPLAN_POOL_STRATEGY;
    expect(new Set(keys.map((k) => p.lease(k).label))).toEqual(new Set(["base"]));
    expect(p.lease().label).toBe("base");
  });

  test("sticky: the same key always maps to the same member; different keys spread", () => {
    process.env.APIPLAN_POOL_STRATEGY = "sticky";
    const first = keys.map((k) => p.lease(k).label);
    expect(keys.map((k) => p.lease(k).label)).toEqual(first);
    expect(new Set(first).size).toBe(3);
    // No key at all ⇒ headroom's active member.
    expect(p.lease().label).toBe("base");
  });

  test("sticky: a capped member is skipped, and only its conversations move", () => {
    process.env.APIPLAN_POOL_STRATEGY = "sticky";
    const before = keys.map((k) => p.lease(k).label);
    p.markCapped("b", Date.now() + HOUR);
    const after = keys.map((k) => p.lease(k).label);
    expect(after).not.toContain("b");
    keys.forEach((_, i) => { if (before[i] !== "b") expect(after[i]).toBe(before[i]); });
  });

  test("round-robin cycles over the eligible members, skipping a capped one", () => {
    process.env.APIPLAN_POOL_STRATEGY = "round-robin";
    expect(Array.from({ length: 6 }, () => p.lease("same-conv").label)).toEqual(["base", "b", "c", "base", "b", "c"]);
    p.markCapped("c", Date.now() + HOUR);
    const next = Array.from({ length: 4 }, () => p.lease("same-conv").label);
    expect(next).not.toContain("c");
    expect(new Set(next)).toEqual(new Set(["base", "b"]));
  });

  test("≥95% weekly is excluded under every strategy", () => {
    const usage = (d7: number) => ({ account: null, five_hour: { used_percent: 1, resets_at: null }, seven_day: { used_percent: d7, resets_at: null }, extra: {}, source: "t", fetched_at: "" });
    p.recordUsage("b", usage(97));
    for (const strat of ["sticky", "round-robin"]) {
      process.env.APIPLAN_POOL_STRATEGY = strat;
      expect(keys.map((k) => p.lease(k).label)).not.toContain("b");
    }
  });
});

// ─────────────────────────── the request path, in a real server ───────────────────────────

type Probe = { proc: ReturnType<typeof Bun.spawn>; api: string; fx: string; home: string };
async function startProbe(name: string, pooled: boolean): Promise<Probe> {
  const root = join(T, name);
  const home = join(root, "home");
  mkdirSync(join(root, "apool"), { recursive: true });
  mkdirSync(join(root, "cpool"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, "anth-base.json"), anth("AT-fake-anth-base", "RT-fake-anth-base"));
  writeFileSync(join(root, "codex-base.json"), codex("AT-fake-codex-base", "RT-fake-codex-base", "acct-base"));
  writeFileSync(join(root, "apool", "b.json"), anth("AT-fake-anth-b", "RT-fake-anth-b"));
  writeFileSync(join(root, "cpool", "b.json"), codex("AT-fake-codex-b", "RT-fake-codex-b", "acct-b"));
  const proc = Bun.spawn(["bun", join(HERE, "helpers", "account-pool-probe.ts")], {
    env: {
      ...process.env,
      APIPLAN_HOME: home,
      APIPLAN_API_KEY: "",
      APIPLAN_ANTHROPIC_CRED_FILE: join(root, "anth-base.json"),
      APIPLAN_CODEX_AUTH: join(root, "codex-base.json"),
      APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_CRED_FILE: join(root, "no-such-google.json"),
      APIPLAN_USAGE_ANTHROPIC_SOURCE: "headers",
      APIPLAN_POOL_STATE: "",
      APIPLAN_ANTHROPIC_POOL_DIR: pooled ? join(root, "apool") : "",
      APIPLAN_CODEX_POOL_DIR: pooled ? join(root, "cpool") : "",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 30_000;
  while (!buf.includes("\n") && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  const m = /READY (\d+) (\d+)/.exec(buf);
  if (!m) throw new Error(`probe never became ready: ${buf}\n${await new Response(proc.stderr).text()}`);
  return { proc, api: `http://127.0.0.1:${m[1]}`, fx: `http://127.0.0.1:${m[2]}`, home };
}
const arm = (p: Probe, f: unknown) => fetch(`${p.fx}/__fixture`, { method: "POST", body: JSON.stringify(f) });
const hitsOf = async (p: Probe): Promise<string[]> => (await fetch(`${p.fx}/__hits`)).json() as Promise<string[]>;
const ask = (p: Probe, model: string) => fetch(`${p.api}/v1/messages`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] }),
});
const health = async (p: Probe, id: string) => ((await (await fetch(`${p.api}/health`)).json()) as any).providers.find((x: any) => x.id === id);
const ledger = (p: Probe) => {
  const f = join(p.home, "usage-ledger.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe("serve with an account pool", () => {
  let p: Probe;
  beforeAll(async () => {
    p = await startProbe("pooled", true);
    // base 10% weekly, b 20%: the poller keeps base active.
    await arm(p, { usage: { "AT-fake-anth-base": [0.05, 0.10], "AT-fake-anth-b": [0.05, 0.20] } });
  });
  afterAll(() => { try { p.proc.kill(); } catch {} });

  test("429 before the first byte ⇒ one retry on the next member", async () => {
    await arm(p, { mode: { "AT-fake-anth-base": "429" } });
    const r = await ask(p, "opus");
    expect(r.status).toBe(200);
    expect(await hitsOf(p)).toEqual(["AT-fake-anth-base", "AT-fake-anth-b"]);
    // The ledger names the member that served.
    await Bun.sleep(50);
    expect(ledger(p).at(-1)).toMatchObject({ status: 200, provider: "anthropic", account: "b" });
  });

  test("/health accounts: labels, hashes and percentages — no secret fields", async () => {
    const h = await health(p, "anthropic");
    expect(Array.isArray(h.accounts)).toBe(true);
    for (const a of h.accounts) expect(Object.keys(a).sort()).toEqual(["active", "capped_until", "five_hour", "ident", "label", "seven_day"]);
    expect(h.accounts.map((a: any) => [a.label, a.active])).toEqual([["base", false], ["b", true]]);
    expect(h.accounts[0].capped_until).toBeString();
    expect(h.accounts[0].ident).toMatch(/^[0-9a-f]{12}$/);
    const body = await (await fetch(`${p.api}/health`)).text();
    expect(body).not.toContain("AT-fake");
    expect(body).not.toContain("RT-fake");
  });

  test("429 after bytes were yielded ⇒ no retry", async () => {
    await arm(p, { mode: { "AT-fake-anth-b": "midstream429" } });
    const r = await ask(p, "opus");
    await r.text();
    expect(await hitsOf(p)).toEqual(["AT-fake-anth-b"]);
  });

  test("Codex usage_limit_reached fails over to the next member with its own account id", async () => {
    await arm(p, { mode: { "AT-fake-codex-base": "429" } });
    const r = await ask(p, "gpt-6-astra");
    expect(r.status).toBe(200);
    expect(await hitsOf(p)).toEqual(["AT-fake-codex-base", "AT-fake-codex-b"]);
    expect((await health(p, "openai")).accounts.find((a: any) => a.active).label).toBe("b");
  });

  test("both members capped ⇒ the refusal surfaces after exactly one retry", async () => {
    await arm(p, { mode: { "AT-fake-anth-base": "429", "AT-fake-anth-b": "429" } });
    const r = await ask(p, "opus");
    expect(r.status).toBe(429);
    // b is active; it is refused, base is capped already ⇒ no other member ⇒ no retry at all.
    expect(await hitsOf(p)).toEqual(["AT-fake-anth-b"]);
  });
});

describe("serve without a pool (zero-config)", () => {
  let p: Probe;
  beforeAll(async () => { p = await startProbe("plain", false); });
  afterAll(() => { try { p.proc.kill(); } catch {} });

  test("single account: no accounts on /health, no account in the ledger, no retry on 429, no state", async () => {
    for (const id of ["anthropic", "openai"]) expect("accounts" in (await health(p, id))).toBe(false);
    await arm(p, {});
    expect((await ask(p, "opus")).status).toBe(200);
    await arm(p, { mode: { "AT-fake-anth-base": "429" } });
    expect((await ask(p, "opus")).status).toBe(429);
    expect(await hitsOf(p)).toEqual(["AT-fake-anth-base"]);
    await Bun.sleep(50);
    const lines = ledger(p);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect("account" in l).toBe(false);
    expect(existsSync(join(p.home, "pool-state.json"))).toBe(false);
  });
});
