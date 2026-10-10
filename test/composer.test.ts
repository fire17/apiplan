// composer.test.ts — Codex composer predictions, decomposed (src/composer.ts). Offline: the
// Codex auth file is a fixture and every upstream call goes through an injected fetch.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSuggestion, parseConfig, predictionMessage, predictionMetadata, SUGGESTION_SCHEMA, FALLBACK_CONFIG,
  turnsFromMessages, turnsFromCodexRollout, turnsFromClaudeTranscript, tailTurns, findCodexRollout,
  predict, predictionConfig, predictFromRequest, ComposerError, PREDICTION_SOURCE,
} from "../src/composer.ts";
import { resolve } from "../src/registry.ts";

const dir = mkdtempSync(join(tmpdir(), "apiplan-composer-"));
beforeAll(() => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  const auth = join(dir, "auth.json");
  writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: jwt, account_id: "acct-test", refresh_token: "r", id_token: "i" } }));
  process.env.APIPLAN_CODEX_AUTH = auth;
});

const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const completed = (text: string) => [
  { type: "response.created", response: { model: "gpt-6-astra" } },
  { type: "response.output_text.delta", delta: text },
  { type: "response.completed", response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 3 } } } },
];
const CFG = { ...FALLBACK_CONFIG, prompt: "PREDICT", prompt_version: "t1", prediction_reasoning_effort: "high" };

describe("parseSuggestion — the Codex TUI acceptance rules", () => {
  test("a JSON suggestion is accepted and trimmed", () => {
    expect(parseSuggestion(`{"suggestion":"  run the tests  "}`)).toBe("run the tests");
  });
  test("null, empty, non-string and missing are null", () => {
    expect(parseSuggestion(`{"suggestion":null}`)).toBeNull();
    expect(parseSuggestion(`{"suggestion":"   "}`)).toBeNull();
    expect(parseSuggestion(`{"suggestion":42}`)).toBeNull();
    expect(parseSuggestion(`{"other":"x"}`)).toBeNull();
    expect(parseSuggestion(`not json`)).toBeNull();
  });
  test("more than 240 characters is null; exactly 240 passes (counted in code points)", () => {
    expect(parseSuggestion(JSON.stringify({ suggestion: "a".repeat(240) }))).toBe("a".repeat(240));
    expect(parseSuggestion(JSON.stringify({ suggestion: "a".repeat(241) }))).toBeNull();
    expect(parseSuggestion(JSON.stringify({ suggestion: "😀".repeat(240) }))).toBe("😀".repeat(240));
  });
  test("control and line-separator characters are null — one line only", () => {
    expect(parseSuggestion(JSON.stringify({ suggestion: "a\nb" }))).toBeNull();
    expect(parseSuggestion(JSON.stringify({ suggestion: "a b" }))).toBeNull();
  });
  test("a fenced or prose-wrapped object is tolerated", () => {
    expect(parseSuggestion("```json\n{\"suggestion\":\"ship it\"}\n```")).toBe("ship it");
  });
});

describe("the request shape", () => {
  test("the appended message is the app's template, schema included", () => {
    expect(predictionMessage("P")).toBe(`P\n\nReturn only JSON matching this schema: ${SUGGESTION_SCHEMA}.`);
    expect(JSON.parse(SUGGESTION_SCHEMA).required).toEqual(["suggestion"]);
  });
  test("the turn metadata names the prediction the way Codex does", () => {
    const m = predictionMetadata({ forkedFrom: "t-1" });
    expect(m.thread_source).toBe(PREDICTION_SOURCE);
    expect(m.turn_trigger).toBe(PREDICTION_SOURCE);
    expect(m.forked_from_thread_id).toBe("t-1");
    expect(m.request_kind).toBe("turn");
  });
});

