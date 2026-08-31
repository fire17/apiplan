// The wire contract. These run with no network and no credentials, so they are the
// guard against silently degrading a request shape (the class of bug that made
// `-e high` a 400 on Opus 4.8 before it was caught).
import { expect, test, describe } from "bun:test";
import { anthropic, openai, google, buildGoogleImageRequest, parseGoogleImageResponse } from "../src/providers.ts";
import { resolve } from "../src/registry.ts";
import { parseArgs } from "../src/engine.ts";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

// fileURLToPath, never url.pathname: on Windows the latter yields "/D:/a/…", which is
// not a path any OS can open. CI on windows-latest caught exactly that.
const readSource = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", name), "utf8");

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
  test("native message blocks retain Anthropic cache controls", () => {
    const content = [{ type: "text", text: "stable prefix", cache_control: { type: "ephemeral" } }];
    const b = build("opus", {}, [{ role: "user", text: "stable prefix", nativeAnthropicContent: content }]);
    expect(b.body.messages[0].content).toEqual(content);
  });
  test("preserves Anthropic session metadata for upstream affinity", () => {
    const b = build("opus", { promptCacheKey: '{"session_id":"stable"}' });
    expect(b.body.metadata).toEqual({ user_id: '{"session_id":"stable"}' });
  });
  test("preserves system cache controls independently from message controls", () => {
    const systemBlocks = [{ type: "text", text: "stable system", cache_control: { type: "ephemeral" } }];
    const messageBlocks = [{ type: "text", text: "stable message", cache_control: { type: "ephemeral" } }];
    const b = build("opus", { system: "stable system", systemBlocks }, [
      { role: "user", text: "stable message", nativeAnthropicContent: messageBlocks },
    ]);
    expect(b.body.system.slice(1)).toEqual(systemBlocks);
    expect(b.body.messages[0].content).toEqual(messageBlocks);
  });
  test("direct provider calls preserve every native system block", () => {
    const billing = { type: "text", text: "x-anthropic-billing-header: caller-owned" };
    const stable = { type: "text", text: "stable system", cache_control: { type: "ephemeral" } };
    const blocks = [billing, stable];
    const b = build("opus", { systemBlocks: blocks });
    expect(b.body.system.slice(1)).toEqual(blocks);
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
  test("forwards a stable prompt cache identity to Codex payload and routing", () => {
    const b = build("sol", { promptCacheKey: "pc_session-stable" });
    expect(b.body.prompt_cache_key).toBe("pc_session-stable");
    expect(b.headers.session_id).toBe("pc_session-stable");
  });
  test("effort maps to reasoning.effort", () => {
    expect(build("sol", { effort: "high" }).body.reasoning).toEqual({ effort: "high" });
  });
  test("reports Codex cached input tokens", () => {
    const d = openai.delta({
      type: "response.completed",
      response: { usage: { input_tokens: 5000, output_tokens: 5, input_tokens_details: { cached_tokens: 4096, cache_write_tokens: 0 } } },
    });
    expect(d.usage).toEqual({ input: 5000, output: 5, cacheRead: 4096, cacheWrite: 0 });
  });
  test("reports explicit zero Codex cache counters", () => {
    const d = openai.delta({
      type: "response.completed",
      response: { usage: { input_tokens: 5000, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } },
    });
    expect(d.usage).toEqual({ input: 5000, output: 5, cacheRead: 0, cacheWrite: 0 });
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

describe("cached route is the permanent server standard", () => {
  const cli = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "apiplan.ts"), "utf8");
  test("has no canary or legacy cache policy escape hatch", () => {
    expect(cli).not.toContain("--cache-canary");
    expect(cli).not.toContain("APIPLAN_CACHE_POLICY");
    expect(cli).toContain('hotswap <status|upgrade>');
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
  test("--raw pins the prompt: the model is told to copy it, not improve it", () => {
    const b = build("sol", { genImage: true, rawPrompt: true });
    expect(b.body.instructions).toContain("character for character");
    expect(b.body.instructions).toContain("do not rewrite");
    expect(b.body.input[0].content[0].text).toBe("hi");
  });
  test("--raw keeps the user's system prompt, it does not replace it", () => {
    const b = build("sol", { genImage: true, rawPrompt: true, system: "be terse" });
    expect(b.body.instructions.startsWith("be terse")).toBe(true);
    expect(b.body.instructions).toContain("character for character");
  });
  test("enhancing stays the default — no pass-through instruction unless asked", () => {
    expect(build("sol", { genImage: true }).body.instructions).toBe("");
  });
  test("--raw and --enhance are opposites, and both imply drawing", () => {
    expect(parseArgs(["--raw", "a cat"]).rawPrompt).toBe(true);
    expect(parseArgs(["--raw", "a cat"]).genImage).toBe(true);
    expect(parseArgs(["--enhance", "a cat"]).rawPrompt).toBe(false);
    expect(parseArgs(["--draw", "a cat"]).rawPrompt).toBeUndefined();
  });
  test("no tool is added unless asked", () => {
    expect(build("sol").body.tools).toBeUndefined();
  });
  test("only providers with proven image endpoints advertise drawing", () => {
    expect(openai.canGenerateImages).toBe(true);
    expect(google.canGenerateImages).toBe(true);
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
    const src = readSource("providers.ts");
    const fn = src.slice(src.indexOf("async readAloud"), src.indexOf("async aloudVoices"));
    expect(fn).not.toContain("throw new Error(\n");   // no consent gate left in the path
    expect(parseArgs(["--last"]).last).toBe(true);      // still accepted, just not required
  });
  test("read-aloud is the only thing in apiplan that reads stored history", () => {
    const eng = readSource("engine.ts");
    const src = readSource("providers.ts");
    expect(eng).not.toContain("/backend-api/conversations");
    expect(src.split("/backend-api/conversation").length - 1).toBeLessThanOrEqual(3);
  });
  test("plain --speak stays free-text, not read-aloud", () => {
    expect(parseArgs(["--speak", "hello"]).aloud).toBe(false);
  });
  test("the two voice sets are kept apart — product voices are asked for live", () => {
    // ChatGPT's read-aloud voices (cove, maple, …) are not the API's (alloy, nova, …);
    // hardcoding either list into the other is the bug this guards.
    const src = readSource("providers.ts");
    expect(src).toContain("/backend-api/settings/voices");
    expect(openai.voices).not.toContain("cove");
  });
  test("read-aloud goes to the ChatGPT synthesize route, no API key in sight", () => {
    const src = readSource("providers.ts");
    const fn = src.slice(src.indexOf("async readAloud"), src.indexOf("async aloudVoices"));
    expect(fn).toContain("/backend-api/synthesize?conversation_id=");
    expect(fn).toContain("message_id=");
    expect(fn).not.toContain("process.env.OPENAI_API_KEY");   // mentions it as advice, never reads one
  });
});

describe("speech from fresh text runs on the subscription", () => {
  test("the realtime voice list is the server's, and is not the read-aloud set", () => {
    const { REALTIME_VOICES } = require("../src/providers.ts");
    expect(REALTIME_VOICES).toContain("cedar");
    expect(REALTIME_VOICES).toContain("alloy");
    expect(REALTIME_VOICES).not.toContain("cove");     // that one is read-aloud only
    expect(openai.voices).toEqual(REALTIME_VOICES);
  });
  test("it speaks over the realtime socket with no API key and no beta header", () => {
    const src = readSource("providers.ts");
    // The socket itself is opened by openRealtime(); speakRealtime is the turn on top of it.
    // Both halves are checked, so a refactor that moves the URL cannot move it out of view.
    const dial = src.slice(src.indexOf("export function openRealtime"), src.indexOf("export function speakRealtime"));
    const at = src.indexOf("export function speakRealtime");
    // to the function's own closing brace (column 0), never to end-of-file: the rest of
    // providers.ts legitimately NAMES the env var it refuses to read.
    const fn = src.slice(at, src.indexOf("\n}\n", at) + 3);
    expect(dial).toContain("wss://api.openai.com/v1/realtime");
    for (const half of [dial, fn]) {
      expect(half).not.toContain('"OpenAI-Beta"');      // the beta shape is retired: it closes 4000
      expect(half).not.toContain("OPENAI_API_KEY");
    }
    expect(fn).toContain("output_modalities");
  });
  test("PCM16 is wrapped in a real 44-byte wav header", async () => {
    const { speakRealtime } = require("../src/providers.ts");
    expect(typeof speakRealtime).toBe("function");
    const src = readSource("providers.ts");
    expect(src).toContain('h.write("RIFF", 0)');
    expect(src).toContain("h.writeUInt32LE(rate * 2, 28)");   // byte rate, mono 16-bit
  });
  test("anthropic still offers no speech of its own", () => {
    expect(anthropic.speak).toBeUndefined();
  });
  test("no local server is ever auto-detected — only an explicit APIPLAN_TTS_BASE", () => {
    const src = readSource("providers.ts");
    expect(src).not.toContain("findLocalSpeechServer");
    expect(src).not.toMatch(/127\.0\.0\.1:88\d\d/);
  });
});

describe("performance direction — how it is said, separate from what is said", () => {
  test("--as and its synonyms all land in one field, and imply speech", () => {
    for (const flag of ["--as", "--style", "--emotion", "--direction"]) {
      const o = parseArgs([flag, "excited, laughing", "hello", "there"]);
      expect(o.direction).toBe("excited, laughing");
      expect(o.speak).toBe(true);
      expect(o.prompt.join(" ")).toBe("hello there");   // the direction must not leak into the words
    }
  });
  test("without a direction the instruction stays strictly verbatim", () => {
    const src = readSource("providers.ts");
    const fn = src.slice(src.indexOf("function perform("), src.indexOf("* Speak text through"));
    expect(fn).toContain("verbatim");
    expect(fn).toContain("Direction:");
    // the words are pinned in the same breath as the direction, or the model ad-libs
    expect(fn).toContain("nothing else");
  });
  test("a direction tells the model to perform, never to narrate the direction", () => {
    const src = readSource("providers.ts");
    const fn = src.slice(src.indexOf("function perform("), src.indexOf("* Speak text through"));
    expect(fn).toMatch(/never announce or describe/i);
    expect(fn).toMatch(/bracketed stage directions/i);
  });
  test("the direction reaches speak() rather than being dropped in the engine", () => {
    const eng = readSource("engine.ts");
    expect(eng).toContain("direction: o.direction");
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
  test("repeatable Gemini media files stay separate from image-only input", () => {
    const o = parseArgs(["-f", "clip.mp4", "--file", "notes.pdf", "--media", "audio.mp3"]);
    expect(o.files).toEqual(["clip.mp4", "notes.pdf", "audio.mp3"]);
    expect(o.images).toEqual([]);
  });
  test("video and song jobs parse without leaking their flags into the prompt", () => {
    const video = parseArgs(["--video", "--duration", "4", "--size", "16:9", "a", "circle"]);
    expect(video.genVideo).toBe(true);
    expect(video.duration).toBe(4);
    expect(video.imageSize).toBe("16:9");
    expect(video.prompt).toEqual(["a", "circle"]);
    expect(parseArgs(["--song", "a", "jingle"]).genSong).toBe(true);
  });
  test("punctuation inside a bare prompt survives parsing", () => {
    const o = parseArgs(["is", "this", "right?", "50%", "sure*"]);
    expect(o.prompt.join(" ")).toBe("is this right? 50% sure*");
  });
});

describe("google media contract", () => {
  const m: any = { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", provider: "google", efforts: ["low", "medium", "high"] };

  test("low, medium, and high become the exact AGY wire ids", () => {
    for (const effort of ["low", "medium", "high"]) {
      expect(google.build(m, [{ role: "user", text: "hi" }], { effort }, CREDS).body.model).toBe(`gemini-3.7-flash-${effort}`);
    }
  });

  test("PDF/audio/video-style media is sent as Gemini inlineData with its MIME type", () => {
    const b = google.build(m, [{ role: "user", text: "inspect", images: [{ mediaType: "application/pdf", base64: "AAAA" }] }], { effort: "low" }, CREDS);
    expect(b.body.request.contents[0].parts).toEqual([
      { text: "inspect" },
      { inlineData: { mimeType: "application/pdf", data: "AAAA" } },
    ]);
  });

  test("image generation matches AGY's dedicated request and response wrappers", () => {
    const b = buildGoogleImageRequest("a blue cube", { imageSize: "16:9" }, "gemini-3.1-flash-image");
    expect(b.model).toBe("gemini-3.1-flash-image");
    expect(b.requestType).toBe("image_gen");
    expect(b.userAgent).toBe("antigravity");
    expect(b.request.generationConfig.imageConfig.aspectRatio).toBe("16:9");
    expect(b.request.contents[0].parts[0].text).toBe("a blue cube");
    expect(parseGoogleImageResponse({ response: { modelVersion: "gemini-3.1-flash-image", candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "AAAA" } }] } }] } }, "fallback"))
      .toEqual({ base64: "AAAA", contentType: "image/jpeg", model: "gemini-3.1-flash-image" });
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
  test("read-aloud is a flag on tts, not a command of its own", () => {
    const C = require("../src/commands.ts");
    expect(C.defaults().find((c: any) => c.name === "aloud")).toBeUndefined();
    const tts = C.defaults().find((c: any) => c.name === "tts");
    if (tts) expect(tts.flags).toEqual(["--speak", "--play"]);
    expect(parseArgs(["--aloud"]).aloud).toBe(true);       // the flag still works
  });
  test("the OS voice follows the script the text is written in", () => {
    const { localVoiceFor } = require("../src/platform.ts");
    const v = localVoiceFor("שלום עולם");
    // Only assert on a machine that actually has the Hebrew voice installed.
    if (v !== null) expect(v).toBe("Carmit");
    expect(localVoiceFor("plain english")).toBe(null);   // system default is right
  });
});

// F6-2 (2026-08-27, canon 164 — "no manual steps"): the Antigravity token lives ~1h and used
// to be refreshed ONLY by a human running `agy`, later by a 600 s launchd heartbeat — so an
// expiry could leave gemini dead for up to ten minutes. google.creds() now refreshes itself
// from the stored refresh_token inside a 5-minute window of expiry and writes the minted
// token back to the same well. These lock the shape; the behaviour was proven live by
// rewinding the stored expiry and watching one call mint a new token inline.
describe("the google credential refreshes itself", () => {
  const s = readSource("providers.ts");
  const creds = s.slice(s.indexOf("export const google:"), s.indexOf("efforts: (m) => m.efforts ?? GOOGLE_EFFORTS"));

  test("creds() refreshes inside the expiry window instead of throwing `run agy`", () => {
    expect(creds).toContain("expiresAt - Date.now() < GOOGLE_REFRESH_WINDOW_MS()");
    expect(creds).toContain("const fresh = refreshGoogle(r)");
    // the stale/throw guard survives the refresh: a refresh that cannot run must never make
    // a healthy token worse, so the old boundary check still stands behind it
    expect(creds).toContain("GOOGLE_STALE_GRACE_MS() < Date.now()");
  });

  test("a refresh writes the minted token back to the SAME well the read came from", () => {
    expect(s).toContain("function writeGoogleBlob(");
    expect(s).toContain('env("APIPLAN_GOOGLE_CRED_FILE", "")');
    expect(s).toContain("add-generic-password");
    expect(s).toContain("writeGoogleBlob(blob)");
  });

  test("it cannot run without a refresh_token or an OAuth client — and then it changes nothing", () => {
    // The mint is now built in two pieces — googleRefreshForm() refuses to produce a request
    // at all without both halves of the credential, and the appliers refuse a reply carrying
    // no access_token. The guard follows the code; the promise it guards is unchanged.
    const form = s.slice(s.indexOf("function googleRefreshForm("), s.indexOf("function googleApplyMint("));
    expect(form).toContain("if (!rt) return null;");
    expect(form).toContain("if (!cli) return null;");
    const fn = s.slice(s.indexOf("function googleApplyMint("), s.indexOf("export const google:"));
    expect(fn).toContain("if (!access) return null;");
  });

  test("no secret is ever hard-coded here — the client is env-first, then lifted from agy", () => {
    // Match the ACT (a literal secret VALUE sitting in the file), never the token: the
    // extraction regex necessarily spells the prefix, and a guard that flagged that would be
    // flagging its own enforcement line. A real GOCSPX secret is 28 more chars of [A-Za-z0-9_-];
    // the regex literal breaks that run immediately with a "[".
    expect(/GOCSPX-[A-Za-z0-9_-]{20,}/.test(s)).toBe(false);
    expect(s).toContain('env("APIPLAN_GOOGLE_OAUTH_CLIENT_SECRET", "")');
  });
});
