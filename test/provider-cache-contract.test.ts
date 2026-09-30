/**
 * THE PROVIDER CACHE CONTRACT — what a vendor adapter must SAY about itself before this
 * gateway can publish its token counts without lying.
 *
 * ── WHY A CONTRACT AND NOT A TABLE ──
 *
 * api.ts used to keep a private `INPUT_BASIS: Record<ProviderId, …>` table naming each
 * vendor's usage convention. That table worked, and it was still the wrong shape, for one
 * reason: it lived in the file that CONSUMES the fact rather than the file that KNOWS it.
 * Two failure modes follow from that, and only the second one is loud:
 *
 *   · A new provider is added and the table is not updated. With a plain lookup that is not
 *     a compile error — `INPUT_BASIS[newProvider]` is simply `undefined`, the
 *     `!== "inclusive"` branch takes it, and the new vendor is silently treated as
 *     exclusive. If it was in fact inclusive, every turn it serves double-counts its cached
 *     prefix. Nothing throws, no test fails, and the number is wrong by most of the prompt
 *     on a cache-heavy agent turn.
 *   · The declared basis and the adapter drift apart, because the sentence justifying the
 *     basis is in one file and the code parsing the vendor's usage object is in another.
 *
 * Moving the declaration onto the Provider fixes both by construction. `usageBasis` and
 * `cache` are REQUIRED interface members, so a provider that omits them does not compile
 * (verified: `tsc` reports TS2739 "missing the following properties from type 'Provider':
 * usageBasis, cache"), and because `PROVIDERS` is typed `Record<ProviderId, Provider>`,
 * widening the `ProviderId` union forces an entry, which forces a Provider, which forces
 * both declarations. The chain has no silent link.
 *
 * ── WHAT THIS SUITE PROVES ──
 *
 *   1. DECLARED. Every PROVIDERS entry declares both fields, with members drawn from the
 *      published unions and internally coherent (a provider with no cache may not name a
 *      field to address it, and one with a cache must).
 *   2. ENFORCED AT COMPILE TIME. Type-level assertions that both members exist on the
 *      interface AND are non-optional, so the guarantee cannot be softened to `usageBasis?`
 *      by a later edit without this file failing to typecheck.
 *   3. HONOURED ON THE WIRE. For EACH basis, a real `api.serve()` on loopback in front of a
 *      stub upstream, driven through BOTH fronts, must publish three DISJOINT buckets —
 *      input holding only what was neither read nor written, so each dialect's own
 *      documented arithmetic recovers the same physical turn. The fixture's numbers are
 *      derived FROM the declared basis, which is what makes this a contract test rather
 *      than a second copy of cache-usage-dialects.test.ts: flip a provider's declaration
 *      without changing its wire and this fails, because the server's output would then
 *      contradict the declaration it was given.
 *
 * The subprocess exists for the reason test/helpers/usage-dialect-probe.ts documents: base
 * URLs and credential wells come from the environment, `bun test` runs every file in one
 * process, and pointing those at a fixture from inside a test file leaks into the suites
 * that legitimately assert the REAL upstream URLs. A host declares its world when it starts,
 * so the world gets its own process. No credential of the operator's is read, no vendor is
 * dialled, and nothing outside a scratch dir is written.
 */
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../src/providers.ts";
import type { Provider, UsageBasis, CacheKind, CacheIdentity } from "../src/providers.ts";
import { resolve, type ProviderId } from "../src/registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "helpers", "usage-dialect-probe.ts");

// ─────────────────────────── 1. every provider declares the contract ───────────────────────────

/** The published unions, repeated here as DATA so a runtime check can see them. A widened
 *  union with no new case here fails below rather than passing unexamined. */
const BASES: UsageBasis[] = ["inclusive", "exclusive"];
const KINDS: CacheKind[] = ["implicit-prefix", "explicit-breakpoint", "cached-content-resource", "none"];
const IDENTITIES: CacheIdentity[] = ["prompt_cache_key", "cache_control", "cachedContent", "none"];

const entries = Object.entries(PROVIDERS) as [ProviderId, Provider][];