describe("parseConfig — the app's zod shape", () => {
  test("a live body passes and an empty effort becomes null", () => {
    const c = parseConfig({ is_enabled: true, prompt: "p", prompt_version: "5", prediction_reasoning_effort: "", sample_rate: 0.75, unsupported_models: ["gpt-6-sol"] });
    expect(c?.prediction_reasoning_effort).toBeNull();
    expect(c?.sample_rate).toBe(0.75);
  });
  test("a malformed body is refused", () => {
    expect(parseConfig({ prompt: "p", prompt_version: "5" })).toBeNull();
    expect(parseConfig({ is_enabled: true, prompt: "p", prompt_version: "5", sample_rate: 2 })).toBeNull();
    expect(parseConfig(null)).toBeNull();
  });
  test("an unreachable config falls back to the bundled copy and says why", async () => {
    const r = await predictionConfig({ fresh: true, fetchImpl: (async () => new Response("no", { status: 503 })) as any });
    expect(r.source).toBe("fallback");
    expect(r.error).toContain("503");
    expect(r.cfg.prompt_version).toBe("fallback-5");
  });
});

describe("conversation sources", () => {
  test("messages: OpenAI and Anthropic content shapes; system dropped", () => {
    const t = turnsFromMessages([
      { role: "system", content: "s" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: "hello" },
      { role: "user", content: "" },
    ]);
    expect(t).toEqual([{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]);
    expect(() => turnsFromMessages("x")).toThrow();
  });
  test("a Codex rollout keeps the visible conversation and skips harness context", () => {
    const rows = [
      { type: "session_meta", payload: {} },
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: [] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "fixed" }] } },
    ];
    expect(turnsFromCodexRollout(rows.map((r) => JSON.stringify(r)).join("\n"))).toEqual([
      { role: "user", text: "fix the bug" }, { role: "assistant", text: "fixed" },
    ]);
  });
  test("a Claude Code transcript drops tools, meta and command wrappers, and joins one reply's blocks", () => {
    const rows = [
      { type: "user", message: { role: "user", content: "build it" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "on it" }, { type: "tool_use", id: "1", name: "Bash", input: {} }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
      { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
    ];
    expect(turnsFromClaudeTranscript(rows.map((r) => JSON.stringify(r)).join("\n"))).toEqual([
      { role: "user", text: "build it" }, { role: "assistant", text: "on it\ndone" },
    ]);
  });
  test("tailTurns keeps whole newest turns within the budget, and always the last one", () => {
    const t = [{ role: "user" as const, text: "aaaa" }, { role: "assistant" as const, text: "bb" }, { role: "user" as const, text: "cc" }];
    expect(tailTurns(t, 4).map((x) => x.text)).toEqual(["bb", "cc"]);
    expect(tailTurns(t, 1).map((x) => x.text)).toEqual(["cc"]);
  });
  test("findCodexRollout resolves a thread id and 'last' under a sessions root", () => {
    const root = join(dir, "sessions");
    const day = join(root, "2026", "10", "10");
    mkdirSync(day, { recursive: true });
    const id = "01a125c2-f7d1-7ec1-bb5c-67a4c288d5f1";
    writeFileSync(join(day, `rollout-2026-10-10T15-21-36-${id}.jsonl`), "");
    expect(findCodexRollout(id, root).threadId).toBe(id);
    expect(findCodexRollout("last", root).threadId).toBe(id);
    expect(() => findCodexRollout("nope", root)).toThrow();
  });
});

