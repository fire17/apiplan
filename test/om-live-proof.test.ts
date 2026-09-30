/**
 * THE ONE TEST WHERE THE CLIENT IS NOT WRITTEN HERE.
 *
 * Every other suite in this repo checks APIPlan against APIPlan's own reading of the two
 * vendors' documentation. That is necessary and it is not sufficient: the founding ask is
 * "prove against om", and a server can satisfy a spec as its author understood it while
 * still being mis-parsed by the real consumer. The gap is not hypothetical — it is where
 * the whole class of accounting faults this project exists to fix actually lived.
 *
 * So this file imports OM's REAL provider — `streamAnthropic` out of
 * @oh-my-pi/pi-ai, the exact code the operator's adopted runtime executes — points it at
 * an isolated `api.serve()` on loopback, and asserts on what OM itself computed. Nothing
 * here re-implements OM's parse; if OM changes how it reads usage, these tests change with
 * it, which is the point of proving against the consumer rather than against a copy of it.
 *
 * ── WHY `streamAnthropic` FOR EVERY BACKEND ──
 * Not a simplification. ~/.omp/agent/models.yml declares ONE provider, `apiplan`, with
 * `api: anthropic-messages`, for all 24 models — including the OpenAI-backed ones
 * (gpt-6-astra, gpt-5.6-*) and the Gemini ones. In production OM therefore ALWAYS drives
 * the Anthropic transport against this server, whatever backend answers. Driving
 * `streamOpenAIResponses` here would prove something about a path OM does not take.
 * (There is no `streamOpenAI` export at all — the transports are named
 * streamOpenAIResponses / streamOpenAICompletions / streamOpenAICodexResponses.)
 *
 * ── WHAT THE FOUR FAMILIES OF ASSERTION ARE ──
 *   1. USAGE. An inclusive backend (openai) and an exclusive one (anthropic) each report a
 *      turn in their own convention; OM's parsed usage must be the same DISJOINT partition
 *      in both cases — input holding only the uncached remainder, so
 *      input + cacheRead + cacheWrite covers the prompt exactly once. This is the crossing
 *      that used to double-count an 8,000-token cached prefix in one direction and go
 *      negative in the other.
 *   2. COST. The partition is only worth having if money comes out right, so each case is
 *      priced on its own rate card and compared to the arithmetic spelled out inline.
 *   3. CACHE IDENTITY. `prompt_cache_key` must reach the upstream and be STABLE across two
 *      calls carrying the same `metadata.user_id`. Read precisely: the key ROUTES, it does
 *      not OWN — OpenAI's own guide says keys "influence routing; they do not pin requests
 *      to a machine or guarantee a cache read hit", and CacheAlternationProbe measured a
 *      never-before-used key hitting a resident prefix 1339s after a DIFFERENT key sent it
 *      (2026-09-06). So a churning key is a lost ROUTING AFFINITY, not a guaranteed miss,
 *      and a stable one is necessary rather than sufficient. What these tests prove is the
 *      forwarding and the stability; whether a given turn reads cache is a live-vendor
 *      question this fixture cannot and does not answer.
 *   4. ATTESTATION. `custom-models.ts` forces `isOAuth: true` for any custom
 *      anthropic-messages provider, so pi-ai injects Claude Code's billing attestation as
 *      system[0] on EVERY request — and its `cch` hashes the request body, so it differs
 *      per turn while sitting at the HEAD of the cached prefix. It must not reach the
 *      upstream prompt. Asserted at BOTH ends: OM really does send it, and the upstream
 *      really does not see it.
 *
 * These are observations about the outgoing request as much as the reply, which is why the
 * host's stub upstream records every body it is handed (test/helpers/om-proof-host.ts).
 *
 * ── OPT-IN ──
 * Skipped unless APIPLAN_OM_PROOF=1. Not because it is slow or flaky (it is neither: no
 * network, no credential, no vendor), but because it reaches OUTSIDE this repo into a
 * pinned OM runtime directory. A contributor without that runtime, or with a different one
 * adopted, must not see a red suite for a dependency this project does not own.
 */
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = join(HERE, "helpers", "om-proof-host.ts");

/**
 * The adopted OM runtime, as of 2026-09-06: ~/.om/runtime-current → this directory.
 * Pinned rather than resolved through the symlink on purpose — a test that silently
 * follows a pointer somebody else may move is not evidence about a known runtime, and the
 * receipt for this lane has to name which code was proven against.
 */
const OM_RUNTIME = "/Users/magic/.om/runtimes/closeout-20260906T094900Z/node_modules/@oh-my-pi";
const PI_AI = `${OM_RUNTIME}/pi-ai/src/index.ts`;
/**
 * `buildModel` is NOT re-exported from pi-catalog's index (only `calculateCost` is), so it
 * is imported from the leaf module that defines it. Skipping it and hand-rolling a Model
 * literal is not an option: it is what materializes `compat` (15 resolved fields for
 * anthropic-messages), and the provider reads `model.compat.*` on nearly every branch —
 * an unbuilt model does not exercise the same code the operator's runtime does.
 */
