/**
 * THE TWO VENDORS MEAN DIFFERENT THINGS BY "INPUT TOKENS", AND THIS SERVER CROSSES THEM.
 *
 * The endpoint dialect and the backend are independent here by design, so a prompt-cache
 * counter routinely leaves one vendor's accounting convention and is republished in the
 * other's — and the conventions are opposites, each vendor's own documentation being the
 * source:
 *
 *   anthropic  EXCLUSIVE   input_tokens counts only what was NOT read from or written to
 *                          the cache; total = cache_read + cache_creation + input_tokens.
 *   openai     INCLUSIVE   input_tokens is the WHOLE prompt and cached_tokens is a
 *                          breakdown of it; ordinary = input - cached - cache_write.
 *
 * Copied straight across, that is a real accounting fault in BOTH directions:
 *   · Codex behind /v1/messages published an inclusive total as Anthropic `input_tokens`
 *     WITH cache_read_input_tokens beside it, so anyone applying Anthropic's documented sum
 *     counted the cached prefix twice and the turn read bigger than it was.
 *   · Claude behind /v1/chat/completions published an exclusive remainder as `prompt_tokens`
 *     with cached_tokens beside it, so anyone applying OpenAI's documented subtraction went
 *     NEGATIVE on the ordinary part and under-counted the prompt by the whole cache.
 * On a cache-heavy agent turn the cached prefix is most of the prompt, so a cost model
 * reading either number is wrong by most of the prompt.
 *
 * ── WHY THIS DRIVES A REAL SERVER AGAINST A REAL UPSTREAM, IN ITS OWN PROCESS ──
 * Asserting on the helpers directly would only prove the helpers agree with themselves. The
 * fault lived in the whole path — an UPSTREAM's counters, carried through run()'s Delta
 * plumbing, folded by tally(), rendered by an emit site of the OTHER dialect. So these tests
 * talk to an actual api.serve() over loopback, whose providers are pointed at a fixture
 * upstream speaking each vendor's genuine wire events (Responses SSE / Anthropic
 * message_start…message_stop). Every counter asserted on has really travelled the production
 * path; nothing is mocked inside the server and no helper is re-implemented.
 *
 * Both live in a SUBPROCESS (test/helpers/usage-dialect-probe.ts) because the base URLs and
 * credential wells come from the environment and `bun test` shares one process across files:
 * setting them here leaked into contract.test.ts and astra.test.ts, which rightly assert the
 * REAL upstream URLs. The probe owns its world, exactly as test/helpers/apiplan-probe.ts does.
 *
 * Zero spend, zero contact with the operator's world: scratch STATE_DIR, stub credential
 * files written below, no vendor ever dialled, nothing outside the temp dir written.
 */
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "helpers", "usage-dialect-probe.ts");

// ─────────────────────────── the world these tests run in ───────────────────────────

const DIR = mkdtempSync(join(tmpdir(), "ap-usage-dialect-"));
const HOME = join(DIR, "home");
const ANTHROPIC_CRED = join(DIR, "anthropic.json");
const CODEX_CRED = join(DIR, "codex.json");

/** Bearers good for hours, so nothing here depends on a refresh path. */
writeFileSync(ANTHROPIC_CRED, JSON.stringify({
  claudeAiOauth: {
    accessToken: "AT-usage-dialect", refreshToken: "RT-usage-dialect",
    expiresAt: Date.now() + 6 * 3600_000, scopes: ["user:inference"],
  },
}));
writeFileSync(CODEX_CRED, JSON.stringify({
  tokens: { access_token: "AT-usage-dialect-codex", refresh_token: "RT-usage-dialect-codex", account_id: "acct-usage-dialect" },
  last_refresh: new Date().toISOString(),
}));

let proc: ReturnType<typeof Bun.spawn> | null = null;
let base = "";     // the apiplan server under test
let fixture = "";  // the stub upstream, so a test can say what it should report