describe("predict — one call against an injected backend", () => {
  const model = resolve("gpt-6-astra")!;
  test("sends the conversation + template with the prediction metadata, parses the reply", async () => {
    let sent: any;
    const fetchImpl = (async (url: string, init: any) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(sse(completed(`{"suggestion":"add tests"}`)), { headers: { "x-codex-primary-used-percent": "3" } });
    }) as any;
    const p = await predict([{ role: "user", text: "write it" }, { role: "assistant", text: "written" }], { model, config: CFG, fetchImpl, forkedFrom: "parent-1" });
    expect(p.suggestion).toBe("add tests");
    expect(p.prompt_version).toBe("t1");
    expect(p.effort).toBe("high");
    expect(p.usage).toEqual({ input_tokens: 100, cached_tokens: 64, output_tokens: 9, reasoning_tokens: 3 });
    expect(p.windows?.["x-codex-primary-used-percent"]).toBe("3");
    expect(sent.url).toEndWith("/backend-api/codex/responses");
    expect(sent.body.reasoning.effort).toBe("high");
    const last = sent.body.input.at(-1);
    expect(last.role).toBe("user");
    expect(last.content[0].text).toBe(predictionMessage("PREDICT"));
    const meta = JSON.parse(sent.headers["x-codex-turn-metadata"]);
    expect(meta).toMatchObject({ thread_source: PREDICTION_SOURCE, turn_trigger: PREDICTION_SOURCE, forked_from_thread_id: "parent-1" });
    expect(sent.body.client_metadata["x-codex-turn-metadata"]).toBe(sent.headers["x-codex-turn-metadata"]);
  });
  test("--no-tag sends no prediction metadata; an explicit effort wins", async () => {
    let sent: any;
    const fetchImpl = (async (_: string, init: any) => { sent = { headers: init.headers, body: JSON.parse(init.body) }; return new Response(sse(completed(`{"suggestion":null}`))); }) as any;
    const p = await predict([{ role: "user", text: "hi" }], { model, config: CFG, fetchImpl, tag: false, effort: "low" });
    expect(p.suggestion).toBeNull();
    expect(p.tagged).toBe(false);
    expect(sent.headers["x-codex-turn-metadata"]).toBeUndefined();
    expect(sent.body.client_metadata).toBeUndefined();
    expect(sent.body.reasoning.effort).toBe("low");
  });
  test("an upstream error carries its status and words", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ detail: "Unsupported model" }), { status: 400 })) as any;
    await expect(predict([{ role: "user", text: "hi" }], { model, config: CFG, fetchImpl })).rejects.toThrow("prediction failed (400): Unsupported model");
  });
  test("a stream cut before completion is an error, never a silent null", async () => {
    const fetchImpl = (async () => new Response(sse([{ type: "response.output_text.delta", delta: `{"sugg` }]))) as any;
    await expect(predict([{ role: "user", text: "hi" }], { model, config: CFG, fetchImpl })).rejects.toThrow("before the backend reported completion");
  });
  test("a non-Codex model is refused before any call", async () => {
    await expect(predict([{ role: "user", text: "hi" }], { model: resolve("haiku")!, config: CFG })).rejects.toThrow("Codex subscription");
  });
});

describe("predictFromRequest — the HTTP route's rules", () => {
  test("exactly one source", async () => {
    await expect(predictFromRequest({}, { allowLocalSources: true })).rejects.toMatchObject({ status: 400 });
    await expect(predictFromRequest({ messages: [], codex_thread: "last" }, { allowLocalSources: true })).rejects.toMatchObject({ status: 400 });
  });
  test("machine transcripts are owner only", async () => {
    await expect(predictFromRequest({ claude_session: "last" }, { allowLocalSources: false })).rejects.toMatchObject({ status: 403 });
    await expect(predictFromRequest({ codex_thread: "last" }, { allowLocalSources: false })).rejects.toBeInstanceOf(ComposerError);
  });
  test("unknown and non-Codex models", async () => {
    await expect(predictFromRequest({ messages: [{ role: "user", content: "x" }], model: "no-such-model-xyz" }, { allowLocalSources: true })).rejects.toMatchObject({ status: 404 });
    await expect(predictFromRequest({ messages: [{ role: "user", content: "x" }], model: "haiku" }, { allowLocalSources: true })).rejects.toMatchObject({ status: 400 });
  });
  test("an empty conversation is a 400", async () => {
    await expect(predictFromRequest({ messages: [{ role: "system", content: "s" }] }, { allowLocalSources: true })).rejects.toMatchObject({ status: 400 });
  });
});
