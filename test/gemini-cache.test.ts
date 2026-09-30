// The API-KEY Gemini route: does a cache HIT survive the whole gateway, in both dialects?
//
// The lane's claim is that `gemini` reports Google's cache counters correctly and that the
// server's ONE usage conversion turns them into disjoint buckets. That claim is only worth
// anything end to end, so nothing here calls the adapter's delta() directly: every
// assertion goes through a real api.serve() talking to a stub that answers in the vendor's
// own proto, and is read off the reply a client would actually receive.
//
// THE ONE PHYSICAL TURN every usage assertion is about:
//   whole prompt 10,000 · cached (read) 8,000 · uncached remainder 2,000 · output 5
// Google states it INCLUSIVELY — promptTokenCount 10,000 with cachedContentTokenCount 8,000
// as a breakdown OF it (measured live 2026-09-06: promptTokenCount 3163 against
// cachedContentTokenCount 3155 for an 8-token fresh question). Both fronts must publish the
// remainder as 2,000, never 10,000: input 2,000 / cacheRead 8,000 / output 5.
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "helpers", "gemini-stub.ts");

const DIR = mkdtempSync(join(tmpdir(), "ap-gemini-cache-"));
const HOME = join(DIR, "home");

let proc: ReturnType<typeof Bun.spawn> | null = null;
let base = "";      // the apiplan server under test
let fixture = "";   // the stub upstream, so a test can say what it should report

/** A model this registry routes to the `gemini` provider. 2.5 because it is the family that
 *  serves explicit caching, and the one whose documented implicit floor is 2,048. */
const GEM = "gemini-key-2.5-flash";
/** A 3.x id, to pin that the thinking field differs by family. */
const GEM3 = "gemini-key-3.8-flash";

