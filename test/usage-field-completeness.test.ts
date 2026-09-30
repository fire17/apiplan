/**
 * ── A DROPPED OPTIONAL FIELD IS A FAULT WITH NO SYMPTOM ──
 *
 * Every accounting bug this project has caught so far was caught by a SYMPTOM: a frozen
 * counter, a doubled cost, a thrown error. A dropped optional usage field produces none of
 * those. The numbers stay self-consistent, every bucket still sums, no test fails, and the
 * loss surfaces only as money nobody notices or as a working cache that reads as one which
 * never hits. Two such faults were live here at once, neither reported by a user:
 *
 *   1. ANTHROPIC'S TTL BREAKDOWN. The vendor reports its cache write TWICE — the flat
 *      `cache_creation_input_tokens`, and `cache_creation: { ephemeral_5m_input_tokens,
 *      ephemeral_1h_input_tokens }`. Only the flat scalar was read. The components bill at
 *      DIFFERENT rates (a 1h write at 2x base input, a 5m write at 1.25x), so a consumer
 *      handed only the total priced every 1h write at the cheaper rate — measured on the
 *      claude-fable-5-1 card as $1.25 where $2.00 was correct, a 1.6x under-bill.
 *   2. GOOGLE'S CACHE-HIT COUNTER. `usageMetadata` was read for exactly two fields,
 *      promptTokenCount and candidatesTokenCount, so `cachedContentTokenCount` — the
 *      counter that says the cache WORKED — was dropped, and downstream a dropped counter
 *      is indistinguishable from a measured zero. `thoughtsTokenCount` went with it, which
 *      on this vendor is billed OUTPUT that no counter downstream reflected.
 *
 * ── SO THIS SUITE IS A DIFF, NOT A SPOT-CHECK ──
 *
 * The method that found both was mechanical: take the vendor's OWN documented usage object,
 * field by field, and diff it against what the adapter actually reads. Every field is then
 * one of two things, and there is no third — FORWARDED to a named destination, or DROPPED
 * for a reason written down. "We didn't notice it" is not a reason.
 *
 * Each describe() below therefore quotes the vendor's documented field list verbatim, sends
 * a fixture carrying EVERY field in it — including the ones this server deliberately does
 * not carry, because a test that never sends them cannot prove they are dropped on purpose
 * rather than by accident — and asserts the front payloads carry each forwarded field with
 * the right number, and do not carry the dropped ones.
 *
 * ── THE ONE INVARIANT THAT OUTRANKS EVERY FORWARD ──
 *
 * A sub-division is never a bucket. `input + cacheRead + cacheWrite` covers the prompt
 * exactly once, and every optional field added here describes a bucket already counted:
 * the TTL split divides cacheWrite (the vendor states it — "the current
 * cache_creation_input_tokens field equals the sum of the values in the cache_creation
 * object"), and the reasoning count is a share of output. If either were added to a total
 * the same physical tokens would be billed twice. Asserted throughout, and it is the part
 * that must not regress.
 *
 * ── PROVED AGAINST THE REAL CONSUMER, NOT ONLY AGAINST OUR READING ──
 *
 * The last describe() imports OM's ACTUAL Anthropic usage extractor and pi-catalog's ACTUAL
 * pricer and runs them over the payload this server emits, because a server can satisfy a
 * specification as its author understood it and still be mis-parsed by the consumer that
 * matters — which is precisely where fault 1 lived. Skipped without APIPLAN_OM_PROOF=1,
 * since it reaches outside this repo into a pinned runtime this project does not own.
 *
 * Every test drives a REAL api.serve() over loopback against fixture upstreams speaking
 * each vendor's genuine wire events, in a subprocess that owns its environment
 * (test/helpers/usage-field-probe.ts). Nothing is mocked inside the server, no helper is
 * re-implemented, no vendor is dialled and no credential of the operator's is read.
 */
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "helpers", "usage-field-probe.ts");

// ─────────────────────────── the world these tests run in ───────────────────────────

const DIR = mkdtempSync(join(tmpdir(), "ap-usage-fields-"));
const HOME = join(DIR, "home");
const ANTHROPIC_CRED = join(DIR, "anthropic.json");
const CODEX_CRED = join(DIR, "codex.json");
const GOOGLE_CRED = join(DIR, "google.json");
const GROK_AUTH = join(DIR, "grok-auth.json");
const GROK_MODELS = join(DIR, "grok-models.json");
const GEMINI_KEY = join(DIR, "gemini-api-key");

/** Bearers good for hours, so nothing here depends on a refresh path. */
writeFileSync(ANTHROPIC_CRED, JSON.stringify({
  claudeAiOauth: {
    accessToken: "AT-usage-fields", refreshToken: "RT-usage-fields",
    expiresAt: Date.now() + 6 * 3600_000, scopes: ["user:inference"],
  },
}));
writeFileSync(CODEX_CRED, JSON.stringify({
  tokens: { access_token: "AT-usage-fields-codex", refresh_token: "RT-usage-fields-codex", account_id: "acct-usage-fields" },
  last_refresh: new Date().toISOString(),
}));
// The Antigravity well's shape: googleToken() reads token.access_token and an expiry, and
// fingerprints the account from the refresh token. An hour of validity keeps the provider's
// self-refresh path (which would dial a token endpoint) entirely out of these tests.
writeFileSync(GOOGLE_CRED, JSON.stringify({
  token: {
    access_token: "AT-usage-fields-google", refresh_token: "RT-usage-fields-google",
    expiry: Date.now() + 6 * 3600_000,
  },
}));
// The grok CLI's own auth-file shape: keyed by issuer::client, with the token in `key`
// rather than `access_token`. Only its refusals are exercised here, but a model cannot even
// be resolved without a readable well.
writeFileSync(GROK_AUTH, JSON.stringify({
  "https://auth.x.ai::11111111-2222-3333-4444-555555555555": {
    key: "AT-usage-fields-grok", auth_mode: "oidc", refresh_token: "RT-usage-fields-grok",
    expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
    user_id: "user-usage-fields", email: "someone@example.com",
    oidc_issuer: "https://auth.x.ai", oidc_client_id: "11111111-2222-3333-4444-555555555555",
  },
}));
writeFileSync(GROK_MODELS, JSON.stringify({
  fetched_at: new Date().toISOString(), auth_method: "session",
  models: {
    "grok-4.6": { info: {
      id: "grok-4.6", model: "grok-4.6", name: "Grok 4.6",
      api_backend: "responses", auth_scheme: "bearer",
      context_window: 500_000, supported_in_api: true,
    } },
  },
}));
// The API-key route reads a key from a file when the env vars are unset. A literal string
// is all it needs; nothing here ever reaches a real endpoint.
writeFileSync(GEMINI_KEY, "AIza-usage-fields-not-a-real-key\n");

