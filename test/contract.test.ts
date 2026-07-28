// The wire contract. These run with no network and no credentials, so they are the
// guard against silently degrading a request shape (the class of bug that made
// `-e high` a 400 on Opus 4.8 before it was caught).
import { expect, test, describe } from "bun:test";
import { anthropic, openai } from "../src/providers.ts";
import { resolve } from "../src/registry.ts";
import { parseArgs } from "../src/engine.ts";

const CREDS = { token: "T", account: "ACC", source: "test" };
const M = (n: string) => resolve(n)!;
const build = (name: string, opts: any = {}, turns: any = [{ role: "user", text: "hi" }]) => {
  const m = M(name);
  return (m.provider === "anthropic" ? anthropic : openai).build(m, turns, opts, CREDS);
};

describe("anthropic request", () => {
  test("subscription requires the Claude Code identity as system[0]", () => {
    const b = build("opus");
    expect(b.body.system[0].text).toContain("You are Claude Code");
    expect(b.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(b.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });
  test("the user's system prompt is appended, never replacing the identity", () => {
    const b = build("opus", { system: "be terse" });
    expect(b.body.system.length).toBe(2);
    expect(b.body.system[0].text).toContain("Claude Code");
    expect(b.body.system[1].text).toBe("be terse");
  });
  test("current models use output_config.effort + adaptive thinking, never budget_tokens", () => {
    for (const n of ["opus", "opus5", "opus48", "sonnet", "fable"]) {
      const b = build(n, { effort: "high" });
      expect(b.body.output_config).toEqual({ effort: "high" });
      expect(b.body.thinking).toEqual({ type: "adaptive" });
      expect(b.body.thinking.budget_tokens).toBeUndefined();
      expect(b.body.temperature).toBeUndefined();
    }
  });
  test("legacy models still use budget_tokens", () => {
    const b = build("haiku", { effort: "high" });
    expect(b.body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(b.body.output_config).toBeUndefined();
  });
  test("high effort raises max_tokens so answers are not truncated", () => {
    expect(build("opus", { effort: "low" }).body.max_tokens).toBe(8192);
    expect(build("opus", { effort: "xhigh" }).body.max_tokens).toBe(32000);
    expect(build("opus", { effort: "xhigh", maxTokens: 999 }).body.max_tokens).toBe(999);
  });
  test("thinking can be turned off explicitly", () => {
    expect(build("opus", { thinkOff: true }).body.thinking).toEqual({ type: "disabled" });
  });
  test("fast mode sets both the beta and the speed field", () => {
    const b = build("opus48", { fast: true });
    expect(b.headers["anthropic-beta"]).toContain("fast-mode-2026-02-01");
    expect(b.body.speed).toBe("fast");
  });
  test("images become base64 or url source blocks", () => {
    const b = build("opus", {}, [{ role: "user", text: "what", images: [{ mediaType: "image/png", base64: "AAA" }, { url: "https://x/y.png" }] }]);
    const c = b.body.messages[0].content;
    expect(c.map((x: any) => x.type)).toEqual(["text", "image", "image"]);
    expect(c[1].source.type).toBe("base64");
    expect(c[2].source).toEqual({ type: "url", url: "https://x/y.png" });
  });
});

describe("openai request", () => {
  test("hits the codex responses endpoint with subscription headers", () => {
    const b = build("sol");
    expect(b.url).toContain("/backend-api/codex/responses");
    expect(b.headers.originator).toBe("codex_cli_rs");
    expect(b.headers["chatgpt-account-id"]).toBe("ACC");
    expect(b.body.store).toBe(false);      // don't pollute the user's Codex history
  });
  test("effort maps to reasoning.effort", () => {
    expect(build("sol", { effort: "high" }).body.reasoning).toEqual({ effort: "high" });
  });
  test("roles map to the Responses content types", () => {
    const b = build("sol", {}, [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c" }]);
    expect(b.body.input.map((i: any) => i.content[0].type)).toEqual(["input_text", "output_text", "input_text"]);
  });
  test("images become input_image data URIs", () => {
    const b = build("sol", {}, [{ role: "user", text: "x", images: [{ mediaType: "image/png", base64: "AAA" }] }]);
    const c = b.body.input[0].content;
    expect(c[1].type).toBe("input_image");
    expect(c[1].image_url).toBe("data:image/png;base64,AAA");
  });
});

describe("stream event mapping", () => {
  test("anthropic text, thinking, served model and errors", () => {
    expect(anthropic.delta({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })).toEqual({ text: "hi" });
    expect(anthropic.delta({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hm" } })).toEqual({ reasoning: "hm" });
    expect(anthropic.delta({ type: "message_start", message: { model: "claude-opus-5" } })).toEqual({ served: "claude-opus-5" });
    expect(anthropic.delta({ type: "error", error: { message: "boom" } })).toEqual({ error: "boom" });
    expect(anthropic.delta({ type: "ping" })).toEqual({});
  });
  test("openai text, reasoning, served model and failures", () => {
    expect(openai.delta({ type: "response.output_text.delta", delta: "hi" })).toEqual({ text: "hi" });
    expect(openai.delta({ type: "response.created", response: { model: "gpt-5.6-sol" } })).toEqual({ served: "gpt-5.6-sol" });
    expect(openai.delta({ type: "response.reasoning_summary_text.delta", delta: "th" })).toEqual({ reasoning: "th" });
    expect(openai.delta({ type: "response.failed", response: { error: { message: "no" } } })).toEqual({ error: "no" });
  });
});

describe("argv: a bare sentence is the prompt", () => {
  test("unquoted words become the prompt, flags do not leak into it", () => {
    const o = parseArgs(["-m", "opus", "-e", "high", "explain", "monads", "in", "one", "sentence"]);
    expect(o.model).toBe("opus");
    expect(o.effort).toBe("high");
    expect(o.prompt.join(" ")).toBe("explain monads in one sentence");
  });
  test("-- makes everything after it literal, even flag-looking words", () => {
    const o = parseArgs(["--", "--not-a-flag", "-e", "text"]);
    expect(o.prompt).toEqual(["--not-a-flag", "-e", "text"]);
    expect(o.effort).toBeUndefined();
  });
  test("--flag=value form works", () => {
    expect(parseArgs(["--effort=xhigh"]).effort).toBe("xhigh");
    expect(parseArgs(["--model=opus48"]).model).toBe("opus48");
  });
  test("repeatable --image, and --thinking off implies thinking disabled", () => {
    const o = parseArgs(["-i", "a.png", "--image", "b.png", "--thinking", "off"]);
    expect(o.images).toEqual(["a.png", "b.png"]);
    expect(o.thinkOff).toBe(true);
  });
  test("punctuation inside a bare prompt survives parsing", () => {
    const o = parseArgs(["is", "this", "right?", "50%", "sure*"]);
    expect(o.prompt.join(" ")).toBe("is this right? 50% sure*");
  });
});
