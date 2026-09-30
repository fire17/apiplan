/**
 * THE GROK BACKEND: a subscription session, an OpenAI-Responses wire shape, and an
 * INCLUSIVE input counter crossing into Anthropic's exclusive one.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and therefore what these tests defend:
 *
 *   1. THE PARTITION. xAI's `input_tokens` is the WHOLE prompt with
 *      `input_tokens_details.cached_tokens` as a breakdown of it — measured, not assumed
 *      (see the usageBasis comment in providers-grok.ts and .deify/grok/receipt.json).
 *      Republished unconverted through the Anthropic front, that double-counts the cached
 *      prefix, which on a cache-heavy agent turn is most of the prompt. So the same
 *      physical turn is driven through BOTH fronts and each must render it in its own
 *      vendor's convention, losslessly.
 *   2. THE OUTBOUND WIRE. Cache identity can only be checked at the request boundary: this
 *      endpoint never echoes `prompt_cache_key` back (CausalCacheProof measured the same
 *      silence on the sibling Responses route across 12 live calls). A test that parsed a
 *      reply for it would prove nothing, so the fixture RECORDS what arrived and the
 *      assertions read that.
 *   3. THE EXPIRED SESSION. APIPlan never writes ~/.grok/auth.json — the CLI owns refresh —
 *      so a stale token must become an honest, named refusal rather than a silent
 *      half-authenticated call.
 *
 * These run against a real api.serve() over loopback whose grok provider is pointed at a
 * fixture speaking the genuine Responses SSE shape. Nothing is mocked inside the server and
 * no helper is re-implemented: every counter asserted on has travelled the production path.
 * The fixture lives in a SUBPROCESS (test/helpers/grok-stub.ts) because base URLs and
 * credential wells come from the environment and `bun test` shares one process across files
 * — the same reason test/helpers/usage-dialect-probe.ts does.
 *
 * ZERO SPEND, ZERO CONTACT WITH THE OPERATOR'S WORLD: scratch STATE_DIR, stub credential
 * files written below, xAI never dialled, nothing outside the temp dir written. The real
 * ~/.grok/auth.json is never read — APIPLAN_GROK_AUTH points at a fixture.
 */
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { grok, readGrokRaw, grokCatalog, grokBase, GROK_FALLBACK, GROK_DEFAULT_BASE } from "../src/providers-grok.ts";
import { resolve, models } from "../src/registry.ts";
import { PROVIDERS } from "../src/providers.ts";
import { harnessRoster, rosterYaml } from "../src/roster.ts";
import type { Model } from "../src/registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "helpers", "grok-stub.ts");

// ─────────────────────────── the world these tests run in ───────────────────────────

const DIR = mkdtempSync(join(tmpdir(), "ap-grok-"));
const HOME_DIR = join(DIR, "home");
const GROK_AUTH = join(DIR, "grok-auth.json");
const GROK_MODELS = join(DIR, "grok-models.json");
const ANTHROPIC_CRED = join(DIR, "anthropic.json");
const CODEX_CRED = join(DIR, "codex.json");

/** The auth-file shape the `grok` CLI writes: keyed by issuer::client, token in `key`. */
const authFile = (expiresAt: number, key = "AT-grok-test") => JSON.stringify({
  "https://auth.x.ai::11111111-2222-3333-4444-555555555555": {
    key, auth_mode: "oidc", refresh_token: "RT-grok-test",
    expires_at: new Date(expiresAt).toISOString(),
    user_id: "user-grok-test", team_id: "team-grok-test",
    email: "someone@example.com", principal_type: "User",
    oidc_issuer: "https://auth.x.ai", oidc_client_id: "11111111-2222-3333-4444-555555555555",
  },
});

/** Good for hours, so nothing here depends on a refresh path. */
const FRESH = Date.now() + 6 * 3600_000;
writeFileSync(GROK_AUTH, authFile(FRESH));
writeFileSync(GROK_MODELS, JSON.stringify({
  fetched_at: new Date().toISOString(), auth_method: "session",
  origin: "https://cli-chat-proxy.grok.com/v1/models",
  models: {
    "grok-4.6": { info: {
      id: "grok-4.6", model: "grok-4.6", name: "Grok 4.6",
      base_url: "https://cli-chat-proxy.grok.com/v1",
      api_backend: "responses", auth_scheme: "bearer",
      context_window: 500_000, supported_in_api: true,
      supports_reasoning_effort: true,
      reasoning_efforts: [
        { id: "xhigh", value: "xhigh", label: "Extra High Effort", default: false },
        { id: "high", value: "high", label: "High Effort", default: true },
        { id: "medium", value: "medium", label: "Medium Effort", default: false },
        { id: "low", value: "low", label: "Low Effort", default: false },
      ],
    } },
  },
}));
writeFileSync(ANTHROPIC_CRED, JSON.stringify({
  claudeAiOauth: { accessToken: "AT-grok-suite", refreshToken: "RT-grok-suite", expiresAt: FRESH, scopes: ["user:inference"] },
}));
writeFileSync(CODEX_CRED, JSON.stringify({
  tokens: { access_token: "AT-grok-suite-codex", refresh_token: "RT-grok-suite-codex", account_id: "acct-grok-suite" },
  last_refresh: new Date().toISOString(),
}));

