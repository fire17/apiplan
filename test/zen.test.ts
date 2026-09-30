/**
 * THE ZEN BACKEND: an API-key gateway that RESELLS other vendors' models, an OpenAI-Responses
 * wire shape, and an INCLUSIVE input counter crossing into Anthropic's exclusive one.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and therefore what these tests defend:
 *
 *   1. THE NAMES. Zen republishes `gpt-6-astra`, `grok-4.6` and (in dialects this lane does
 *      not serve) `claude-opus-5` under the vendors' own ids. Unprefixed, `resolve()` returns
 *      the FIRST match, so one route becomes unreachable while still being listed, the roster's
 *      uniqueness rule drops a row silently, and — worst — an alias on PATH could quietly start
 *      billing a different credential. Every zen id therefore carries a `zen-` prefix and every
 *      zen family a `zen` prefix, and the no-collision assertions below are the guard.
 *   2. THE PARTITION. This dialect's `input_tokens` is the WHOLE prompt with
 *      `input_tokens_details.cached_tokens` as a breakdown OF it. Republished unconverted
 *      through the Anthropic front, that double-counts the cached prefix, which on a
 *      cache-heavy agent turn is most of the prompt. So the same physical turn is driven
 *      through BOTH fronts and each must render it in its own vendor's convention, losslessly.
 *   3. THE FREE TIER, WHICH IS NOT OURS TO TAKE. Zen's zero-priced ids are served only to
 *      opencode's own client, gated on the `x-opencode-*` headers it stamps. The provider sends
 *      NONE of them and never offers a zero-cost id; T4/T5 fail if either ever changes, because
 *      the alternative is impersonating another client to take a tier its vendor says is not
 *      ours — an operator's decision, not a provider's.
 *   4. THE MISSING KEY. Nobody on this machine has a Zen key, so the refusal path is the path
 *      most users meet first: it must name the two ways to fix it and must never dial.
 *
 * These run against a real api.serve() over loopback whose zen provider is pointed at a fixture
 * speaking the genuine Responses SSE shape. Nothing is mocked inside the server and no helper
 * is re-implemented: every counter asserted on has travelled the production path. The fixture
 * lives in a SUBPROCESS (test/helpers/zen-stub.ts) because base URLs and credential wells are
 * read at import time and `bun test` shares one process.
 *
 * WHAT THESE TESTS DO NOT PROVE, stated here rather than left to be discovered: no live Zen
 * call has ever been made from this gateway, because no Zen key exists on this machine. The
 * wire shape, the headers, the refusals and the accounting are STUB-PROVEN; whether Zen honours
 * `prompt_cache_key`, and whether a KEYED call is also refused for want of a session header,
 * are open questions a keyed run must answer.
 *
 * ZERO SPEND, ZERO CONTACT WITH THE OPERATOR'S WORLD: scratch STATE_DIR, stub credential files
 * written below, opencode.ai never dialled, nothing outside the temp dir written. The real
 * ~/.local/share/opencode/auth.json is never read — APIPLAN_ZEN_AUTH points at a fixture — and
 * OPENCODE_API_KEY is blanked in both processes.
 */
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  zen, readZenKey, zenScan, zenCatalog, zenBase, zenWireId, zenAuthFile,
  ZEN_FALLBACK, ZEN_DEFAULT_BASE,
} from "../src/providers-zen.ts";
import { grok } from "../src/providers-grok.ts";
import { resolve, models, unparseable, aliasesFor } from "../src/registry.ts";
import { PROVIDERS } from "../src/providers.ts";
import { defaults } from "../src/commands.ts";
import { zenEvents } from "./helpers/zen-stub.ts";
import type { Model } from "../src/registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "helpers", "zen-stub.ts");

// ─────────────────────────── the world these tests run in ───────────────────────────

const DIR = mkdtempSync(join(tmpdir(), "ap-zen-"));
const HOME_DIR = join(DIR, "home");
const ZEN_AUTH = join(DIR, "zen-auth.json");
const ZEN_MODELS = join(DIR, "zen-models.json");
const ANTHROPIC_CRED = join(DIR, "anthropic.json");
const CODEX_CRED = join(DIR, "codex.json");

/** A fixture value in the SHAPE opencode writes, deliberately not in the shape of a real key:
 *  nothing here should ever be mistaken for a credential if it lands in a log. */
const STUB_KEY = "ZK-zen-fixture-not-a-real-key";
/** The auth-file shape `opencode auth login` writes: keyed by provider id, discriminated on
 *  `type`. The `google` sibling is real-world shape (this machine's own file holds exactly one
 *  entry, of type `oauth`) and is here so the reader is seen to pick the right one. */
const authFile = (key: string | null = STUB_KEY) => JSON.stringify({
  google: { type: "oauth", refresh: "not-read", access: "not-read", expires: 0 },
  ...(key === null ? {} : { opencode: { type: "api", key } }),
});
writeFileSync(ZEN_AUTH, authFile());

/**
 * A MINIMAL models.json in opencode's own shape, carrying one of each case the scan must tell
 * apart: a paid Responses-dialect id, its zero-priced free twin, a chat-completions id (npm
 * null → the provider default, `@ai-sdk/openai-compatible`), and an anthropic-dialect id whose
 * name COLLIDES with a model this registry already serves under another credential.
 */