let proc: ReturnType<typeof Bun.spawn> | null = null;
let base = "";     // the apiplan server under test
let fixture = "";  // the stub upstream, so a test can say what it should report
let recorder = "";  // where the probe publishes what the recover() hook was handed

beforeAll(async () => {
  proc = Bun.spawn(["bun", PROBE], {
    env: {
      ...process.env,
      APIPLAN_HOME: HOME,
      APIPLAN_API_KEY: "",
      APIPLAN_ANTHROPIC_CRED_FILE: ANTHROPIC_CRED,
      APIPLAN_CODEX_AUTH: CODEX_CRED,
      APIPLAN_GOOGLE_CRED_FILE: GOOGLE_CRED,
      APIPLAN_GROK_AUTH: GROK_AUTH,
      APIPLAN_GROK_MODELS: GROK_MODELS,
      APIPLAN_GEMINI_API_KEY_FILE: GEMINI_KEY,
      // The API-key route prefers these env vars over the file; unset them so the stub file
      // is what answers and a real key in the developer's shell can never be sent anywhere.
      APIPLAN_GEMINI_API_KEY: "",
      GEMINI_API_KEY: "",
      // Never let a Keychain entry on the developer's machine answer instead of the stubs.
      APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
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
  const m = /READY (\d+) (\d+) (\d+)/.exec(buf);
  if (!m) throw new Error(`probe never became ready: ${buf}\n${await new Response(proc.stderr).text()}`);
  base = `http://127.0.0.1:${m[1]}`;
  fixture = `http://127.0.0.1:${m[2]}`;
  recorder = `http://127.0.0.1:${m[3]}`;
});
afterAll(() => {
  try { proc?.kill(); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────── talking to the server ───────────────────────────

/** Arm the stub upstream. Awaited, so the fixture is in place before the request goes out. */
async function upstream(f: unknown) {
  const r = await fetch(`${fixture}/__fixture`, { method: "POST", body: JSON.stringify(f) });
  expect(r.ok).toBe(true);
}

/** A backend per vendor. `pick()` resolves these against the real registry. */
const CLAUDE = "opus";          // → anthropic backend
const CODEX = "gpt-6-astra";    // → openai backend (Responses shape)
const GEMINI = "gemini";        // → google backend (Antigravity subscription)
// The three remaining explain() implementors. Each is reached only for its refusals, so a
// credential well and a resolvable id are all they need.
const OLLAMA = "usage-fields:latest";  // → ollama backend (discovered from the fixture daemon)
const GROK = "grok-4.6";               // → grok backend (Responses shape)
const GEMINI_KEY_MODEL = "geminikey";  // → gemini backend (the API-key route)

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** POST /v1/messages (Anthropic FRONT), non-streaming. */
async function messages(model: string): Promise<any> {
  const r = await post("/v1/messages", { model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
  const j = await r.json();
  if (!r.ok) throw new Error(`messages ${r.status}: ${JSON.stringify(j)}`);
  return j;
}
/** POST /v1/chat/completions (OpenAI FRONT), non-streaming. */
async function chat(model: string): Promise<any> {
  const r = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "hello" }] });
  const j = await r.json();
  if (!r.ok) throw new Error(`chat ${r.status}: ${JSON.stringify(j)}`);
  return j;
}
/** Whatever the front answered, ok or not — for the refusal paths. */
async function messagesRaw(model: string): Promise<{ status: number; body: any }> {
  const r = await post("/v1/messages", { model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
  return { status: r.status, body: await r.json() };
}

/**
 * The reply's RAW BYTES, exactly as they left the server, for asserting a field is absent.
 *
 * Not a stylistic preference — DISTRUST THE INSTRUMENT BEFORE THE SYSTEM. Re-serialising a
 * parsed body with JSON.stringify() silently omits any key whose value is `undefined`, so
 * `expect(JSON.stringify(parsed)).not.toContain("x")` would also pass for a payload that
 * really did emit `"x"` and had it read back as undefined: the recorder would manufacture
 * the very absence the test claims to have observed. Reading the wire text means the only
 * way these assertions pass is that the bytes never carried the field.
 */
async function messagesWire(model: string): Promise<{ json: any; wire: string }> {
  const r = await post("/v1/messages", { model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
  const wire = await r.text();
  if (!r.ok) throw new Error(`messages ${r.status}: ${wire}`);
  return { json: JSON.parse(wire), wire };
}
async function chatWire(model: string): Promise<{ json: any; wire: string }> {
  const r = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "hello" }] });
  const wire = await r.text();
  if (!r.ok) throw new Error(`chat ${r.status}: ${wire}`);
  return { json: JSON.parse(wire), wire };
}

/** Every `data:` payload of an SSE response, parsed, in order. */
async function sseFrames(r: Response): Promise<any[]> {
  expect(r.ok).toBe(true);
  const text = await r.text();
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const p = line.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    out.push(JSON.parse(p));
  }
  return out;
}
/** The message_delta of a streamed Anthropic-front reply. */
async function messagesStreamUsage(model: string): Promise<any> {
  const r = await post("/v1/messages", {
    model, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hello" }],
  });
  const delta = (await sseFrames(r)).filter((f) => f.type === "message_delta");
  expect(delta.length).toBe(1);
  return delta[0];
}
/** The usage-bearing final chunk of a streamed OpenAI-front reply. */
async function chatStreamUsage(model: string): Promise<any> {
  const r = await post("/v1/chat/completions", {
    model, messages: [{ role: "user", content: "hello" }],
    stream: true, stream_options: { include_usage: true },
  });
  const withUsage = (await sseFrames(r)).filter((f) => f.usage);
  // Exactly one usage-bearing chunk: a second would let a reader double-count by summing.
  expect(withUsage.length).toBe(1);
  return withUsage[0];
}

/** Anthropic's documented identity: the parts are disjoint and sum to the whole prompt. */
const anthropicPromptTotal = (u: any) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

// ═══════════════════════════════ ANTHROPIC ═══════════════════════════════

/**
 * THE VENDOR'S DOCUMENTED `Usage` OBJECT, quoted from the Messages API reference — this is
 * the checklist every assertion below is a line of:
 *
 *   input_tokens                 number   tokens not read from or used to create a cache
 *   output_tokens                number
 *   cache_read_input_tokens      number   "Number of input tokens read from the cache."
 *   cache_creation_input_tokens  number   "Number of input tokens used to create the cache
 *                                          entry."
 *   cache_creation               object   { ephemeral_1h_input_tokens: "The number of input
 *                                          tokens used to create the 1 hour cache entry.",
 *                                          ephemeral_5m_input_tokens: "The number of input
 *                                          tokens used to create the 5 minute cache entry." }
 *   server_tool_use              object   { web_search_requests: "The number of web search
 *                                          tool requests.", web_fetch_requests: "The number
 *                                          of web fetch tool requests." }
 *   iterations                   array    per-attempt counts inside a server-side fallback
 *                                         chain, each an { input_tokens, output_tokens,
 *                                         cache_read_input_tokens,
 *                                         cache_creation_input_tokens } of its own
 *
 * The worked example the vendor prints beside `cache_creation` is the fixture below, exactly:
 *   { "input_tokens": 2048, "cache_read_input_tokens": 1800,
 *     "cache_creation_input_tokens": 248, "output_tokens": 503,
 *     "cache_creation": { "ephemeral_5m_input_tokens": 148,
 *                         "ephemeral_1h_input_tokens": 100 } }
 * followed by the sentence that makes the TTL split a sub-division rather than a bucket:
 * "Note that the current cache_creation_input_tokens field equals the sum of the values in
 * the cache_creation object."
 */
const DOC_INPUT = 2048, DOC_READ = 1800, DOC_WRITE = 248, DOC_OUT = 503;
const DOC_5M = 148, DOC_1H = 100;
const ANTHROPIC_DOC_USAGE = {
  input_tokens: DOC_INPUT, output_tokens: DOC_OUT,
  cache_read_input_tokens: DOC_READ, cache_creation_input_tokens: DOC_WRITE,
  cache_creation: { ephemeral_5m_input_tokens: DOC_5M, ephemeral_1h_input_tokens: DOC_1H },
  server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 },
};

describe("anthropic's documented usage object, field by field", () => {
  test("every forwarded field reaches the Anthropic front with the right number", async () => {
    await upstream({ anthropic: ANTHROPIC_DOC_USAGE });
    const u = (await messages(CLAUDE)).usage;
    // The four buckets, unchanged — a same-dialect turn needs no conversion.
    expect(u.input_tokens).toBe(DOC_INPUT);
    expect(u.output_tokens).toBe(DOC_OUT);
    expect(u.cache_read_input_tokens).toBe(DOC_READ);
    expect(u.cache_creation_input_tokens).toBe(DOC_WRITE);
    // THE P-23 FIELD: the TTL breakdown, in the vendor's own spelling.
    expect(u.cache_creation).toEqual({ ephemeral_5m_input_tokens: DOC_5M, ephemeral_1h_input_tokens: DOC_1H });
    // Per-REQUEST tool counters, also this vendor's own object.
    expect(u.server_tool_use).toEqual({ web_search_requests: 3, web_fetch_requests: 2 });
  });

  test("the TTL components sum to cacheWrite — a sub-division, never a fourth bucket", async () => {
    await upstream({ anthropic: ANTHROPIC_DOC_USAGE });
    const u = (await messages(CLAUDE)).usage;
    // The vendor's own stated identity, which is what makes this safe to forward at all.
    expect(u.cache_creation.ephemeral_5m_input_tokens + u.cache_creation.ephemeral_1h_input_tokens)
      .toBe(u.cache_creation_input_tokens);
    // And therefore the prompt is still covered EXACTLY once: adding the split to anything
    // would count the same 248 physical tokens twice.
    expect(anthropicPromptTotal(u)).toBe(DOC_INPUT + DOC_READ + DOC_WRITE);
    // An exact partition needs no caveat, and must not claim to be an estimate.
    const j = await messages(CLAUDE);
    expect(j.x_apiplan_usage).toBeUndefined();
    expect(j.x_apiplan_usage_basis).toBeUndefined();
  });

  test("the breakdown survives the stream, on the corrected message_delta", async () => {
    await upstream({ anthropic: ANTHROPIC_DOC_USAGE });
    const d = await messagesStreamUsage(CLAUDE);
    expect(d.usage.cache_creation).toEqual({ ephemeral_5m_input_tokens: DOC_5M, ephemeral_1h_input_tokens: DOC_1H });
    expect(d.usage.cache_creation_input_tokens).toBe(DOC_WRITE);
  });

  test("a 1h-only write is carried as 1h — the case that was being under-billed", async () => {
    // The reachable shape: a caller sends cache_control with ttl "1h", so the whole write is
    // the 1h component and the 5m one is absent rather than zero.
    await upstream({ anthropic: {
      input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100_000,
      cache_creation: { ephemeral_1h_input_tokens: 100_000 },
    } });
    const u = (await messages(CLAUDE)).usage;
    expect(u.cache_creation).toEqual({ ephemeral_1h_input_tokens: 100_000 });
    expect(u.cache_creation.ephemeral_5m_input_tokens).toBeUndefined();
    expect(u.cache_creation_input_tokens).toBe(100_000);
  });

  test("a vendor that reports no breakdown gets none invented", async () => {
    // ABSENT MEANS ABSENT. A consumer already handles a missing split by pricing the flat
    // total; synthesizing one would put a derived-looking number in front of a reader who
    // would reasonably take it as measured.
    await upstream({ anthropic: {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 4_000,
    } });
    const u = (await messages(CLAUDE)).usage;
    expect(u.cache_creation_input_tokens).toBe(4_000);
    expect(u.cache_creation).toBeUndefined();
    expect(u.server_tool_use).toBeUndefined();
  });

  test("an ALL-ZERO breakdown is not emitted — it would CLEAR a real one downstream", async () => {
    // Not a cosmetic choice. OM's extractor treats an explicit all-zero `cache_creation` as
    // a command to delete `usage.cttl`, and this vendor reports usage twice per turn
    // (message_start, then a corrected message_delta). Emitting a zeroed object on the
    // correction would therefore erase the genuine split the opening snapshot carried —
    // a NEW silent drop introduced by the fix for the old one.
    await upstream({ anthropic: {
      input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    } });
    const u = (await messages(CLAUDE)).usage;
    // The measured zero on the flat counter is EVIDENCE and survives: it means "a write was
    // looked for and there was none", which a cache reader must tell apart from silence.
    expect(u.cache_creation_input_tokens).toBe(0);
    expect(u.cache_creation).toBeUndefined();
  });

  test("the corrected message_delta wins, and does not lose the opening breakdown", async () => {
    // message_start opens with the split; message_delta corrects the totals and, as real
    // Anthropic streams do, repeats the split. The final numbers are the corrected ones.
    await upstream({
      anthropicStart: {
        input_tokens: 2048, output_tokens: 1, cache_creation_input_tokens: 248,
        cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 },
      },
      anthropic: {
        input_tokens: 2048, output_tokens: 503, cache_creation_input_tokens: 248,
        cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 },
      },
    });
    const d = await messagesStreamUsage(CLAUDE);
    expect(d.usage.output_tokens).toBe(503);
    expect(d.usage.cache_creation).toEqual({ ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 });
  });

  test("`iterations` is dropped, and the totals beside it are unaffected", async () => {
    // DROPPED WITH A REASON: per-attempt counts inside a server-side fallback chain, whose
    // sums are already the top-level fields. Republishing them would invite a reader to add
    // the same tokens twice, and no front dialect defines a field for them.
    await upstream({ anthropic: {
      input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0,
      iterations: [
        { type: "message", model: "claude-opus-5", input_tokens: 60, output_tokens: 5 },
        { type: "fallback_message", model: "claude-sonnet-5", input_tokens: 40, output_tokens: 15 },
      ],
    } as any });
    const { json: j, wire } = await messagesWire(CLAUDE);
    expect(j.usage.input_tokens).toBe(100);
    expect(j.usage.output_tokens).toBe(20);
    expect(j.usage.iterations).toBeUndefined();
    expect(wire).not.toContain("iterations");
    expect(wire).not.toContain("fallback_message");
  });
});