describe("every provider declares its usage basis and its cache", () => {
  // A guard on the guard: an empty registry would make every iterating test below pass by
  // vacuum, which is the one way a contract suite can be green while proving nothing.
  test("there are providers to check", () => {
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  for (const [id, p] of entries) {
    describe(id, () => {
      test("declares a usageBasis from the published union", () => {
        expect(BASES).toContain(p.usageBasis);
      });

      test("declares a cache with a kind and an identity from the published unions", () => {
        expect(p.cache).toBeDefined();
        expect(KINDS).toContain(p.cache.kind);
        expect(IDENTITIES).toContain(p.cache.identity);
      });

      /**
       * ONE DIRECTION, NOT TWO. A named identity with `kind: "none"` is incoherent — it
       * points a caller at a field for a cache this vendor does not have — so a real
       * identity must imply a real kind.
       *
       * The converse is NOT a rule, and asserting it was a bug this suite briefly carried.
       * "A real kind with identity none" is a perfectly truthful state: a purely implicit
       * prefix cache EXISTS, it changes the bill, and there is no client field that reaches
       * it. Requiring an identity there would force an adapter to either name a field the
       * vendor does not accept, or deny a cache it does have — the contract would make the
       * honest declaration unrepresentable, which is the one thing it must never do.
       */
      test("a named identity implies a real cache kind", () => {
        if (p.cache.identity !== "none") expect(p.cache.kind).not.toBe("none");
      });

      test("no cache means no handle to it", () => {
        if (p.cache.kind === "none") expect(p.cache.identity).toBe("none");
      });

      /**
       * DOCUMENTED-OR-ABSENT. Both numbers are optional because a vendor may publish
       * neither, and an absent field means "the vendor does not say" — never "zero" and
       * never "forever". So the only thing to check is that a PRESENT one is a real
       * measurement: a zero or negative minimum is not a floor, and a zero TTL is not a
       * lifetime. Either would read as documented while meaning nothing.
       */
      test("any number it does declare is a real one", () => {
        if (p.cache.minTokens !== undefined) {
          expect(Number.isInteger(p.cache.minTokens)).toBe(true);
          expect(p.cache.minTokens).toBeGreaterThan(0);
        }
        if (p.cache.ttlMs !== undefined) {
          expect(Number.isFinite(p.cache.ttlMs)).toBe(true);
          expect(p.cache.ttlMs).toBeGreaterThan(0);
        }
      });

      /** A provider with no cache has no thresholds to publish; numbers beside `kind:
       *  "none"` would describe a mechanism that is not there. */
      test("a provider with no cache publishes no cache numbers", () => {
        if (p.cache.kind !== "none") return;
        expect(p.cache.minTokens).toBeUndefined();
        expect(p.cache.ttlMs).toBeUndefined();
      });

      /** The declaration must be about THIS provider: an object copied from a neighbour
       *  and half-edited is exactly how a wrong basis gets in, and `id` is the tell. */
      test("the entry is keyed by its own id", () => {
        expect(p.id).toBe(id);
      });
    });
  }
});

// ─────────────────────────── 2. the compile-time gate ───────────────────────────

/**
 * These assertions have no runtime content on purpose — they ARE the test, and `tsc` is the
 * assertion engine. Each is written so the only way it can be satisfied is the property it
 * names, which means a later edit that weakens the interface breaks this file's typecheck.
 *
 * Verified failing on a deliberately incomplete provider:
 *   error TS2739: Type '{ id: "ollama"; label: string; … }' is missing the following
 *   properties from type 'Provider': usageBasis, cache
 *
 * The project ships no tsconfig.json (it runs on bun, which strips types rather than
 * checking them), so the runtime half of this suite is what fails under `bun test`, and
 * this half is what fails under an explicit-flag typecheck. The exact command is in the
 * receipt at .deify/provider-contract/receipt.json.
 */

/** Present on the interface at all. */
type ContractKeys = "usageBasis" | "cache";
type AbsentFromProvider = Exclude<ContractKeys, keyof Provider>;
const declaredOnInterface: AbsentFromProvider extends never ? true : AbsentFromProvider = true;

/** …and REQUIRED, not merely allowed. `{}` is assignable to `Pick<T, K>` only when K is
 *  optional, which is exactly what separates `cache: C` from `cache?: C`. */
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];
type WeakenedToOptional = Extract<OptionalKeys<Provider>, ContractKeys>;
const requiredNotOptional: WeakenedToOptional extends never ? true : WeakenedToOptional = true;

/**
 * …and exhaustive over the provider space. This is the link that makes a NEW ProviderId
 * unable to skip the contract: `PROVIDERS` is `Record<ProviderId, Provider>`, so widening
 * the union forces an entry, an entry must be a `Provider`, and a `Provider` must declare
 * both fields. Asserting the record type here pins that chain, so it cannot be loosened to
 * `Partial<Record<…>>` (which would let a provider be missing entirely) without this line
 * failing to compile.
 */
const exhaustiveOverProviderIds: Record<ProviderId, Provider> = PROVIDERS;

test("the compile-time gate's own assertions hold", () => {
  // Runtime is trivially true; the value of these is that they typecheck at all, and
  // referencing them here keeps them from being deleted as unused.
  expect([declaredOnInterface, requiredNotOptional]).toEqual([true, true]);
  expect(Object.keys(exhaustiveOverProviderIds).length).toBe(entries.length);
});

/**
 * The same guarantee from the other end, at RUNTIME, because a type is only as good as the
 * world matching it: any provider the model registry can route to must have an adapter in
 * PROVIDERS, or a request for one of its models reaches a lookup that answers undefined.
 * Registry caches are per-machine, so this asserts nothing about WHICH providers exist —
 * only that whatever the registry names here is declared.
 */
test("every provider the registry can route to is declared", () => {
  for (const alias of ["opus", "gpt-6-astra", "gemini", "heretic"]) {
    const m = resolve(alias);
    if (!m) continue; // that family is not in this machine's cache; nothing to check
    const p: Provider | undefined = PROVIDERS[m.provider];
    expect(p).toBeDefined();
    expect(BASES).toContain(p.usageBasis);
    expect(KINDS).toContain(p.cache.kind);
    expect(IDENTITIES).toContain(p.cache.identity);
  }
});

// ─────────────────────────── 3. the wire honours the declaration ───────────────────────────

const DIR = mkdtempSync(join(tmpdir(), "ap-cache-contract-"));
const HOME = join(DIR, "home");
const ANTHROPIC_CRED = join(DIR, "anthropic.json");
const CODEX_CRED = join(DIR, "codex.json");

/** Bearers good for hours, so nothing here depends on a refresh path. */
writeFileSync(ANTHROPIC_CRED, JSON.stringify({
  claudeAiOauth: {
    accessToken: "AT-cache-contract", refreshToken: "RT-cache-contract",
    expiresAt: Date.now() + 6 * 3600_000, scopes: ["user:inference"],
  },
}));
writeFileSync(CODEX_CRED, JSON.stringify({
  tokens: { access_token: "AT-cache-contract-codex", refresh_token: "RT-cache-contract-codex", account_id: "acct-cache-contract" },
  last_refresh: new Date().toISOString(),
}));

/** As much of the probe subprocess as this file touches. Named rather than lifted off the
 *  spawn helper's return, so what this suite depends on is stated instead of inferred. */
type ProbeProcess = { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; kill(): void };

let proc: ProbeProcess | null = null;
let base = "";     // the apiplan server under test
let fixture = "";  // the stub upstream, so a test can say what it should report

beforeAll(async () => {
  const spawned = Bun.spawn(["bun", PROBE], {
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
  proc = spawned;
  // The READY line is the only synchronisation point: a port that is merely allocated is
  // not a server that answers, and polling a guessed port would race the boot.
  const reader = spawned.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 30_000;
  while (!buf.includes("\n") && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  const m = /READY (\d+) (\d+)/.exec(buf);
  if (!m) throw new Error(`probe never became ready: ${buf}\n${await new Response(spawned.stderr).text()}`);
  base = `http://127.0.0.1:${m[1]}`;
  fixture = `http://127.0.0.1:${m[2]}`;
});
afterAll(() => {
  try { proc?.kill(); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

// ── reading the server's reply without pretending to know its shape ──

type JsonObject = Record<string, unknown>;

/** A parsed JSON value that must be an object, or a failure that says what was there
 *  instead. Every field this suite reads comes through here, so a server that answers an
 *  error body fails with that body in the message rather than with "cannot read property
 *  of undefined" ten lines later. */
function asObject(v: unknown, what: string): JsonObject {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is not an object: ${JSON.stringify(v)}`);
  return v as JsonObject; // narrowed above; TS cannot express "plain object" any other way
}

/** One token count off a usage object. Absent stays absent — an omitted counter is the
 *  backend declining to say, which this server preserves rather than defaulting to zero.
 *  A present non-number is a fault to surface, never to coerce: these are the numbers a
 *  cost model bills from. */
function count(o: JsonObject, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number") throw new Error(`${key} is not a number: ${JSON.stringify(v)}`);
  return v;
}

/** Anthropic's usage, in that vendor's own field names — because the assertion that matters
 *  is the vendor's own documented arithmetic, and renaming the fields here would quietly
 *  make this suite test something else. */
type AnthropicUsage = {
  input_tokens?: number; output_tokens?: number;
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
};
/** OpenAI's usage, likewise. */
type OpenAIUsage = {
  prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
  cached_tokens?: number; cache_write_tokens?: number;
};
/** A reply's usage plus the two honesty markers, which are the OTHER half of the claim: a
 *  partition is only exact if the server also declined to caveat it. */
type Reply<U> = { usage: U; hasUsageMarker: boolean; hasBasisMarker: boolean };

function anthropicReply(body: JsonObject): Reply<AnthropicUsage> {
  const u = asObject(body.usage, "anthropic usage");
  return {
    usage: {
      input_tokens: count(u, "input_tokens"),
      output_tokens: count(u, "output_tokens"),
      cache_read_input_tokens: count(u, "cache_read_input_tokens"),
      cache_creation_input_tokens: count(u, "cache_creation_input_tokens"),
    },
    hasUsageMarker: body.x_apiplan_usage !== undefined,
    hasBasisMarker: body.x_apiplan_usage_basis !== undefined,
  };
}

function openaiReply(body: JsonObject): Reply<OpenAIUsage> {
  const u = asObject(body.usage, "openai usage");
  const d = u.prompt_tokens_details === undefined ? {} : asObject(u.prompt_tokens_details, "prompt_tokens_details");
  return {
    usage: {
      prompt_tokens: count(u, "prompt_tokens"),
      completion_tokens: count(u, "completion_tokens"),
      total_tokens: count(u, "total_tokens"),
      cached_tokens: count(d, "cached_tokens"),
      cache_write_tokens: count(d, "cache_write_tokens"),
    },
    hasUsageMarker: body.x_apiplan_usage !== undefined,
    hasBasisMarker: body.x_apiplan_usage_basis !== undefined,
  };
}

// ── the one physical turn ──

/**
 * ONE physical turn, with BOTH cache buckets non-zero so a conversion that forgets either
 * one is caught. Every assertion below is that this single turn survives every crossing.
 */
const TOTAL = 40_000, READ = 30_000, WRITE = 8_000, UNCACHED = TOTAL - READ - WRITE, OUT = 250;

/**
 * The stub upstream's counters for this turn, in ANTHROPIC's wire field names, as a backend
 * of the given basis would really report them. This is the ONE place the declared basis is
 * turned into numbers, and the whole reason the suite tests the contract rather than
 * restating it: an exclusive backend publishes the uncached remainder as its input, an
 * inclusive one publishes the whole prompt. That IS the definition of the two words.
 */
const anthropicFixture = (basis: UsageBasis) => ({
  anthropic: {
    input_tokens: basis === "exclusive" ? UNCACHED : TOTAL, output_tokens: OUT,
    cache_read_input_tokens: READ, cache_creation_input_tokens: WRITE,
  },
});
/** The same turn in the RESPONSES wire field names. */
const openaiFixture = (basis: UsageBasis) => ({
  openai: {
    input_tokens: basis === "exclusive" ? UNCACHED : TOTAL, output_tokens: OUT,
    cached_tokens: READ, cache_write_tokens: WRITE,
  },
});
/** The fixture shape follows the BACKEND's dialect; its numbers follow the DECLARED basis. */
const fixtureFor = (provider: ProviderId, basis: UsageBasis) =>
  provider === "anthropic" ? anthropicFixture(basis) : openaiFixture(basis);

/** Arm the stub upstream. Awaited, so the fixture is in place before the request goes out. */
async function upstream(f: unknown): Promise<void> {
  const r = await fetch(`${fixture}/__fixture`, { method: "POST", body: JSON.stringify(f) });
  expect(r.ok).toBe(true);
}

/** POST /v1/messages — the ANTHROPIC front, non-streaming. */
async function messagesFront(model: string): Promise<Reply<AnthropicUsage>> {
  const r = await fetch(`${base}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] }),
  });
  const body = asObject(await r.json(), `messages reply (${r.status})`);
  if (!r.ok) throw new Error(`messages ${r.status}: ${JSON.stringify(body)}`);
  return anthropicReply(body);
}
/** POST /v1/chat/completions — the OPENAI front, non-streaming. */
async function chatFront(model: string): Promise<Reply<OpenAIUsage>> {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
  });
  const body = asObject(await r.json(), `chat reply (${r.status})`);
  if (!r.ok) throw new Error(`chat ${r.status}: ${JSON.stringify(body)}`);
  return openaiReply(body);
}