writeFileSync(ZEN_MODELS, JSON.stringify({
  opencode: {
    id: "opencode", api: "https://opencode.ai/zen/v1", name: "OpenCode Zen",
    models: {
      "muse-spark-1.3": {
        name: "Muse Spark 1.3", provider: { npm: "@ai-sdk/openai" },
        cost: { input: 1.25, output: 4.25, cache_read: 0.15 },
        limit: { context: 1_048_576, output: 131_072 },
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] }],
      },
      "muse-spark-1.3-contributor-free": {
        name: "Muse Spark 1.3 Free", provider: { npm: "@ai-sdk/openai" },
        cost: { input: 0, output: 0, cache_read: 0 },
        limit: { context: 1_048_576, output: 131_072 },
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }],
      },
      "kimi-k3": { name: "Kimi K3", provider: { npm: null }, cost: { input: 0.6, output: 2.5 }, limit: { context: 256_000, output: 32_000 } },
      "claude-opus-5": { name: "Claude Opus 5", provider: { npm: "@ai-sdk/anthropic" }, cost: { input: 15, output: 75 }, limit: { context: 200_000, output: 64_000 } },
    },
  },
}));
writeFileSync(ANTHROPIC_CRED, JSON.stringify({
  claudeAiOauth: { accessToken: "AT-zen-suite", refreshToken: "RT-zen-suite", expiresAt: Date.now() + 6 * 3600_000, scopes: ["user:inference"] },
}));
writeFileSync(CODEX_CRED, JSON.stringify({
  tokens: { access_token: "AT-zen-suite-codex", refresh_token: "RT-zen-suite-codex", account_id: "acct-zen-suite" },
  last_refresh: new Date().toISOString(),
}));