const PI_CATALOG_BUILD = `${OM_RUNTIME}/pi-catalog/src/build.ts`;
const PI_CATALOG = `${OM_RUNTIME}/pi-catalog/src/index.ts`;

const ARMED = process.env.APIPLAN_OM_PROOF === "1";
/**
 * Two independent gates, and the runtime one is deliberately NOT an assertion. Arming the
 * flag on a machine whose runtime has moved should skip, not fail: the absence of a
 * third-party directory is not a defect in this server.
 */
const RUNNABLE = ARMED && existsSync(PI_AI) && existsSync(PI_CATALOG_BUILD);
const proof = describe.skipIf(!RUNNABLE);

// ─────────────────────────── the world these tests run in ───────────────────────────

const DIR = mkdtempSync(join(tmpdir(), "ap-om-proof-"));
const HOME = join(DIR, "home");
const ANTHROPIC_CRED = join(DIR, "anthropic.json");
const CODEX_CRED = join(DIR, "codex.json");

/** Stub bearers good for hours, so nothing here depends on a refresh path. Never the
 *  operator's: the wells are these files, and the Keychain is pointed at a service that
 *  does not exist. */
writeFileSync(ANTHROPIC_CRED, JSON.stringify({
  claudeAiOauth: {
    accessToken: "AT-om-proof", refreshToken: "RT-om-proof",
    expiresAt: Date.now() + 6 * 3600_000, scopes: ["user:inference"],
  },
}));
writeFileSync(CODEX_CRED, JSON.stringify({
  tokens: { access_token: "AT-om-proof-codex", refresh_token: "RT-om-proof-codex", account_id: "acct-om-proof" },
  last_refresh: new Date().toISOString(),
}));

/** Bun's spawned-process handle, named rather than reached for through
 *  `ReturnType<typeof Bun.spawn>`: only `stdout`, `stderr` and `kill` are used here, and
 *  the READY handshake below depends on both pipes being readable streams. */
type HostProcess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(): void;
};
let proc: HostProcess | null = null;
let apiBase = "";  // the apiplan server under test, which OM will be pointed at
let fixture = "";  // the stub upstream: says what to report, records what it was sent

/** OM's real Anthropic transport, and the catalog functions that shape and price a model.
 *  Loaded in beforeAll rather than at module scope so a skipped run never touches the
 *  runtime directory at all. */
type StreamAnthropic = (model: unknown, context: unknown, options: unknown) => { result(): Promise<OmMessage> };
type BuildModel = (spec: Record<string, unknown>) => Record<string, unknown>;
type CalculateCost = (model: unknown, usage: OmUsage) => OmCost;
let streamAnthropic: StreamAnthropic;
let buildModel: BuildModel;
let calculateCost: CalculateCost;

/** The shape of OM's own accounting — the numbers under test. Declared locally because
 *  importing pi-ai's types at module scope would defeat the skip gate above. */
type OmCost = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
type OmUsage = {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: OmCost;
  /** Anthropic's cache-write TTL breakdown, which pi-ai extracts from `cache_creation`
   *  (anthropic.ts:1620-1633) and pi-catalog prices per component (models.ts:97-105):
   *  1h writes bill at 2x INPUT, not at the flat 1.25x `cacheWrite` scalar. Absent for
   *  every provider but Anthropic. */
  cttl?: { ephemeral5m?: number; ephemeral1h?: number };
};
type OmMessage = { usage: OmUsage; stopReason: string; errorMessage?: string };