beforeAll(async () => {
  proc = Bun.spawn(["bun", STUB], {
    env: {
      ...process.env,
      APIPLAN_HOME: HOME,
      APIPLAN_API_KEY: "",
      // The explicit-cache path is opt-in in production; this suite exercises it, so it is
      // armed here — and only here, in this process.
      APIPLAN_GEMINI_EXPLICIT_CACHE: "1",
      // A low floor so the suite's small fixtures clear the spend gate. Production's
      // default is 8,192 chars (~2,048 tokens, the vendor's own floor).
      APIPLAN_GEMINI_EXPLICIT_CACHE_MIN_CHARS: "64",
      // Never let a Keychain entry or a real credential on the developer's machine answer
      // instead of the stubs. The stub sets its own APIPLAN_GEMINI_API_KEY.
      APIPLAN_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_KEYCHAIN_SERVICE: "apiplan-test-no-such-service",
      APIPLAN_GOOGLE_CRED_FILE: join(DIR, "no-such-google-credential.json"),
      APIPLAN_GEMINI_API_KEY_FILE: join(DIR, "no-such-gemini-key"),
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
  if (!m) throw new Error(`stub never became ready: ${buf}\n${await new Response(proc!.stderr).text()}`);
  base = `http://127.0.0.1:${m[1]}`;
  fixture = `http://127.0.0.1:${m[2]}`;
});
afterAll(() => {
  try { proc?.kill(); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────── talking to the server ───────────────────────────

type UsageMetadata = {
  promptTokenCount?: number; candidatesTokenCount?: number;
  cachedContentTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number;
};
type Fixture = {
  usage?: UsageMetadata; silent?: boolean; text?: string;
  create?: { status?: number; tokens?: number; body?: unknown };
  rejectCachedContent?: number;
};
/** Arm the stub. Awaited, so the fixture is in place before the request goes out. */
async function upstream(f: Fixture) {
  expect((await fetch(`${fixture}/__fixture`, { method: "POST", body: JSON.stringify(f) })).ok).toBe(true);
}
type Seen = { path: string; model?: string; cachedContent?: string; hasSystem: boolean; hasTools: boolean; thinking?: unknown };
/** What the stub actually received — the only way to assert on the OUTBOUND body. */
const seen = async (): Promise<Seen[]> => (await fetch(`${fixture}/__calls`)).json() as Promise<Seen[]>;
const resetSeen = async () => { await fetch(`${fixture}/__reset`); };

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** POST /v1/chat/completions (OpenAI FRONT), non-streaming. */
async function chat(model: string, extra: Record<string, unknown> = {}) {
  const r = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "hello" }], ...extra });
  const j = await r.json();
  if (!r.ok) throw new Error(`chat ${r.status}: ${JSON.stringify(j)}`);
  return j as Reply;
}
/** POST /v1/messages (Anthropic FRONT), non-streaming. */
async function messages(model: string, extra: Record<string, unknown> = {}) {
  const r = await post("/v1/messages", { model, max_tokens: 64, messages: [{ role: "user", content: "hello" }], ...extra });
  const j = await r.json();
  if (!r.ok) throw new Error(`messages ${r.status}: ${JSON.stringify(j)}`);
  return j as Reply;
}
/**
 * A reply, with the two honesty markers where the server actually puts them: TOP LEVEL,
 * beside `usage` rather than inside it. That placement is deliberate on the server's part
 * — both SDKs ignore an unknown top-level field, while an unknown key inside `usage` is a
 * number a summing consumer might pick up — so a test that looked for them inside `usage`
 * would read `undefined` and pass for the wrong reason on every arm.
 */
type Reply = {
  usage: Record<string, unknown>;
  x_apiplan_usage?: string;
  x_apiplan_usage_basis?: string;
};

/** The turn every usage test is about. See the header. */
const HIT: UsageMetadata = { promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5 };

// ─────────────────────────── the cache hit, through both fronts ───────────────────────────

describe("a cache hit survives the gateway in both dialects", () => {
  test("the Anthropic front publishes the UNCACHED remainder, not the whole prompt", async () => {
    await upstream({ usage: HIT });
    const r = await messages(GEM);
    const u = r.usage;
    // Anthropic's documented convention: the three buckets are DISJOINT and sum to the
    // whole prompt. 2,000 + 8,000 = 10,000, which is what the vendor reported inclusively.
    expect(u.input_tokens).toBe(2_000);
    expect(u.cache_read_input_tokens).toBe(8_000);
    expect(u.output_tokens).toBe(5);
    expect((u.input_tokens as number) + (u.cache_read_input_tokens as number)).toBe(10_000);
    // No cache_creation: this vendor reports no write counter on a generateContent
    // response, and an absent counter must never become a measured zero.
    expect(u.cache_creation_input_tokens).toBeUndefined();
    // The partition was exact and both counters were measured, so neither honesty marker
    // rides along — an ordinary reply stays clean.
    expect(r.x_apiplan_usage_basis).toBeUndefined();
    expect(r.x_apiplan_usage).toBeUndefined();
  });

  test("the OpenAI front folds it back to an inclusive total with the breakdown beside it", async () => {
    await upstream({ usage: HIT });
    const u = (await chat(GEM)).usage;
    // OpenAI's `prompt_tokens` is inclusive BY DEFINITION, so the round trip returns the
    // vendor's own 10,000 — and a consumer applying OpenAI's documented subtraction
    // recovers exactly the 2,000 the other front published. That is the round trip being
    // lossless in BOTH directions off one physical turn.
    expect(u.prompt_tokens).toBe(10_000);
    expect(u.completion_tokens).toBe(5);
    const details = u.prompt_tokens_details as Record<string, unknown>;
    expect(details.cached_tokens).toBe(8_000);
    expect((u.prompt_tokens as number) - (details.cached_tokens as number)).toBe(2_000);
    expect(details.cache_write_tokens).toBeUndefined();
  });

  test("a measured MISS is an explicit zero, distinguishable from 'cannot say'", async () => {
    // Zero is EVIDENCE — it means measured, and it was a miss. That is exactly what a
    // cache-effectiveness reader needs to tell apart from an absent counter, so an explicit
    // zero must survive into the reply rather than being dropped as falsy.
    await upstream({ usage: { promptTokenCount: 10_000, cachedContentTokenCount: 0, candidatesTokenCount: 5 } });
    const r = await messages(GEM);
    expect(r.usage.input_tokens).toBe(10_000);
    expect(r.usage.cache_read_input_tokens).toBe(0);
    // Measured zero is an EXACT partition: nothing was cached, so nothing is unknown.
    expect(r.x_apiplan_usage_basis).toBeUndefined();
  });

  test("a vendor that reports NO cache field at all is 'unavailable', never a zero", async () => {
    // An inclusive backend reporting an input total and no cache field is declining to say
    // what share was cached. Subtracting an assumed zero would publish a derived-looking
    // number nothing supports, so the total stands and the honest marker rides along.
    await upstream({ usage: { promptTokenCount: 10_000, candidatesTokenCount: 5 } });
    const r = await messages(GEM);
    expect(r.usage.input_tokens).toBe(10_000);
    expect(r.usage.cache_read_input_tokens).toBeUndefined();
    expect(r.x_apiplan_usage_basis).toBe("unavailable");
  });

  test("thinking tokens are billed as output, and reported as a share of it", async () => {
    // `candidatesTokenCount` does NOT contain thoughts — the vendor's own totalTokenCount
    // identity is "prompt + thoughts + response candidates", three addends, and it was
    // measured live (candidates 1 beside thoughts 25, total 29). Publishing output without
    // thoughts under-reports the BILLED output on every thinking turn, since the docs price
    // it as "the sum of output tokens and thinking tokens".
    await upstream({ usage: { promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, thoughtsTokenCount: 25 } });
    const u = (await messages(GEM)).usage;
    expect(u.output_tokens).toBe(30);           // 5 candidates + 25 thoughts
    expect(u.input_tokens).toBe(2_000);         // the partition is unaffected
  });

  test("an impossible reading is REPORTED, not repaired", async () => {
    // Cached tokens outnumbering the input they are a part of cannot be subtracted: the
    // result would be a fabricated negative, and clamping to zero would destroy real
    // tokens. So the measured total is preserved, the contradictory cache counter is
    // WITHHELD rather than republished, and the marker says why it is gone.
    await upstream({ usage: { promptTokenCount: 1_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5 } });
    const r = await messages(GEM);
    expect(r.usage.input_tokens).toBe(1_000);
    expect(r.usage.cache_read_input_tokens).toBeUndefined();
    expect(r.x_apiplan_usage_basis).toBe("source-inconsistent");
  });
});

// ─────────────────────────── what goes UPSTREAM ───────────────────────────

describe("the request this provider builds", () => {
  test("the route marker never reaches the vendor, and the key rides in x-goog-api-key", async () => {
    await resetSeen();
    await upstream({ usage: HIT });
    await messages(GEM);
    const gen = (await seen()).filter((c) => c.path.includes("streamGenerateContent"));
    expect(gen.length).toBeGreaterThanOrEqual(1);
    // `gemini-key-2.5-flash` is how the REGISTRY names this route (both Google routes
    // publish the same vendor names); the endpoint answers 404 for an id it does not
    // publish, so the marker must be stripped exactly once.
    expect(gen.at(-1)!.model).toBe("gemini-2.5-flash");
    // The stub 401s any request without the header, so reaching a 200 at all proves it.
  });

  test("the thinking field differs by FAMILY, because sending the wrong one is a 400", async () => {
    // Measured 2026-09-06: gemini-2.5-flash answers 400 "Thinking level is not supported
    // for this model." to `thinkingLevel`, and 200 to `thinkingBudget`; 3.8-flash takes the
    // level. A single field for both families would break one of them on every request.
    await resetSeen();
    await upstream({ usage: HIT });
    await messages(GEM, { output_config: { effort: "low" } });
    await messages(GEM3, { output_config: { effort: "low" } });
    const gen = (await seen()).filter((c) => c.path.includes("streamGenerateContent"));
    const two5 = gen.find((c) => c.model === "gemini-2.5-flash");
    const three = gen.find((c) => c.model === "gemini-3.8-flash");
    expect(two5?.thinking).toEqual({ thinkingBudget: 512 });
    expect(three?.thinking).toEqual({ thinkingLevel: "LOW" });
  });
});

// ─────────────────────────── the explicit cache ───────────────────────────

describe("the explicit cachedContents resource", () => {
  /** A system prompt over the suite's spend gate, so a create is attempted. */
  const SYS = "You are a cache-probe fixture. ".repeat(8);
  /**
   * Wait for the background create to reach the stub.
   *
   * This awaits a real cross-process HTTP round trip that the code under test deliberately
   * does NOT expose a promise for — arming the create is fire-and-forget precisely so no
   * request waits on it, so there is no signal to await and fake timers cannot help. So it
   * polls the OBSERVABLE condition (the stub recorded a create) rather than sleeping a
   * guessed duration: it returns the instant the create lands, and a failure names the
   * missing create rather than a timeout.
   */
  async function creates(): Promise<Seen[]> {
    for (let i = 0; i < 200; i++) {
      const c = (await seen()).filter((x) => x.path.endsWith("/cachedContents"));
      if (c.length) return c;
      await Bun.sleep(5);
    }
    return [];
  }

  test("the create is armed in the BACKGROUND, so no request waits on it", async () => {
    // build() is synchronous by contract, so it cannot create a CachedContent — a sync
    // network call on a resident host blocks every other request. So the first request
    // carrying a fresh prefix ARMS the create and goes out on the implicit path; the entry
    // is in hand for the NEXT request with that prefix, which is the case a named cache
    // exists for (a one-off prefix is never worth an object billed by the token-hour).
    await resetSeen();
    await upstream({ usage: HIT, create: { tokens: 8_000 } });

    const first = await messages(GEM, { system: SYS });
    // The first request is served normally and its usage is untouched by the arming.
    expect(first.usage.input_tokens).toBe(2_000);
    expect(first.usage.cache_read_input_tokens).toBe(8_000);
    // It did NOT reference a cache (there was none yet) and DID send the system prompt.
    const gen1 = (await seen()).filter((c) => c.path.includes("streamGenerateContent"));
    expect(gen1.length).toBe(1);
    expect(gen1[0].cachedContent).toBeUndefined();
    expect(gen1[0].hasSystem).toBe(true);

    // The create landed in the background, pinned to the VERSIONED wire id in the
    // "models/<id>" spelling the vendor echoes (a mismatch is a 400 quoting both sides).
    const made = await creates();
    expect(made.length).toBe(1);
    expect(made[0].model).toBe("models/gemini-2.5-flash");
    expect(made[0].hasSystem).toBe(true);
  });

  test("the NEXT request references it, and does not re-send what the cache holds", async () => {
    await upstream({ usage: HIT, create: { tokens: 8_000 } });
    await resetSeen();
    const u = (await messages(GEM, { system: SYS })).usage;
    expect(u.input_tokens).toBe(2_000);
    const gen = (await seen()).filter((c) => c.path.includes("streamGenerateContent"));
    expect(gen.length).toBe(1);
    // "System instructions and tools MUST be stored in the cache, not sent separately" —
    // sending either beside a `cachedContent` is a 400, so the reference REPLACES them.
    expect(gen[0].cachedContent).toBe("cachedContents/stub1");
    expect(gen[0].hasSystem).toBe(false);
    // And it is REUSED rather than recreated: the prefix is keyed by
    // sha256(model + system + tools), so an identical prefix finds the entry in hand.
    expect((await seen()).filter((c) => c.path.endsWith("/cachedContents")).length).toBe(0);
  });

  test("an EXPIRED entry answers 403, NOT 404 — and the dead name is dropped, not re-sent", async () => {
    // Measured against the live API 2026-09-06: a dead or unknown cache name answers
    // 403 PERMISSION_DENIED "CachedContent not found (or permission denied)". Any recovery
    // keyed on 404 — the status a reader of the REST reference would expect — never fires
    // at all, so this is pinned by STATUS and TEXT together.
    //
    // AND THE POISONING IS THE REAL BUG. Without the repair, ONE eviction breaks every
    // subsequent request carrying that prefix for the life of the process: build() keeps
    // finding the entry, keeps sending its name, upstream keeps refusing. So the assertion
    // that matters is not the 403 — it is that the request AFTER it succeeds.
    await upstream({ usage: HIT, create: { tokens: 8_000 }, rejectCachedContent: 1 });
    await resetSeen();

    const r = await post("/v1/messages", { model: GEM, max_tokens: 64, system: SYS, messages: [{ role: "user", content: "hello" }] });
    expect(r.status).toBe(403);
    const body = await r.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("CachedContent not found");
    // The reference really did go out — the refusal is about the cache, not the key.
    const refused = (await seen()).filter((c) => c.path.includes("streamGenerateContent"));
    expect(refused.at(-1)!.cachedContent).toBe("cachedContents/stub1");

    // The dead entry was forgotten, so this request does NOT reference it again. There is
    // no automatic retry by design (one honest refusal, then recovery), so the next request
    // is on the implicit path and a fresh create is armed behind it.
    await resetSeen();
    const next = await messages(GEM, { system: SYS });
    expect(next.usage.input_tokens).toBe(2_000);
    const after = (await seen()).filter((c) => c.path.includes("streamGenerateContent"));
    expect(after.at(-1)!.cachedContent).toBeUndefined();
    expect(after.at(-1)!.hasSystem).toBe(true);
    // A NEW entry is minted rather than the corpse reused.
    expect((await creates()).at(-1)!.model).toBe("models/gemini-2.5-flash");

    // And the one after THAT references the new name — the cache is working again.
    await resetSeen();
    await messages(GEM, { system: SYS });
    const healed = (await seen()).filter((c) => c.path.includes("streamGenerateContent"));
    expect(healed.at(-1)!.cachedContent).toBe("cachedContents/stub2");
  });

  test("a refused create leaves the caller on the implicit path rather than failing", async () => {
    // Explicit caching is a PAID-tier feature; a free-tier key cannot create a resource.
    // An operator opting into a cost optimisation must not thereby make requests fail — the
    // fallback is the vendor's free implicit cache, which is what they had anyway. A failed
    // create is also not retried on the very next request (there is a cooldown), because a
    // refusal that will not change adds a doomed round trip to every call.
    await upstream({ usage: HIT, create: { status: 403, body: "Context caching requires a paid tier" } });
    await resetSeen();
    const u = (await messages(GEM, { system: `${SYS} refused arm` })).usage;
    expect(u.input_tokens).toBe(2_000);
    expect(u.cache_read_input_tokens).toBe(8_000);
    const gen = (await seen()).filter((c) => c.path.includes("streamGenerateContent"));
    // No reference went out, and the system instruction was sent normally instead.
    expect(gen.at(-1)!.cachedContent).toBeUndefined();
    expect(gen.at(-1)!.hasSystem).toBe(true);
  });
});