/**
 * A model this machine can actually route to a backend of the wanted basis, resolved
 * against the REAL registry rather than assumed — an alias that stopped mapping to the
 * family it used to would otherwise let this suite quietly test the wrong provider.
 *
 * Only the two backends the probe can reach are candidates: it is given stub Anthropic and
 * Codex wells and NO google credential, deliberately, because a suite that dials a live
 * vendor proves nothing repeatable. Between them both bases are covered, which is what the
 * contract needs — the claim under test is about a BASIS, not about a vendor.
 */
type BasisPick = { alias: string; provider: ProviderId };
function modelOfBasis(basis: UsageBasis): BasisPick | null {
  for (const alias of ["opus", "gpt-6-astra"]) {
    const m = resolve(alias);
    if (m && PROVIDERS[m.provider].usageBasis === basis) return { alias, provider: m.provider };
  }
  return null;
}

/** Anthropic's documented identity: the three parts are disjoint and sum to the prompt.
 *  "total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens" */
const anthropicPromptTotal = (u: AnthropicUsage) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
/** OpenAI's documented subtraction: prompt_tokens already CONTAINS both cached parts.
 *  "ordinaryInputTokens = inputTokens - cachedTokens - cacheWriteTokens" */
const openaiOrdinary = (u: OpenAIUsage) =>
  (u.prompt_tokens ?? 0) - (u.cached_tokens ?? 0) - (u.cache_write_tokens ?? 0);

