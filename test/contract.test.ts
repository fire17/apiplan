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

describe("image generation", () => {
  test("--draw adds the image tool to an OpenAI request", () => {
    const b = build("sol", { genImage: true });
    expect(b.body.tools).toEqual([{ type: "image_generation" }]);
  });
  test("size and quality reach the tool, not the top level", () => {
    const b = build("sol", { genImage: true, imageSize: "1024x1024", imageQuality: "high" });
    expect(b.body.tools[0]).toEqual({ type: "image_generation", size: "1024x1024", quality: "high" });
    expect(b.body.size).toBeUndefined();
  });
  test("no tool is added unless asked", () => {
    expect(build("sol").body.tools).toBeUndefined();
  });
  test("only the provider that can draw advertises it", () => {
    expect(openai.canGenerateImages).toBe(true);
    expect(anthropic.canGenerateImages).toBeUndefined();
  });
  test("the finished image is picked up from every shape the API sends it in", () => {
    expect(openai.delta({ type: "response.image_generation_call.completed", result: "AAAA", revised_prompt: "a red circle" }))
      .toEqual({ imageB64: "AAAA", revisedPrompt: "a red circle" });
    expect(openai.delta({ type: "response.output_item.done", item: { type: "image_generation_call", result: "BBBB" } }))
      .toEqual({ imageB64: "BBBB", revisedPrompt: undefined });
    expect(openai.delta({ type: "response.completed", response: { output: [{ type: "image_generation_call", result: "CCCC" }] } }))
      .toEqual({ imageB64: "CCCC", revisedPrompt: undefined });
  });
  test("drawing progress is reported, not silence", () => {
    expect(openai.delta({ type: "response.image_generation_call.generating" }).progress).toBeTruthy();
  });
});

describe("every generation is fresh — no conversation history is ever reused", () => {
  test("a drawing request carries only this prompt, stores nothing", () => {
    const b = build("sol", { genImage: true }, [{ role: "user", text: "a red circle" }]);
    expect(b.body.store).toBe(false);
    expect(b.body.input.length).toBe(1);
    expect(b.body.input[0].content[0].text).toBe("a red circle");
    expect(b.body.previous_response_id).toBeUndefined();
    expect(b.body.conversation).toBeUndefined();
  });
  test("each call gets its own session id, so calls are never threaded together", () => {
    const a = build("sol", { genImage: true }).headers.session_id;
    const c2 = build("sol", { genImage: true }).headers.session_id;
    expect(a).toBeTruthy();
    expect(a).not.toBe(c2);
  });
});

describe("read-aloud — the speech path the subscription really covers", () => {
  test("only the provider with a ChatGPT account offers it", () => {
    expect(typeof openai.readAloud).toBe("function");
    expect(typeof openai.aloudVoices).toBe("function");
    expect(anthropic.readAloud).toBeUndefined();
  });
  test("--aloud implies speech and needs no prompt", () => {
    const o = parseArgs(["--aloud", "--play"]);
    expect(o.aloud).toBe(true);
    expect(o.speak).toBe(true);
    expect(o.prompt).toEqual([]);
  });
  test("a specific message can be picked, and picking one implies --aloud", () => {
    const o = parseArgs(["--conversation", "c-1", "--message", "m-1", "--voice", "maple"]);
    expect(o.conversation).toBe("c-1");
    expect(o.message).toBe("m-1");
    expect(o.aloud).toBe(true);
    expect(o.prompt).toEqual([]);        // the ids must not leak into the prompt
  });
  test("bare --aloud just works — no second flag to confirm the obvious", () => {
    const src = require("node:fs").readFileSync(new URL("../src/providers.ts", import.meta.url).pathname, "utf8");
    const fn = src.slice(src.indexOf("async readAloud"), src.indexOf("async aloudVoices"));
    expect(fn).not.toContain("throw new Error(\n");   // no consent gate left in the path
    expect(parseArgs(["--last"]).last).toBe(true);      // still accepted, just not required
  });
  test("read-aloud is the only thing in apiplan that reads stored history", () => {
    const eng = require("node:fs").readFileSync(new URL("../src/engine.ts", import.meta.url).pathname, "utf8");
    const src = require("node:fs").readFileSync(new URL("../src/providers.ts", import.meta.url).pathname, "utf8");
    expect(eng).not.toContain("/backend-api/conversations");
    expect(src.split("/backend-api/conversation").length - 1).toBeLessThanOrEqual(3);
  });
  test("plain --speak stays free-text, not read-aloud", () => {
    expect(parseArgs(["--speak", "hello"]).aloud).toBe(false);
  });
  test("the two voice sets are kept apart — product voices are asked for live", () => {
    // ChatGPT's read-aloud voices (cove, maple, …) are not the API's (alloy, nova, …);
    // hardcoding either list into the other is the bug this guards.
    const src = require("node:fs").readFileSync(new URL("../src/providers.ts", import.meta.url).pathname, "utf8");
    expect(src).toContain("/backend-api/settings/voices");
    expect(openai.voices).not.toContain("cove");
  });
  test("read-aloud goes to the ChatGPT synthesize route, no API key in sight", () => {
    const src = require("node:fs").readFileSync(new URL("../src/providers.ts", import.meta.url).pathname, "utf8");
    const fn = src.slice(src.indexOf("async readAloud"), src.indexOf("async aloudVoices"));
    expect(fn).toContain("/backend-api/synthesize?conversation_id=");
    expect(fn).toContain("message_id=");
    expect(fn).not.toContain("process.env.OPENAI_API_KEY");   // mentions it as advice, never reads one
  });
});