describe("the TTL split crossing into the OpenAI dialect", () => {
  test("is NOT rendered there, because that dialect has no lifetime dimension", async () => {
    // Explicitly the right answer rather than an oversight. `prompt_tokens_details` has a
    // cached/written dimension and no TTL one, so emitting `ephemeral_1h_input_tokens`
    // inside an OpenAI-shaped usage object would invent a field in a vendor's namespace —
    // and the next reader would reasonably take it as vendor-stated. The information is
    // legitimately unavailable on this front; a consumer that needs it reads the other one.
    await upstream({ anthropic: ANTHROPIC_DOC_USAGE });
    const { json: j, wire } = await chatWire(CLAUDE);
    // The buckets still cross correctly: exclusive → inclusive folds the cached parts in.
    expect(j.usage.prompt_tokens).toBe(DOC_INPUT + DOC_READ + DOC_WRITE);
    expect(j.usage.prompt_tokens_details.cached_tokens).toBe(DOC_READ);
    expect(j.usage.prompt_tokens_details.cache_write_tokens).toBe(DOC_WRITE);
    // And nothing invented a lifetime or a tool counter in this vendor's namespace —
    // asserted on the WIRE TEXT, so the absence is the server's and not the recorder's.
    expect(wire).not.toContain("ephemeral_1h_input_tokens");
    expect(wire).not.toContain("ephemeral_5m_input_tokens");
    expect(wire).not.toContain("cache_creation");
    expect(wire).not.toContain("server_tool_use");
  });
});