describe("each declared basis round-trips through both fronts with disjoint buckets", () => {
  for (const basis of BASES) {
    describe(`a ${basis} backend`, () => {
      /**
       * Not a skip. A basis with no reachable backend means this suite cannot prove the
       * claim it exists to prove, and a green skip would hide that — so it fails loudly
       * and names what is missing.
       */
      test("is reachable on this machine, or the contract is unproven", () => {
        expect(modelOfBasis(basis)).not.toBeNull();
      });

      test("published through the ANTHROPIC front, the three buckets are disjoint", async () => {
        const pick = modelOfBasis(basis)!;
        await upstream(fixtureFor(pick.provider, basis));
        const { usage: u } = await messagesFront(pick.alias);

        expect(u.cache_read_input_tokens).toBe(READ);
        expect(u.cache_creation_input_tokens).toBe(WRITE);
        // The whole claim: input holds ONLY the uncached remainder, so the vendor's own sum
        // covers the prompt exactly once instead of counting the cached prefix twice.
        expect(u.input_tokens).toBe(UNCACHED);
        expect(anthropicPromptTotal(u)).toBe(TOTAL);
        expect(u.output_tokens).toBe(OUT);
      });

      test("published through the OPENAI front, the documented subtraction recovers it", async () => {
        const pick = modelOfBasis(basis)!;
        await upstream(fixtureFor(pick.provider, basis));
        const { usage: u } = await chatFront(pick.alias);

        expect(u.cached_tokens).toBe(READ);
        expect(u.cache_write_tokens).toBe(WRITE);
        // Inclusive by definition on this front, so the buckets are disjoint iff the
        // vendor's own subtraction lands on the uncached remainder — and never below zero,
        // which is the exact fault an unconverted exclusive backend produced here.
        expect(u.prompt_tokens).toBe(TOTAL);
        expect(openaiOrdinary(u)).toBe(UNCACHED);
        expect(openaiOrdinary(u)).toBeGreaterThanOrEqual(0);
        expect(u.completion_tokens).toBe(OUT);
        expect(u.total_tokens).toBe(TOTAL + OUT);
      });

      /**
       * An EXACT partition must not be labelled an estimate. The markers exist to warn a
       * reader that the buckets could not be made disjoint; emitting one when they could
       * would train readers to ignore it, which costs the marker its only purpose.
       */
      test("an exact partition carries no honesty marker on either front", async () => {
        const pick = modelOfBasis(basis)!;
        const fx = fixtureFor(pick.provider, basis);
        await upstream(fx);
        const a = await messagesFront(pick.alias);
        expect(a.hasUsageMarker).toBe(false);
        expect(a.hasBasisMarker).toBe(false);
        await upstream(fx);
        const o = await chatFront(pick.alias);
        expect(o.hasUsageMarker).toBe(false);
        expect(o.hasBasisMarker).toBe(false);
      });
    });
  }

  /**
   * The two bases meeting on one turn. Both fronts, both backends: four crossings of the
   * SAME physical turn, which must all agree on the prompt total and the uncached share.
   * This is what a cost model reads, and the reason the declaration has to be right — the
   * three buckets bill at three different rates, so a partition error is a billing error.
   */
  test("all four crossings of one physical turn agree", async () => {
    const excl = modelOfBasis("exclusive");
    const incl = modelOfBasis("inclusive");
    expect(excl).not.toBeNull();
    expect(incl).not.toBeNull();

    await upstream(fixtureFor(excl!.provider, "exclusive"));
    const exclViaAnthropic = (await messagesFront(excl!.alias)).usage;
    await upstream(fixtureFor(excl!.provider, "exclusive"));
    const exclViaOpenAI = (await chatFront(excl!.alias)).usage;
    await upstream(fixtureFor(incl!.provider, "inclusive"));
    const inclViaAnthropic = (await messagesFront(incl!.alias)).usage;
    await upstream(fixtureFor(incl!.provider, "inclusive"));
    const inclViaOpenAI = (await chatFront(incl!.alias)).usage;

    // One prompt total, four readings.
    expect(anthropicPromptTotal(exclViaAnthropic)).toBe(TOTAL);
    expect(anthropicPromptTotal(inclViaAnthropic)).toBe(TOTAL);
    expect(exclViaOpenAI.prompt_tokens).toBe(TOTAL);
    expect(inclViaOpenAI.prompt_tokens).toBe(TOTAL);
    // One uncached share, four readings.
    expect(exclViaAnthropic.input_tokens).toBe(UNCACHED);
    expect(inclViaAnthropic.input_tokens).toBe(UNCACHED);
    expect(openaiOrdinary(exclViaOpenAI)).toBe(UNCACHED);
    expect(openaiOrdinary(inclViaOpenAI)).toBe(UNCACHED);
    // And the cache counters are carried across every crossing, not consumed by one.
    expect(exclViaAnthropic.cache_read_input_tokens).toBe(READ);
    expect(inclViaAnthropic.cache_read_input_tokens).toBe(READ);
    expect(exclViaOpenAI.cached_tokens).toBe(READ);
    expect(inclViaOpenAI.cached_tokens).toBe(READ);
  });
});

