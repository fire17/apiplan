// speech-model.test.ts — /v1/audio/speech honours the request's `model` (MIND report 2026-10-11:
// it was ignored, every call ran gpt-realtime and a bogus id answered 200).
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { serve, speechModel, isGeminiTts, geminiVoice } from "../src/api.ts";
import { DEFAULT_LIVE_MODEL } from "../src/live-models.ts";

describe("speechModel — which Realtime model a speech request runs on", () => {
  test("absent, empty and OpenAI's own TTS ids keep the default", () => {
    for (const m of [undefined, null, "", "tts-1", "tts-1-hd", "gpt-4o-mini-tts"]) expect(speechModel(m)).toBe(DEFAULT_LIVE_MODEL);
  });
  test("a catalogued Realtime model is used, by id or alias", () => {
    expect(speechModel("gpt-realtime-2.1")).toBe("gpt-realtime-2.1");
    expect(speechModel("realtime-2.1")).toBe("gpt-realtime-2.1");
    expect(speechModel("gpt-realtime-mini")).toBe("gpt-realtime-mini");
  });
  test("an unknown id is a 404, never a silent substitution", () => {
    expect(() => speechModel("gpt-realtime-9-bogus")).toThrow("no speech model");
    try { speechModel("bogus"); } catch (e: any) { expect(e.status).toBe(404); }
  });
  test("a live model on another transport, or a non-string, is a 400", () => {
    try { speechModel("codex-live"); throw new Error("no throw"); } catch (e: any) { expect(e.status).toBe(400); expect(e.message).toContain("codex-webrtc"); }
    try { speechModel(42); throw new Error("no throw"); } catch (e: any) { expect(e.status).toBe(400); }
  });
});

describe("POST /v1/audio/speech refuses a bad model before any socket opens", () => {
  let s: ReturnType<typeof serve>;
  beforeAll(() => { s = serve({ port: 0, host: "127.0.0.1" }); });
  afterAll(() => s.stop());
  const post = (body: unknown) => fetch(s.url + "/v1/audio/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  test("unknown model → 404 with the realtime list", async () => {
    const r = await post({ input: "hi", model: "gpt-realtime-9-bogus" });
    expect(r.status).toBe(404);
    expect((await r.json() as any).error.message).toContain("gpt-realtime-2.1");
  });
  test("non-realtime live model → 400", async () => {
    expect((await post({ input: "hi", model: "codex-live" })).status).toBe(400);
  });
});

describe("Gemini TTS ids route through the Gemini API key", () => {
  test("the family is recognised; chat and live ids are not", () => {
    for (const id of ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"]) {
      expect(isGeminiTts(id)).toBe(true);
      expect(speechModel(id)).toBe(id);
    }
    for (const id of ["gemini-3.8-flash", "gemini-3.1-flash-live-preview"]) expect(isGeminiTts(id)).toBe(false);
  });
  test("OpenAI voice names fall back to Gemini's default; a Gemini voice passes through", () => {
    expect(geminiVoice("alloy")).toBe("Kore");
    expect(geminiVoice(undefined)).toBe("Kore");
    expect(geminiVoice("Puck")).toBe("Puck");
  });

  let fake: ReturnType<typeof Bun.serve>, s: ReturnType<typeof serve>, seen: any;
  const env = { base: process.env.APIPLAN_GEMINI_API_BASE, key: process.env.APIPLAN_GEMINI_API_KEY };
  beforeAll(() => {
    fake = Bun.serve({ port: 0, async fetch(req) {
      const url = new URL(req.url);
      seen = { path: url.pathname, key: req.headers.get("x-goog-api-key"), body: await req.json() };
      if (url.pathname.includes("no-such")) return Response.json({ error: { code: 404, message: "model not found" } }, { status: 404 });
      const pcm = Buffer.alloc(480).toString("base64");
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm } }] } }] });
    } });
    process.env.APIPLAN_GEMINI_API_BASE = `http://127.0.0.1:${fake.port}`;
    process.env.APIPLAN_GEMINI_API_KEY = "test-key";
    s = serve({ port: 0, host: "127.0.0.1" });
  });
  afterAll(() => {
    s.stop(); fake.stop(true);
    if (env.base === undefined) delete process.env.APIPLAN_GEMINI_API_BASE; else process.env.APIPLAN_GEMINI_API_BASE = env.base;
    if (env.key === undefined) delete process.env.APIPLAN_GEMINI_API_KEY; else process.env.APIPLAN_GEMINI_API_KEY = env.key;
  });
  const post = (body: unknown) => fetch(s.url + "/v1/audio/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  test("a Gemini TTS id answers WAV with x-apiplan-model, the requested id and voice on the wire", async () => {
    const r = await post({ model: "gemini-3.1-flash-tts-preview", input: "hello", voice: "Puck" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-apiplan-model")).toBe("gemini-3.1-flash-tts-preview");
    expect(r.headers.get("content-type")).toBe("audio/wav");
    expect(seen.path).toBe("/v1beta/models/gemini-3.1-flash-tts-preview:generateContent");
    expect(seen.key).toBe("test-key");
    expect(seen.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    expect((await r.arrayBuffer()).byteLength).toBe(44 + 480);
  });
  test("an upstream 404 stays a 404", async () => {
    expect((await post({ model: "gemini-9-no-such-tts", input: "hi" })).status).toBe(404);
  });
});
