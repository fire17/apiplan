// Realtime ("live") models and images, 2026-09-29.
//   · gpt-realtime and gpt-realtime-2.1 answered an input_image turn correctly ("MARK 3") on
//     wss://api.openai.com/v1/realtime with the Codex OAuth token (scratchpad gpt6/vision-rt-probe.txt).
//   · GPT-6 models are Responses models: the realtime endpoint refuses them with invalid_model
//     ("Model \"gpt-6-luna\" is not supported in realtime mode."), so they must not fall through to the
//     "custom Realtime id" path, which would open a socket and fail after the handshake.
import { describe, expect, test } from "bun:test";
import { LIVE_MODELS, resolveLiveModel, requireLiveCapability } from "../src/live-models.ts";

describe("vision capability — true only where a live image turn was answered", () => {
  test("gpt-realtime and gpt-realtime-2.1 see; nothing else claims it", () => {
    const seeing = LIVE_MODELS.filter((m) => m.capabilities.vision).map((m) => m.id);
    expect(seeing).toEqual(["gpt-realtime", "gpt-realtime-2.1"]);
    for (const m of LIVE_MODELS) expect(typeof m.capabilities.vision).toBe("boolean");
    expect(resolveLiveModel("gpt-realtime").evidence).toContain("vision proven 2026-09-29");
  });
  test("a custom realtime id claims no vision", () => {
    expect(resolveLiveModel("my-rt-model").capabilities.vision).toBe(false);
  });
  test("requireLiveCapability refuses vision where it is unproven", () => {
    expect(() => requireLiveCapability(resolveLiveModel("realtime-mini"), "vision")).toThrow("does not support vision");
    requireLiveCapability(resolveLiveModel("realtime"), "vision");
  });
});

describe("GPT-6 is not a realtime model", () => {
  test.each(["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-5.6-terra"])("%s is refused before any socket opens", (id) => {
    expect(() => resolveLiveModel(id)).toThrow(/Responses model, not a Realtime one/);
  });
  test("realtime ids still resolve", () => {
    expect(resolveLiveModel("gpt-realtime-2.1").id).toBe("gpt-realtime-2.1");
    expect(resolveLiveModel("gpt-realtime-2.1-mini").transport).toBe("realtime-websocket");
  });
});