// ═══════════════════════════════ OPENAI / RESPONSES ═══════════════════════════════

/**
 * THE DOCUMENTED RESPONSES USAGE OBJECT — the fields both this vendor and the xAI proxy
 * (whose catalog declares `api_backend: "responses"`) put on the same shape:
 *
 *   input_tokens                             number
 *   output_tokens                            number
 *   total_tokens                             number
 *   input_tokens_details.cached_tokens       number  the cached share OF input_tokens
 *   input_tokens_details.cache_write_tokens  number  (absent on xAI: that vendor states no
 *                                                    write counter at all — an ABSENCE)
 *   output_tokens_details.reasoning_tokens   number  "Tokens generated by the model for
 *                                                    reasoning" — already inside
 *                                                    output_tokens, billed at the full
 *                                                    completion rate
 *   input_tokens_details.orchestration_input_tokens
 *   input_tokens_details.orchestration_input_cached_tokens
 *   output_tokens_details.orchestration_output_tokens
 *                                            a SEPARATE accounting lane, not a breakdown
 *
 * xAI additionally sends context_details.{input,output}_tokens, num_sources_used,
 * num_server_side_tools_used and cost_in_usd_ticks; the first is that vendor's own
 * re-description of counters already carried, and the last is money, which this server
 * never computes or republishes.
 */
const R_IN = 10_000, R_OUT = 500, R_CACHED = 7_424, R_REASON = 300;