/**
 * THE REGRESSION THE CONTRACT REPLACED. api.ts's deleted table defaulted an undeclared
 * provider to exclusive — `undefined !== "inclusive"` — so an inclusive backend that was
 * never added to it passed its counters through unconverted and double-counted the cached
 * prefix. There is no way to construct that state through the type system any more, so what
 * is asserted here is the arithmetic itself: the unconverted reading is a DIFFERENT, wrong
 * number, and the server does not emit it.
 */
test("an inclusive backend's raw input total is not what gets published", async () => {
  const incl = modelOfBasis("inclusive");
  expect(incl).not.toBeNull();
  await upstream(fixtureFor(incl!.provider, "inclusive"));
  const { usage: u } = await messagesFront(incl!.alias);

  // Upstream said 40,000. Passing that through as Anthropic's exclusive input_tokens would
  // make the documented sum report a 78,000-token prompt for a 40,000-token turn.
  expect(u.input_tokens).not.toBe(TOTAL);
  expect(TOTAL + READ + WRITE).toBe(78_000);
  expect(anthropicPromptTotal(u)).toBe(TOTAL);
});

/**
 * THE ANCHOR — the one place a vendor's basis is pinned WITHOUT consulting the declaration.
 *
 * Everything above derives its fixture from `usageBasis`, which is what makes it a contract
 * test: it proves the server behaves as the declaration says. But a self-consistent lie
 * survives that — flip a provider's declaration AND the fixture follows, so the arithmetic
 * still closes and only the coverage guard ("is this basis reachable?") notices. That guard
 * is a real backstop and it does fire, but it reports a missing basis rather than the wrong
 * one, which is a confusing way to learn you broke the accounting.
 *
 * So each backend the probe can reach is pinned to the basis its own VENDOR DOCUMENTATION
 * states, as a literal, with the quote in the message. Independent of any field, so a
 * declaration that drifts from the docs fails HERE, by name, saying exactly which provider
 * disagrees with which sentence.
 *
 * Not every provider is pinned, and the rule for adding one has moved once — recorded here
 * rather than rewritten, because the two readings fail differently. The original rule was
 * "only backends this suite can hermetically reach", on the argument that a pin without a
 * reachable backend asserts a constant against itself. That is true of a pin whose only
 * warrant is the pin: it restates its own literal. It is NOT true of a pin warranted by an
 * EXTERNAL reading — a vendor sentence, or the route's own billing code — which is a second
 * source, so the assertion can fail when the declaration drifts from it. `anthropic` was
 * always such a row (documented, never live-measured here), and `zen` is another: its
 * backend is unreachable from this box at all (no credential exists — see its row), while
 * its own client's arithmetic is on disk and openable.
 *
 * What a pin of that kind does NOT prove is what the real backend's counter means; only a
 * paid call does, and each row says which it has. A provider added later is still covered by
 * everything above (it must declare, and its basis must round-trip) whether or not it is
 * pinned here.
 *
 * WHAT KIND OF EVIDENCE EACH PIN RESTS ON, stated per row, because this suite is hermetic
 * and a hermetic suite can assert any partition it plants. A stub upstream reporting
 * inclusive counters proves the FRONT re-partitions them correctly; it says nothing about
 * what the REAL backend's input counter means. That second question is answered only by a
 * doc sentence or by paid calls against the live vendor, so each row says which it has.
 */