beforeAll(async () => {
  if (!RUNNABLE) return;
  // Dynamic import, deliberately: a static one would load the OM runtime even on a skipped
  // run, and the path is a pinned absolute outside this repo rather than a package the
  // project depends on.
  const ai = await import(PI_AI);
  const build = await import(PI_CATALOG_BUILD);
  const catalog = await import(PI_CATALOG);
  streamAnthropic = ai.streamAnthropic;
  buildModel = build.buildModel;
  calculateCost = catalog.calculateCost;

  proc = Bun.spawn(["bun", HOST], {
    env: {
      ...process.env,
      APIPLAN_HOME: HOME,
      APIPLAN_API_KEY: "",
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
  if (!m) throw new Error(`om proof host never became ready: ${buf}\n${await new Response(proc.stderr).text()}`);
  apiBase = `http://127.0.0.1:${m[1]}`;
  fixture = `http://127.0.0.1:${m[2]}`;
});
afterAll(() => {
  try { proc?.kill(); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────── driving OM at this server ───────────────────────────

/** What the next upstream call reports, in each vendor's OWN field names. */
type AnthropicCounters = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Anthropic's cache-write TTL BREAKDOWN, which bills at two different rates. Present
   *  and zero is a DIFFERENT input from absent; see the P-23 suite at the bottom. */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};
type Fixture = {
  anthropic?: AnthropicCounters;
  openai?: { input_tokens?: number; output_tokens?: number; cached_tokens?: number; cache_write_tokens?: number };
  /** Usage for `message_start` when it must DIFFER from the `message_delta` correction.
   *  Anthropic sends usage twice per turn and pi-ai folds them in order, so some faults —
   *  notably a zeroed breakdown erasing a real split — are only observable across the pair.
   *  Defaults to `anthropic`, so tests that do not ask for a disagreement are unaffected. */
  anthropicStart?: AnthropicCounters;
};
/** One request as the stub upstream received it — the evidence for every outgoing-body
 *  assertion. `raw` is kept beside the parsed body so a byte-level check (an attestation
 *  hiding anywhere in the payload, a cache_control count) needs no traversal. */
type Captured = { path: string; body: Record<string, unknown>; raw: string; headers: Record<string, string> };

/** Arm the stub upstream and forget any earlier traffic, so each test's captures are its
 *  own. Awaited, so the fixture is in place before the request goes out. */
async function upstream(f: Fixture): Promise<void> {
  const reset = await fetch(`${fixture}/__reset`, { method: "POST" });
  expect(reset.ok).toBe(true);
  const armed = await fetch(`${fixture}/__fixture`, { method: "POST", body: JSON.stringify(f) });
  expect(armed.ok).toBe(true);
}
async function captured(): Promise<Captured[]> {
  return (await (await fetch(`${fixture}/__captured`)).json()) as Captured[];
}

/**
 * A model exactly as OM builds one for this server, from the operator's real models.yml
 * block: provider `apiplan`, api anthropic-messages, baseUrl the local server. `cost` is
 * the rate card under test, passed per case so one helper serves every model family.
 *
 * `isOAuth` is not set here — it rides on the OPTIONS below, because that is where the
 * provider reads it. The rule it mirrors is custom-models.ts:58-63: a custom
 * anthropic-messages provider with no explicit `auth:` key resolves isOAuth TRUE, and
 * ~/.omp/agent/models.yml sets no `auth:`. So true is the production value, not a choice
 * made for this test.
 */
const omModel = (id: string, cost: OmCost extends never ? never : { input: number; output: number; cacheRead: number; cacheWrite: number }, contextWindow = 1_000_000) =>
  buildModel({
    id, name: id, api: "anthropic-messages", provider: "apiplan",
    baseUrl: apiBase, reasoning: true, input: ["text", "image"],
    cost, contextWindow, maxTokens: 128_000,
    thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true },
  });

/** A stable prompt: every cache assertion here is about identity ACROSS turns, so nothing
 *  in the request may vary except what a test varies on purpose. */
const SYSTEM = "STABLE SYSTEM PROMPT for the OM proof harness";
const ASK = "say hi";
/** OM's real attribution envelope — pi-ai only forwards a caller `user_id` under OAuth when
 *  it matches this shape (`isClaudeJsonUserId`); anything else is replaced with fresh
 *  entropy, which would make the stability assertion vacuous. */
const userId = (session: string) => JSON.stringify({ device_id: "dev-om-proof", session_id: session });

/**
 * One turn through OM into this server. `onPayload` is pi-ai's own pre-send hook, so
 * `sent` is the body OM composed BEFORE the wire — the only place to observe that the
 * attestation was really injected (by the time the upstream sees the request, APIPlan has
 * legitimately removed it, and "absent" would be indistinguishable from "never added").
 */
async function turn(model: Record<string, unknown>, session: string): Promise<{ msg: OmMessage; sent: Record<string, unknown> }> {
  let sent: Record<string, unknown> = {};
  const stream = streamAnthropic(model, {
    systemPrompt: [SYSTEM],
    messages: [{ role: "user", content: ASK, timestamp: Date.now() }],
  }, {
    apiKey: "not-needed",
    isOAuth: true,
    thinkingEnabled: false,
    metadata: { user_id: userId(session) },
    onPayload: (payload: Record<string, unknown>) => { sent = payload; return undefined; },
  });
  const msg = await stream.result();
  // A turn that errored would otherwise report zeroed usage and pass a lenient assertion.
  expect(msg.errorMessage ?? "-").toBe("-");
  return { msg, sent };
}

/** The four buckets, without the cost object, so a whole partition is one comparison. */
const partition = (u: OmUsage) => ({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });

// ─────────────────────────── the paired vendor reading ───────────────────────────

/**
 * ONE physical turn as each vendor would really describe it. 10,000 prompt tokens of which
 * 8,000 came from cache, 5 out:
 *   OPENAI (inclusive)   input_tokens is the WHOLE prompt; cached_tokens is a breakdown OF
 *                        it. 10,000 with 8,000 cached.
 *   ANTHROPIC (exclusive) input_tokens counts only what was NOT cached, and the docs state
 *                        the identity: total = input + cache_read + cache_creation. 2,000
 *                        with 8,000 read.
 * OM must land on the SAME disjoint partition either way. Deliberately kept under the
 * 272,000-token long-context threshold: past it a rate card switches tiers and a cost
 * assertion would fail for a reason that looks like a cache bug.
 */
const TOTAL = 10_000, CACHED = 8_000, UNCACHED = TOTAL - CACHED, OUT = 5;
const INCLUSIVE_UPSTREAM: Fixture = { openai: { input_tokens: TOTAL, output_tokens: OUT, cached_tokens: CACHED } };
const EXCLUSIVE_UPSTREAM: Fixture = { anthropic: { input_tokens: UNCACHED, output_tokens: OUT, cache_read_input_tokens: CACHED, cache_creation_input_tokens: 0 } };

/** The Astra card, as ~/.omp/agent/models.yml carries it. */
const ASTRA_COST = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
/** Every Claude card this suite prices, from the same file. */
const FABLE_5_1_COST = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };
const FABLE_5_COST = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
const OPUS_5_COST = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

/** Rates are per MILLION tokens, so every expected figure is built the same way. */
const priced = (rates: { input: number; output: number; cacheRead: number; cacheWrite: number }, u: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
  (rates.input * u.input + rates.output * u.output + rates.cacheRead * u.cacheRead + rates.cacheWrite * u.cacheWrite) / 1e6;

proof("an INCLUSIVE backend read by OM's own parser", () => {
  test("OM lands on the disjoint partition, not the double count", async () => {
    await upstream(INCLUSIVE_UPSTREAM);
    const { msg } = await turn(omModel("gpt-6-astra", ASTRA_COST, 1_050_000), "sess-inclusive");
    // 10,000 inclusive with 8,000 cached becomes 2,000 uncached — the number the server
    // measured, recovered by the consumer rather than by this repo's own arithmetic.
    expect(partition(msg.usage)).toEqual({ input: UNCACHED, output: OUT, cacheRead: CACHED, cacheWrite: 0 });
    // The identity that makes it a partition: the prompt is covered exactly once.
    expect(msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite).toBe(TOTAL);
    expect(msg.usage.totalTokens).toBe(TOTAL + OUT);
  });

  test("OM prices that turn on the Astra card exactly", async () => {
    await upstream(INCLUSIVE_UPSTREAM);
    const model = omModel("gpt-6-astra", ASTRA_COST, 1_050_000);
    const { msg } = await turn(model, "sess-inclusive-cost");
    // 2,000 * 10/1e6 + 8,000 * 1/1e6 + 5 * 50/1e6 — the brief's arithmetic, spelled out.
    const expected = (2000 * 10) / 1e6 + (8000 * 1) / 1e6 + (5 * 50) / 1e6;
    expect(msg.usage.cost.total).toBeCloseTo(expected, 12);
    // And the same answer when OM re-prices the parsed usage from the rate card directly,
    // so the figure is the pricing function's, not a coincidence of the stream path.
    expect(calculateCost(model, msg.usage).total).toBeCloseTo(expected, 12);
    // Had the cached prefix been double-counted, input alone would have carried all 10,000.
    expect(msg.usage.cost.total).not.toBeCloseTo(priced(ASTRA_COST, { input: TOTAL, output: OUT, cacheRead: CACHED, cacheWrite: 0 }), 9);
  });
});

proof("an EXCLUSIVE backend read by OM's own parser", () => {
  test("an already-disjoint reading crosses unchanged", async () => {
    await upstream(EXCLUSIVE_UPSTREAM);
    const { msg } = await turn(omModel("claude-opus-5", OPUS_5_COST), "sess-exclusive");
    expect(partition(msg.usage)).toEqual({ input: UNCACHED, output: OUT, cacheRead: CACHED, cacheWrite: 0 });
    expect(msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite).toBe(TOTAL);
  });

  test("both bases arrive at ONE reading — the crossing is lossless in both directions", async () => {
    // The MODEL ID picks the backend, so each basis has to be armed on the backend that
    // actually speaks it: `gpt-6-astra` resolves to the openai (Responses) backend and
    // `claude-opus-5` to the anthropic one. Arming Anthropic counters on an Astra call is
    // not a stricter test, it is a silent no-op — the Responses reply then carries no
    // usage at all and APIPlan honestly falls back to its ESTIMATE, which is what the
    // first draft of this test caught (input 32, cacheRead 0). The rate card is held at
    // ASTRA_COST on both sides so the only thing that varies is the reported convention.
    await upstream(INCLUSIVE_UPSTREAM);
    const inclusive = await turn(omModel("gpt-6-astra", ASTRA_COST, 1_050_000), "sess-both-a");
    await upstream(EXCLUSIVE_UPSTREAM);
    const exclusive = await turn(omModel("claude-opus-5", ASTRA_COST), "sess-both-b");
    // The same physical turn described in two opposite conventions, read by OM as one
    // thing. This is the whole claim of the usage-normalization layer, checked by the
    // consumer instead of by the code that implements it.
    expect(partition(exclusive.msg.usage)).toEqual(partition(inclusive.msg.usage));
    expect(exclusive.msg.usage.cost.total).toBeCloseTo(inclusive.msg.usage.cost.total, 12);
    // Both are the MEASURED partition, not an estimate that happens to match: an estimate
    // would carry no cache counters at all, which is exactly how this test first failed.
    expect(inclusive.msg.usage.cacheRead).toBe(CACHED);
    expect(exclusive.msg.usage.cacheRead).toBe(CACHED);
  });
});

/**
 * ── EVERY MODEL FAMILY, NOT JUST ASTRA ──
 * A partition that is right on one rate card and wrong on another is not a working
 * accounting layer. These drive the Anthropic backend behind the Anthropic front — the
 * same-dialect passthrough, and the ONLY path OM takes in production for Claude models —
 * with a reading that exercises all three buckets at once, including a non-zero cache
 * WRITE, which the 10k/8k case above leaves at zero.
 *
 * 2 uncached + 288,000 read + 1,500 written = 289,502 prompt tokens: a real cache-heavy
 * agent turn, and still under the 272,000-token long-context threshold ON THE BUCKET THAT
 * MATTERS for these cards (Claude cards in models.yml carry no longContext tier at all, so
 * no tier can switch under them — checked, not assumed).
 */
const BIG: Fixture = { anthropic: { input_tokens: 2, output_tokens: OUT, cache_read_input_tokens: 288_000, cache_creation_input_tokens: 1_500 } };
const BIG_PARTITION = { input: 2, output: OUT, cacheRead: 288_000, cacheWrite: 1_500 };

proof("the Anthropic front over the Anthropic backend, per model family", () => {
  for (const [id, cost] of [
    ["claude-fable-5-1", FABLE_5_1_COST],
    ["claude-opus-5", OPUS_5_COST],
    ["claude-fable-5", FABLE_5_COST],
  ] as const) {
    test(`${id}: OM reads all three buckets and prices them on its own card`, async () => {
      await upstream(BIG);
      const model = omModel(id, cost);
      const { msg } = await turn(model, `sess-${id}`);
      // A cache WRITE is the bucket the smaller case cannot exercise: it is the one that
      // bills at 1.25x input, so losing it is a silent under-count of the priciest tokens.
      expect(partition(msg.usage)).toEqual(BIG_PARTITION);
      expect(msg.usage.totalTokens).toBe(2 + OUT + 288_000 + 1_500);
      expect(msg.usage.cost.total).toBeCloseTo(priced(cost, BIG_PARTITION), 12);
      // Per-bucket, so a compensating error between two buckets cannot hide in the total.
      expect(msg.usage.cost.cacheRead).toBeCloseTo((cost.cacheRead * 288_000) / 1e6, 12);
      expect(msg.usage.cost.cacheWrite).toBeCloseTo((cost.cacheWrite * 1_500) / 1e6, 12);
      expect(calculateCost(model, msg.usage).total).toBeCloseTo(priced(cost, BIG_PARTITION), 12);
    });
  }

  test("the three cards really are distinct, so the per-family checks are not one check thrice", () => {
    // Fable 5.1 and Fable 5 differ ONLY in cacheRead (0.25 vs 1) — the exact axis a cache
    // accounting bug moves. If a future catalog edit collapsed them, the loop above would
    // still pass while proving less, so the distinction is asserted rather than assumed.
    expect(FABLE_5_1_COST.cacheRead).not.toBe(FABLE_5_COST.cacheRead);
    expect(OPUS_5_COST.input).not.toBe(FABLE_5_COST.input);
    expect(priced(FABLE_5_1_COST, BIG_PARTITION)).not.toBeCloseTo(priced(FABLE_5_COST, BIG_PARTITION), 9);
  });
});

// ─────────────────────────── what OM sends, as the upstream saw it ───────────────────────────

proof("the OM → APIPlan → upstream request, end to end", () => {
  test("the cache identity survives the crossing and is STABLE across turns", async () => {
    await upstream(INCLUSIVE_UPSTREAM);
    const model = omModel("gpt-6-astra", ASTRA_COST, 1_050_000);
    await turn(model, "sess-stable");
    await turn(model, "sess-stable");
    const calls = await captured();
    expect(calls.length).toBe(2);
    // The Responses backend: this is the field Codex routes its prompt cache on.
    expect(calls.every((c) => c.path === "/responses")).toBe(true);
    const keys = calls.map((c) => c.body.prompt_cache_key);
    expect(typeof keys[0]).toBe("string");
    expect(keys[0]).toBeTruthy();
    // A churning key forfeits the ROUTING AFFINITY that makes a prefix reachable — it is
    // not a guaranteed miss (a fresh key was measured hitting a resident prefix), which is
    // why this asserts forwarding and stability rather than a hit rate.
    expect(keys[1]).toBe(keys[0]);
    // And the same identity rides Codex's routing HEADER, not only the payload.
    expect(calls[0].headers.session_id).toBe(keys[0] as string);
  });

  test("two different sessions get two different cache identities", async () => {
    await upstream(INCLUSIVE_UPSTREAM);
    const model = omModel("gpt-6-astra", ASTRA_COST, 1_050_000);
    await turn(model, "sess-one");
    await turn(model, "sess-two");
    const calls = await captured();
    expect(calls.length).toBe(2);
    // The mirror of the test above. Without this, a hard-coded constant key would satisfy
    // "stable" perfectly while routing every conversation on the machine at one prefix —
    // stability has to mean "derived from the caller's identity", not "constant".
    expect(calls[1].body.prompt_cache_key).not.toBe(calls[0].body.prompt_cache_key);
  });

  test("OM really injects the billing attestation — and the upstream never sees it", async () => {
    await upstream(INCLUSIVE_UPSTREAM);
    const { sent } = await turn(omModel("gpt-6-astra", ASTRA_COST, 1_050_000), "sess-attest");
    // HALF ONE: it was there. custom-models.ts forces isOAuth for a custom
    // anthropic-messages provider, so pi-ai puts Claude Code's attestation at system[0] —
    // whose `cch` hashes the request body and therefore differs on every single turn.
    // Without this half, the assertion below would pass on a server that was never tested.
    const system = sent.system;
    expect(Array.isArray(system)).toBe(true);
    const head = Array.isArray(system) && system[0] && typeof system[0] === "object" && "text" in system[0] ? String(system[0].text) : "";
    expect(head.startsWith("x-anthropic-billing-header:")).toBe(true);
    // SCOPE, mutation-verified (P-36 — a per-guard sabotage measures redundancy, so the
    // only honest check is mutating the DEFENDED VALUE). api.ts strips the attestation on
    // two independent paths: a `system` BLOCK ARRAY (two `.startsWith(ATTESTATION)`
    // filters) and a `system` STRING / leading role:system message (stripAttestationLines).
    // OM always sends a block array, so THIS test covers only that path — measured, not
    // assumed: neutering stripAttestationLines leaves this file 16/16 GREEN, while
    // neutering the block filters fails this test. The string path is covered by
    // test/attestation-shapes.test.ts, which the same mutation fails 4 times. Two files,
    // two paths, no gap — but do not read a green run here as covering both.

    // HALF TWO: it is gone by the time the prompt reaches upstream. It sat at the HEAD of
    // the cached prefix, so one changed character cost the whole cache — the fault that
    // pinned a live Astra session's cache read to a small constant while its input grew
    // past 600k. Checked on the RAW bytes, so it cannot be hiding in a nested field.
    const calls = await captured();
    expect(calls.length).toBe(1);
    expect(calls[0].raw).not.toContain("x-anthropic-billing-header");
    expect(String(calls[0].body.instructions ?? "")).not.toContain("x-anthropic-billing-header");
    // The operator's own system prompt is NOT collateral damage: only the attestation line
    // is ever removed, and the rest of the prefix must arrive intact.
    expect(String(calls[0].body.instructions ?? "")).toContain(SYSTEM);
  });

  test("the cache_control breakpoints OM placed are not stripped on the Anthropic path", async () => {
    await upstream(BIG);
    await turn(omModel("claude-fable-5-1", FABLE_5_1_COST), "sess-breakpoints");
    const calls = await captured();
    expect(calls.length).toBe(1);
    expect(calls[0].path.startsWith("/v1/messages")).toBe(true);
    // pi-ai's applyPromptCaching marks the end of the reusable prefix with
    // `cache_control: {type:"ephemeral"}` on a rolling window of the last messages. On
    // Anthropic — the EXPLICIT-breakpoint vendor — that marker IS the cache: "the prefix
    // up to and including the block designated with cache_control". Dropping it in the
    // proxy would leave every Claude turn uncached with no error anywhere.
    expect((calls[0].raw.match(/cache_control/g) ?? []).length).toBeGreaterThanOrEqual(1);
    const messages = calls[0].body.messages;
    expect(Array.isArray(messages)).toBe(true);
    const marked = Array.isArray(messages)
      ? messages.filter((msg) => JSON.stringify(msg).includes(`"cache_control"`)).length
      : 0;
    expect(marked).toBeGreaterThanOrEqual(1);
    // And the identity for THIS vendor rides metadata.user_id, not prompt_cache_key.
    expect(calls[0].body.metadata).toBeTruthy();
  });
});

/**
 * ── THE CACHE-WRITE TTL BREAKDOWN (P-23, FIXED 2026-09-06) ──
 *
 * Anthropic reports its cache WRITE twice: once as the flat
 * `cache_creation_input_tokens` scalar, and once broken down by TTL as
 * `cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`. The two are
 * not redundant, because the components bill at DIFFERENT RATES — pi-catalog prices a 5m
 * write at the flat `cacheWrite` scalar (1.25x input) and a 1h write at 2x INPUT
 * (models.ts:97-105, deriving 1h from the published multiplier rather than from a stored
 * scalar). OM extracts the breakdown into `usage.cttl` (pi-ai anthropic.ts:1620-1633).
 *
 * WHAT THE BUG WAS. APIPlan dropped the breakdown in TWO places, which is why a
 * provider-only patch could not have fixed it: the anthropic `delta()` read only the flat
 * scalar and never `cache_creation`, and `api.ts` had no carrier for it either (`Tally`
 * declared no such field and `cacheUsageAnthropic()` emitted only the two flat counters).
 * A 1h write therefore crossed this server as an untyped write and OM priced it at the 5m
 * rate. MEASURED here before the fix, on the claude-fable-5-1 card: 100,000 tokens of 1h
 * write gave `usage.cttl === undefined` and `cost.cacheWrite === $1.25` against a correct
 * $2.00 — a 1.6x under-bill, card-independent (the gap is (input*2)/cacheWrite, which is
 * 1.6 for all four Claude cards in models.yml since every one sets cacheWrite =
 * input * 1.25). Nothing errored, no counter contradicted another, and no test could fail
 * on it: silent mispricing, which is exactly the class of fault this project exists to
 * eliminate. It was found by saturation sweep rather than by any symptom.
 *
 * WHAT FIXED IT (UsageFieldCompleteness, verified from disk):
 *   · src/providers.ts `anthropicUsage()` — ONE reader now feeding BOTH `message_start`
 *     and `message_delta`, forwarding `cache_creation` into
 *     `Delta.usage.cacheWriteTtl {m5,h1}` (and `server_tool_use` alongside it);
 *   · src/api.ts `Tally`/`tally()` carry that field through, and every `normalizeTally`
 *     return spreads `...t`, so the sub-division rides along without ever entering the
 *     partition arithmetic;
 *   · `cacheUsageAnthropic()` re-emits `cache_creation:
 *     {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` on the Anthropic front only.
 *
 * THIS BLOCK WAS THE DETECTOR. The first test below was written as `test.failing` while
 * the bug was open — green while it stood, red the instant the fix made the expectation
 * pass, with bun printing "marked as failing but it passed. Remove `.failing`". It fired
 * exactly that way, so the `.failing` is now gone and it is an ordinary assertion of the
 * corrected behaviour. Its companion has been INVERTED in the same change: while the bug
 * was open it pinned the wrong figure so the defect had a number to move, and it now pins
 * the recovered one while keeping the rate-gap arithmetic as the documented magnitude of
 * what was won back.
 *
 * THE INVARIANT THAT MUST NOT REGRESS. The TTL components are a SUB-DIVISION of
 * `cacheWrite`, never a fourth bucket — Anthropic's own docs state that
 * `cache_creation_input_tokens` equals the sum of the values in the `cache_creation`
 * object, so counting them separately would double-count the same physical tokens. The
 * partition identity `input + cacheRead + cacheWrite` must still cover the prompt exactly
 * once, and that is asserted here beside the pricing.
 *
 * A SHARP EDGE WORTH KEEPING WRITTEN DOWN. pi-ai's `applyAnthropicUsageExtras` treats an
 * explicit ALL-ZERO `cache_creation` object as a command to DELETE `usage.cttl`, setting
 * it only when a component is non-zero. So emitting a zeroed breakdown is not neutral — on
 * the `message_start` → `message_delta` correction path it would clear a real split that
 * the opening frame had already reported. The fix suppresses the all-zero case for that
 * reason, and the last test here holds that line.
 */
const WRITE_1H = 100_000;
const CTTL_UPSTREAM: Fixture = {
  anthropic: {
    input_tokens: 2, output_tokens: OUT, cache_read_input_tokens: 0,
    cache_creation_input_tokens: WRITE_1H,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: WRITE_1H },
  },
};
/** The flat 5m rate this used to bill at, and the 1h rate it bills at now. */
const FLAT_5M_USD = (FABLE_5_1_COST.cacheWrite * WRITE_1H) / 1e6;   // $1.25
const CORRECT_1H_USD = (FABLE_5_1_COST.input * 2 * WRITE_1H) / 1e6; // $2.00

proof("the cache-write TTL breakdown (P-23, fixed)", () => {
  test("a 1h cache write reaches OM as cttl and bills at 2x input, not the flat 5m rate", async () => {
    await upstream(CTTL_UPSTREAM);
    const model = omModel("claude-fable-5-1", FABLE_5_1_COST);
    const { msg } = await turn(model, "sess-cttl");
    // The flat total survives — the fix must not trade one bucket for another.
    expect(msg.usage.cacheWrite).toBe(WRITE_1H);
    // The TTL attribution now crosses the proxy, so OM can tell a 1h write from a 5m one.
    expect(msg.usage.cttl?.ephemeral1h).toBe(WRITE_1H);
    // 1h writes bill at 2x INPUT: 100,000 * (10 * 2) / 1e6 = $2.00, not the flat
    // 100,000 * 12.5 / 1e6 = $1.25 the dropped breakdown used to yield.
    expect(msg.usage.cost.cacheWrite).toBeCloseTo(CORRECT_1H_USD, 12);
    // Priced through OM's own function too, so the figure is the rate card's rather than a
    // coincidence of the stream path.
    expect(calculateCost(model, msg.usage).cacheWrite).toBeCloseTo(CORRECT_1H_USD, 12);
  });

  test("the recovered amount is exactly the 5m/1h rate gap, and the partition is untouched", async () => {
    await upstream(CTTL_UPSTREAM);
    const { msg } = await turn(omModel("claude-fable-5-1", FABLE_5_1_COST), "sess-cttl-size");
    // What the fix won back, stated so nobody has to recompute it: 1.6x, card-independent,
    // $0.75 on this single turn.
    expect(CORRECT_1H_USD / FLAT_5M_USD).toBeCloseTo(1.6, 12);
    expect(CORRECT_1H_USD - FLAT_5M_USD).toBeCloseTo(0.75, 12);
    // And it is no longer billing at the flat rate — the assertion that would have passed
    // for the whole time the bug was open.
    expect(msg.usage.cost.cacheWrite).not.toBeCloseTo(FLAT_5M_USD, 9);
    // THE INVARIANT: a sub-division, never a fourth bucket. The components sum to the flat
    // scalar and the prompt is still covered exactly once.
    expect((msg.usage.cttl?.ephemeral5m ?? 0) + (msg.usage.cttl?.ephemeral1h ?? 0)).toBe(msg.usage.cacheWrite);
    expect(msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite).toBe(2 + WRITE_1H);
    expect(msg.usage.totalTokens).toBe(2 + OUT + WRITE_1H);
  });

  test("a write with NO breakdown reported arrives with none, priced at the flat rate", async () => {
    // The ABSENT case: the vendor said nothing about TTL, so nothing may be invented. Note
    // what this does NOT test — with no `cache_creation` key at all, `anthropicUsage`'s
    // all-zero guard is never even evaluated (cc is undefined, so m5/h1 are undefined).
    // The all-zero case is a genuinely different input and gets its own test below.
    await upstream({ anthropic: { input_tokens: 2, output_tokens: OUT, cache_read_input_tokens: 0, cache_creation_input_tokens: WRITE_1H } });
    const { msg } = await turn(omModel("claude-fable-5-1", FABLE_5_1_COST), "sess-cttl-absent");
    expect(msg.usage.cacheWrite).toBe(WRITE_1H);
    expect(msg.usage.cttl).toBeUndefined();
    // With no split to price, the flat 5m scalar is the CORRECT answer — the fix must not
    // start charging 1h rates for writes nobody said were 1h.
    expect(msg.usage.cost.cacheWrite).toBeCloseTo(FLAT_5M_USD, 12);
  });

  /**
   * ── THIS TEST EXISTS BECAUSE ITS FIRST TWO VERSIONS WERE VACUOUS (P-30, I-13) ──
   *
   * V1 armed NO `cache_creation` key and claimed to defend the all-zero suppression. It did
   * not: with the key absent the guard is never reached, so removing the suppression left
   * the test GREEN. V2 armed explicit zeroes — and was STILL green with the suppression
   * removed at BOTH sites (providers.ts and api.ts's `cacheUsageAnthropic`), for two
   * separate reasons I only found by sabotage rather than by reading:
   *   · MY OWN INSTRUMENT dropped the input. The host's `AnthropicCounters` type had no
   *     `cache_creation` field, so the fixture never sent one and no `src/` change could
   *     possibly matter. A fabricated absence, manufactured by the recorder — distrust the
   *     instrument before the system.
   *   · Even with the input flowing, `cttl === undefined` is satisfied BOTH by "zeroes were
   *     suppressed" and by "zeroes were forwarded and pi-ai deleted the split". A
   *     single-frame turn cannot tell those apart, so the assertion had no discriminating
   *     power even in principle.
   *
   * The harm is only observable ACROSS THE TWO FRAMES Anthropic really sends. So this arms
   * a `message_start` carrying a genuine 1h split and a `message_delta` correcting to all
   * zeroes — the shape a real cache-write turn takes. If this server forwards the zeroed
   * breakdown, `applyAnthropicUsageExtras` deletes the split the opening frame already
   * recorded and the turn silently reverts to flat 5m pricing: the P-23 mispricing,
   * reintroduced by the fix for P-23. Suppression is what keeps the opening split standing.
   *
   * Verified non-vacuous the only way that counts: with the suppression removed this test
   * FAILS, and it fails on the COST, which is the thing anyone actually pays.
   */
  test("a zeroed correction frame cannot erase the split the opening frame reported", async () => {
    await upstream({
      // message_start: a real 1h split, as a cache-write turn reports.
      anthropicStart: {
        input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 0,
        cache_creation_input_tokens: WRITE_1H,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: WRITE_1H },
      },
      // message_delta: the correction, with the breakdown zeroed — the destructive input.
      anthropic: {
        input_tokens: 2, output_tokens: OUT, cache_read_input_tokens: 0,
        cache_creation_input_tokens: WRITE_1H,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    });
    const { msg } = await turn(omModel("claude-fable-5-1", FABLE_5_1_COST), "sess-cttl-erase");
    // The flat write survives either way, so it cannot be what discriminates.
    expect(msg.usage.cacheWrite).toBe(WRITE_1H);
    // THE POINT: the split reported at message_start is still there at the end of the turn.
    expect(msg.usage.cttl?.ephemeral1h).toBe(WRITE_1H);
    // And it is still priced at the 1h rate. This is the assertion that fails when the
    // zeroes get through — $2.00 collapsing back to $1.25.
    expect(msg.usage.cost.cacheWrite).toBeCloseTo(CORRECT_1H_USD, 12);
  });
});