/** Bun's spawned-process handle, named rather than reached for through
 *  `ReturnType<typeof Bun.spawn>`: only `stdout`, `stderr` and `kill` are used here. */
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
      APIPLAN_ZEN_AUTH: ZEN_AUTH,
      APIPLAN_ZEN_MODELS: ZEN_MODELS,
      // The one credential this suite is about: never the operator's own, in either process.
      OPENCODE_API_KEY: "",
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
  // The READY line is the only synchronisation point: a port that is merely allocated is not a
  // server that answers, and polling a guessed port would race the boot.
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
  if (!m) throw new Error(`zen stub never became ready: ${buf}\n${await new Response(proc.stderr).text()}`);
  base = `http://127.0.0.1:${m[1]}`;
  fixture = `http://127.0.0.1:${m[2]}`;
});
afterAll(() => {
  try { proc?.kill(); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────── talking to the server ───────────────────────────

type ZenCounters = { input_tokens?: number; output_tokens?: number; cached_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number };
type Fixture = { zen?: ZenCounters; silent?: boolean; reject?: { status: number; body: string } };

/** Arm the stub upstream. Awaited, so the fixture is in place before the request goes out.
 *  It also CLEARS the recorded request, which is what makes "never dialled" checkable. */
async function upstream(f: Fixture) {
  const r = await fetch(`${fixture}/__fixture`, { method: "POST", body: JSON.stringify(f) });
  expect(r.ok).toBe(true);
}
/** What the upstream last received — the only honest place to check the outbound wire. */
async function seen(): Promise<{ path: string; headers: Record<string, string>; body: Record<string, unknown> } | null> {
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

const SPARK = "zen-muse-spark-1.3";
const SPARK_WIRE = "muse-spark-1.3";

/**
 * THE DERIVED-REAL TURN. Not invented and not live-recorded either — DERIVED, and the
 * derivation is the load-bearing part. opencode stored this turn in its own database
 * (~/.local/share/opencode/opencode.db, message row 2026-09-09 11:32:54.821, model
 * muse-spark-1.3-contributor-free):
 *     tokens { total 134660, input 889, output 3307, reasoning 1583, cache {read 128881} }
 * Its persisted `input` is the reader's `noCache` — `Math.max(0, input_tokens - cached_tokens)`
 * (opencode 1.18.30, byte offset 66_477_874) — so the WIRE reported input_tokens 129_770, and
 * the row's own `total` confirms it from the other side: 129770 + 3307 + 1583 = 134660.
 * 889 is therefore what this gateway must DERIVE back when republishing in Anthropic's
 * convention, and a regression in either direction moves it.
 */
const REAL: ZenCounters = { input_tokens: 129_770, cached_tokens: 128_881, output_tokens: 3_307, reasoning_tokens: 1_583 };
const REAL_UNCACHED = 889;

// ─────────────────────────── T1 · the declaration ───────────────────────────

describe("T1 zen's contract and registration", () => {
  test("it is IN the provider table, and is the object under test", () => {
    // A provider can be perfectly written and simply not wired in: models(), /v1/models,
    // status and refresh all key off this map.
    expect(PROVIDERS.zen).toBe(zen);
    expect(zen.id).toBe("zen");
  });

  test("an INCLUSIVE basis and an implicit-prefix cache, with no invented numbers", () => {
    expect(zen.usageBasis).toBe("inclusive");
    expect(zen.cache.kind).toBe("implicit-prefix");
    expect(zen.cache.identity).toBe("prompt_cache_key");
    // DOCUMENTED-OR-ABSENT: opencode.ai publishes neither a minimum nor a TTL for this
    // gateway, and a floor borrowed from OpenAI's 1,024 would read as a measured Zen fact.
    expect(zen.cache.minTokens).toBeUndefined();
    expect(zen.cache.ttlMs).toBeUndefined();
  });

  test("the endpoint is the published gateway, and an override is honoured", () => {
    expect(ZEN_DEFAULT_BASE).toBe("https://opencode.ai/zen/v1");
    expect(zenBase()).toBe(ZEN_DEFAULT_BASE);
    process.env.APIPLAN_ZEN_BASE = "http://127.0.0.1:9/zen/v1/";
    try {
      // Trailing slashes are trimmed, so a path is never joined onto a double slash.
      expect(zenBase()).toBe("http://127.0.0.1:9/zen/v1");
    } finally { delete process.env.APIPLAN_ZEN_BASE; }
  });
});

// ─────────────────────────── T2 · the alias law ───────────────────────────

describe("T2 `spark` reaches Muse Spark, and nothing else moved", () => {
  test("spark / zenmuse / zenmuse13spark all land on Muse Spark 1.3", () => {
    expect(resolve("spark")?.id).toBe(SPARK);
    expect(resolve("spark")?.label).toBe("Muse Spark 1.3");
    // Family alone means the NEWEST of the family, the rule the whole registry is built on.
    expect(resolve("zenmuse")?.id).toBe(SPARK);
    expect(resolve("zenmuse13spark")?.id).toBe(SPARK);
    expect(resolve("zenmuse12spark")?.id).toBe("zen-muse-spark-1.2");
    expect(aliasesFor(models("zen").find((m) => m.id === SPARK)!).sort()).toEqual(["spark", "zenmuse", "zenmuse13spark"]);
  });

  test("a listed alias always REACHES the row it is printed on", () => {
    // `apiplan models` prints this list to a human who then types one of the words. A gateway
    // brings a crowd of shared variant words with it (astra, sol, nano, codex, pro…), and
    // resolve() gives each word to exactly ONE model — so every other row printing it was
    // offering a name that answers with a different model, on a different credential.
    // Checked across the WHOLE registry, not just zen: the fault is in the alias rule, and a
    // zen-only assertion would leave the same wrong cell on the gemini/google rows.
    for (const m of models()) {
      for (const a of aliasesFor(m)) {
        expect(resolve(a)?.id, `${m.id} advertises "${a}"`).toBe(m.id);
      }
    }
    // …and the discrimination that makes it non-vacuous: the words really are shared, so the
    // rule had something to decide. `spark` belongs to 1.3, `sol` to the subscription.
    expect(aliasesFor(models("zen").find((m) => m.id === "zen-muse-spark-1.2")!)).not.toContain("spark");
    expect(aliasesFor(resolve("sol")!)).toContain("sol");
    expect(aliasesFor(models("zen").find((m) => m.id === "zen-gpt-5.6-sol")!)).not.toContain("sol");
  });

  test("every zen id is exactly addressable by its own id", () => {
    const all = models("zen");
    expect(all.length).toBeGreaterThanOrEqual(26);
    for (const m of all) expect(resolve(m.id)?.id).toBe(m.id);
  });

  test("THE COLLISION GUARD: a reseller never steals another credential's alias", () => {
    // Zen republishes gpt-6-astra and grok-4.6 under their vendors' own names. If those names
    // resolved here, the same command on PATH would start billing a different account — the
    // single worst failure this port could cause, and the reason for the `zen-` prefix.
    expect(resolve("opus")?.id).toBe("claude-opus-5");
    expect(resolve("opus")?.provider).toBe("anthropic");
    expect(resolve("gpt")?.provider).toBe("openai");
    expect(resolve("codex")?.provider).toBe("openai");
    expect(resolve("gemini")?.provider).toBe("google");
    expect(resolve("grok")?.provider).toBe("grok");
    // …and the zen copies stay reachable, by their prefixed ids and their own families.
    expect(resolve("zen-gpt-6-astra")?.provider).toBe("zen");
    expect(resolve("zengpt")?.provider).toBe("zen");
    expect(resolve("zengrok")?.id).toBe("zen-grok-4.6");
    // A generic word is never claimed: `build` is the trap parseGrok already documents.
    expect(resolve("build")).toBeNull();
    expect(resolve("nonexistent-model-xyz")).toBeNull();
  });

  test("THE CLAIMED-WORDS PIN: the bare words that now bill the Zen key are a CLOSED set", () => {
    // The collision guard above proves no word MOVED. This one pins what the gateway TOOK:
    // before this port `spark`, `nano`, `codexmax`, `codexspark` and `codexmini` all answered
    // null; they now resolve, on the Zen key, and a word that used to error is the one shape a
    // human never re-checks. The catalog is a vendor file that changes without us — the next
    // refresh could hand zen another bare word (a new `-flash`, a new `-pro`) silently, because
    // nothing in resolve() asks permission. So the SET is asserted, not the members: a word
    // joining it fails here, in a test that names the credential, rather than on an invoice.
    //
    // NOT a ruling that these five SHOULD resolve — that is the operator's call, and this leg
    // is written so that either answer is one edit away from a red line that says which.
    //
    // Derived, never hand-listed: the candidate words come from models() itself, so the leg
    // cannot go stale against a catalog it does not read. Only the zen-owned answer is spelled
    // out, because that is the claim under guard.
    const variantWords = [...new Set(models().filter((m) => m.variant).map((m) => m.variant!))].sort();
    const claimed = variantWords.filter((w) => resolve(w)?.provider === "zen");
    expect(claimed).toEqual(["codexmax", "codexmini", "codexspark", "nano", "spark"]);
    // …and each names the ROW it lands on, so a re-point INSIDE zen (a newer nano, a renamed
    // variant) is caught too — the word staying zen's is not the same as it staying this model's.
    expect(claimed.map((w) => resolve(w)!.id)).toEqual([
      "zen-gpt-5.1-codex-max",
      "zen-gpt-5.1-codex-mini",
      "zen-gpt-5.3-codex-spark",
      "zen-gpt-5.4-nano",
      "zen-muse-spark-1.3",
    ]);
    // THE DENOMINATOR, so a filter that silently matched nothing could not pass: the words were
    // filtered OUT of a strictly larger set, and the rest are owned by other credentials.
    expect(variantWords.length).toBeGreaterThan(claimed.length);
    expect(variantWords).toEqual(expect.arrayContaining(claimed));
    // Every bare word that was already spoken for keeps its provider — the other half of the
    // set claim: zen took exactly these and nothing else, checked on the words that are live
    // commands on PATH today. (`codex` is resolve()'s own special case, not a variant, and is
    // here because it is the word a gateway carrying five `gpt-5.x-codex-*` rows most endangers.)
    const kept: [string, string][] = [
      ["opus", "anthropic"], ["gpt", "openai"], ["codex", "openai"], ["gemini", "google"],
      ["grok", "grok"], ["sol", "openai"], ["astra", "openai"], ["luna", "openai"],
      ["terra", "openai"], ["pro", "google"], ["mini", "openai"],
    ];
    for (const [w, p] of kept) expect(resolve(w)?.provider, `bare "${w}"`).toBe(p);
    // and none of them is in the claimed set, stated as an assertion rather than left implied.
    for (const [w] of kept) expect(claimed, `bare "${w}"`).not.toContain(w);
  });

  test("the unprefixed gpt-5.3-codex-spark stays unresolvable, as registry.test.ts requires", () => {
    // Zen DOES list gpt-5.3-codex-spark, and `spark` is now a live variant word — so this is
    // exactly where the two could have been conflated. They are not: the zen id is
    // `zen-gpt-5.3-codex-spark` with variant `codexspark`, and the bare Codex name (which the
    // subscription marks unsupported in the API) still answers null.
    expect(resolve("gpt-5.3-codex-spark")).toBeNull();
    expect(models("zen").find((m) => m.id === "zen-gpt-5.3-codex-spark")?.variant).toBe("codexspark");
    expect(resolve("spark")?.id).not.toBe("zen-gpt-5.3-codex-spark");
  });

  test("no zen id is unparseable, and an UNPREFIXED one still is", () => {
    // unparseable() exists to REPORT what a provider's catalog offered and this registry could
    // not address. The second assertion is the prefix rule stated as a parser fact: a raw
    // vendor id must NOT slip in without the marker that says whose bill it is.
    expect(unparseable("zen", models("zen"))).toEqual([]);
    expect(unparseable("zen", [{ id: "muse-spark-1.3" }])).toEqual(["muse-spark-1.3"]);
    expect(unparseable("zen", [{ id: "zen-" }])).toEqual(["zen-"]);
  });
});

// ─────────────────────────── T3 · what the catalog offers ───────────────────────────

describe("T3 only the paid, Responses-dialect ids are offered", () => {
  test("the scan keeps the paid openai-dialect id and names everything it dropped", () => {
    process.env.APIPLAN_ZEN_MODELS = ZEN_MODELS;
    try {
      const s = zenScan();
      expect(s.source).toBe("file");
      expect(s.models.map((m) => m.id)).toEqual([`zen-${SPARK_WIRE}`]);
      expect(s.models[0]).toMatchObject({ label: "Muse Spark 1.3", contextWindow: 1_048_576, maxOutput: 131_072 });
      expect(s.models[0].efforts).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
      // Each drop, under the reason it was dropped for — a single "dropped" bucket would hide
      // the difference between "a tier we may not use" and "a wire we cannot speak".
      expect(s.dropped.free).toEqual(["muse-spark-1.3-contributor-free"]);
      expect(s.dropped.chat).toEqual(["kimi-k3"]);
      expect(s.dropped.anthropic).toEqual(["claude-opus-5"]);
      expect(s.dropped.google).toEqual([]);
      // And nothing free reaches the catalog, which is the assertion that matters most.
      expect(zenCatalog().some((m) => m.id.includes("contributor-free"))).toBe(false);
    } finally { delete process.env.APIPLAN_ZEN_MODELS; }
  });

  test("no zero-cost id is listed anywhere the registry can see", () => {
    // The free tier is served only to opencode's own client; listing it would offer a name
    // this route is refused. The baked fallback must obey the same rule as a live scan.
    for (const m of ZEN_FALLBACK) expect(m.cost?.input === 0).toBe(false);
    expect(ZEN_FALLBACK.some((m) => m.id.includes("contributor"))).toBe(false);
    expect(models("zen").some((m) => m.id.includes("contributor"))).toBe(false);
  });

  test("a missing or broken catalog falls back to the documented list, never to empty", () => {
    // An empty catalog would make every zen name unresolvable on a machine without opencode;
    // the documented snapshot is the honest floor. The dropped lists come back EMPTY, and that
    // is an absence — nothing was examined — not a measured zero.
    const garbage = join(DIR, "zen-models-garbage.json");
    writeFileSync(garbage, "not json at all");
    for (const f of [join(DIR, "no-such-models.json"), garbage]) {
      process.env.APIPLAN_ZEN_MODELS = f;
      try {
        const s = zenScan();
        expect(s.source).toBe("fallback");
        expect(s.models).toEqual(ZEN_FALLBACK);
        expect(s.dropped).toEqual({ free: [], chat: [], anthropic: [], google: [] });
      } finally { delete process.env.APIPLAN_ZEN_MODELS; }
    }
  });

  test("the wire id is the vendor's, without this registry's routing marker", () => {
    expect(zenWireId(SPARK)).toBe(SPARK_WIRE);
    // Idempotent on an already-bare id, so a double strip can never mangle a name.
    expect(zenWireId(SPARK_WIRE)).toBe(SPARK_WIRE);
  });
});

// ─────────────────────────── T4 · the outbound wire ───────────────────────────

describe("T4 what zen actually sends upstream", () => {
  test("a Responses request on the Zen gateway, bearing the key from the well", async () => {
    await upstream({ zen: { input_tokens: 10, output_tokens: 1 } });
    await messages("spark");
    const s = (await seen())!;
    expect(s.path).toBe("/responses");
    // The WIRE id, never the registry's prefixed one: the endpoint does not publish `zen-…`.
    expect(s.body.model).toBe(SPARK_WIRE);
    expect(Array.isArray(s.body.input)).toBe(true);
    expect(s.body).toMatchObject({ store: false, stream: true });
    expect(s.body.messages).toBeUndefined();
    expect(s.headers.authorization).toBe(`Bearer ${STUB_KEY}`);
    expect(s.headers.accept).toBe("text/event-stream");
    expect(s.headers["user-agent"]?.startsWith("apiplan/")).toBe(true);
  });

  test("NO x-opencode-* header is ever sent — the free-tier bypass stays unbuilt", async () => {
    // opencode gates its free tier on `x-opencode-session`, stamped only for its own client.
    // Sending one from here would be wearing another client's identity to take a tier its
    // vendor says is opencode-only. That is the operator's decision; this assertion is what
    // keeps it from becoming a quiet code change.
    await upstream({ zen: { input_tokens: 10, output_tokens: 1 } });
    await messages("spark", { metadata: { user_id: "session-abc" } });
    const s = (await seen())!;
    const smuggled = Object.keys(s.headers).filter((h) => /^x-opencode-/i.test(h));
    expect(smuggled).toEqual([]);
    // And the marker of a keyless opencode client is never our bearer.
    expect(s.headers.authorization).not.toBe("Bearer public");
  });

  test("the same conversation keeps ONE prompt_cache_key across turns", async () => {
    // An implicit-prefix cache is reachable only through a stable handle; a conversation that
    // changed its key mid-thread would lose its own prefix on every turn.
    await upstream({ zen: { input_tokens: 10, output_tokens: 1 } });
    await messages("spark", { metadata: { user_id: "session-stable" } });
    const first = (await seen())!.body.prompt_cache_key;
    expect(typeof first).toBe("string");
    expect(first).toBeTruthy();
    await upstream({ zen: { input_tokens: 10, output_tokens: 1 } });
    await messages("spark", { metadata: { user_id: "session-stable" } });
    expect((await seen())!.body.prompt_cache_key).toBe(first);
  });

  test("a caller's tools ride as FLAT Responses function tools", async () => {
    await upstream({ zen: { input_tokens: 10, output_tokens: 1 } });
    await messages("spark", {
      tools: [{
        name: "read_file",
        description: "Read a file",
        input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
    });
    const s = (await seen())!;
    const tools = s.body.tools as { type: string; name: string; parameters: Record<string, unknown> }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "function", name: "read_file" });
    // `$schema` is JSON-Schema framing, not a parameter schema, and this backend family is
    // inconsistent about tolerating it — so it is pruned rather than forwarded.
    expect(tools[0].parameters.$schema).toBeUndefined();
    expect(tools[0].parameters).toMatchObject({ type: "object" });
  });

  test("an effort the model does not advertise is never sent", () => {
    const model: Model = { id: SPARK, provider: "zen", family: "zenmuse", version: [1, 3], variant: "spark", label: "Muse Spark 1.3", efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] };
    const c = { token: "T", source: "test" };
    expect(zen.build(model, [{ role: "user", text: "hi" }], { effort: "high" }, c).body.reasoning).toEqual({ effort: "high" });
    expect(zen.build(model, [{ role: "user", text: "hi" }], { effort: "ludicrous" }, c).body.reasoning).toBeUndefined();
    // A request-level effort change resets the cached prefix upstream, so it is only ever sent
    // when the caller asked for one.
    expect(zen.build(model, [{ role: "user", text: "hi" }], {}, c).body.reasoning).toBeUndefined();
  });

  // The other side of the OM whitelist (roster.ts OM_EFFORTS). `none` is a REAL Responses-API
  // reasoning effort this vendor advertises on ten gpt-5.x ids, and apiplan's own CLI still
  // offers it (bin/apiplan.ts RESPONSES_EFFORTS). OM's models.yml schema is what cannot take
  // it, so the narrowing lives in the roster — stripping it from the catalog instead would
  // make `apiplan -e none` silently unsendable, because this builder only sends an effort the
  // model advertises. This leg is the tripwire for that wrong-layer fix.
  test('the vendor\'s "none" effort still reaches the wire when the catalog advertises it — the OM filter lives in the roster, not here', () => {
    const model: Model = { id: "zen-gpt-5.1", provider: "zen", family: "zengpt", version: [5, 1], label: "GPT-5.1", efforts: ["none", "low", "medium", "high"] };
    const c = { token: "T", source: "test" };
    expect(zen.build(model, [{ role: "user", text: "hi" }], { effort: "none" }, c).body.reasoning).toEqual({ effort: "none" });
  });
});

// ─────────────────────────── T5 · no key ───────────────────────────

describe("T5 a missing key is refused BEFORE any call, naming both fixes", () => {
  test("the provider reads the well, picks the `opencode` entry, and never throws on absence", () => {
    // A credential read must not become a way for this provider to fail loudly about another
    // program's file: probe() and /health depend on that.
    const keyless = join(DIR, "zen-auth-keyless.json");
    writeFileSync(keyless, authFile(null));                     // google only — the real shape
    const cases: [string, string][] = [
      ["absent", join(DIR, "no-such-zen.json")],
      ["not json", join(DIR, "zen-garbage.json")],
      ["json but not an object", join(DIR, "zen-array.json")],
      ["no opencode entry", keyless],
      ["an oauth entry, not an api key", join(DIR, "zen-oauth.json")],
      ["an api entry with an empty key", join(DIR, "zen-emptykey.json")],
    ];
    writeFileSync(cases[1][1], "{{{not json");
    writeFileSync(cases[2][1], "[1,2,3]");
    writeFileSync(cases[4][1], JSON.stringify({ opencode: { type: "oauth", refresh: "not-a-bearer" } }));
    writeFileSync(cases[5][1], JSON.stringify({ opencode: { type: "api", key: "" } }));
    const hadEnv = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "";
    for (const [why, file] of cases) {
      process.env.APIPLAN_ZEN_AUTH = file;
      try {
        expect(readZenKey(), why).toBeNull();
        expect(zen.probe().connected, why).toBe(false);
        expect(() => zen.creds(), why).toThrow(/OpenCode Zen key/i);
      } finally { delete process.env.APIPLAN_ZEN_AUTH; }
    }
    if (hadEnv === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = hadEnv;
  });

  test("the fix-it names BOTH routes — the login and the variable", () => {
    const hadEnv = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "";
    process.env.APIPLAN_ZEN_AUTH = join(DIR, "no-such-zen.json");
    try {
      const p = zen.probe();
      expect(p.connected).toBe(false);
      expect(p.loginHint).toContain("opencode auth login");
      expect(p.loginHint).toContain("OPENCODE_API_KEY");
      let msg = "";
      try { zen.creds(); } catch (e) { msg = String((e as Error).message); }
      expect(msg).toContain("opencode auth login");
      expect(msg).toContain("OPENCODE_API_KEY");
    } finally {
      delete process.env.APIPLAN_ZEN_AUTH;
      if (hadEnv === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = hadEnv;
    }
  });

  test("the env var wins over the stored key, as opencode's own reader does", () => {
    const hadEnv = process.env.OPENCODE_API_KEY;
    process.env.APIPLAN_ZEN_AUTH = ZEN_AUTH;
    process.env.OPENCODE_API_KEY = "ZK-from-the-environment";
    try {
      const k = readZenKey();
      expect(k?.key).toBe("ZK-from-the-environment");
      expect(k?.source).toBe("env:OPENCODE_API_KEY");
      expect(zen.probe().connected).toBe(true);
      // The key is NAMED and never published: a sha256 prefix, not the secret.
      expect(zen.probe().detail).not.toContain("ZK-from-the-environment");
      expect(zen.probe().detail).toContain("key sha256");
    } finally {
      delete process.env.APIPLAN_ZEN_AUTH;
      if (hadEnv === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = hadEnv;
    }
  });

  test("through the real server: no key means a named refusal and NOTHING dialled", async () => {
    // The end-to-end half. The stub server reads the SAME auth file, so emptying it here is
    // what an operator without a Zen key actually has.
    await upstream({ zen: { input_tokens: 10, output_tokens: 1 } });   // also clears __seen
    writeFileSync(ZEN_AUTH, authFile(null));
    try {
      const r = await post("/v1/messages", { model: "spark", max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
      const text = await r.text();
      expect(r.ok).toBe(false);
      expect(text).toContain("opencode auth login");
      expect(text).toContain("OPENCODE_API_KEY");
      // THE ASSERTION THAT MATTERS: the refusal happened on this side of the wire. A gateway
      // that dialled with a placeholder bearer would look identical from the client.
      expect(await seen()).toBeNull();
    } finally { writeFileSync(ZEN_AUTH, authFile()); }
  });

  test("the fingerprint identifies the credential without ever being one", () => {
    process.env.APIPLAN_ZEN_AUTH = ZEN_AUTH;
    const hadEnv = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "";
    try {
      const fp = zen.credFp!();
      expect(fp.cred).not.toContain(STUB_KEY);
      expect(fp.ident).not.toContain(STUB_KEY);
      expect(fp.ident).toMatch(/^[0-9a-f]{12}$/);
      // A Zen key states no expiry, so there is nothing to fold in and 0 is the honest value.
      expect(fp.exp).toBe(0);
      // A rotated key reads as a NEW credential, so no verdict recorded against the old one
      // carries over — while the SOURCE, which is all this well knows about identity, holds.
      writeFileSync(ZEN_AUTH, authFile("ZK-zen-fixture-rotated"));
      const after = zen.credFp!();
      expect(after.cred).not.toBe(fp.cred);
      expect(after.ident).toBe(fp.ident);
      // No key at all is 'absent', which is not a fingerprint collision with a real one.
      process.env.APIPLAN_ZEN_AUTH = join(DIR, "no-such-zen.json");
      expect(zen.credFp!()).toEqual({ cred: "absent", ident: "absent", exp: 0 });
    } finally {
      writeFileSync(ZEN_AUTH, authFile());
      delete process.env.APIPLAN_ZEN_AUTH;
      if (hadEnv === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = hadEnv;
    }
  });
});

// ─────────────────────────── T6 · the partition, through both fronts ───────────────────────────

describe("T6 zen's inclusive counters cross into each front's own convention", () => {
  test("COLD: nothing cached, and an explicit zero is a measured MISS", async () => {
    await upstream({ zen: { input_tokens: 6_200, cached_tokens: 0, output_tokens: 40, reasoning_tokens: 8 } });
    const j = await messages("spark");
    expect(j.usage.input_tokens).toBe(6_200);
    // 0 means measured-and-missed; a MISSING field would mean the vendor did not say. A
    // cache-effectiveness reader depends on the difference.
    expect(j.usage.cache_read_input_tokens).toBe(0);
    expect(anthropicPromptTotal(j.usage)).toBe(6_200);
  });

  test("WARM: the Anthropic front does not double-count the cached prefix", async () => {
    await upstream({ zen: { input_tokens: 6_200, cached_tokens: 6_144, output_tokens: 40, reasoning_tokens: 8 } });
    const j = await messages("spark");
    // THE FAULT THIS PREVENTS: input_tokens 6,200 published beside cache_read 6,144 makes
    // Anthropic's own documented sum report a 12,344-token prompt for a 6,200-token turn.
    expect(j.usage.input_tokens).toBe(56);
    expect(j.usage.cache_read_input_tokens).toBe(6_144);
    expect(anthropicPromptTotal(j.usage)).toBe(6_200);
    expect(j.usage.output_tokens).toBe(40);
    // An exact partition needs no caveat, and must not claim to be an estimate.
    expect(j.x_apiplan_usage_basis).toBeUndefined();
  });

  test("THE DERIVED-REAL TURN re-partitions to 889 exactly, end to end", async () => {
    await upstream({ zen: REAL });
    const j = await messages("spark");
    expect(j.usage.input_tokens).toBe(REAL_UNCACHED);
    expect(j.usage.cache_read_input_tokens).toBe(128_881);
    expect(anthropicPromptTotal(j.usage)).toBe(129_770);
    expect(j.usage.output_tokens).toBe(3_307);
    expect(j.x_apiplan_usage_basis).toBeUndefined();
  });

  test("the OpenAI front republishes the inclusive total losslessly, reasoning included", async () => {
    await upstream({ zen: REAL });
    const j = await chat("spark");
    expect(j.usage.prompt_tokens).toBe(129_770);
    expect(j.usage.prompt_tokens_details.cached_tokens).toBe(128_881);
    expect(openaiOrdinary(j.usage)).toBe(REAL_UNCACHED);
    expect(j.usage.completion_tokens).toBe(3_307);
    // Reasoning is a SUB-DIVISION of output, never an addend: summing them bills the model's
    // thinking twice.
    expect(j.usage.completion_tokens_details.reasoning_tokens).toBe(1_583);
    expect(j.usage.completion_tokens_details.reasoning_tokens).toBeLessThanOrEqual(j.usage.completion_tokens);
  });

  test("both fronts describe the SAME physical turn", async () => {
    await upstream({ zen: REAL });
    const a = await messages("spark");
    await upstream({ zen: REAL });
    const o = await chat("spark");
    // Round-trip conservation: each front's own arithmetic arrives at one prompt size.
    expect(anthropicPromptTotal(a.usage)).toBe(o.usage.prompt_tokens);
    expect(a.usage.cache_read_input_tokens).toBe(o.usage.prompt_tokens_details.cached_tokens);
    expect(a.usage.input_tokens).toBe(openaiOrdinary(o.usage));
  });

  test("a FULL cache hit is representable and never drives the remainder negative", async () => {
    await upstream({ zen: { input_tokens: 6_200, cached_tokens: 6_200, output_tokens: 40 } });
    const j = await messages("spark");
    expect(j.usage.input_tokens).toBe(0);
    expect(j.usage.cache_read_input_tokens).toBe(6_200);
    expect(anthropicPromptTotal(j.usage)).toBe(6_200);
  });

  test("a SILENT backend yields an ESTIMATE that says it is one — never a measured-looking zero", async () => {
    // WHAT THE GATEWAY REALLY DOES, checked rather than assumed (this assertion was written
    // the other way round first, and the run corrected it): when a backend reports no counters
    // at all, api.ts substitutes its own ~4-chars/token estimate and MARKS the response
    // `x_apiplan_usage: "estimated"` (api.ts:1508-1509). That is the honest shape — a hardcoded
    // 0 would read as a measured turn of nothing — and the mark is the part that matters, so it
    // is what this pins.
    await upstream({ silent: true });
    const j = await messages("spark");
    expect(j.x_apiplan_usage).toBe("estimated");
    // An estimate stands in for the WHOLE prompt, so it can never be published beside a cache
    // breakdown: there is no measured partition to break down.
    expect(j.usage?.cache_read_input_tokens).toBeUndefined();
    expect(j.usage?.cache_creation_input_tokens).toBeUndefined();
    expect(j.usage?.input_tokens).toBeGreaterThan(0);
    // …and the contrast that makes this a real discrimination rather than a vacuous pass: a
    // turn the backend DID report is not marked estimated.
    await upstream({ zen: { input_tokens: 6_200, cached_tokens: 6_144, output_tokens: 40 } });
    expect((await messages("spark")).x_apiplan_usage).toBeUndefined();
  });

  test("an input total with NO cache field is reported honestly instead of converted", async () => {
    // An inclusive backend that states an input total and no cache counter cannot be
    // partitioned: the absence is the backend declining to say, and subtracting an assumed
    // zero would publish a derived-looking number nothing supports.
    await upstream({ zen: { input_tokens: 6_200, output_tokens: 40 } });
    const j = await messages("spark");
    expect(j.usage.input_tokens).toBe(6_200);
    expect(j.usage.cache_read_input_tokens).toBeUndefined();
    expect(j.x_apiplan_usage_basis).toBe("unavailable");
  });
});

// ─────────────────────────── T7 · delta parity with grok ───────────────────────────

describe("T7 one wire shape, one reading", () => {
  test("zen.delta and grok.delta agree event-for-event on a REAL event sequence", () => {
    // zen.delta is a copy of grok.delta because it is the same wire. Two parsers for one shape
    // is how two backends drift into disagreeing about what the same event meant — so the
    // copies are pinned to each other here, over the exact events the fixture serves (not a
    // hand-made list, which would only prove the two agree about a shape nothing sends).
    const events = zenEvents({ zen: REAL });
    expect(events.length).toBeGreaterThanOrEqual(7);
    for (const ev of events) {
      expect(zen.delta(ev), `event ${String(ev.type)}`).toEqual(grok.delta(ev));
    }
    // …and the sequence is not a row of empty objects, which is the one way this could pass
    // while proving nothing.
    const deltas = events.map((e) => zen.delta(e));
    expect(deltas.some((d) => d.text === "ok")).toBe(true);
    expect(deltas.some((d) => d.reasoning === "thinking")).toBe(true);
    expect(deltas.some((d) => d.toolStart?.name === "read_file")).toBe(true);
    expect(deltas.some((d) => d.toolArgs?.json === '{"path"')).toBe(true);
    expect(deltas.some((d) => d.toolArgs?.full === true)).toBe(true);
    expect(deltas.some((d) => d.usage?.cacheRead === 128_881)).toBe(true);
  });

  test("usage is read off response.completed, cached passed through UNSUBTRACTED", () => {
    // The adapter must not convert: normalizeTally() owns the single conversion, and
    // subtracting here too would double-subtract and trip its source-inconsistent guard.
    const d = zen.delta({ type: "response.completed", response: { usage: { input_tokens: 129_770, output_tokens: 3_307, input_tokens_details: { cached_tokens: 128_881 }, output_tokens_details: { reasoning_tokens: 1_583 } } } });
    expect(d.usage).toEqual({ input: 129_770, output: 3_307, cacheRead: 128_881, reasoning: 1_583 });
    expect(d.stopReason).toBe("end_turn");
  });

  test("an absent cache counter stays absent — never a measured zero", () => {
    const d = zen.delta({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 1 } } });
    expect(d.usage).toEqual({ input: 10, output: 1 });
    expect(d.usage?.cacheRead).toBeUndefined();
    expect(d.usage?.cacheWrite).toBeUndefined();
  });

  test("only a final response object terminates the turn", () => {
    // Without this, a body that stopped mid-answer would be indistinguishable from a finished
    // one, and a truncated reply would be treated as complete.
    for (const t of ["response.completed", "response.incomplete", "response.failed", "response.done"]) {
      expect(zen.terminal!({ type: t })).toBe(true);
    }
    for (const t of ["response.created", "response.output_text.delta", "response.in_progress"]) {
      expect(zen.terminal!({ type: t })).toBe(false);
    }
  });

  test("an output-cap truncation is the ONLY max_tokens stop", () => {
    expect(zen.delta({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }).stopReason).toBe("max_tokens");
    expect(zen.delta({ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }).stopReason).toBe("end_turn");
  });
});

// ─────────────────────────── T8 · the refusals ───────────────────────────

describe("T8 each refusal names its OWN fix", () => {
  /** The vendor's words, verbatim, as the gateway answered a keyless call from outside
   *  opencode. Quoted rather than paraphrased: this sentence is the whole reason the free tier
   *  is not ported. */
  const MISSING_SESSION = JSON.stringify({ error: { type: "MissingSessionID", message: "Error from provider (Console): OpenCode's free tier can only be used in OpenCode" } });

  test("400 MissingSessionID is explained as a TIER refusal, not a bad request", async () => {
    await upstream({ reject: { status: 400, body: MISSING_SESSION } });
    const r = await post("/v1/messages", { model: "spark", max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
    expect(r.ok).toBe(false);
    const text = await r.text();
    // The vendor's own words survive — a gateway that swallowed them would leave an operator
    // guessing — and so does its name for the fault.
    expect(text).toContain("OpenCode's free tier can only be used in OpenCode");
    expect(text).toContain("MissingSessionID");
    const hint = zen.explain?.(400, MISSING_SESSION);
    expect(hint).toContain("free tier");
    expect(hint).toContain("opencode.ai/zen");
  });

  test("401 points at the key, 402 at the balance, and 429 gets no invented explanation", () => {
    const unauth = zen.explain?.(401, JSON.stringify({ error: { message: "invalid api key" } }));
    expect(unauth).toContain("401");
    expect(unauth).toContain("opencode.ai/auth");
    expect(unauth).toContain("OPENCODE_API_KEY");
    expect(zen.explain?.(402, "{}")).toContain("balance");
    // Rate limiting is not an auth fault and the engine's generic wording is right for it —
    // and a 400 that is NOT the tier refusal is not this provider's to explain either.
    expect(zen.explain?.(429, "slow down")).toBeUndefined();
    expect(zen.explain?.(400, JSON.stringify({ error: { message: "unknown parameter" } }))).toBeUndefined();
  });
});

// ─────────────────────────── T9 · the command ───────────────────────────

describe("T9 `spark` is a command the installer will mint", () => {
  test("defaults() offers spark → spark", () => {
    // His order was `/model spark`. A model nothing on PATH can reach is a port that stopped
    // one step short.
    const spark = defaults().filter((c) => c.name === "spark");
    expect(spark).toHaveLength(1);
    expect(spark[0].model).toBe("spark");
    // And it must reach the model, not merely exist as a name.
    expect(resolve(spark[0].model)?.id).toBe(SPARK);
  });

  test("adding zen minted no default command for a generic word", () => {
    // A gateway brings a lot of new variant words with it (`pro`, `nano`, `codex`…). The ones
    // another provider already owns must not be re-minted, and none may shadow a real tool —
    // `add()` refuses both, and this is the assertion that says so out loud.
    const names = defaults().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("build");
  });
});