type BasisEvidence =
  /** The vendor's own documentation, quoted. No live counter was read for this row. */
  | { kind: "documented" }
  /** Confirmed against real upstream counters, with the receipt and the exact scope — a
   *  run on ONE model id does not generalise to that vendor's other ids. */
  | { kind: "live"; model: string; receipt: string };

const DOCUMENTED_BASIS: { provider: ProviderId; basis: UsageBasis; quote: string; evidence: BasisEvidence }[] = [
  {
    provider: "anthropic", basis: "exclusive",
    quote: "input_tokens: Number of input tokens which were not read from or used to create a cache — "
      + "total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens",
    // NOT live-verified. The only measurement in evidence on the Anthropic side was a STUB
    // upstream (planted counters, 8007 in → 1327 + 6680 out), which proves normalizeTally's
    // conversion and this front's re-partition — not what the real backend's counter means.
    evidence: { kind: "documented" },
  },
  {
    provider: "openai", basis: "inclusive",
    quote: "ordinaryInputTokens = inputTokens - cachedTokens - cacheWriteTokens "
      + "(the guide's own cost sample, which is only meaningful if input already contains both)",
    // Live: input_tokens stayed PINNED at 7,520 across four calls while cache_read varied
    // between 0 and 7,424. Exclusive would imply a ~14,944-token prompt for a turn measured
    // at ~7.5-8k, so the reading is decided by counters, not only by the sentence. What
    // proves the basis is that the input counter DOES NOT MOVE when the cached share does —
    // the hit/miss sequence is irrelevant to it, which is why this row deliberately does NOT
    // characterise that sequence. Two earlier versions of this comment did, and both were
    // wrong in opposite directions: the first spelled out "0 → 7,424 → 0 → 7,424", inviting a
    // 50%-alternation reading; the second called that alternation REFUTED, which overstated a
    // 6/6 non-reproduction. A non-reproduction constrains how OFTEN an event happens; it
    // cannot delete a recorded counter, and raw_calls[1]=7424 → raw_calls[2]=0 on one fixed
    // key 7.5s apart with the same body sha is a WARM miss still on record. What is actually
    // refuted is a STANDING 50% ceiling. The basis conclusion never depended on any of it.
    evidence: { kind: "live", model: "gpt-6-astra", receipt: ".deify/cache-proof/live-ab.json" },
  },
  {
    provider: "grok", basis: "inclusive",
    quote: "cached_tokens Equal to prompt_tokens = Full cache hit, your entire prompt was served from cache; "
      + "and long context applies when total prompt tokens (including cached tokens) exceed the threshold "
      + "(https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing)",
    // Live: three BYTE-IDENTICAL 6,197-token requests under one stable prompt_cache_key.
    // input_tokens stayed pinned at 6,197 while cached_tokens climbed 0 → 128 → 6,144.
    // Exclusive PREDICTS call 3's input counter falls to ~53; observed 6,197, unmoved — so
    // exclusive is refuted by counters, not merely disfavoured by a sentence. The vendor's
    // billing agrees independently: cost_in_usd_ticks fell 130,960,000 → 38,980,000 for a
    // same-sized prompt. That 128-token read is also why this row declares NO minTokens:
    // xAI cached BELOW any published floor, so a borrowed 1,024 would have been actively
    // wrong rather than merely unsupported.
    evidence: { kind: "live", model: "grok-4.6", receipt: ".deify/grok/receipt.json" },
  },
  {
    provider: "zen", basis: "inclusive",
    // NOT a doc SENTENCE — opencode.ai/docs/zen states nothing about the usage shape at all.
    // What is quoted is the route's own BILLING CLIENT, opened rather than described:
    // ~/.opencode/bin/opencode v1.18.30 (Mach-O arm64, embedded source), byte offset
    // 67,539,101, verbatim —
    //     Y=K(usage.inputTokens??0) … Z=K(usage.cacheReadInputTokens??0) … V=K(Y-Z-J)
    //     z={total, input:V, output:K(W-H), reasoning:H, cache:{write:J, read:Z}}
    // The client SUBTRACTS the cached (and written) share out of `inputTokens` to get the
    // number it stores and bills, which is only meaningful if `input_tokens` already
    // CONTAINS both — the same arithmetic that decides openai's row above.
    quote: "opencode's own token writer computes input = inputTokens - cacheReadInputTokens - cacheWriteInputTokens "
      + "(~/.opencode/bin/opencode v1.18.30, byte 67539101), i.e. the wire's input_tokens already contains the cached prefix",
    // DOCUMENTED, not live, and the reason is a fact about THIS BOX rather than a choice:
    // there is no OpenCode Zen credential here to measure with — ~/.local/share/opencode/
    // auth.json holds one entry (`google`, type oauth) and OPENCODE_API_KEY is unset in the
    // environment and absent from every shell rc. So no counter of the real backend has been
    // read by this lane, and this row must not wear the stronger label.
    //
    // The arithmetic IS corroborated once, on this machine, by opencode's own stored row:
    // ~/.local/share/opencode/opencode.db, 2026-09-09 11:32:54, model muse-spark-1.3-
    // contributor-free — {total 134660, input 889, output 3307, reasoning 1583, cache.read
    // 128881}. 889 + 128,881 = 129,770 and 3,307 + 1,583 = 4,890, and 129,770 + 4,890 =
    // 134,660, the vendor's own totalTokens, exactly. That is a reading of a STORED row
    // produced by the subtraction above, not an independent measurement of the wire, which
    // is why it is written here as corroboration and not as evidence.kind "live".
    // A7 upgrades this row to live, with the receipt at .deify/zen/receipt.json.
    evidence: { kind: "documented" },
  },
];