describe("the Responses usage object, field by field", () => {
  test("reasoning_tokens is forwarded, in the spelling THIS front documents", async () => {
    await upstream({ openai: { input_tokens: R_IN, output_tokens: R_OUT, cached_tokens: R_CACHED, reasoning_tokens: R_REASON } });
    const j = await chat(CODEX);
    // A same-dialect turn: the inclusive total is republished as the inclusive total.
    expect(j.usage.prompt_tokens).toBe(R_IN);
    expect(j.usage.completion_tokens).toBe(R_OUT);
    expect(j.usage.prompt_tokens_details.cached_tokens).toBe(R_CACHED);
    // This endpoint is Chat Completions, whose usage object nests the reasoning count as
    // `completion_tokens_details.reasoning_tokens`. The Responses API's
    // `output_tokens_details` is a different shape and never appears on a chat.completion,
    // so rendering it here would be a field this dialect does not define.
    expect(j.usage.completion_tokens_details).toEqual({ reasoning_tokens: R_REASON });
    expect(j.usage.output_tokens_details).toBeUndefined();
  });

  test("reasoning is a SHARE of the completion, never added to it", async () => {
    await upstream({ openai: { input_tokens: R_IN, output_tokens: R_OUT, cached_tokens: R_CACHED, reasoning_tokens: R_REASON } });
    const j = await chat(CODEX);
    // The invariant a consumer can rely on across every vendor, whatever that vendor's own
    // nesting: reasoning is inside output, so summing them would bill it twice.
    expect(j.usage.completion_tokens_details.reasoning_tokens).toBeLessThanOrEqual(j.usage.completion_tokens);
    expect(j.usage.completion_tokens).toBe(R_OUT);
    expect(j.usage.total_tokens).toBe(R_IN + R_OUT);
  });

  test("it survives the stream too, when the caller asked for usage", async () => {
    await upstream({ openai: { input_tokens: R_IN, output_tokens: R_OUT, cached_tokens: R_CACHED, reasoning_tokens: R_REASON } });
    const last = await chatStreamUsage(CODEX);
    expect(last.usage.completion_tokens_details).toEqual({ reasoning_tokens: R_REASON });
    expect(last.usage.prompt_tokens_details.cached_tokens).toBe(R_CACHED);
  });

  test("an absent cache-write counter stays ABSENT, never a measured zero", async () => {
    // The inverse of the TTL bug, and the same class: xAI's Responses usage has no write
    // counter at all. Defaulting it to 0 would manufacture measured evidence of a cache
    // miss out of a vendor's silence — and an explicit zero is exactly what a
    // cache-effectiveness reader is entitled to treat as "measured, and it missed".
    await upstream({ openai: { input_tokens: 5_000, output_tokens: 12, cached_tokens: 1_024 } });
    const j = await chat(CODEX);
    expect(j.usage.prompt_tokens_details.cached_tokens).toBe(1_024);
    expect(j.usage.prompt_tokens_details.cache_write_tokens).toBeUndefined();
  });

  test("an explicit zero DOES survive — silence and a measured miss are different facts", async () => {
    await upstream({ openai: { input_tokens: 5_000, output_tokens: 12, cached_tokens: 0, cache_write_tokens: 0 } });
    const j = await chat(CODEX);
    expect(j.usage.prompt_tokens_details.cached_tokens).toBe(0);
    expect(j.usage.prompt_tokens_details.cache_write_tokens).toBe(0);
  });

  test("the orchestration counters are dropped, and do not disturb the primary lane", async () => {
    // DROPPED WITH A REASON: a consumer that reads them keeps them as a SEPARATE lane, its
    // own input/cacheRead/output triple, and only after deciding from `total_tokens`
    // whether the primary counters already contain them. This gateway's Delta has exactly
    // one lane, so there is nowhere to put them that does not either double-count a bucket
    // or silently inflate one — and neither front dialect defines the fields, so
    // re-emitting them would invent a vendor field on the way out.
    await upstream({ openai: {
      input_tokens: R_IN, output_tokens: R_OUT, cached_tokens: R_CACHED, reasoning_tokens: R_REASON,
      total_tokens: R_IN + R_OUT,
      orchestration_input_tokens: 900, orchestration_input_cached_tokens: 400, orchestration_output_tokens: 120,
    } });
    const { json: j, wire } = await chatWire(CODEX);
    // The primary numbers are exactly what the vendor said about the primary lane.
    expect(j.usage.prompt_tokens).toBe(R_IN);
    expect(j.usage.completion_tokens).toBe(R_OUT);
    expect(j.usage.prompt_tokens_details.cached_tokens).toBe(R_CACHED);
    expect(j.usage.total_tokens).toBe(R_IN + R_OUT);
    // Nothing leaked, under any spelling — read off the wire text, not a re-serialisation.
    expect(wire).not.toContain("orchestration");
  });

  test("crossing into the Anthropic dialect, reasoning is published under this server's own prefix", async () => {
    // The Anthropic usage object has NO thinking-token counter, so a measured reasoning
    // share has no vendor spelling to arrive in on that front. Dropping it silently would
    // re-create, on the cross-dialect path, exactly the loss this whole change removes — so
    // it is published under an `x_apiplan_` name, which says plainly who is speaking rather
    // than inventing a field inside a vendor's namespace.
    await upstream({ openai: { input_tokens: R_IN, output_tokens: R_OUT, cached_tokens: R_CACHED, reasoning_tokens: R_REASON } });
    const u = (await messages(CODEX)).usage;
    expect(u.x_apiplan_reasoning_tokens).toBe(R_REASON);
    // Still a share of output, and the buckets still cover the prompt exactly once
    // (inclusive → exclusive subtracts the cached part).
    expect(u.x_apiplan_reasoning_tokens).toBeLessThanOrEqual(u.output_tokens);
    expect(u.input_tokens).toBe(R_IN - R_CACHED);
    expect(anthropicPromptTotal(u)).toBe(R_IN);
  });
});

// ═══════════════════════════════ GOOGLE / GEMINI ═══════════════════════════════

/**
 * GEMINI'S DOCUMENTED `UsageMetadata`, quoted from the generateContent reference:
 *
 *   promptTokenCount         integer  "Number of tokens in the prompt. When cachedContent is
 *                                     set, this is still the total effective prompt size
 *                                     meaning this includes the number of tokens in the
 *                                     cached content."
 *   cachedContentTokenCount  integer  "Number of tokens in the cached part of the prompt
 *                                     (the cached content)"
 *   candidatesTokenCount     integer  "Total number of tokens across all the generated
 *                                     response candidates."
 *   toolUsePromptTokenCount  integer  "Output only. Number of tokens present in tool-use
 *                                     prompt(s)."
 *   thoughtsTokenCount       integer  "Output only. Number of tokens of thoughts for
 *                                     thinking models."
 *   totalTokenCount          integer  "Total token count for the generation request (prompt
 *                                     + thoughts + response candidates)."
 *   promptTokensDetails[]    object   per-modality breakdown of the input
 *   cacheTokensDetails[]     object   per-modality breakdown of the cached content
 *
 * TWO SEMANTICS THAT DECIDE THE MAPPING, AND NEITHER IS GUESSABLE FROM THE FIELD NAMES:
 *   · cachedContentTokenCount is a BREAKDOWN of promptTokenCount (the first quote says so),
 *     so it maps to cacheRead raw and normalizeTally does the single subtraction this
 *     inclusive vendor needs.
 *   · thoughtsTokenCount is NOT inside candidatesTokenCount — the totalTokenCount identity
 *     makes thoughts a THIRD addend — and the thinking guide prices it as output. So the
 *     billed output is candidates + thoughts, and publishing candidates alone under-reports
 *     every thinking turn.
 * The live figures below were captured against the real endpoint (3163/1/3155/23/3187).
 */
const G_PROMPT = 3163, G_CAND = 1, G_CACHED = 3155, G_THOUGHTS = 23;
const GOOGLE_DOC_USAGE = {
  promptTokenCount: G_PROMPT, candidatesTokenCount: G_CAND,
  cachedContentTokenCount: G_CACHED, thoughtsTokenCount: G_THOUGHTS,
  totalTokenCount: G_PROMPT + G_CAND + G_THOUGHTS,
  toolUsePromptTokenCount: 77,
  promptTokensDetails: [{ modality: "TEXT", tokenCount: G_PROMPT }],
  cacheTokensDetails: [{ modality: "TEXT", tokenCount: G_CACHED }],
};

