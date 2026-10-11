// speech-model.test.ts — /v1/audio/speech honours the request's `model` (MIND report 2026-10-11:
// it was ignored, every call ran gpt-realtime and a bogus id answered 200).
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { serve, speechModel } from "../src/api.ts";
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
