// The local API's wire contract. These start a real server on a loopback port but never
// reach a provider: every test either asks for something rejected before the call, or
// checks a shape the translation layer owns. That keeps them credential-free and fast,
// which is what lets them run in CI on three operating systems.
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { serve, optsFrom, fromAnthropic } from "../src/api.ts";

const readSrc = (name: string) =>
  require("node:fs").readFileSync(new URL(`../src/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");

let base = "";
let stop = () => {};
beforeAll(() => {
  // port 0 lets the OS pick a free one — a fixed port makes the suite fail when a real
  // `apiplan serve` happens to be running on the same machine.
  const s = serve({ port: 0, host: "127.0.0.1" });
  base = s.url;
  stop = s.stop;
});
afterAll(() => stop());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });


describe("it answers on both vendors' paths", () => {
  test("health reports what it is", async () => {
    const j: any = await (await fetch(base + "/health")).json();
    // NOT `ok === true`: /health is a verdict about the world it runs in, and this suite
    // runs in whatever world CI or a laptop has — a cold state dir, no credentials, an
    // unexercised provider. Demanding green here would either fail honestly-red machines
    // or push the server back toward answering ok on nothing (the false green the outcome
    // mechanism exists to prevent). What the CONTRACT owes is the shape and the vocabulary,
    // plus the one invariant that must hold in every world: green costs proof.
    expect(typeof j.ok).toBe("boolean");
    expect(["ok", "degraded", "down", "unproven", "unverified"]).toContain(j.status);
    expect(Array.isArray(j.providers)).toBe(true);
    if (j.ok) for (const p of j.providers) { expect(p.connected).toBe(true); expect(p.verified).toBe("ok"); }
    expect(j.dialects).toEqual(["openai", "anthropic"]);
    expect(j.models).toBeGreaterThan(0);
  });
  test("GET /v1/models answers in OpenAI's list shape", async () => {
    const j: any = await (await fetch(base + "/v1/models")).json();
    expect(j.object).toBe("list");
    expect(Array.isArray(j.data)).toBe(true);
    expect(j.data[0]).toHaveProperty("owned_by");
  });
  test("the same path answers in Anthropic's shape for an Anthropic caller", async () => {
    // The SDKs are told apart by the header they authenticate with.
    const j: any = await (await fetch(base + "/v1/models", { headers: { "x-api-key": "k" } })).json();
    expect(j).toHaveProperty("has_more");
    expect(j.data[0].type).toBe("model");
    expect(j.data[0]).toHaveProperty("display_name");
  });
  test("a trailing slash is the same route", async () => {
    expect((await fetch(base + "/v1/models/")).status).toBe(200);
  });
});

describe("server control telemetry", () => {
  test("reports request counters and enters an explicit drain state", async () => {
    const s = serve({ port: 0, host: "127.0.0.1" });
    try {
      const before: any = await (await fetch(s.url + "/_apiplan/control")).json();
      expect(before.pid).toBe(process.pid);
      expect(before.accepting).toBe(true);
      expect(before.activeRequests).toBe(0);
      expect(before.completedRequests).toBe(0);
      expect(before.cachePolicy).toBe("cached");

      expect((await fetch(s.url + "/v1/models")).status).toBe(200);
      const after: any = await (await fetch(s.url + "/_apiplan/control")).json();
      expect(after.completedRequests).toBe(1);
      const draining: any = await (await fetch(s.url + "/_apiplan/drain", { method: "POST" })).json();
      expect(draining.accepting).toBe(false);
      expect(draining.draining).toBe(true);
      expect(draining.activeRequests).toBe(0);
      expect((await fetch(s.url + "/v1/models")).status).toBe(503);
    } finally { s.stop(); }
  });
});

describe("cache identity normalization", () => {
  test("keeps OpenAI prompt_cache_key unchanged", () => {
    expect(optsFrom({ prompt_cache_key: "pc_session_stable" }).promptCacheKey).toBe("pc_session_stable");
  });
  test("keeps OM's structured Anthropic metadata envelope unchanged", () => {
    const wrapped = JSON.stringify({ device_id: "stable-device", session_id: "stable-session" });
    expect(optsFrom({ metadata: { user_id: wrapped } }).promptCacheKey).toBe(wrapped);
  });
  test("keeps opaque Anthropic metadata compatible", () => {
    expect(optsFrom({ metadata: { user_id: "opaque-affinity" } }).promptCacheKey).toBe("opaque-affinity");
    const unrelated = JSON.stringify({ tenant: "stable-tenant" });
    expect(optsFrom({ metadata: { user_id: unrelated } }).promptCacheKey).toBe(unrelated);
  });
  test("removes request-bound billing attestations only at the Anthropic proxy boundary", () => {
    const stale = { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.246; cch=abcde;" };
    const stable = { type: "text", text: "stable system", cache_control: { type: "ephemeral" } };
    const misleading = { type: "text", text: "prefix x-anthropic-billing-header: keep this" };
    const parsed = fromAnthropic({
      system: [stale, stable, stale, misleading],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(parsed.systemBlocks).toEqual([stable, misleading]);
  });
  test("different per-turn attestations rebuild to the same cacheable system prefix", () => {
    const body = (cch: string) => ({
      system: [
        { type: "text", text: `x-anthropic-billing-header: cc_version=2.1.246; cch=${cch};` },
        { type: "text", text: "stable system", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "stable prefix" }],
    });
    const first = fromAnthropic(body("11111"));
    const second = fromAnthropic(body("22222"));
    expect(first.systemBlocks).toEqual(second.systemBlocks);
    expect(first.systemBlocks).toEqual([
      { type: "text", text: "stable system", cache_control: { type: "ephemeral" } },
    ]);
  });
});

describe("errors come back in the caller's own dialect", () => {
  test("OpenAI callers get an OpenAI error envelope", async () => {
    const r = await post("/v1/chat/completions", { model: "no-such-model", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(404);
    const j: any = await r.json();
    expect(j.error.message).toContain("unknown model");
    expect(j.error).toHaveProperty("param");        // OpenAI's envelope, not Anthropic's
  });
  test("Anthropic callers get an Anthropic error envelope", async () => {
    const r = await post("/v1/messages", { model: "no-such-model", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(404);
    const j: any = await r.json();
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("not_found_error");
  });
  test("a missing model is a 400, and an unknown route a 404", async () => {
    expect((await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] })).status).toBe(400);
    expect((await post("/v1/nope", {})).status).toBe(404);
  });
  test("an empty message list is refused before any provider is touched", async () => {
    const r = await post("/v1/chat/completions", { model: "opus", messages: [] });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error.message).toContain("at least one");
  });
  test("non-JSON bodies say so instead of throwing", async () => {
    const r = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error.message).toContain("JSON");
  });
  test("speech and images validate their required field", async () => {
    expect((await post("/v1/audio/speech", { voice: "alloy" })).status).toBe(400);
    expect((await post("/v1/images/generations", {})).status).toBe(400);
  });
});

describe("a key is optional, but enforced on both headers when set", () => {
  test("both vendors' auth headers are accepted, and a wrong one is 401", async () => {
    const s = serve({ port: 0, host: "127.0.0.1", token: "secret" });
    try {
      const bad = await fetch(s.url + "/v1/models");
      expect(bad.status).toBe(401);
      expect((await fetch(s.url + "/v1/models", { headers: { authorization: "Bearer secret" } })).status).toBe(200);
      expect((await fetch(s.url + "/v1/models", { headers: { "x-api-key": "secret" } })).status).toBe(200);
      expect(s.tokenRequired).toBe(true);
    } finally { s.stop(); }
  });
});

describe("it binds loopback unless told otherwise", () => {
  test("the default host is 127.0.0.1 — this hands out a subscription", () => {
    const src = require("node:fs").readFileSync(new URL("../src/api.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");
    expect(src).toContain('"127.0.0.1"');
    expect(src).not.toContain('"0.0.0.0"');
  });
});

describe("optional-value flags don't swallow the next flag", () => {
  test("--greet bare is true; --greet <text> is that text; --greet --voice x is still true", () => {
    // The real bug: `--greet --voice cedar` made the greeting instruction the literal
    // string "--voice", which overrode the persona for the opening line.
    const optVal = (argv: string[], f: string) => {
      const i = argv.indexOf(f);
      if (i < 0) return undefined;
      const v = argv[i + 1];
      return v === undefined || v.startsWith("-") ? true : v;
    };
    expect(optVal(["--greet"], "--greet")).toBe(true);
    expect(optVal(["--greet", "--voice", "cedar"], "--greet")).toBe(true);
    expect(optVal(["--greet", "open warmly"], "--greet")).toBe("open warmly");
    expect(optVal(["--voice", "cedar"], "--greet")).toBeUndefined();
  });
  test("the shipped CLI uses optVal for --greet, and plain valOf elsewhere", () => {
    const src = require("node:fs").readFileSync(new URL("../bin/apiplan.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");
    expect(src).toContain('optVal("--greet")');
    // --flags carries values that legitimately start with "-", so it must NOT use optVal
    expect(src).toContain('valOf("--flags")');
    expect(src).not.toContain('optVal("--flags")');
  });
});

describe("chat mode opens only when there is a human at the terminal", () => {
  test("the chat backend contract is what both CLIs implement", async () => {
    const { chat } = await import("../src/chat.ts");
    expect(typeof chat).toBe("function");
    const src = readSrc("chat.ts");
    // A chat needs scrollback and copy-paste, so it must never take the alternate screen.
    expect(src).not.toContain("?1049h");
    expect(src).toContain('from "node:readline"');   // stdlib, so zero-deps survives
  });
  test("both entry points fall back to the old error when not a TTY", () => {
    for (const f of ["ask.ts", "jimmy.ts"]) {
      const src = require("node:fs").readFileSync(new URL(`../bin/${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");
      expect(src).toContain("process.stdin.isTTY && process.stdout.isTTY");
      expect(src).toContain("no prompt");
    }
  });
  test("a failed turn is dropped from history rather than poisoning later turns", () => {
    expect(readSrc("chat.ts")).toContain("turns.pop()");
  });
  test("every slash command in the help actually exists", () => {
    const src = readSrc("chat.ts");
    for (const c of ["clear", "system", "retry", "copy", "help", "exit"]) {
      expect(src).toContain(`case "${c}"`);
    }
  });
});