describe("each vendor's declared basis matches its own documentation", () => {
  for (const { provider, basis, quote, evidence } of DOCUMENTED_BASIS) {
    // The provenance rides in the test NAME, so a reader of the output learns which pins are
    // backed by counters and which by a sentence — without opening this file.
    const how = evidence.kind === "live"
      ? `live-verified on ${evidence.model} (${evidence.receipt})`
      : "doc-derived, NOT live-verified";
    test(`${provider} is ${basis} [${how}]: ${quote}`, () => {
      expect(PROVIDERS[provider].usageBasis).toBe(basis);
    });
  }
});

/**
 * And the honesty of the row itself: a "live" claim must carry the model it was measured on
 * and the receipt it came from, or it is a doc-derived row wearing a stronger label. Cheap
 * to assert, and it is the assertion that keeps the provenance above from rotting into
 * decoration the next time a row is added.
 */
test("every live-verified basis pin names its model and receipt", () => {
  for (const { provider, evidence } of DOCUMENTED_BASIS) {
    if (evidence.kind !== "live") continue;
    expect(evidence.model.length, `${provider} live pin needs a model id`).toBeGreaterThan(0);
    expect(evidence.receipt, `${provider} live pin needs a receipt path`).toMatch(/^\.deify\/.+\.json$/);
  }
});

/**
 * ── P-34: AN ABSENCE MUST BE ASSERTED, NOT MERELY PERMITTED ──
 *
 * `documented-or-absent` makes ABSENCE a load-bearing claim: an omitted `minTokens` says
 * "this vendor publishes no minimum". Every other test in this file only checks that a
 * PRESENT number is sane, so before this block the suite could not tell a truthful absence
 * from a deleted fact. That was demonstrated by a TEMPORARY, SINCE-REVERTED experiment:
 * openai's `minTokens: 1024` and `ttlMs: 30m` — both vendor-documented — were deleted, and
 * the suite printed 59 pass / 0 fail.
 *
 * NOTHING IS SABOTAGED IN THE TREE. That experiment was reverted byte-identically and the
 * declarations it touched are live and correct; this paragraph is history, not a state to
 * hunt. It is spelled out because a reader who met this comment while the gate below was
 * still landing reasonably suspected a leftover mutation, and checked the LIVE declarations
 * before believing a test snapshot — which is the right instinct and the right order.
 *
 * That is the asymmetry P-34 names, and it is why staring at the file cannot help: a broken
 * instrument yields a VISIBLY WRONG VALUE on a positive claim, but a CLEAN FABRICATED
 * SILENCE on a negative one. A wrong 4096 is arguable; a vanished 1024 is invisible.
 *
 * So the fabrication pathway is closed the only way it can be — by naming, per provider,
 * which numbers the vendor IS known to publish. A vendor that publishes one must declare
 * it; a vendor that publishes none must stay silent, and saying so out loud is what makes
 * the silence evidence instead of an unfilled field. This table is the instrument's
 * calibration, and it is deliberately NOT derived from the declarations it checks: reading
 * the value under test to decide what the value should be is the reflexive check P-34
 * warns about, and would pass no matter what.
 */
/**
 * ── P-36: A PRESENCE GATE IS NOT A CORRECTNESS GATE ──
 *
 * The first version of this table carried booleans — "does the vendor publish a minimum?" —
 * and asserted only that a published number was DEFINED. That closed the absence pathway and
 * left the wrong-VALUE pathway wide open, proved by a since-reverted mutation: openai's
 * minTokens 1024 → 4096 printed 78 pass / 0 fail. Both guards over that field pass a 4096
 * (it is a positive integer, and it is defined), and 4096 is a real Anthropic floor and a
 * real Gemini 3.x floor, so it reads as documented.
 *
 * The lesson is sharper than "N guards over one value are redundant": those two guards were
 * redundant OVER THE WRONG PREDICATE. Both answer "is declared"; neither touches "is
 * correct". Stacking presence guards never becomes a correctness gate, and they are most
 * dangerous when they look complementary.
 *
 * So a row now records the EXPECTED VALUE, or `null` for "the vendor publishes none". That
 * is deliberately a second copy of each number, and the duplication is the point: this table
 * is not a second source of truth about the vendor, it is a second independent READING of
 * the vendor, and two readings of one external fact is corroboration rather than repetition
 * — the same reason DOCUMENTED_BASIS pins each basis to a literal instead of deriving it.
 *
 * A DRIFT IS A FINDING, NOT A MAINTENANCE COST. If the declaration and this table disagree,
 * someone changed a vendor number without re-reading the vendor — the single most likely way
 * a wrong floor enters this file, and not hypothetical: the Anthropic floor is non-monotonic
 * in version AND was mis-stated in the brief this lane was given. Because every row carries
 * the doc SENTENCE, resolving a disagreement means re-reading the source, never picking a
 * side. And this forbids nothing truthful — only an unread number.
 */
