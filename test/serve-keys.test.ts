// serve-keys.test.ts — per-device/project keys for `apiplan serve` and the per-key usage ledger.
//
// Three layers:
//   1. the store + pricing + ledger arithmetic, as plain functions;
//   2. the auth gate against an in-process serve() (no backend needed: /v1/models, and a
//      request refused on an unknown model, which is still ledgered);
//   3. real metered calls through a CHILD serve() whose Codex backend is a loopback stub playing
//      scripted Responses events — both caller dialects, stream and non-stream — asserting the
//      ledger line, its cost, that no key or prompt text reaches it, and per-key isolation on
//      GET /v1/usage/keys. A child because api.ts/registry.ts read APIPLAN_HOME at import time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKey, revokeKey, readStore, keyCache, costUsd, parseWindow, totalsByKey, readLedger, type LedgerLine } from "../src/serve-keys.ts";
import { serve } from "../src/api.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DIR = mkdtempSync(join(tmpdir(), "ap-serve-keys-"));
for (const k of ["APIPLAN_SERVE_KEY", "APIPLAN_API_KEY", "APIPLAN_SERVE_KEY_FILE", "APIPLAN_SERVE_OPEN", "APIPLAN_SERVE_KEYS_FILE"]) delete process.env[k];

describe("the key store", () => {
  test("a key is apk_<id>_<32 url-safe>, printed once, stored ONLY as a sha256 hash, file mode 0600", () => {
    const file = join(DIR, "unit", "keys.json");
    const { record, key } = createKey("  laptop  ", file);
    expect(key).toMatch(/^apk_[a-z0-9]{8}_[A-Za-z0-9_-]{32}$/);
    expect(key.startsWith(`apk_${record.id}_`)).toBe(true);
    expect(record.label).toBe("laptop");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(key);
    expect(raw).not.toContain(key.slice(`apk_${record.id}_`.length));
    const stored = readStore(file).keys[0] as any;
    expect(Object.keys(stored).sort()).toEqual(["created_at", "id", "label", "sha256"]);
    expect(stored.sha256).toBe(new Bun.CryptoHasher("sha256").update(key).digest("hex"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => createKey("   ", file)).toThrow(/label/);
  });

  test("match: right key → its record; wrong secret, unknown id, junk → null; revoke is picked up live", () => {
    const file = join(DIR, "unit2", "keys.json");
    const a = createKey("a", file), b = createKey("b", file);
    const cache = keyCache(file);
    expect(cache.activeCount()).toBe(2);
    expect(cache.match(a.key)?.id).toBe(a.record.id);
    expect(cache.match(b.key)?.label).toBe("b");
    const flipped = a.key.slice(0, -1) + (a.key.endsWith("A") ? "B" : "A");
    expect(cache.match(flipped)).toBeNull();
    expect(cache.match(`apk_zzzzzzzz_${a.key.slice(-32)}`)).toBeNull();
    expect(cache.match("not-needed")).toBeNull();
    expect(cache.match("")).toBeNull();
    revokeKey(a.record.id, file);
    expect(cache.match(a.key)).toBeNull();
    expect(cache.activeCount()).toBe(1);
    expect(readStore(file).keys.find((k) => k.id === a.record.id)?.revoked_at).toBeTruthy();
    expect(() => revokeKey("nope1234", file)).toThrow(/no key/);
  });
});

describe("cost and totals", () => {
  test("priced from the roster's published cards, cache-aware and long-context-aware", () => {
    // claude-sonnet-5-5: $2 in / $10 out / $0.20 cache read / $2.50 cache write per MTok.
    expect(costUsd("claude-sonnet-5-5", { input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 2000 }))
      .toBeCloseTo((1000 * 2 + 100 * 10 + 10_000 * 0.2 + 2000 * 2.5) / 1e6, 10);
    // a stated 1h write share is priced at 2x input
    expect(costUsd("claude-sonnet-5-5", { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 1000 })).toBeCloseTo(1000 * 4 / 1e6, 10);
    // gpt-6.1-sol: $2 / $10 / $0.10 read; over 272K prompt the whole request moves to 4 / 15 / 0.2
    expect(costUsd("gpt-6.1-sol", { input: 200, output: 30, cacheRead: 1000, cacheWrite: 0 })).toBeCloseTo(0.0008, 10);
    expect(costUsd("gpt-6.1-sol", { input: 300_000, output: 10, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo((300_000 * 4 + 10 * 15) / 1e6, 10);
    expect(costUsd("no-such-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
  test("windows and per-key totals", () => {
    expect(parseWindow("24h")).toBe(86_400_000);
    expect(parseWindow("7d")).toBe(7 * 86_400_000);
    expect(parseWindow("all")).toBe(0);
    expect(() => parseWindow("yesterday")).toThrow(/window/);
    const l = (key_id: string, extra: Partial<LedgerLine> = {}): LedgerLine => ({ ts: "2026-10-01T00:00:00.000Z", key_id, label: key_id, route: "/v1/messages",
      provider: "openai", model: "gpt-6.1-sol", stream: false, status: 200, input_tokens: 10, output_tokens: 5, cache_read_tokens: 1, cache_write_tokens: 0,
      cost_usd: 0.001, latency_ms: 5, ...extra });
    const t = totalsByKey([l("a"), l("a", { status: 502, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 }), l("b")]);
    const a = t.find((x) => x.key_id === "a")!;
    expect(a).toMatchObject({ requests: 2, errors: 1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 1, total_tokens: 16, cost_usd: 0.001 });
    expect(totalsByKey([l("a"), l("b")], (k) => k === "b").map((x) => x.key_id)).toEqual(["b"]);
  });
});

describe("the gate (in-process serve)", () => {
  const keysFile = join(DIR, "gate", "keys.json");
  const ledger = join(DIR, "gate", "ledger.jsonl");
  let k1 = "", k1id = "", k2 = "";
  beforeAll(() => { process.env.APIPLAN_USAGE_LEDGER = ledger; const a = createKey("dev-a", keysFile); k1 = a.key; k1id = a.record.id; k2 = createKey("dev-b", keysFile).key; });
  afterAll(() => { delete process.env.APIPLAN_USAGE_LEDGER; delete process.env.APIPLAN_SERVE_OPEN; });

  test("store keys are required once one exists; Bearer and x-api-key both work; wrong/placeholder/revoked → 401", async () => {
    const s = serve({ port: 0, host: "127.0.0.1", keysFile });
    try {
      expect(s.tokenRequired).toBe(true);
      const get = (h: Record<string, string> = {}) => fetch(`${s.url}/v1/models`, { headers: h });
      expect((await get()).status).toBe(401);
      expect((await get({ authorization: "Bearer not-needed" })).status).toBe(401);
      expect((await get({ authorization: `Bearer ${k1}` })).status).toBe(200);
      expect((await get({ "x-api-key": k2 })).status).toBe(200);
      expect((await get({ authorization: `Bearer ${k1.slice(0, -2)}xx` })).status).toBe(401);
      revokeKey(k1id, keysFile);
      expect((await get({ authorization: `Bearer ${k1}` })).status).toBe(401);
      expect((await get({ "x-api-key": k2 })).status).toBe(200);
      // public liveness still answers without a key
      expect(((await (await fetch(`${s.url}/health`)).json()) as any).auth).toBe("required");
    } finally { s.stop(); }
  });

  test("the legacy single key keeps working beside the store, attributed 'legacy'", async () => {
    const s = serve({ port: 0, host: "127.0.0.1", keysFile, token: "legacy-secret" });
    try {
      expect((await fetch(`${s.url}/v1/models`, { headers: { authorization: "Bearer legacy-secret" } })).status).toBe(200);
      expect((await fetch(`${s.url}/v1/models`, { headers: { "x-api-key": k2 } })).status).toBe(200);
      const r = await fetch(`${s.url}/v1/messages`, { method: "POST", headers: { "x-api-key": "legacy-secret", "content-type": "application/json" },
        body: JSON.stringify({ model: "no-such-model-xyz", max_tokens: 5, messages: [{ role: "user", content: "hello PROMPT-GATE" }] }) });
      expect(r.status).toBe(404);
      const last = readLedger(0, ledger).at(-1)!;
      expect(last).toMatchObject({ key_id: "legacy", route: "/v1/messages", model: "no-such-model-xyz", status: 404, input_tokens: 0, cost_usd: 0, stream: false });
      expect(readFileSync(ledger, "utf8")).not.toContain("PROMPT-GATE");
    } finally { s.stop(); }
  });

  test("open mode: keyless → 'anonymous'; a presented-but-invalid key is still 401", async () => {
    process.env.APIPLAN_SERVE_OPEN = "1";
    const s = serve({ port: 0, host: "127.0.0.1", keysFile });
    try {
      expect((await fetch(`${s.url}/v1/models`)).status).toBe(200);
      expect((await fetch(`${s.url}/v1/models`, { headers: { authorization: "Bearer apk_deadbeef_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } })).status).toBe(401);
      expect((await fetch(`${s.url}/v1/models`, { headers: { authorization: "Bearer not-needed" } })).status).toBe(401);
      await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "no-such-model-xyz", messages: [{ role: "user", content: "x" }] }) });
      expect(readLedger(0, ledger).at(-1)).toMatchObject({ key_id: "anonymous", label: "anonymous", route: "/v1/chat/completions", status: 404 });
    } finally { s.stop(); delete process.env.APIPLAN_SERVE_OPEN; }
  });

  test("nothing configured: the gate is unchanged — any placeholder passes, ledgered anonymous", async () => {
    const s = serve({ port: 0, host: "127.0.0.1", keysFile: join(DIR, "gate", "none.json") });
    try {
      expect(s.tokenRequired).toBe(false);
      expect((await fetch(`${s.url}/v1/models`, { headers: { authorization: "Bearer not-needed" } })).status).toBe(200);
    } finally { s.stop(); }
  });
});

// ─────────────────────────── real metered calls through a stubbed Codex backend ───────────────────────────

const HOME = join(DIR, "home");
const CODEX_CRED = join(DIR, "codex.json");
const KEYS = join(DIR, "child-keys.json");
const LEDGER = join(DIR, "child-ledger.jsonl");
mkdirSync(HOME, { recursive: true });
const eff = ["low", "medium", "high", "xhigh", "max"];
writeFileSync(join(HOME, "models.openai.json"), JSON.stringify({ fetched_at: Date.now(), models: [
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: eff, contextWindow: 272000 },
] }));
writeFileSync(CODEX_CRED, JSON.stringify({
  tokens: { access_token: "AT-serve-keys", refresh_token: "RT-serve-keys", account_id: "acct-serve-keys" },
  last_refresh: new Date().toISOString(),
}));
const A = createKey("laptop-a", KEYS), B = createKey("project-b", KEYS);
const LEGACY_KEY = "owner-legacy-key-123";

const HOST = `
const USAGE = { input_tokens: 1200, output_tokens: 30, input_tokens_details: { cached_tokens: 1000 } };
const EVENTS = [
  { type: "response.created", response: { model: "gpt-6.1-sol" } },
  { type: "response.output_text.delta", delta: "pong" },
  { type: "response.completed", response: { usage: USAGE } },
];
const sse = (evs) => evs.map((e) => "event: " + e.type + "\\ndata: " + JSON.stringify(e) + "\\n\\n").join("");
const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname.endsWith("/responses")) { await req.json(); return new Response(sse(EVENTS), { headers: { "content-type": "text/event-stream" } }); }
  return new Response("no", { status: 404 });
} });
process.env.APIPLAN_OPENAI_BASE = "http://127.0.0.1:" + stub.port;
const { serve } = await import(${JSON.stringify(ROOT + "src/api.ts")});
const s = serve({ port: 0, host: "127.0.0.1" });
console.log("READY " + JSON.stringify({ api: "http://127.0.0.1:" + s.port }));
`;

let proc: { kill(): void; stdout: ReadableStream<Uint8Array> } | null = null;
let API = "";

describe("metered calls → one ledger line each, per key", () => {
  beforeAll(async () => {
    const hostFile = join(DIR, "host.ts");
    writeFileSync(hostFile, HOST);
    proc = Bun.spawn(["bun", hostFile], {
      cwd: ROOT,
      env: {
        ...process.env, APIPLAN_HOME: HOME, APIPLAN_API_KEY: "", APIPLAN_SERVE_KEY: LEGACY_KEY, APIPLAN_SERVE_KEY_FILE: "", APIPLAN_SERVE_OPEN: "",
        APIPLAN_SERVE_KEYS_FILE: KEYS, APIPLAN_USAGE_LEDGER: LEDGER, APIPLAN_CODEX_AUTH: CODEX_CRED,
        APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
        APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
        APIPLAN_GOOGLE_CRED_FILE: join(DIR, "no-such-google.json"),
        APIPLAN_ANTHROPIC_CRED_FILE: join(DIR, "no-such-anthropic.json"),
      },
      stdout: "pipe", stderr: "ignore",
    }) as any;
    const reader = proc!.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const m = buf.match(/READY (\{.*\})/);
      if (m) { API = JSON.parse(m[1]).api; break; }
    }
    reader.releaseLock();
    if (!API) throw new Error("host never became ready: " + buf.slice(0, 500));
  }, 30_000);
  afterAll(() => { try { proc?.kill(); } catch {} });

  const PROMPT = "PROMPT-TEXT-MUST-NOT-BE-LEDGERED";
  const call = async (path: string, key: string, body: any) => {
    const before = existsSync(LEDGER) ? readLedger(0, LEDGER).length : 0;
    const r = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    const text = await r.text();
    // a stream is ledgered when its body settles; give it a moment
    for (let i = 0; i < 50 && (existsSync(LEDGER) ? readLedger(0, LEDGER).length : 0) <= before; i++) await Bun.sleep(20);
    return { status: r.status, text, line: readLedger(0, LEDGER).at(-1)! };
  };
  const expectLine = (line: LedgerLine, want: Partial<LedgerLine>) => {
    expect(line).toMatchObject({ provider: "openai", model: "gpt-6.1-sol", status: 200,
      // Codex is inclusive: 1200 in, 1000 of it cached → disjoint 200 + 1000 read
      input_tokens: 200, output_tokens: 30, cache_read_tokens: 1000, cache_write_tokens: 0, ...want });
    expect(line.cost_usd).toBeCloseTo(0.0008, 10);
    expect(typeof line.latency_ms).toBe("number");
    expect(line.estimated).toBeUndefined();
  };

  test("anthropic route /v1/messages — non-stream and stream", async () => {
    const body = { model: "gpt-6.1-sol", max_tokens: 50, messages: [{ role: "user", content: PROMPT }] };
    const ns = await call("/v1/messages", A.key, body);
    expect(ns.status).toBe(200);
    expectLine(ns.line, { key_id: A.record.id, label: "laptop-a", route: "/v1/messages", stream: false });
    const st = await call("/v1/messages", A.key, { ...body, stream: true });
    expect(st.text).toContain("message_stop");
    expectLine(st.line, { key_id: A.record.id, route: "/v1/messages", stream: true });
  }, 30_000);

  test("openai routes /v1/chat/completions and /v1/responses — non-stream and stream (usage metered even without include_usage)", async () => {
    const chat = { model: "gpt-6.1-sol", messages: [{ role: "user", content: PROMPT }] };
    expectLine((await call("/v1/chat/completions", B.key, chat)).line, { key_id: B.record.id, label: "project-b", route: "/v1/chat/completions", stream: false });
    const st = await call("/v1/chat/completions", B.key, { ...chat, stream: true });
    expect(st.text).toContain("[DONE]");
    expect(st.text).not.toContain("prompt_tokens"); // the caller did not ask for usage…
    expectLine(st.line, { key_id: B.record.id, route: "/v1/chat/completions", stream: true }); // …the ledger has it anyway
    const resp = { model: "gpt-6.1-sol", input: PROMPT };
    expectLine((await call("/v1/responses", B.key, resp)).line, { key_id: B.record.id, route: "/v1/responses", stream: false });
    expectLine((await call("/v1/responses", B.key, { ...resp, stream: true })).line, { key_id: B.record.id, route: "/v1/responses", stream: true });
  }, 30_000);

  test("the ledger carries no key material and no prompt text; it is append-only JSONL", () => {
    const raw = readFileSync(LEDGER, "utf8");
    for (const secret of [A.key, B.key, LEGACY_KEY, A.key.slice(-32), B.key.slice(-32), "AT-serve-keys"]) expect(raw).not.toContain(secret);
    expect(raw).not.toContain(PROMPT);
    expect(raw).not.toContain("pong");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(6);
    for (const l of lines) expect(Object.keys(JSON.parse(l))).toEqual(expect.arrayContaining(["ts", "key_id", "label", "route", "provider", "model", "stream", "status",
      "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "latency_ms"]));
  });

  test("GET /v1/usage/keys: a client key sees only itself; the legacy owner key sees every key", async () => {
    const get = async (key: string, q = "") => (await fetch(`${API}/v1/usage/keys${q}`, { headers: { authorization: `Bearer ${key}` } })).json() as any;
    const a = await get(A.key);
    expect(a.scope).toBe("own");
    expect(a.keys.map((k: any) => k.key_id)).toEqual([A.record.id]);
    expect(a.keys[0]).toMatchObject({ requests: 2, input_tokens: 400, output_tokens: 60, cache_read_tokens: 2000 });
    expect(a.keys[0].cost_usd).toBeCloseTo(0.0016, 8);
    const b = await get(B.key, "?since=24h");
    expect(b.keys.map((k: any) => k.key_id)).toEqual([B.record.id]);
    expect(b.keys[0].requests).toBe(4);
    const all = await get(LEGACY_KEY, "?since=7d");
    expect(all.scope).toBe("all");
    expect(all.keys.map((k: any) => k.key_id).sort()).toEqual([A.record.id, B.record.id].sort());
    expect((await fetch(`${API}/v1/usage/keys`)).status).toBe(401);
    expect((await fetch(`${API}/v1/usage/keys?since=soon`, { headers: { authorization: `Bearer ${A.key}` } })).status).toBe(400);
    // a client key cannot drain the server; the legacy owner key and this machine can
    expect((await fetch(`${API}/_apiplan/control`, { headers: { authorization: `Bearer ${A.key}`, "x-forwarded-for": "1.2.3.4" } })).status).toBe(401);
  });
});