/** Bun's spawned-process handle, named rather than reached for through
 *  `ReturnType<typeof Bun.spawn>`: only `stdout`, `stderr` and `kill` are used here, and
 *  the READY handshake below depends on both pipes being readable streams. */
type StubProcess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(): void;
};
let proc: StubProcess | null = null;
let base = "";     // the apiplan server under test
let fixture = "";  // the stub upstream

beforeAll(async () => {
  proc = Bun.spawn(["bun", STUB], {
    env: {
      ...process.env,
      APIPLAN_HOME: HOME_DIR,
      APIPLAN_API_KEY: "",
      APIPLAN_GROK_AUTH: GROK_AUTH,
      APIPLAN_GROK_MODELS: GROK_MODELS,
      APIPLAN_ANTHROPIC_CRED_FILE: ANTHROPIC_CRED,
      APIPLAN_CODEX_AUTH: CODEX_CRED,
      // Never let a Keychain entry on the developer's machine answer instead of the stubs.
      APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_CRED_FILE: join(DIR, "no-such-google-credential.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // The READY line is the only synchronisation point: a port that is merely allocated is
  // not a server that answers, and polling a guessed port would race the boot.
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
  if (!m) throw new Error(`grok stub never became ready: ${buf}\n${await new Response(proc.stderr).text()}`);
  base = `http://127.0.0.1:${m[1]}`;
  fixture = `http://127.0.0.1:${m[2]}`;
});
afterAll(() => {
  try { proc?.kill(); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────── talking to the server ───────────────────────────

type GrokCounters = { input_tokens?: number; output_tokens?: number; cached_tokens?: number; cache_write_tokens?: number };
type Fixture = { grok?: GrokCounters; silent?: boolean; reject?: { status: number; body: string } };

/** Arm the stub upstream. Awaited, so the fixture is in place before the request goes out. */
async function upstream(f: Fixture) {
  const r = await fetch(`${fixture}/__fixture`, { method: "POST", body: JSON.stringify(f) });
  expect(r.ok).toBe(true);
}
/** What the upstream last received — the only honest place to check the outbound wire. */
async function seen(): Promise<{ path: string; headers: Record<string, string>; body: Record<string, unknown> }> {
  const r = await fetch(`${fixture}/__seen`);
  return await r.json();
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** POST /v1/chat/completions (OpenAI FRONT), non-streaming. */
async function chat(model: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const r = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "hello" }], ...extra });
  const j = await r.json();
  if (!r.ok) throw new Error(`chat ${r.status}: ${JSON.stringify(j)}`);
  return j;
}
/** POST /v1/messages (Anthropic FRONT), non-streaming. */
async function messages(model: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const r = await post("/v1/messages", { model, max_tokens: 64, messages: [{ role: "user", content: "hello" }], ...extra });
  const j = await r.json();
  if (!r.ok) throw new Error(`messages ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

/** Anthropic's documented identity: the parts are disjoint and sum to the whole prompt. */
const anthropicPromptTotal = (u: Record<string, number>) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
/** OpenAI's documented subtraction: prompt_tokens already CONTAINS the cached parts. */
const openaiOrdinary = (u: Record<string, any>) =>
  (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0) - (u.prompt_tokens_details?.cache_write_tokens ?? 0);

/**
 * ONE physical turn as xAI really reports it: whole prompt 10,000 with 8,000 of it served
 * from cache, so the uncached remainder is 2,000. The shape of the real thing — the live
 * receipt has input_tokens 6,197 with cached_tokens 6,144 inside it, same relationship.
 */
const TOTAL = 10_000, CACHED = 8_000, UNCACHED = TOTAL - CACHED, OUT = 5;
const paired: GrokCounters = { input_tokens: TOTAL, output_tokens: OUT, cached_tokens: CACHED };

const GROK = "grok-4.6";

// ─────────────────────────── the partition, through both fronts ───────────────────────────

describe("grok's inclusive counters cross into each front's own convention", () => {
  test("the Anthropic front does not double-count the cached prefix", async () => {
    await upstream({ grok: paired });
    const j = await messages(GROK);
    // THE FAULT THIS PREVENTS: input_tokens 10,000 published beside cache_read 8,000 makes
    // Anthropic's own documented sum report an 18,000-token prompt for a 10,000-token turn.
    expect(j.usage.input_tokens).toBe(UNCACHED);
    expect(j.usage.cache_read_input_tokens).toBe(CACHED);
    expect(anthropicPromptTotal(j.usage)).toBe(TOTAL);
    // Physical counts are re-partitioned, never invented or dropped.
    expect(j.usage.output_tokens).toBe(OUT);
    // An exact partition needs no caveat, and must not claim to be an estimate.
    expect(j.x_apiplan_usage).toBeUndefined();
    expect(j.x_apiplan_usage_basis).toBeUndefined();
  });

  test("the OpenAI front republishes an inclusive total, losslessly", async () => {
    await upstream({ grok: paired });
    const j = await chat(GROK);
    // Same dialect in and out, so the total is folded back and the vendor's documented
    // subtraction recovers exactly the uncached count the server measured.
    expect(j.usage.prompt_tokens).toBe(TOTAL);
    expect(j.usage.prompt_tokens_details.cached_tokens).toBe(CACHED);
    expect(openaiOrdinary(j.usage)).toBe(UNCACHED);
    expect(j.usage.completion_tokens).toBe(OUT);
  });

  test("both fronts describe the SAME physical turn", async () => {
    await upstream({ grok: paired });
    const a = await messages(GROK);
    await upstream({ grok: paired });
    const o = await chat(GROK);
    // The one property that matters: each front's own arithmetic arrives at one prompt size.
    expect(anthropicPromptTotal(a.usage)).toBe(o.usage.prompt_tokens);
    expect(a.usage.cache_read_input_tokens).toBe(o.usage.prompt_tokens_details.cached_tokens);
    expect(a.usage.input_tokens).toBe(openaiOrdinary(o.usage));
  });

  test("a full cache hit is representable and does not drive the remainder negative", async () => {
    // The reading xAI's own doc calls a "Full cache hit": cached equals the whole prompt.
    // Under an exclusive misreading this is where subtraction goes wrong twice over.
    await upstream({ grok: { input_tokens: TOTAL, output_tokens: OUT, cached_tokens: TOTAL } });
    const j = await messages(GROK);
    expect(j.usage.input_tokens).toBe(0);
    expect(j.usage.cache_read_input_tokens).toBe(TOTAL);
    expect(anthropicPromptTotal(j.usage)).toBe(TOTAL);
    expect(j.x_apiplan_usage_basis).toBeUndefined();
  });

  test("an explicit zero is a measured MISS, not an absence", async () => {
    // The distinction a cache-effectiveness reader depends on: 0 means measured-and-missed
    // (the live receipt's cold call), while a missing field means the vendor did not say.
    await upstream({ grok: { input_tokens: TOTAL, output_tokens: OUT, cached_tokens: 0 } });
    const j = await messages(GROK);
    expect(j.usage.input_tokens).toBe(TOTAL);
    expect(j.usage.cache_read_input_tokens).toBe(0);
    expect(anthropicPromptTotal(j.usage)).toBe(TOTAL);
  });

  test("no cache counter at all is reported honestly instead of converted", async () => {
    // An inclusive backend that reports an input total and NO cache field cannot be
    // partitioned: the absence is the backend declining to say, not evidence of zero, and
    // subtracting an assumed zero would publish a derived-looking number nothing supports.
    await upstream({ grok: { input_tokens: TOTAL, output_tokens: OUT } });
    const j = await messages(GROK);
    expect(j.usage.input_tokens).toBe(TOTAL);
    expect(j.usage.cache_read_input_tokens).toBeUndefined();
    // The total is still true and still published; the caveat rides along.
    expect(j.x_apiplan_usage_basis).toBe("unavailable");
  });
});

// ─────────────────────────── the outbound wire ───────────────────────────

describe("what grok actually sends upstream", () => {
  test("a Responses request on the subscription proxy, bearing the session", async () => {
    await upstream({ grok: paired });
    await messages(GROK);
    const s = await seen();
    expect(s.path).toBe("/responses");
    expect(s.headers.authorization).toBe("Bearer AT-grok-test");
    expect(s.headers.accept).toBe("text/event-stream");
    // The body is the Responses shape, not chat-completions: `input` + `instructions`.
    expect(s.body.model).toBe(GROK);
    expect(Array.isArray(s.body.input)).toBe(true);
    expect(s.body).toMatchObject({ store: false, stream: true });
    expect(s.body.messages).toBeUndefined();
    // No output cap: this first-party proxy is not the metered API, and a cap it rejects
    // would fail the whole call for every client that sets max_tokens by default.
    expect(s.body.max_output_tokens).toBeUndefined();
  });

  test("the xAI client headers the CLI's own binary sends", async () => {
    await upstream({ grok: paired });
    await messages(GROK);
    const s = await seen();
    expect(s.headers["x-grok-client-identifier"]).toBe("grok-shell");
    expect(s.headers["x-grok-client-version"]).toBe("1.0.13");
    expect(s.headers["user-agent"]).toBe("grok-cli/1.0.13");
  });

  test("cache identity travels as BOTH the body field and x-grok-conv-id, with one value", async () => {
    await upstream({ grok: paired });
    // A stable caller identity is what api.ts forwards as the prompt cache key.
    await messages(GROK, { metadata: { user_id: "session-abc" } });
    const s = await seen();
    const key = s.body.prompt_cache_key;
    expect(typeof key).toBe("string");
    expect(key).toBeTruthy();
    // xAI documents the two spellings as ONE mechanism ("It functions identically to
    // setting x-grok-conv-id"), and cache entries are per-server — so a conversation whose
    // routing handle disagreed with its cache key would lose its own prefix.
    expect(s.headers["x-grok-conv-id"]).toBe(key);
    expect(s.headers["x-grok-session-id"]).toBe(key);
  });

  test("the live-measured turn re-partitions exactly, end to end", async () => {
    // THE NUMBERS FROM THE REAL VENDOR, pinned as a regression. Measured 2026-09-06 against
    // cli-chat-proxy.grok.com (.deify/grok/receipt.json): three byte-identical 6,197-token
    // requests reported input_tokens 6,197 on ALL THREE while cached_tokens climbed
    // 0 → 128 → 6,144. Driven through the Anthropic front, the live server published
    // input_tokens 53 + cache_read 6,144 on the cached call.
    //
    // 53 is the load-bearing number twice over: it is what an EXCLUSIVE reading wrongly
    // predicts xAI's own counter would fall to (it stayed at 6,197, which is how exclusive
    // was refuted), and it is what this gateway must CORRECTLY derive as the uncached
    // remainder when republishing in Anthropic's convention. A regression in either
    // direction moves it.
    await upstream({ grok: { input_tokens: 6197, output_tokens: 120, cached_tokens: 6144 } });
    const j = await messages(GROK);
    expect(j.usage.input_tokens).toBe(53);
    expect(j.usage.cache_read_input_tokens).toBe(6144);
    expect(anthropicPromptTotal(j.usage)).toBe(6197);
    // The live run carried no caveat, because the partition was exact. So must this.
    expect(j.x_apiplan_usage_basis).toBeUndefined();
  });

  test("the same conversation keeps ONE routing handle across turns", async () => {
    // This is what makes a cache reachable at all: per-server entries plus a changing handle
    // means every turn can land on a machine that has never seen the prefix.
    await upstream({ grok: paired });
    await messages(GROK, { metadata: { user_id: "session-stable" } });
    const first = (await seen()).headers["x-grok-conv-id"];
    await upstream({ grok: paired });
    await messages(GROK, { metadata: { user_id: "session-stable" } });
    expect((await seen()).headers["x-grok-conv-id"]).toBe(first);
  });

  test("a caller's tools ride as FLAT Responses function tools", async () => {
    await upstream({ grok: paired });
    await messages(GROK, {
      tools: [{
        name: "read_file",
        description: "Read a file",
        input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
    });
    const s = await seen();
    const tools = s.body.tools as { type: string; name: string; parameters: Record<string, unknown> }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "function", name: "read_file" });
    // `$schema` is JSON-Schema framing, not a parameter schema, and this backend family is
    // inconsistent about tolerating it — so it is pruned rather than forwarded.
    expect(tools[0].parameters.$schema).toBeUndefined();
    expect(tools[0].parameters).toMatchObject({ type: "object" });
  });
});

// ─────────────────────────── the refusal paths ───────────────────────────

describe("an unusable session fails honestly", () => {
  test("an expired token is refused BEFORE any call, naming the fix", () => {
    // The provider read directly, against an expired well — no server, no upstream. This is
    // the codex behaviour mirrored: APIPlan never writes ~/.grok/auth.json, so a stale token
    // is reported rather than silently used or silently refreshed.
    const expiredAt = Date.now() - 60_000;
    writeFileSync(GROK_AUTH, authFile(expiredAt));
    process.env.APIPLAN_GROK_AUTH = GROK_AUTH;
    try {
      const p = grok.probe();
      expect(p.connected).toBe(false);
      expect(p.detail).toContain("expired");
      // The CHEAP fix first: the CLI refreshes in the background, so a browser login is
      // only needed once the refresh chain is spent.
      expect(p.loginHint).toContain("grok");
      expect(() => grok.creds()).toThrow(/expired/i);
    } finally {
      writeFileSync(GROK_AUTH, authFile(FRESH));
      delete process.env.APIPLAN_GROK_AUTH;
    }
  });

  test("an upstream 401 explains itself as a stale session, not a bad account", async () => {
    const body = JSON.stringify({ error: { message: "invalid bearer token", code: "unauthenticated" } });
    await upstream({ reject: { status: 401, body } });
    const r = await post("/v1/messages", { model: GROK, max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
    expect(r.ok).toBe(false);
    const text = await r.text();
    // The vendor's own words survive — a gateway that swallowed them would leave an
    // operator guessing — and the fix-it line points at the refresh, not a re-login.
    expect(text).toContain("invalid bearer token");
    const hint = grok.explain?.(401, body);
    expect(hint).toContain("401");
    expect(hint).toContain("grok");
  });

  test("a 403 is NOT reported as a stale session", () => {
    // An authenticated principal without the entitlement. Telling that user to
    // re-authenticate would send them to re-auth a perfectly healthy account.
    const hint = grok.explain?.(403, JSON.stringify({ error: { message: "model not available" } }));
    expect(hint).toContain("403");
    expect(hint).toContain("subscription");
    expect(hint).not.toContain("expired");
  });

  test("a 429 gets no invented explanation", () => {
    // Rate limiting is not an auth fault and the engine's generic wording is right for it.
    expect(grok.explain?.(429, "slow down")).toBeUndefined();
  });
});

// ─────────────────────────── the credential well ───────────────────────────

describe("reading the grok CLI's session", () => {
  test("the entry with the LATEST expiry wins, not the first one listed", () => {
    // The file is keyed by issuer::client and is plural by construction — a second issuer, a
    // re-login under a new client id, or a devbox login each add a SIBLING. Taking the first
    // would serve a dead session while a live one sat beside it.
    const multi = join(DIR, "grok-multi.json");
    const older = Date.now() + 3600_000, newer = Date.now() + 7200_000;
    writeFileSync(multi, JSON.stringify({
      "https://auth.x.ai::aaa": { key: "AT-older", expires_at: new Date(older).toISOString(), user_id: "u1" },
      "https://auth.x.ai::bbb": { key: "AT-newer", expires_at: new Date(newer).toISOString(), user_id: "u2" },
    }));
    process.env.APIPLAN_GROK_AUTH = multi;
    try {
      const s = readGrokRaw();
      expect(s?.key).toBe("AT-newer");
      expect(s?.expiresAt).toBe(newer);
    } finally { delete process.env.APIPLAN_GROK_AUTH; }
  });

  test("a missing, unreadable or tokenless file is null — never a throw", () => {
    // A credential read must not become a way for this provider to fail loudly about
    // another program's file; probe() and the /health path depend on that.
    const cases: [string, string][] = [
      ["absent", join(DIR, "no-such-grok.json")],
      ["not json", join(DIR, "grok-garbage.json")],
      ["json but not an object", join(DIR, "grok-array.json")],
      ["entry without a key", join(DIR, "grok-keyless.json")],
    ];
    writeFileSync(cases[1][1], "{{{not json");
    writeFileSync(cases[2][1], "[1,2,3]");
    writeFileSync(cases[3][1], JSON.stringify({ "https://auth.x.ai::ccc": { expires_at: new Date().toISOString() } }));
    for (const [why, file] of cases) {
      process.env.APIPLAN_GROK_AUTH = file;
      try {
        expect(readGrokRaw(), why).toBeNull();
        expect(grok.probe().connected, why).toBe(false);
        expect(() => grok.creds(), why).toThrow();
      } finally { delete process.env.APIPLAN_GROK_AUTH; }
    }
  });

  test("an unparseable expiry stays UNKNOWN and never becomes never-expires", () => {
    // A NaN here would compare false against every clock, so a broken stamp would read as a
    // token that never expires — the most dangerous possible misreading of a bad date.
    const bad = join(DIR, "grok-bad-stamp.json");
    writeFileSync(bad, JSON.stringify({ "https://auth.x.ai::ddd": { key: "AT-bad-stamp", expires_at: "not a date" } }));
    process.env.APIPLAN_GROK_AUTH = bad;
    try {
      const s = readGrokRaw();
      expect(s?.key).toBe("AT-bad-stamp");
      expect(s?.expiresAt).toBeUndefined();
      // Unknown expiry is not a dead session: it is still served, and says so.
      expect(grok.probe().detail).toContain("unknown");
      expect(grok.creds().expiresAt).toBeUndefined();
    } finally { delete process.env.APIPLAN_GROK_AUTH; }
  });

  test("the fingerprint identifies the credential without ever being one", () => {
    process.env.APIPLAN_GROK_AUTH = GROK_AUTH;
    try {
      const fp = grok.credFp!();
      // Never the token, and never long enough to be one.
      expect(fp.cred).not.toContain("AT-grok-test");
      expect(fp.ident).not.toContain("AT-grok-test");
      expect(fp.ident).toMatch(/^[0-9a-f]{12}$/);
      expect(fp.exp).toBe(FRESH);
      // A background refresh by the CLI — same account, new JWT — must read as a NEW
      // credential, so nothing recorded against the old bearer carries over to it.
      const rotated = Date.now() + 7 * 3600_000;
      writeFileSync(GROK_AUTH, authFile(rotated, "AT-grok-rotated"));
      const after = grok.credFp!();
      expect(after.cred).not.toBe(fp.cred);
      // …while the ACCOUNT is unchanged: identity keyed on the principal, not the rotating
      // refresh token, or one account would look like an endless stream of different ones.
      expect(after.ident).toBe(fp.ident);
    } finally {
      writeFileSync(GROK_AUTH, authFile(FRESH));
      delete process.env.APIPLAN_GROK_AUTH;
    }
  });

  test("no session at all is 'absent', which is not a fingerprint collision", () => {
    process.env.APIPLAN_GROK_AUTH = join(DIR, "no-such-grok.json");
    try {
      expect(grok.credFp!()).toEqual({ cred: "absent", ident: "absent", exp: 0 });
    } finally { delete process.env.APIPLAN_GROK_AUTH; }
  });
});

// ─────────────────────────── the catalog ───────────────────────────

describe("the model catalog", () => {
  test("the CLI's live catalog is preferred, including its base URL and efforts", () => {
    process.env.APIPLAN_GROK_MODELS = GROK_MODELS;
    try {
      const c = grokCatalog();
      expect(c.map((m) => m.id)).toEqual(["grok-4.6"]);
      expect(c[0]).toMatchObject({ label: "Grok 4.6", contextWindow: 500_000, baseUrl: GROK_DEFAULT_BASE });
      // `reasoning_efforts[].value` in the catalog's own order — the model's preferred rung
      // stays first rather than being alphabetised or re-sorted.
      expect(c[0].efforts).toEqual(["xhigh", "high", "medium", "low"]);
    } finally { delete process.env.APIPLAN_GROK_MODELS; }
  });

  test("a model the proxy will not serve is not offered", () => {
    // `supported_in_api: false` would answer 400, so listing it offers a name nothing
    // supports. (A `hidden` model is different: that governs the CLI's own picker.)
    const f = join(DIR, "grok-unsupported.json");
    writeFileSync(f, JSON.stringify({ models: {
      "grok-4.6": { info: { id: "grok-4.6", name: "Grok 4.6", supported_in_api: true, context_window: 500_000 } },
      "grok-internal": { info: { id: "grok-internal", name: "Internal", supported_in_api: false } },
    } }));
    process.env.APIPLAN_GROK_MODELS = f;
    try {
      expect(grokCatalog().map((m) => m.id)).toEqual(["grok-4.6"]);
    } finally { delete process.env.APIPLAN_GROK_MODELS; }
  });

  test("a missing or broken catalog falls back to the documented list, never to empty", () => {
    // An empty catalog would make every grok name unresolvable on a fresh machine; the
    // documented list is the honest floor.
    for (const f of [join(DIR, "no-such-models.json"), join(DIR, "grok-models-garbage.json")]) {
      writeFileSync(join(DIR, "grok-models-garbage.json"), "not json at all");
      process.env.APIPLAN_GROK_MODELS = f;
      try {
        expect(grokCatalog()).toEqual(GROK_FALLBACK);
      } finally { delete process.env.APIPLAN_GROK_MODELS; }
    }
  });

  test("the endpoint is the subscription proxy, and an override is honoured", () => {
    // api.x.ai is the METERED API-key product; a session token is not its currency, so the
    // default must never drift there.
    expect(GROK_DEFAULT_BASE).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(grokBase("grok-4.6")).toContain("cli-chat-proxy.grok.com");
    expect(grokBase()).toBe(GROK_DEFAULT_BASE);
    process.env.APIPLAN_GROK_BASE = "http://127.0.0.1:9/v1/";
    try {
      // Trailing slashes are trimmed, so a path is never joined onto a double slash.
      expect(grokBase("grok-4.6")).toBe("http://127.0.0.1:9/v1");
    } finally { delete process.env.APIPLAN_GROK_BASE; }
  });
});

// ─────────────────────────── the declaration and the registry ───────────────────────────

describe("grok's contract and registration", () => {
  test("it declares an INCLUSIVE basis and an implicit-prefix cache, with no invented numbers", () => {
    expect(PROVIDERS.grok).toBe(grok);
    expect(grok.usageBasis).toBe("inclusive");
    expect(grok.cache.kind).toBe("implicit-prefix");
    expect(grok.cache.identity).toBe("prompt_cache_key");
    // DOCUMENTED-OR-ABSENT. xAI publishes neither a minimum nor a TTL for this cache, and a
    // borrowed 1,024 would be actively WRONG, not merely unsupported: the live receipt shows
    // a 128-token cache read out of 6,197, i.e. xAI cached far below any published floor.
    expect(grok.cache.minTokens).toBeUndefined();
    expect(grok.cache.ttlMs).toBeUndefined();
  });

  test("`grok` means the NEWEST grok, and every id stays exactly addressable", () => {
    expect(resolve("grok")?.id).toBe("grok-4.6");
    expect(resolve("grok46")?.id).toBe("grok-4.6");
    expect(resolve("grok45")?.id).toBe("grok-4.5");
    expect(resolve("grok43")?.id).toBe("grok-4.3");
    expect(resolve("grok-build-0.1")?.id).toBe("grok-build-0.1");
    expect(resolve("grokbuild")?.id).toBe("grok-build-0.1");
    for (const m of models("grok")) expect(resolve(m.id)?.id).toBe(m.id);
  });

  test("the named line does not claim a generic word, nor outrank the flagship", () => {
    // As a VARIANT of `grok`, `grok-build-0.1` would mint the bare alias `build` — a word
    // far too ordinary to own in a shell — and would share the flagship's version ordering,
    // so the day the named line reached 5.0 it would steal the bare `grok` alias.
    expect(resolve("build")).toBeNull();
    expect(models("grok").find((m) => m.id === "grok-build-0.1")?.family).toBe("grokbuild");
    expect(models("grok").find((m) => m.id === "grok-4.6")?.family).toBe("grok");
  });

  test("adding grok did not disturb any other provider's aliases", () => {
    // The resolve path is shared, so a new family is exactly where an alias regression hides.
    expect(resolve("opus")?.id).toBe("claude-opus-5");
    expect(resolve("codex")?.provider).toBe("openai");
    expect(resolve("gemini")?.provider).toBe("google");
    expect(resolve("nonexistent-model-xyz")).toBeNull();
  });

  test("no grok id is unparseable, and junk still is", () => {
    // unparseable() exists to REPORT what a provider's catalog offered and this registry
    // could not address — silent truncation is the fault it prevents.
    expect(models("grok").length).toBeGreaterThanOrEqual(4);
    const { unparseable } = require("../src/registry.ts");
    expect(unparseable("grok", models("grok"))).toEqual([]);
    expect(unparseable("grok", [{ id: "not-a-grok" }])).toEqual(["not-a-grok"]);
  });
});

// ─────────────────────────── the roster ───────────────────────────

describe("grok in the harness roster", () => {
  const rows = harnessRoster().filter((r) => r.id.startsWith("grok"));

  test("every documented grok model reaches the roster as a reasoning model", () => {
    // A provider missing from harnessRoster()'s sweep array is INVISIBLE unless
    // HARNESS_ORDER names it, so this asserts the wiring, not just the data.
    expect(rows.map((r) => r.id).sort()).toEqual(["grok-4.3", "grok-4.5", "grok-4.6", "grok-build-0.1"]);
    for (const r of rows) {
      expect(r.reasoning).toBe(true);
      expect(r.efforts).toEqual(["xhigh", "high", "medium", "low"]);
      expect(r.input).toEqual(["text", "image"]);
      // Never the bare 32,000 / 8,000 local fallback a provider without a branch inherits.
      expect(r.contextWindow).toBeGreaterThanOrEqual(256_000);
      expect(r.maxTokens).toBeGreaterThanOrEqual(256_000);
    }
  });

  test("the published rates, per model, from that model's own page", () => {
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["grok-4.6"].cost).toEqual({
      input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0,
      longContext: { inputThreshold: 200_000, inputThresholdInclusive: true, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
    });
    expect(by["grok-4.5"].cost?.cacheRead).toBe(0.3);
    expect(by["grok-4.3"].cost?.input).toBe(1.25);
    expect(by["grok-build-0.1"].cost?.output).toBe(2);
    // cacheWrite is 0 at BOTH tiers for every grok row, and that is a measured vendor
    // property: xAI's usage object carries no cache-write counter at all and it publishes no
    // cache-write price. A 1.25x scalar borrowed from the OpenAI rows would be a fabrication.
    for (const r of rows) {
      expect(r.cost?.cacheWrite).toBe(0);
      expect(r.cost?.longContext?.cacheWrite).toBe(0);
    }
  });

  test("xAI's boundary is INCLUSIVE at the true 200,000 — not emulated with 199,999", () => {
    // Every grok page: "Requests whose prompt REACHES 200k tokens are billed at the higher
    // rate for all tokens in the request." The harness models exactly this
    // (`inputThresholdInclusive`), so the field carries the number xAI published. Encoding
    // 199,999 against the strict comparator would price the boundary turn correctly while
    // making the FIELD false — and a later switch to a `>=` comparator would then shift the
    // boundary one token with nothing to catch it.
    for (const r of rows) {
      expect(r.cost?.longContext?.inputThreshold).toBe(200_000);
      expect(r.cost?.longContext?.inputThresholdInclusive).toBe(true);
    }
  });

  test("the inclusive flag is NOT inherited by the strict OpenAI tiers", () => {
    // The mirror-image bug: OpenAI's pages say ">272K", so an inherited or defaulted `true`
    // would move Astra's boundary one token the OTHER way.
    const oai = harnessRoster().filter((r) => r.cost?.longContext && r.id.startsWith("gpt-"));
    expect(oai.length).toBeGreaterThan(0);
    for (const r of oai) {
      expect(r.cost?.longContext?.inputThreshold).toBe(272_000);
      expect(r.cost?.longContext?.inputThresholdInclusive).toBeUndefined();
    }
  });

  test("the emitted YAML carries the flag BY NAME, on exactly the grok tiers", () => {
    // The field name is pi-catalog's, so a rename upstream must break loudly HERE rather
    // than silently dropping the flag — a dropped flag reverts the tier to strict and
    // under-charges every boundary request, with nothing to notice it.
    const yaml = rosterYaml();
    const flagged = yaml.split("\n").filter((l) => l.includes("inputThresholdInclusive"));
    // One per grok row, each at xAI's true documented boundary — never an emulated 199_999.
    expect(flagged.length).toBe(4);
    for (const l of flagged) expect(l).toContain("inputThreshold: 200000, inputThresholdInclusive: true");
    // And the flag reaches ONLY the grok rows. Asserted against the roster data rather than
    // against a vendor's threshold number: another vendor may legitimately document a tier
    // at 200,000 too (a gemini route already does), so "200,000 implies inclusive" would be
    // a false inference — the flag tracks what a vendor's page SAYS about its boundary
    // (reaches vs exceeds), not where the boundary sits.
    const inclusiveIds = harnessRoster().filter((r) => r.cost?.longContext?.inputThresholdInclusive).map((r) => r.id);
    expect(inclusiveIds.sort()).toEqual(["grok-4.3", "grok-4.5", "grok-4.6", "grok-build-0.1"]);
    // Other tiers exist and are emitted WITHOUT it, so this is a real discrimination and
    // not a vacuous pass.
    const tiers = yaml.split("\n").filter((l) => l.includes("longContext"));
    expect(tiers.length).toBeGreaterThan(flagged.length);
  });

  test("the roster still emits ONE apiplan provider, and never writes a file", () => {
    // The whole point of the single-provider roster: one `apiplan:` key speaking
    // anthropic-messages for every backend, grok included.
    const yaml = rosterYaml();
    expect(yaml.match(/^ {2}[a-z][a-z0-9_-]*:$/gm)).toEqual(["  apiplan:"]);
    expect(yaml).toContain('id: "grok-4.6"');
    expect(yaml).toContain("api: anthropic-messages");
  });
});

// ─────────────────────────── the stream ───────────────────────────

describe("reading the grok stream", () => {
  /** The one model shape the adapter needs, matching the registry's own grok entry. */
  const model: Model = { id: GROK, provider: "grok", family: "grok", version: [4, 6], label: "Grok 4.6", efforts: ["xhigh", "high", "medium", "low"] };

  test("usage is read off response.completed, cached passed through UNSUBTRACTED", () => {
    // The adapter must not convert: normalizeTally() owns the single conversion, and
    // subtracting here too would double-subtract and trip its source-inconsistent guard.
    const d = grok.delta({ type: "response.completed", response: { usage: { input_tokens: TOTAL, output_tokens: OUT, input_tokens_details: { cached_tokens: CACHED } } } });
    expect(d.usage).toEqual({ input: TOTAL, output: OUT, cacheRead: CACHED });
    expect(d.stopReason).toBe("end_turn");
  });

  test("an absent cache counter stays absent — never a measured zero", () => {
    // xAI reports NO cache-write counter at all, so cacheWrite must never appear as 0.
    const d = grok.delta({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 1 } } });
    expect(d.usage).toEqual({ input: 10, output: 1 });
    expect(d.usage?.cacheRead).toBeUndefined();
    expect(d.usage?.cacheWrite).toBeUndefined();
  });

  test("an output-cap truncation is the ONLY max_tokens stop", () => {
    expect(grok.delta({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }).stopReason).toBe("max_tokens");
    expect(grok.delta({ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }).stopReason).toBe("end_turn");
  });

  test("text, thinking and the served model are told apart", () => {
    expect(grok.delta({ type: "response.output_text.delta", delta: "hi" })).toEqual({ text: "hi" });
    expect(grok.delta({ type: "response.reasoning_summary_text.delta", delta: "hmm" })).toEqual({ reasoning: "hmm" });
    // The served id is the only trustworthy proof of which model answered.
    expect(grok.delta({ type: "response.created", response: { model: GROK } })).toEqual({ served: GROK });
  });

  test("a function call opens, fills and closes under one ref", () => {
    const added = grok.delta({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file" } });
    expect(added.toolStart).toEqual({ ref: "fc_1", id: "call_1", name: "read_file" });
    expect(grok.delta({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"pa' }).toolArgs).toEqual({ ref: "fc_1", json: '{"pa' });
    // The backend's own complete copy REPLACES a partial accumulation — the path xAI's
    // "function calls returned whole in a single chunk" behaviour takes.
    const done = grok.delta({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", arguments: '{"path":"x"}' } });
    expect(done.toolArgs).toEqual({ ref: "fc_1", json: '{"path":"x"}', full: true });
    expect(done.toolStop).toEqual({ ref: "fc_1" });
  });

  test("the vendor's own fault name is carried, not flattened", () => {
    // A client that retries on one error type and gives up on another makes the opposite
    // decision when the label is lost.
    const d = grok.delta({ type: "response.failed", response: { error: { message: "boom", type: "server_error" } } });
    expect(d).toEqual({ error: "boom", errorType: "server_error" });
  });

  test("only a final response object terminates the turn", () => {
    // Without this, a body that stopped mid-answer would be indistinguishable from a
    // finished one, and a truncated reply would be treated as complete.
    for (const t of ["response.completed", "response.incomplete", "response.failed", "response.done"]) {
      expect(grok.terminal!({ type: t })).toBe(true);
    }
    for (const t of ["response.created", "response.output_text.delta", "response.in_progress"]) {
      expect(grok.terminal!({ type: t })).toBe(false);
    }
  });

  test("an effort the model does not advertise is never sent", () => {
    // Per-model `reasoning_efforts`; an unsupported effort is a 400 on this family.
    const c = { token: "T", source: "test" };
    const withEffort = grok.build(model, [{ role: "user", text: "hi" }], { effort: "high" }, c);
    expect(withEffort.body.reasoning).toEqual({ effort: "high" });
    const bogus = grok.build(model, [{ role: "user", text: "hi" }], { effort: "ludicrous" }, c);
    expect(bogus.body.reasoning).toBeUndefined();
    // A request-level effort change resets the cached prefix upstream, so it is only ever
    // sent when the caller asked for one.
    expect(grok.build(model, [{ role: "user", text: "hi" }], {}, c).body.reasoning).toBeUndefined();
  });
});