describe("gemini's documented usageMetadata, field by field", () => {
  test("cachedContentTokenCount reaches the front as a cache READ — the counter that was dropped", async () => {
    await upstream({ google: GOOGLE_DOC_USAGE });
    const u = (await messages(GEMINI)).usage;
    // THE FAULT: this counter says the cache WORKED, and a dropped counter is
    // indistinguishable downstream from a measured zero — so a working cache read as one
    // that never hit, which is the single question a caller sends cached content to answer.
    expect(u.cache_read_input_tokens).toBe(G_CACHED);
    // Inclusive → exclusive: the cached share is subtracted exactly once, so the vendor's
    // 3,163-token prompt is still covered exactly once across the buckets.
    expect(u.input_tokens).toBe(G_PROMPT - G_CACHED);
    expect(anthropicPromptTotal(u)).toBe(G_PROMPT);
    // An exact partition carries no caveat.
    const j = await messages(GEMINI);
    expect(j.x_apiplan_usage).toBeUndefined();
    expect(j.x_apiplan_usage_basis).toBeUndefined();
  });

  test("thoughtsTokenCount is billed output, so it is INSIDE the output count and reported as reasoning", async () => {
    await upstream({ google: GOOGLE_DOC_USAGE });
    const u = (await messages(GEMINI)).usage;
    // Not candidatesTokenCount alone — that under-reports the billed output by the thoughts.
    expect(u.output_tokens).toBe(G_CAND + G_THOUGHTS);
    expect(u.x_apiplan_reasoning_tokens).toBe(G_THOUGHTS);
    // The same cross-vendor invariant: a share of output, never an addend to it.
    expect(u.x_apiplan_reasoning_tokens).toBeLessThanOrEqual(u.output_tokens);
  });

  test("on the OpenAI front the same turn reads correctly in that dialect's own spelling", async () => {
    await upstream({ google: GOOGLE_DOC_USAGE });
    const j = await chat(GEMINI);
    // This vendor is inclusive and so is this dialect, so the prompt total is republished
    // whole with the cached share as a breakdown of it.
    expect(j.usage.prompt_tokens).toBe(G_PROMPT);
    expect(j.usage.prompt_tokens_details.cached_tokens).toBe(G_CACHED);
    expect(j.usage.completion_tokens).toBe(G_CAND + G_THOUGHTS);
    expect(j.usage.completion_tokens_details).toEqual({ reasoning_tokens: G_THOUGHTS });
  });

  test("toolUsePromptTokenCount and the per-modality details are dropped", async () => {
    // DROPPED WITH A REASON, and toolUsePromptTokenCount is the interesting one: the vendor
    // never documents whether promptTokenCount CONTAINS it, and the totalTokenCount identity
    // omits it. Folding it into input could double-count; subtracting it could go negative.
    // Documented-or-absent — a guessed partition outlives whoever guessed it. The modality
    // arrays describe counters already carried in full, and no dialect has a modality axis.
    await upstream({ google: GOOGLE_DOC_USAGE });
    const { json: j, wire } = await messagesWire(GEMINI);
    // The prompt is accounted for by the buckets alone, with no room left for a 77 that
    // nobody can place.
    expect(anthropicPromptTotal(j.usage)).toBe(G_PROMPT);
    expect(wire).not.toContain("toolUsePromptTokenCount");
    expect(wire).not.toContain("promptTokensDetails");
    expect(wire).not.toContain("cacheTokensDetails");
    expect(wire).not.toContain("modality");
  });

  test("a turn with no thinking and no cache reports neither, and invents nothing", async () => {
    await upstream({ google: { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160 } });
    const u = (await messages(GEMINI)).usage;
    expect(u.input_tokens).toBe(120);
    expect(u.output_tokens).toBe(40);
    // No cache counter was stated, so none is published — and an inclusive backend that
    // says nothing about its cache cannot be converted, which the basis marker declares
    // rather than papering over with an assumed zero.
    expect(u.cache_read_input_tokens).toBeUndefined();
    expect(u.x_apiplan_reasoning_tokens).toBeUndefined();
  });
});

// ═══════════════════════════ THE PROVIDER'S OWN FIX-IT LINE ═══════════════════════════

/**
 * `Provider.explain(status, body)` turns a non-2xx status and a vendor error body into an
 * accurate fix-it line — and it had ZERO call sites. Four providers published careful
 * guidance that nothing ever read, which is the same class of fault as a dropped usage
 * field: no symptom, no error, just information that never arrives.
 *
 * The one that matters most is google's: this endpoint answers 403 SUBSCRIPTION_REQUIRED
 * when the CLIENT IDENTITY is wrong rather than the login, so the generic reading sends a
 * user to re-authenticate a perfectly healthy account — the exact outcome that line exists
 * to prevent.
 */
describe("a provider's explain() reaches the caller", () => {
  test("google's 403 says the client identity is wrong, not the login", async () => {
    await upstream({ reject: { status: 403, body: JSON.stringify({
      error: { code: 403, message: "This project requires a valid license.", status: "PERMISSION_DENIED",
               details: [{ reason: "SUBSCRIPTION_REQUIRED" }] },
    }) } });
    const { status, body } = await messagesRaw(GEMINI);
    expect(status).toBe(403);
    const msg = body?.error?.message ?? "";
    // The adapter's diagnosis, not the vendor's bare refusal.
    expect(msg).toContain("subscription tier was not served");
    expect(msg).toContain("CLIENT identity");
    // And the guidance that keeps a user away from a pointless re-login.
    expect(msg).toContain("re-logging in will not help");
    // THE VENDOR'S OWN WORDS ARE KEPT BESIDE IT: an interpretation that erases its evidence
    // cannot be checked, and if the adapter's reading is wrong the human reading this
    // message is the only one who can notice.
    expect(msg).toContain("valid license");
  });

  test("google's 404 explains that a display name is not a wire id", async () => {
    await upstream({ reject: { status: 404, body: JSON.stringify({ error: { message: "models/nope is not found" } }) } });
    const { status, body } = await messagesRaw(GEMINI);
    expect(status).toBe(404);
    expect(body?.error?.message ?? "").toContain("no such model on the wire");
  });

  test("a status the provider has no line for keeps the vendor's own message", async () => {
    // explain() returning undefined must change nothing: the generic wording is right for
    // most faults, and a fix-it line is an addition, never a replacement policy.
    await upstream({ reject: { status: 429, body: JSON.stringify({ error: { message: "quota exhausted, retry later" } }) } });
    const { status, body } = await messagesRaw(GEMINI);
    expect(status).toBe(429);
    const msg = body?.error?.message ?? "";
    expect(msg).toContain("quota exhausted");
    expect(msg).not.toContain("subscription tier was not served");
  });

  test("a provider with no explain() at all is unaffected", async () => {
    // anthropic implements none, so its refusals must read exactly as they did before this
    // call site existed.
    await upstream({ reject: { status: 400, body: JSON.stringify({
      error: { type: "invalid_request_error", message: "max_tokens: must be greater than 0" },
    }) } });
    const { status, body } = await messagesRaw(CLAUDE);
    expect(status).toBe(400);
    expect(body?.error?.message ?? "").toContain("max_tokens: must be greater than 0");
  });

  test("the status and the vendor's error TYPE are never rewritten by a fix-it line", async () => {
    // A diagnosis changes what a HUMAN reads. A client's retry logic branches on the status
    // and the vendor's own fault name, and neither may move because an adapter had advice.
    await upstream({ reject: { status: 403, body: JSON.stringify({
      error: { type: "permission_error", message: "valid license required", details: [{ reason: "SUBSCRIPTION_REQUIRED" }] },
    }) } });
    const { status, body } = await messagesRaw(GEMINI);
    expect(status).toBe(403);
    expect(body?.error?.type).toBe("permission_error");
  });

  // ── ONE TEST PER IMPLEMENTING PROVIDER ──
  // The call site is one line shared by every provider, so proving it for google proves the
  // mechanism. These prove the WIRING per adapter: a provider whose explain() is never
  // consulted — because its route, its model resolution or its credential well diverges —
  // is back to publishing guidance nobody reads, which is the fault being closed.

  test("ollama's 404 says the model is not pulled, rather than 'no such model'", async () => {
    await upstream({ reject: { status: 404, body: JSON.stringify({ error: "model 'usage-fields:latest' not found" }) } });
    const { status, body } = await messagesRaw(OLLAMA);
    expect(status).toBe(404);
    const msg = body?.error?.message ?? "";
    // The actionable part: which command fixes it, and that the tag is part of the name.
    expect(msg).toContain("ollama pull");
    expect(msg).toContain("not pulled on this machine");
  });

  test("grok's 401 says the SESSION is stale, not that the account is bad", async () => {
    // The distinction that matters to a user: a stale local session is refreshed by running
    // the CLI once; a bad account is not, and telling them the wrong one wastes their time.
    await upstream({ reject: { status: 401, body: JSON.stringify({ error: { message: "unauthorized" } }) } });
    const { status, body } = await messagesRaw(GROK);
    expect(status).toBe(401);
    const msg = body?.error?.message ?? "";
    expect(msg).toContain("refused the session (401)");
    // The vendor's own words are kept beside the diagnosis, as everywhere else.
    expect(msg).toContain("unauthorized");
  });

  test("the gemini API-key route explains a rejected key without blaming the endpoint", async () => {
    await upstream({ reject: { status: 400, body: JSON.stringify({
      error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" },
    }) } });
    const { status, body } = await messagesRaw(GEMINI_KEY_MODEL);
    expect(status).toBe(400);
    // Whatever the adapter's wording, the vendor's own sentence must reach the human — this
    // is the provider whose explain() is newest, so the assertion is on the contract (a
    // non-empty message that keeps the evidence) rather than on today's phrasing.
    const msg = body?.error?.message ?? "";
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain("API key not valid");
  });
});

