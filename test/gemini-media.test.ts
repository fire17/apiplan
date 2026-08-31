import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { discoverGeminiMedia, generateGeminiMusic, generateGeminiSpeech, generateGeminiVideo } from "../src/gemini-media.ts";

const realFetch = globalThis.fetch;
const oldKey = process.env.APIPLAN_GEMINI_API_KEY;

beforeAll(() => { process.env.APIPLAN_GEMINI_API_KEY = "test-key-never-sent"; });
afterAll(() => {
  globalThis.fetch = realFetch;
  if (oldKey === undefined) delete process.env.APIPLAN_GEMINI_API_KEY;
  else process.env.APIPLAN_GEMINI_API_KEY = oldKey;
});

describe("Gemini public media endpoints", () => {
  test("Lyria audio is decoded from inlineData", async () => {
    globalThis.fetch = (async (_url: any, init: any) => {
      expect(init.headers["x-goog-api-key"]).toBe("test-key-never-sent");
      const body = JSON.parse(init.body);
      expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/mpeg", data: "aGk=" } }] } }] });
    }) as any;
    const r = await generateGeminiMusic("a tiny song");
    expect(new TextDecoder().decode(r.bytes)).toBe("hi");
    expect(r.contentType).toBe("audio/mpeg");
  });

  test("Gemini TTS wraps returned PCM16 in a playable WAV", async () => {
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
      expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: {
        mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAECAw==",
      } }] } }] });
    }) as any;
    const r = await generateGeminiSpeech("hello");
    expect(r.contentType).toBe("audio/wav");
    expect(new TextDecoder().decode(r.bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(r.bytes.slice(8, 12))).toBe("WAVE");
    expect([...r.bytes.slice(44)]).toEqual([0, 1, 2, 3]);
  });

  test("Veo starts, polls, and downloads one long-running result", async () => {
    let calls = 0;
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls++;
      const s = String(url);
      if (s.includes(":predictLongRunning")) {
        const body = JSON.parse(init.body);
        expect(body.parameters).toMatchObject({ sampleCount: 1, durationSeconds: 4, aspectRatio: "16:9" });
        return Response.json({ name: "models/veo/operations/123", done: false });
      }
      if (s.includes("models/veo/operations/123")) return Response.json({
        done: true,
        response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://download.test/video" } }] } },
      });
      if (s.includes("download.test")) return new Response(new Uint8Array([0, 1, 2]), { headers: { "content-type": "video/mp4" } });
      throw new Error(`unexpected URL ${s}`);
    }) as any;
    const r = await generateGeminiVideo("a circle", { duration: 4, aspectRatio: "16:9", pollMs: 1 });
    expect(calls).toBe(3);
    expect([...r.bytes]).toEqual([0, 1, 2]);
    expect(r.contentType).toBe("video/mp4");
  });

  test("catalog discovery distinguishes image, video, music, and speech", async () => {
    globalThis.fetch = (async () => Response.json({ models: [
      { name: "models/gemini-image", supportedGenerationMethods: ["generateContent"] },
      { name: "models/veo-3", supportedGenerationMethods: ["predictLongRunning"] },
      { name: "models/lyria-3", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-tts-preview", supportedGenerationMethods: ["generateContent"] },
    ] })) as any;
    const rows = await discoverGeminiMedia();
    expect(rows.map((r) => r.kind)).toEqual(["image", "video", "music", "speech"]);
  });
});