describe("speech is OpenAI-only and honest about it", () => {
  test("anthropic offers no speak() at all", () => {
    expect(anthropic.speak).toBeUndefined();
  });
  test("without a key it explains that the subscription does not cover speech", async () => {
    const prev = { a: process.env.OPENAI_API_KEY, b: process.env.APIPLAN_OPENAI_API_KEY, c: process.env.APIPLAN_TTS_BASE };
    delete process.env.OPENAI_API_KEY; delete process.env.APIPLAN_OPENAI_API_KEY; delete process.env.APIPLAN_TTS_BASE;
    try {
      await openai.speak!({ text: "hi", voice: "alloy", format: "mp3" });
      throw new Error("should have refused");
    } catch (e: any) {
      expect(e.message).toContain("does not cover it");
      expect(e.message).toContain("OPENAI_API_KEY");
    } finally {
      if (prev.a) process.env.OPENAI_API_KEY = prev.a;
      if (prev.b) process.env.APIPLAN_OPENAI_API_KEY = prev.b;
      if (prev.c) process.env.APIPLAN_TTS_BASE = prev.c;
    }
  });
  test("no local server is ever auto-detected — only an explicit APIPLAN_TTS_BASE", () => {
    const src = require("node:fs").readFileSync(new URL("../src/providers.ts", import.meta.url).pathname, "utf8");
    expect(src).not.toContain("findLocalSpeechServer");
    expect(src).not.toMatch(/127\.0\.0\.1:88\d\d/);
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

describe("upgrades gain new default commands", () => {
  test("mergeDefaults adds what is missing and leaves the user's own alone", () => {
    const C = require("../src/commands.ts");
    const cfg: any = { version: 1, commands: [{ name: "mine", model: "opus", flags: ["-e", "high"] }] };
    const added = C.mergeDefaults(cfg);
    expect(added.length).toBeGreaterThan(0);
    expect(cfg.commands.find((x: any) => x.name === "mine").flags).toEqual(["-e", "high"]);
    expect(C.mergeDefaults(cfg)).toEqual([]);          // idempotent
  });
  test("a default the user removed is never resurrected", () => {
    const C = require("../src/commands.ts");
    const cfg: any = { version: 1, commands: C.defaults() };
    const victim = cfg.commands.find((x: any) => x.name === "opus-fast");
    if (!victim) return;                                // platform without it
    C.remove(cfg, "opus-fast");
    expect(cfg.removed).toContain("opus-fast");
    expect(C.mergeDefaults(cfg)).not.toContain("opus-fast");
  });
});

describe("making things is seamless", () => {
  test("--open is a flag, and imagine bakes it in", () => {
    expect(parseArgs(["--draw", "--open", "a cat"]).open).toBe(true);
    const C = require("../src/commands.ts");
    const imagine = C.defaults().find((c: any) => c.name === "imagine");
    if (imagine) expect(imagine.flags).toEqual(["--draw", "--open"]);
  });
  test("aloud needs no flag beyond its own name", () => {
    const C = require("../src/commands.ts");
    const aloud = C.defaults().find((c: any) => c.name === "aloud");
    if (aloud) expect(aloud.flags).toEqual(["--aloud", "--play"]);
  });
  test("the OS voice follows the script the text is written in", () => {
    const { localVoiceFor } = require("../src/platform.ts");
    const v = localVoiceFor("שלום עולם");
    // Only assert on a machine that actually has the Hebrew voice installed.
    if (v !== null) expect(v).toBe("Carmit");
    expect(localVoiceFor("plain english")).toBe(null);   // system default is right
  });
});