/**
 * ── THE `recover()` HOOK: THE ENGINE'S HALF OF THE CONTRACT ──
 *
 * A provider cannot see an upstream status anywhere else — build() is synchronous by
 * contract and delta() only ever sees stream frames — so a refusal that invalidates state
 * the provider HOLDS has no way to reach it. The case that motivated the hook: Google
 * answers 403 (not 404) for an evicted CachedContent, and a provider still holding that
 * dead name keeps referencing a corpse on every later turn with the same prefix, until the
 * process restarts. One refusal, then permanent poisoning.
 *
 * WHAT IS TESTED HERE IS ONLY THE WIRING, deliberately. Whether a given adapter forgets the
 * right entry is that adapter's own state to observe and belongs in its own lane. What
 * belongs here is the part every adapter depends on and none can verify: that the engine
 * calls the hook at all, hands it the RAW body rather than the narrowed message, reports
 * the fault unchanged anyway, and is undisturbed when the hook throws.
 *
 * THE OBSERVATION IS NOT VACUOUS, and that has to be argued rather than asserted, because a
 * negative result is only evidence if the instrument could have produced the positive. The
 * recorder here reports what it was HANDED — a status, a body, a model id — so a wiring
 * that never fired yields an empty list, which is distinguishable from every passing case.
 * The raw-body claim is the load-bearing one, and it is checked positively: the fixture's
 * error body carries a marker OUTSIDE `error.message`, so a hook handed the narrowed detail
 * could not contain it. That is the exact trap this signature was designed around — an
 * implementation matching on any field but error.message would otherwise silently never
 * fire, which looks identical to the bug it was written to fix.
 */
type RecoverSeen = { status: number; body: string; model: string };
/** Clear the recorder, and choose whether the hook throws when the engine calls it. */
async function armRecover(mode?: "throw") {
  const r = await fetch(`${recorder}/reset${mode ? `?mode=${mode}` : ""}`);
  expect(r.ok).toBe(true);
}
const recovered = async (): Promise<RecoverSeen[]> => (await fetch(recorder)).json();

describe("a provider's recover() is consulted on an upstream refusal", () => {
  /**
   * `x_apiplan_probe` sits OUTSIDE error.message on purpose: by the time the engine throws,
   * `detail` has been narrowed to the vendor's message, so a hook handed `detail` could not
   * possibly see this marker. Its presence is therefore positive proof of the raw body, and
   * its absence would be positive proof of the narrowing bug — not an ambiguous silence.
   */
  const EVICTED = JSON.stringify({
    error: {
      code: 403, status: "PERMISSION_DENIED",
      message: "CachedContent not found (or permission denied).",
      x_apiplan_probe: "outside-error-message",
    },
  });

  test("it is handed the RAW body and the real status, and the refusal still surfaces", async () => {
    await armRecover();
    await upstream({ reject: { status: 403, body: EVICTED } });
    const { status, body } = await messagesRaw(CLAUDE);
    // The caller gets one honest refusal: recover() repairs local state, it does not retry
    // and it does not soften what happened.
    expect(status).toBe(403);
    expect(body?.error?.message ?? "").toContain("CachedContent not found");

    const seen = await recovered();
    // Called exactly once — a hook called twice per refusal would double any repair.
    expect(seen.length).toBe(1);
    expect(seen[0].status).toBe(403);
    expect(seen[0].model).toBe("claude-opus-5-5");
    // THE RAW-BODY GUARANTEE, checked positively.
    expect(seen[0].body).toContain("x_apiplan_probe");
    expect(seen[0].body).toContain("PERMISSION_DENIED");
  });

  test("a throwing recover() changes nothing a caller can see", async () => {
    // A provider's repair is best-effort. If it faults, the upstream's own refusal is still
    // the answer — swallowing the vendor's fault because a recovery attempt failed would
    // replace a real diagnosis with an internal one.
    await armRecover("throw");
    await upstream({ reject: { status: 403, body: EVICTED } });
    const { status, body } = await messagesRaw(CLAUDE);
    expect(status).toBe(403);
    expect(body?.error?.message ?? "").toContain("CachedContent not found");
    // And it really was called — otherwise this test proves nothing about throwing.
    expect((await recovered()).length).toBe(1);
  });

  test("it is NOT consulted when the upstream accepted the request", async () => {
    // The hook exists to react to a refusal. Calling it on a healthy turn would invite a
    // provider to discard live state it is about to need.
    await armRecover();
    await upstream({ anthropic: ANTHROPIC_DOC_USAGE });
    const u = (await messages(CLAUDE)).usage;
    expect(u.cache_creation_input_tokens).toBe(DOC_WRITE);
    expect(await recovered()).toEqual([]);
  });
});