beforeAll(async () => {
  proc = Bun.spawn(["bun", PROBE], {
    env: {
      ...process.env,
      APIPLAN_HOME: HOME,
      APIPLAN_API_KEY: "",
      APIPLAN_ANTHROPIC_CRED_FILE: ANTHROPIC_CRED,
      APIPLAN_CODEX_AUTH: CODEX_CRED,
      // Never let a Keychain entry on the developer's machine answer instead of the stubs.
      APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      // No google credential at all: this suite never routes there.
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
  if (!m) throw new Error(`probe never became ready: ${buf}\n${await new Response(proc.stderr).text()}`);
  base = `http://127.0.0.1:${m[1]}`;
  fixture = `http://127.0.0.1:${m[2]}`;
});
afterAll(() => {
  try { proc?.kill(); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────── talking to the server ───────────────────────────

/** What the next upstream call will report, in each vendor's OWN field names. */
type Counters = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type Fixture = {
  anthropic?: Counters;
  openai?: { input_tokens?: number; output_tokens?: number; cached_tokens?: number; cache_write_tokens?: number };
  /** Anthropic reports a count on message_start and CORRECTS it on message_delta. */
  anthropicStart?: Counters;
  /** Omit the usage object entirely, the way a backend reporting nothing does. */
  silent?: boolean;
};
/** Arm the stub upstream. Awaited, so the fixture is in place before the request goes out. */
async function upstream(f: Fixture) {
  const r = await fetch(`${fixture}/__fixture`, { method: "POST", body: JSON.stringify(f) });
  expect(r.ok).toBe(true);
}

/** A backend on each side of the matrix. `pick()` resolves these against the real registry. */
const CLAUDE = "opus";       // → anthropic backend
const CODEX = "gpt-6-astra"; // → openai backend

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** POST /v1/chat/completions (OpenAI FRONT), non-streaming. */
async function chat(model: string): Promise<any> {
  const r = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "hello" }] });
  const j = await r.json();
  if (!r.ok) throw new Error(`chat ${r.status}: ${JSON.stringify(j)}`);
  return j;
}
/** POST /v1/messages (Anthropic FRONT), non-streaming. */
async function messages(model: string): Promise<any> {
  const r = await post("/v1/messages", { model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
  const j = await r.json();
  if (!r.ok) throw new Error(`messages ${r.status}: ${JSON.stringify(j)}`);
  return j;
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
/** The message_delta of a streamed Anthropic-front reply, plus its message_start. */
async function messagesStreamUsage(model: string): Promise<{ start: any; delta: any }> {
  const r = await post("/v1/messages", {
    model, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hello" }],
  });
  const frames = await sseFrames(r);
  const delta = frames.filter((f) => f.type === "message_delta");
  expect(delta.length).toBe(1);
  return { start: frames.find((f) => f.type === "message_start"), delta: delta[0] };
}

// ─────────────────────────── what each dialect's own docs say ───────────────────────────

/** Anthropic's documented identity: the parts are disjoint and sum to the whole prompt. */
const anthropicPromptTotal = (u: any) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
/** OpenAI's documented subtraction: prompt_tokens already CONTAINS the cached parts. */
const openaiOrdinary = (u: any) =>
  (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0) - (u.prompt_tokens_details?.cache_write_tokens ?? 0);

// ─────────────────────────── the paired vendor reading ───────────────────────────

/**
 * ONE physical turn, described by each vendor the way that vendor really would, so the two
 * fixtures are the SAME prompt seen through the two conventions:
 *   whole prompt 10,000 · cached (read) 8,000 · uncached remainder 2,000
 * Anthropic reports the remainder as input_tokens (2,000); OpenAI reports the whole prompt
 * as input_tokens (10,000). Every assertion below is that this one physical turn survives
 * both crossings.
 */
const TOTAL = 10_000, CACHED = 8_000, UNCACHED = TOTAL - CACHED, OUT = 500;
const pairedAnthropic: Counters = { input_tokens: UNCACHED, output_tokens: OUT, cache_read_input_tokens: CACHED, cache_creation_input_tokens: 0 };
const pairedOpenAI = { input_tokens: TOTAL, output_tokens: OUT, cached_tokens: CACHED, cache_write_tokens: 0 };

describe("an inclusive backend crossing into Anthropic's shape", () => {
  test("does not double-count the cached prefix (non-streaming)", async () => {
    await upstream({ openai: pairedOpenAI });
    const j = await messages(CODEX);
    // THE BUG: input_tokens was 10,000 while cache_read was 8,000, so Anthropic's own
    // documented sum reported an 18,000-token prompt for a 10,000-token turn.
    expect(j.usage.input_tokens).toBe(UNCACHED);
    expect(j.usage.cache_read_input_tokens).toBe(CACHED);
    expect(anthropicPromptTotal(j.usage)).toBe(TOTAL);
    // The physical numbers are re-partitioned, never invented or dropped.
    expect(j.usage.output_tokens).toBe(OUT);
    // An exact partition needs no caveat, and must not claim to be an estimate.
    expect(j.x_apiplan_usage).toBeUndefined();
    expect(j.x_apiplan_usage_basis).toBeUndefined();
  });

  test("does not double-count on a stream either", async () => {
    await upstream({ openai: pairedOpenAI });
    const { delta } = await messagesStreamUsage(CODEX);
    expect(delta.usage.input_tokens).toBe(UNCACHED);
    expect(delta.usage.cache_read_input_tokens).toBe(CACHED);
    expect(anthropicPromptTotal(delta.usage)).toBe(TOTAL);
    expect(delta.x_apiplan_usage_basis).toBeUndefined();
  });

  test("a large cached share leaves a small honest remainder", async () => {
    // The shape of a real agent turn: nearly all prefix, a few new tokens.
    await upstream({ openai: { input_tokens: 200_000, output_tokens: 120, cached_tokens: 199_872, cache_write_tokens: 0 } });
    const j = await messages(CODEX);
    expect(j.usage.input_tokens).toBe(128);
    expect(j.usage.cache_read_input_tokens).toBe(199_872);
    expect(anthropicPromptTotal(j.usage)).toBe(200_000);
  });

  test("a cache WRITE is subtracted too, not just a read", async () => {
    await upstream({ openai: { input_tokens: 5_000, output_tokens: 10, cached_tokens: 1_000, cache_write_tokens: 2_500 } });
    const j = await messages(CODEX);
    expect(j.usage.input_tokens).toBe(1_500);
    expect(j.usage.cache_read_input_tokens).toBe(1_000);
    expect(j.usage.cache_creation_input_tokens).toBe(2_500);
    expect(anthropicPromptTotal(j.usage)).toBe(5_000);
  });
});

describe("an exclusive backend crossing into OpenAI's shape", () => {
  test("prompt_tokens is the whole prompt, so the documented subtraction works", async () => {
    await upstream({ anthropic: pairedAnthropic });
    const j = await chat(CLAUDE);
    // THE BUG: prompt_tokens was 2,000 with cached_tokens 8,000 beside it, so OpenAI's own
    // documented subtraction produced -6,000 ordinary tokens.
    expect(j.usage.prompt_tokens).toBe(TOTAL);
    expect(j.usage.prompt_tokens_details.cached_tokens).toBe(CACHED);
    expect(openaiOrdinary(j.usage)).toBe(UNCACHED);
    expect(openaiOrdinary(j.usage)).toBeGreaterThanOrEqual(0);
    expect(j.usage.completion_tokens).toBe(OUT);
    expect(j.usage.total_tokens).toBe(TOTAL + OUT);
    expect(j.x_apiplan_usage).toBeUndefined();
    expect(j.x_apiplan_usage_basis).toBeUndefined();
  });

  test("the same holds on a stream when the caller asked for usage", async () => {
    await upstream({ anthropic: pairedAnthropic });
    const last = await chatStreamUsage(CLAUDE);
    expect(last.usage.prompt_tokens).toBe(TOTAL);
    expect(last.usage.prompt_tokens_details.cached_tokens).toBe(CACHED);
    expect(openaiOrdinary(last.usage)).toBe(UNCACHED);
    expect(last.usage.total_tokens).toBe(TOTAL + OUT);
  });

  test("a cache write is folded in as well", async () => {
    await upstream({ anthropic: { input_tokens: 2_000, output_tokens: 40, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 1_000 } });
    const j = await chat(CLAUDE);
    // 2,000 uncached + 8,000 read + 1,000 written = an 11,000-token prompt.
    expect(j.usage.prompt_tokens).toBe(11_000);
    expect(j.usage.prompt_tokens_details.cached_tokens).toBe(8_000);
    expect(j.usage.prompt_tokens_details.cache_write_tokens).toBe(1_000);
    expect(openaiOrdinary(j.usage)).toBe(2_000);
  });
});

describe("round-trip conservation", () => {
  /**
   * The point of the whole change: ONE physical turn, and whichever front a caller uses,
   * each vendor's OWN arithmetic must recover the same prompt total and the same uncached
   * remainder. That is what a cost model reads, so this is the test that matters.
   */
  test("both fronts agree on one turn's prompt total and uncached share", async () => {
    await upstream({ openai: pairedOpenAI });
    const viaAnthropicFront = await messages(CODEX);   // openai backend → anthropic dialect
    await upstream({ anthropic: pairedAnthropic });
    const viaOpenAIFront = await chat(CLAUDE);         // anthropic backend → openai dialect

    expect(anthropicPromptTotal(viaAnthropicFront.usage)).toBe(TOTAL);
    expect(viaOpenAIFront.usage.prompt_tokens).toBe(TOTAL);
    expect(viaAnthropicFront.usage.input_tokens).toBe(UNCACHED);
    expect(openaiOrdinary(viaOpenAIFront.usage)).toBe(UNCACHED);
    // Cache counters are carried, not consumed by the conversion.
    expect(viaAnthropicFront.usage.cache_read_input_tokens).toBe(CACHED);
    expect(viaOpenAIFront.usage.prompt_tokens_details.cached_tokens).toBe(CACHED);
  });

  test("same-dialect passthrough is unchanged in both directions", async () => {
    // A backend answering its OWN dialect needs no conversion at all, and must not get one.
    await upstream({ anthropic: pairedAnthropic });
    const a = await messages(CLAUDE);
    expect(a.usage.input_tokens).toBe(UNCACHED);
    expect(a.usage.cache_read_input_tokens).toBe(CACHED);
    expect(anthropicPromptTotal(a.usage)).toBe(TOTAL);

    await upstream({ openai: pairedOpenAI });
    const o = await chat(CODEX);
    expect(o.usage.prompt_tokens).toBe(TOTAL);
    expect(o.usage.prompt_tokens_details.cached_tokens).toBe(CACHED);
    expect(openaiOrdinary(o.usage)).toBe(UNCACHED);
  });
});

describe("cost recomputed on known prices", () => {
  /**
   * The reason any of this matters. A cost model bills the three buckets at three DIFFERENT
   * rates, so a partition error is a billing error. These are the published Opus-5 rates as
   * recorded in src/roster.ts (input 5, cacheRead = input/10 = 0.5, output 25 USD/MTok); the
   * arithmetic is done here rather than imported so the test states its own ground truth.
   *
   * Only the ACCOUNTING is checked. Whether a subscription bills any of it is not this
   * file's business, and the server never converts a token count into money.
   */
  const IN_RATE = 5, READ_RATE = 0.5, OUT_RATE = 25;
  const usd = (input: number, read: number, out: number) =>
    (input * IN_RATE + read * READ_RATE + out * OUT_RATE) / 1e6;

  test("both fronts price one physical turn identically, and the bug over-billed", async () => {
    const truth = usd(UNCACHED, CACHED, OUT);

    await upstream({ anthropic: pairedAnthropic });
    const oa = (await chat(CLAUDE)).usage;
    const fromOpenAIShape = usd(openaiOrdinary(oa), oa.prompt_tokens_details.cached_tokens, oa.completion_tokens);

    await upstream({ openai: pairedOpenAI });
    const an = (await messages(CODEX)).usage;
    const fromAnthropicShape = usd(an.input_tokens, an.cache_read_input_tokens, an.output_tokens);

    expect(fromOpenAIShape).toBeCloseTo(truth, 10);
    expect(fromAnthropicShape).toBeCloseTo(truth, 10);
    expect(fromAnthropicShape).toBeCloseTo(fromOpenAIShape, 10);

    // And the old behaviour really was wrong: billing the raw inclusive input as though it
    // were the uncached remainder charged the full input rate on the cached prefix as well.
    const buggy = usd(TOTAL, CACHED, OUT);
    expect(buggy).toBeGreaterThan(truth);
    expect(buggy - truth).toBeCloseTo((CACHED * IN_RATE) / 1e6, 10);
  });
});

describe("what the server will not invent", () => {
  test("an unknown counter stays unknown rather than becoming a zero", async () => {
    // A backend that reports NO usage at all. The reply still carries numbers (a context
    // meter reading 0 never auto-compacts, and the session dies of an overflow instead), but
    // they are marked as this server's estimate — the pre-existing honesty contract.
    await upstream({ silent: true });
    const j = await messages(CODEX);
    expect(j.x_apiplan_usage).toBe("estimated");
    expect(j.usage.input_tokens).toBeGreaterThan(0);
    // Nothing was measured about the cache, so no cache counter is conjured.
    expect(j.usage.cache_read_input_tokens).toBeUndefined();
    expect(j.usage.cache_creation_input_tokens).toBeUndefined();

    await upstream({ silent: true });
    const o = await chat(CLAUDE);
    expect(o.x_apiplan_usage).toBe("estimated");
    expect(o.usage.prompt_tokens).toBeGreaterThan(0);
    expect(o.usage.prompt_tokens_details).toBeUndefined();
  });

  test("an inclusive backend that reports no cache counters is UNAVAILABLE, not assumed-zero", async () => {
    // The backend gave a total but never said what share was cached. Subtracting an assumed
    // zero would publish an exclusive-looking number nothing supports, so the total passes
    // through and the reply says the partition could not be derived.
    await upstream({ openai: { input_tokens: TOTAL, output_tokens: OUT } });
    const j = await messages(CODEX);
    expect(j.usage.input_tokens).toBe(TOTAL);            // the measured total, untouched
    expect(j.usage.cache_read_input_tokens).toBeUndefined();
    expect(j.x_apiplan_usage_basis).toBe("unavailable");
    expect(j.x_apiplan_usage).toBeUndefined();            // measured, just not partitionable
  });

  test("an explicit zero is preserved as the measured cache MISS it is", async () => {
    // Zero and absent must stay distinguishable: one is evidence of a miss, the other is the
    // backend declining to say. That distinction is what a cache-effectiveness reader needs.
    await upstream({ openai: { input_tokens: 4_000, output_tokens: 20, cached_tokens: 0, cache_write_tokens: 0 } });
    const j = await messages(CODEX);
    expect(j.usage.cache_read_input_tokens).toBe(0);
    expect(j.usage.cache_creation_input_tokens).toBe(0);
    // Nothing was cached, so the whole prompt is the uncached part on either basis.
    expect(j.usage.input_tokens).toBe(4_000);
    expect(anthropicPromptTotal(j.usage)).toBe(4_000);
    expect(j.x_apiplan_usage_basis).toBeUndefined();

    await upstream({ anthropic: { input_tokens: 4_000, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    const o = await chat(CLAUDE);
    expect(o.usage.prompt_tokens_details.cached_tokens).toBe(0);
    expect(o.usage.prompt_tokens).toBe(4_000);
    expect(openaiOrdinary(o.usage)).toBe(4_000);
  });

  test("contradictory upstream counters are reported, never silently repaired", async () => {
    // An inclusive backend claiming more cached tokens than the input they are part of. A
    // subtraction would fabricate a negative and a clamp would destroy real tokens, so the
    // measured input survives, the counters that cannot be reconciled are withheld rather
    // than republished as though a reader could add them up, and the reply says why.
    await upstream({ openai: { input_tokens: 1_000, output_tokens: 10, cached_tokens: 9_000 } });
    const j = await messages(CODEX);
    expect(j.x_apiplan_usage_basis).toBe("source-inconsistent");
    expect(j.usage.input_tokens).toBe(1_000);             // physical, unmodified
    expect(j.usage.input_tokens).toBeGreaterThanOrEqual(0);
    expect(j.usage.cache_read_input_tokens).toBeUndefined();
    // Whatever else happens, no reader can be led into a double count.
    expect(anthropicPromptTotal(j.usage)).toBe(1_000);

    await upstream({ openai: { input_tokens: 1_000, output_tokens: 10, cached_tokens: 9_000 } });
    const o = await chat(CODEX);
    expect(o.x_apiplan_usage_basis).toBe("source-inconsistent");
    expect(o.usage.prompt_tokens).toBe(1_000);            // not inflated by the bad counter
    expect(o.usage.prompt_tokens_details).toBeUndefined();
    expect(openaiOrdinary(o.usage)).toBe(1_000);
  });

  test("cache counters without a measured input do not partition an ESTIMATE", async () => {
    // The estimate models the WHOLE prompt, so treating it as the uncached remainder would
    // count the cached prefix twice on top of a number that was never measured.
    await upstream({ openai: { output_tokens: 30, cached_tokens: 7_000 } });
    const j = await messages(CODEX);
    expect(j.x_apiplan_usage).toBe("estimated");
    expect(j.x_apiplan_usage_basis).toBe("unavailable");
    expect(j.usage.cache_read_input_tokens).toBe(7_000);   // measured, still reported
    expect(j.usage.input_tokens).toBeGreaterThan(0);

    await upstream({ openai: { output_tokens: 30, cached_tokens: 7_000 } });
    const o = await chat(CODEX);
    expect(o.x_apiplan_usage).toBe("estimated");
    expect(o.x_apiplan_usage_basis).toBe("unavailable");
    // The estimate is published as it stands, NOT inflated by adding the cached tokens.
    expect(o.usage.prompt_tokens).toBeLessThan(7_000);
    expect(o.usage.prompt_tokens_details.cached_tokens).toBe(7_000);
  });
});

describe("a streamed reply's cumulative snapshots", () => {
  test("the corrected final count wins over the opening one", async () => {
    // Anthropic sends a count on message_start and a CORRECTION on message_delta. The fold
    // must publish the correction, not the first thing it saw, or a stream reports a turn's
    // usage as whatever was known before the turn happened.
    await upstream({
      anthropicStart: { input_tokens: UNCACHED, output_tokens: 1, cache_read_input_tokens: CACHED, cache_creation_input_tokens: 0 },
      anthropic: pairedAnthropic,
    });
    const last = await chatStreamUsage(CLAUDE);
    expect(last.usage.completion_tokens).toBe(OUT);        // the correction, not the opening 1
    expect(last.usage.prompt_tokens).toBe(TOTAL);
    expect(openaiOrdinary(last.usage)).toBe(UNCACHED);
  });

  test("the Anthropic front's own message_start estimate is marked, and message_delta is exact", async () => {
    // message_start is emitted before upstream has answered, so its count is necessarily
    // this server's estimate and says so; the closing message_delta carries the real one.
    await upstream({ openai: pairedOpenAI });
    const { start, delta } = await messagesStreamUsage(CODEX);
    expect(start.message.x_apiplan_usage).toBe("estimated");
    expect(delta.usage.input_tokens).toBe(UNCACHED);
    expect(delta.usage.cache_read_input_tokens).toBe(CACHED);
    expect(anthropicPromptTotal(delta.usage)).toBe(TOTAL);
    expect(delta.x_apiplan_usage).toBeUndefined();
  });

  test("a stream that was not asked for usage still reports none", async () => {
    // OpenAI only sends usage on a stream when the caller opted in. The normalization must
    // not have quietly introduced a field a strict client is not expecting.
    await upstream({ anthropic: pairedAnthropic });
    const r = await post("/v1/chat/completions", { model: CLAUDE, messages: [{ role: "user", content: "hello" }], stream: true });
    const frames = await sseFrames(r);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((f) => f.usage)).toBe(false);
  });
});