describe("chatjimmy is reachable through both dialects too", () => {
  test("it is advertised in the model list", async () => {
    const j: any = await (await fetch(base + "/v1/models")).json();
    const jimmy = j.data.find((m: any) => m.owned_by === "jimmy");
    expect(jimmy).toBeTruthy();
    expect(jimmy.id).toBe("llama3.1-8B");
  });
  test("the alias and the wire id both route there, and are not treated as unknown models", () => {
    const src = readSrc("api.ts");
    expect(src).toContain('"jimmy"');
    expect(src).toContain('"chatjimmy"');
    // It must bypass pick(), which only knows credentialed providers.
    expect(src).toContain("const jimmy = isJimmy(body?.model)");
  });
  test("its telemetry sentinel never leaks into an API response", () => {
    const src = readSrc("api.ts");
    const fn = src.slice(src.indexOf("async function* runJimmy"), src.indexOf("const now ="));
    expect(fn).toContain("<|stats|>");        // held back while streaming
    expect(fn).toContain("JIMMY_STATS");      // and stripped from the final text
  });
  test("it needs no credential, so it works when nothing is logged in", () => {
    const fn = readSrc("api.ts");
    const body = fn.slice(fn.indexOf("async function* runJimmy"), fn.indexOf("const now ="));
    expect(body).not.toContain("creds()");
  });
});