// ═══════════════════════ PROVED AGAINST THE REAL CONSUMER ═══════════════════════

/**
 * The tests above prove this server emits what the vendors document. That is necessary and
 * not sufficient: the founding ask is "prove against om", and a server can satisfy a
 * specification as its author understood it while still being mis-parsed by the consumer
 * that actually reads it — which is exactly where the TTL fault lived. So this block runs
 * OM's REAL extractor and pi-catalog's REAL pricer over the payload this server emits.
 *
 * Skipped without APIPLAN_OM_PROOF=1 — not because it is slow or flaky (no network, no
 * credential, no vendor) but because it reaches OUTSIDE this repo into a pinned OM runtime
 * this project does not own, and a contributor without it must not see a red suite.
 */
const OM_RUNTIME = "/Users/magic/.om/runtimes/closeout-20260906T094900Z/node_modules/@oh-my-pi";
const OM_ANTHROPIC = `${OM_RUNTIME}/pi-ai/src/providers/anthropic.ts`;
const OM_MODELS = `${OM_RUNTIME}/pi-catalog/src/models.ts`;
const omProof = process.env.APIPLAN_OM_PROOF === "1" && existsSync(OM_ANTHROPIC) ? describe : describe.skip;

omProof("OM's own parser and pricer, over the payload this server emits", () => {
  /** The rate card of a real model, so the money below is the money that would be billed:
   *  claude-fable-5-1 — input $10, cacheWrite $12.50 (1.25x input), read $0.25, output $50. */
  const RATES = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };

  test("usage.cttl matches the cache_creation this server published", async () => {
    // DYNAMIC ON PURPOSE: the module lives outside this repo behind an env gate, so a static
    // import would make every run depend on a runtime directory this project does not own.
    const { applyAnthropicUsageExtras } = await import(OM_ANTHROPIC);
    await upstream({ anthropic: ANTHROPIC_DOC_USAGE });
    const emitted = (await messages(CLAUDE)).usage;

    // OM's shape, filled by OM's own extractor from OUR payload. Nothing here
    // re-implements the parse — if OM changes how it reads usage, this test changes with it.
    const usage: Record<string, unknown> = { input: emitted.input_tokens, output: emitted.output_tokens,
      cacheRead: emitted.cache_read_input_tokens, cacheWrite: emitted.cache_creation_input_tokens };
    applyAnthropicUsageExtras(usage, emitted);

    expect(usage.cttl).toEqual({ ephemeral5m: DOC_5M, ephemeral1h: DOC_1H });
    // The server-tool counters cross the same way, from the same object.
    expect(usage.server).toEqual({ webSearch: 3, webFetch: 2 });
  });

  test("the 1h portion is priced at 2x input, which is what the drop was costing", async () => {
    const { applyAnthropicUsageExtras } = await import(OM_ANTHROPIC);
    const { calculateCost } = await import(OM_MODELS);
    const WRITE_1H = 100_000;
    await upstream({ anthropic: {
      input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 0,
      cache_creation_input_tokens: WRITE_1H,
      cache_creation: { ephemeral_1h_input_tokens: WRITE_1H },
    } });
    const emitted = (await messages(CLAUDE)).usage;

    const usage: Record<string, unknown> = {
      input: emitted.input_tokens, output: emitted.output_tokens,
      cacheRead: emitted.cache_read_input_tokens ?? 0, cacheWrite: emitted.cache_creation_input_tokens,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    applyAnthropicUsageExtras(usage, emitted);
    expect((usage.cttl as { ephemeral1h?: number })?.ephemeral1h).toBe(WRITE_1H);

    calculateCost({ cost: RATES } as never, usage as never);
    const cost = usage.cost as { cacheWrite: number };
    // 100,000 x (input 10 x 2) / 1e6 = $2.00, the correct figure.
    expect(cost.cacheWrite).toBeCloseTo((RATES.input * 2 * WRITE_1H) / 1e6, 12);
    // NOT the flat 5m rate the dropped breakdown used to fall back to: 100,000 x 12.5 / 1e6
    // = $1.25. The gap is 0.75x input per 1h write — derived from the rates rather than
    // hardcoded, so this stays true if a card moves.
    const flat5m = (RATES.cacheWrite * WRITE_1H) / 1e6;
    expect(cost.cacheWrite).toBeGreaterThan(flat5m);
    expect(cost.cacheWrite - flat5m).toBeCloseTo(((RATES.input * 2 - RATES.cacheWrite) * WRITE_1H) / 1e6, 12);
  });

  test("a mixed split prices each component at its own rate, and the parts still sum", async () => {
    const { applyAnthropicUsageExtras } = await import(OM_ANTHROPIC);
    const { calculateCost } = await import(OM_MODELS);
    await upstream({ anthropic: ANTHROPIC_DOC_USAGE });
    const emitted = (await messages(CLAUDE)).usage;

    const usage: Record<string, unknown> = {
      input: emitted.input_tokens, output: emitted.output_tokens,
      cacheRead: emitted.cache_read_input_tokens, cacheWrite: emitted.cache_creation_input_tokens,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    applyAnthropicUsageExtras(usage, emitted);
    calculateCost({ cost: RATES } as never, usage as never);
    const cost = usage.cost as { cacheWrite: number };
    // 148 at the 5m rate + 100 at 2x input, with no residual because the split sums to the
    // flat total exactly — the vendor's stated identity, priced.
    expect(cost.cacheWrite).toBeCloseTo((RATES.cacheWrite * DOC_5M) / 1e6 + ((RATES.input * 2) * DOC_1H) / 1e6, 12);
    expect(DOC_5M + DOC_1H).toBe(DOC_WRITE);
  });

  test("with no breakdown published, the flat rate still applies — a partial forward is safe", async () => {
    // The property that made this fix landable incrementally: OM prices any unattributed
    // remainder at the flat rate rather than dropping it, so forwarding nothing, half, or
    // all of a split can never make write tokens free.
    const { applyAnthropicUsageExtras } = await import(OM_ANTHROPIC);
    const { calculateCost } = await import(OM_MODELS);
    await upstream({ anthropic: {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 4_000,
    } });
    const emitted = (await messages(CLAUDE)).usage;
    expect(emitted.cache_creation).toBeUndefined();

    const usage: Record<string, unknown> = {
      input: emitted.input_tokens, output: emitted.output_tokens,
      cacheRead: 0, cacheWrite: emitted.cache_creation_input_tokens,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    applyAnthropicUsageExtras(usage, emitted);
    expect(usage.cttl).toBeUndefined();
    calculateCost({ cost: RATES } as never, usage as never);
    expect((usage.cost as { cacheWrite: number }).cacheWrite).toBeCloseTo((RATES.cacheWrite * 4_000) / 1e6, 12);
  });
});