type PublishedNumbers = {
  /** The minimum the vendor publishes, or null when it publishes none. */ minTokens: number | null;
  /** The default lifetime the vendor publishes in ms, or null when it publishes none. */ ttlMs: number | null;
  /** Why — the doc fact, so a future reader can re-check rather than trust this row. */ why: string;
};
const PUBLISHES: Partial<Record<ProviderId, PublishedNumbers>> = {
  anthropic: { minTokens: 512, ttlMs: 5 * 60_000,
    why: "'Cache limitations' lists a per-model minimum (512 Opus 5 … 4096 Opus 4.6/Haiku 4.5) and states 'ephemeral is the only supported cache type, which by default has a 5-minute lifetime'" },
  openai: { minTokens: 1024, ttlMs: 30 * 60_000,
    why: "'minimum cacheable prompt length is 1,024 tokens for GPT-5.6 and later' and 'prompt_cache_options.ttl … the only supported value, 30m, is also the default'" },
  google: { minTokens: 2048, ttlMs: null,
    why: "publishes per-model floors (2,048 for 2.5 Flash/Pro) but NO implicit-cache lifetime and NO CachedContent default ttl — storage is billed per token-hour and ttl is set per resource" },
  ollama: { minTokens: null, ttlMs: null,
    why: "no prompt cache to publish numbers about; reports no cache counters on either endpoint" },
  grok: { minTokens: null, ttlMs: null,
    why: "xAI's prompt-caching usage-and-pricing page documents neither a minimum nor a lifetime — and a live run cached 128 tokens out of a 6,197-token prompt, i.e. BELOW any floor another vendor publishes, so a borrowed 1,024 would have been actively wrong rather than merely unsupported (.deify/grok/receipt.json)" },
  zen: { minTokens: null, ttlMs: null,
    why: "opencode.ai/docs/zen publishes neither a cacheable floor nor a cache lifetime — the page prices input / output / cached input per model and says nothing about the cache itself; the gateway proxies to the model vendor, so whatever floor that vendor applies is not a property OpenCode Zen states. Borrowing OpenAI's 1,024 because the ids are named gpt-* would be inventing a number for a reseller route (the same error the grok row above names, where the vendor cached 128 tokens below every published floor). UNMEASURED here: no zen key exists on this box, so no live turn has been observed to cache at any size (.deify/zen/ has no receipt)" },
  gemini: { minTokens: 2048, ttlMs: null,
    why: "same vendor docs as the google route — per-model floors are published (2,048 for 2.5 Flash/Pro, 4,096 for 3.x) but no implicit lifetime and no CachedContent default ttl; this route SETS an explicit ttl per resource precisely because the vendor defaults none (.deify/gemini/receipt.json)" },
};

describe("a declared absence is a claim about the vendor, and is checked as one", () => {
  for (const [id, pub] of Object.entries(PUBLISHES) as [ProviderId, PublishedNumbers][]) {
    const p = PROVIDERS[id];
    // A provider named here but no longer registered would silently stop being checked.
    test(`${id} is still registered`, () => { expect(p).toBeDefined(); });

    // `null` asserts the ABSENCE (P-34); a number asserts the VALUE (P-36). One expectation
    // each way, so neither a deleted fact nor a wrong-but-plausible one can pass.
    test(`${id} ${pub.minTokens === null ? "publishes no minimum, so declares none" : `declares its vendor's published minimum ${pub.minTokens}`}`, () => {
      if (pub.minTokens === null) expect(p.cache.minTokens, `vendor publishes none: ${pub.why}`).toBeUndefined();
      else expect(p.cache.minTokens, `vendor publishes ${pub.minTokens}: ${pub.why}`).toBe(pub.minTokens);
    });

    test(`${id} ${pub.ttlMs === null ? "publishes no default lifetime, so declares none" : `declares its vendor's published lifetime ${pub.ttlMs}ms`}`, () => {
      if (pub.ttlMs === null) expect(p.cache.ttlMs, `vendor publishes none: ${pub.why}`).toBeUndefined();
      else expect(p.cache.ttlMs, `vendor publishes ${pub.ttlMs}ms: ${pub.why}`).toBe(pub.ttlMs);
    });
  }

  /**
   * A provider absent from PUBLISHES is NOT failed — a new vendor's docs are the new lane's
   * to read, and forcing a stranger to fill this table would invite a guess, which is the
   * failure the law exists to prevent. But it must be VISIBLE that its absences are
   * unchecked, because "no test failed" would otherwise read as "the absence was verified".
   */
  test("every provider is either calibrated here or reported as uncalibrated", () => {
    const uncalibrated = (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => !(id in PUBLISHES));
    const silent = uncalibrated.filter((id) => PROVIDERS[id].cache.minTokens === undefined || PROVIDERS[id].cache.ttlMs === undefined);
    // Not an assertion about correctness — a printed inventory, so an unchecked absence is
    // never mistaken for a checked one.
    if (silent.length) console.log(`[P-34] absences NOT verified against vendor docs (add to PUBLISHES): ${silent.join(", ")}`);
    expect(uncalibrated.every((id) => PROVIDERS[id].cache !== undefined)).toBe(true);
  });
});
