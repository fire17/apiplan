// The Bidi transport, tested against a WebSocket stub that replays the frames the LIVE
// server actually sent (probed 2026-09-06, transcripts in .deify/gemini-live/receipt.json)
// — so these assertions are about a measured protocol rather than an imagined one.
import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { BidiSession, bidiEvents, bidiUsage, uncachedInput, socketForm, pcm16Wav, transcribeBidi } from "../src/gemini-live.ts";
import { LIVE_MODELS, resolveLiveModel, realtimeModelId, requireLiveCapability } from "../src/live-models.ts";

const saved = { ...process.env };
let running: Server | null = null;
afterEach(() => {
  running?.stop(true);
  running = null;
  for (const key of ["APIPLAN_GEMINI_WS_BASE", "APIPLAN_GEMINI_API_KEY", "APIPLAN_LIVE_MODEL"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

/** Frames as the live server sent them — usage counters included verbatim. */
const SETUP_COMPLETE = { setupComplete: {} };
const ACTIVITY_START = { serverContent: {}, voiceActivity: { type: "ACTIVITY_START", audioOffset: "0.200s" } };
const INTERIM = { serverContent: { interimInputTranscription: { text: "acknowledged" } } };
const FINAL = { serverContent: { inputTranscription: { text: "Acknowledged. Happy plan Gemini live transport check." } } };
const MODEL_TURN = { serverContent: { modelTurn: { role: "model", parts: [{ text: "hello there" }] } } };
const TURN_DONE = { serverContent: { turnComplete: true } };
const USAGE = { usageMetadata: { promptTokenCount: 3163, responseTokenCount: 41, cachedContentTokenCount: 3155, thoughtsTokenCount: 7, totalTokenCount: 3211 } };
const GO_AWAY = { goAway: { timeLeft: "10s" } };
const RESUMPTION = { sessionResumptionUpdate: { newHandle: "handle-abc", resumable: true } };

/**
 * A stub Bidi server. `script` is replayed on `setup`; anything the client sends
 * afterwards is recorded so the tests can assert on the frames APIPlan PRODUCES, which is
 * the half a live probe cannot check (the real server never echoes them back).
 */
function stub(script: ReadonlyArray<Record<string, unknown>>, opts: { closeAfter?: { code: number; reason: string } } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  // Client frames arrive on the server's own event loop turn, so an assertion written
  // straight after a `send` races it. `awaitFrames` waits for the CONDITION — the frames
  // actually landing — rather than for a guessed duration, so the test is deterministic
  // and costs only as long as the socket really takes.
  let notify: (() => void) | null = null;
  const awaitFrames = async (predicate: (frames: ReadonlyArray<Record<string, unknown>>) => boolean) => {
    while (!predicate(sent)) await new Promise<void>(resolve => { notify = resolve; });
  };
  running = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      paths.push(url.pathname + (url.searchParams.has("key") ? "?key=present" : "?key=MISSING"));
      return server.upgrade(req) ? undefined : new Response("expected websocket", { status: 400 });
    },
    websocket: {
      message(ws: ServerWebSocket<unknown>, raw) {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        sent.push(frame);
        const wake = notify; notify = null; wake?.();
        if (!frame.setup) return;
        for (const out of script) ws.send(JSON.stringify(out));
        if (opts.closeAfter) ws.close(opts.closeAfter.code, opts.closeAfter.reason);
      },
    },
  });
  process.env.APIPLAN_GEMINI_WS_BASE = `ws://127.0.0.1:${running.port}`;
  process.env.APIPLAN_GEMINI_API_KEY = "test-key-not-a-real-secret";
  return { sent, paths, awaitFrames };
}

describe("bidi frame parsing", () => {
  test("reads every server frame shape the live socket produced", () => {
    expect(bidiEvents(SETUP_COMPLETE)).toEqual([{ kind: "ready" }]);
    expect(bidiEvents(ACTIVITY_START)).toEqual([{ kind: "activity", state: "start", offset: "0.200s" }]);
    expect(bidiEvents(INTERIM)).toEqual([{ kind: "transcript", text: "acknowledged", final: false, of: "input" }]);
    expect(bidiEvents(FINAL)[0]).toEqual({ kind: "transcript", text: "Acknowledged. Happy plan Gemini live transport check.", final: true, of: "input" });
    expect(bidiEvents(MODEL_TURN)).toEqual([{ kind: "text", text: "hello there" }]);
    expect(bidiEvents(GO_AWAY)).toEqual([{ kind: "goaway", detail: "10s" }]);
    expect(bidiEvents(RESUMPTION)).toEqual([{ kind: "resumable", handle: "handle-abc" }]);
    // Junk is not an event, and neither is a frame with nothing recognizable in it.
    for (const junk of [null, undefined, "text", 7, {}, { serverContent: {} }]) expect(bidiEvents(junk)).toEqual([]);
  });

  test("turnComplete is an event of its own, and carries usage only when they share a frame", () => {
    expect(bidiEvents(TURN_DONE)).toEqual([{ kind: "turn", usage: undefined }]);
    const both = bidiEvents({ ...TURN_DONE, ...USAGE });
    expect(both.find(e => e.kind === "turn")?.kind).toBe("turn");
    // Usage is published on its own too — a consumer watching only `usage` never misses it.
    expect(both.some(e => e.kind === "usage")).toBe(true);
  });

  test("audio parts arrive as raw PCM bytes, base64 decoded once", () => {
    const pcm = new Uint8Array([0, 1, 0xff, 0x7f]);
    const [event] = bidiEvents({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from(pcm).toString("base64") } }] } } });
    expect(event.kind).toBe("audio");
    if (event.kind === "audio") expect([...event.pcm]).toEqual([...pcm]);
  });

  test("an error delivered as a FRAME is read as an error, never as content", () => {
    // The failure mode this guards: a rejection parsed as a turn looks like success.
    expect(bidiEvents({ error: { message: "quota exhausted" }, serverContent: { modelTurn: { parts: [{ text: "ignored" }] } } }))
      .toEqual([{ kind: "error", error: "quota exhausted" }]);
  });
});

describe("usage mapping", () => {
  test("maps the live counters inclusively and never subtracts twice", () => {
    const usage = bidiUsage(USAGE.usageMetadata);
    expect(usage).toEqual({ input: 3163, output: 48, reasoning: 7, cacheRead: 3155 });
    // INCLUSIVE basis: input is the WHOLE prompt, cacheRead a breakdown of it. The
    // partition is the caller's to compute, and it is exact.
    expect(uncachedInput(usage)).toBe(8);
    // thoughts are OUTSIDE the response counter and billed as output, so they are added
    // in AND reported again as `reasoning` — never summed by a consumer.
    expect(usage!.output).toBe(41 + 7);
    expect(usage!.reasoning!).toBeLessThanOrEqual(usage!.output!);
  });

  test("accepts either route's spelling of the output counter", () => {
    expect(bidiUsage({ promptTokenCount: 10, responseTokenCount: 4 })).toEqual({ input: 10, output: 4 });
    expect(bidiUsage({ promptTokenCount: 10, candidatesTokenCount: 4 })).toEqual({ input: 10, output: 4 });
  });

  test("a missing counter is never a measured zero", () => {
    expect(bidiUsage(undefined)).toBeUndefined();
    expect(bidiUsage({})).toBeUndefined();
    expect(bidiUsage({ trafficType: "ON_DEMAND" })).toBeUndefined();
    expect(uncachedInput(undefined)).toBeUndefined();
    expect(uncachedInput({ output: 3 })).toBeUndefined();
    // No cache counter at all: the whole prompt is fresh, and that is stated, not inferred.
    expect(uncachedInput({ input: 12 })).toBe(12);
    // toolUsePromptTokenCount is deliberately NOT mapped (containment undocumented).
    expect(bidiUsage({ promptTokenCount: 5, toolUsePromptTokenCount: 9 })).toEqual({ input: 5 });
  });
});

describe("session lifecycle", () => {
  test("handshakes, sends the setup keys the SDK's converter defines, and streams events", async () => {
    const { sent, paths, awaitFrames } = stub([SETUP_COMPLETE, ACTIVITY_START, INTERIM, FINAL, TURN_DONE, USAGE, GO_AWAY]);
    const session = new BidiSession({ model: "gemini-key-3.5-transcribe-live", modalities: ["TEXT"], system: "be brief", timeoutMs: 5000 });
    await session.open();

    const setup = sent[0].setup as Record<string, unknown>;
    // The route marker is stripped for the wire — the endpoint 404s an id it does not publish.
    expect(setup.model).toBe("models/gemini-3.5-transcribe-live");
    expect(setup.generationConfig).toEqual({ responseModalities: ["TEXT"] });
    // systemInstruction is a Content, not a bare string.
    expect(setup.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    expect(setup.inputAudioTranscription).toEqual({});
    expect(paths[0]).toBe("/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=present");

    const kinds: string[] = [];
    session.sendText("anything");
    for await (const ev of session.events()) {
      kinds.push(ev.kind);
      if (ev.kind === "goaway") break;
    }
    expect(kinds).toEqual(["activity", "transcript", "transcript", "turn", "usage", "goaway"]);
    expect(session.usageFrames).toEqual([USAGE.usageMetadata]);

    // The client's own turn frame: camelCase, turnComplete explicit. Awaited rather than
    // assumed — the send and the server's receipt of it are separate event-loop turns.
    await awaitFrames(frames => frames.some(f => f.clientContent));
    expect(sent.find(f => f.clientContent)?.clientContent).toEqual({ turns: [{ role: "user", parts: [{ text: "anything" }] }], turnComplete: true });
    session.close();
  });

  test("audio frames carry the mime type and rate the models were probed with", async () => {
    const { sent, awaitFrames } = stub([SETUP_COMPLETE]);
    const session = new BidiSession({ model: "gemini-3.5-transcribe-live", modalities: ["TEXT"], timeoutMs: 5000 });
    await session.open();
    session.sendAudio(new Uint8Array([1, 2, 3, 4]));
    session.sendSilence(10);
    session.endAudio();
    // Wait for the three frames to LAND, not for a duration that might be long enough.
    await awaitFrames(frames => frames.filter(f => f.realtimeInput).length >= 3);

    const audio = sent.filter(f => f.realtimeInput).map(f => f.realtimeInput as Record<string, unknown>);
    const first = audio[0].audio as Record<string, unknown>;
    expect(first.mimeType).toBe("audio/pcm;rate=16000");
    expect([...Buffer.from(String(first.data), "base64")]).toEqual([1, 2, 3, 4]);
    // 10ms of 16kHz mono PCM16 silence is 320 zero bytes — audio TIME, which is what the
    // endpointer settles on.
    expect(Buffer.from(String((audio[1].audio as Record<string, unknown>).data), "base64")).toHaveLength(320);
    expect(audio[2]).toEqual({ audioStreamEnd: true });
    session.close();
  });

  test("never sends cachedContent — the field does not exist and closes the socket 1007", async () => {
    // MEASURED both ways 2026-09-06: a cache cannot be CREATED for a live model (400
    // INVALID_ARGUMENT, "only supports real-time bidirectional streaming via WebSocket
    // … instead of createCachedContent"), and quoting a valid one closes the socket 1007
    // ("Unknown name \"cachedContent\" at 'setup': Cannot find field"). Since the failure
    // kills the connection rather than being ignored, the key must never be emitted —
    // including when a caller passes a stray property through the options object.
    const { sent } = stub([SETUP_COMPLETE]);
    const session = new BidiSession({ model: "gemini-3.5-transcribe-live", modalities: ["TEXT"], timeoutMs: 5000 });
    await session.open();
    const setup = sent[0].setup as Record<string, unknown>;
    expect(setup).not.toHaveProperty("cachedContent");
    expect(JSON.stringify(setup)).not.toContain("cachedContent");
    // The setup keys are exactly the ones the SDK's own converter defines.
    expect(Object.keys(setup).sort()).toEqual(["generationConfig", "inputAudioTranscription", "model"]);
    session.close();
  });

  test("manual activity signalling is what drives a dialogue model, and it is opt-in", async () => {
    // The automatic detector never ended an utterance on the dialogue ids (60s of silence
    // after one ACTIVITY_START), so converseBidi disables it and brackets each turn by
    // hand. The STT model settles fine, so it keeps the automatic detector.
    const { sent, awaitFrames } = stub([SETUP_COMPLETE]);
    const manual = new BidiSession({ model: "gemini-3.1-flash-live-preview", modalities: ["AUDIO"], manualActivity: true, timeoutMs: 5000 });
    await manual.open();
    expect((sent[0].setup as Record<string, unknown>).realtimeInputConfig).toEqual({ automaticActivityDetection: { disabled: true } });
    manual.beginAudio();
    manual.endAudio();
    await awaitFrames(f => f.filter(x => x.realtimeInput).length >= 2);
    const frames = sent.filter(f => f.realtimeInput).map(f => f.realtimeInput);
    expect(frames).toEqual([{ activityStart: {} }, { activityEnd: {} }]);
    manual.close();
  });

  test("a close before setupComplete rejects with the server's own reason", async () => {
    // This is verbatim what the live server answers for a refused modality, and it is the
    // whole diagnosis — so it must reach the caller instead of becoming a timeout.
    stub([], { closeAfter: { code: 1007, reason: "The requested combination of response modalities (TEXT) is not supported by the model. models/gemini-3.1-flash-live-preview" } });
    const session = new BidiSession({ model: "gemini-3.1-flash-live-preview", modalities: ["TEXT"], timeoutMs: 5000 });
    await expect(session.open()).rejects.toThrow("not supported by the model");
  });

  test("the printable form of the endpoint cannot leak the key", async () => {
    stub([SETUP_COMPLETE]);
    expect(socketForm()).toContain("/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent");
    expect(socketForm()).not.toContain("key");
    expect(socketForm()).not.toContain(process.env.APIPLAN_GEMINI_API_KEY!);
  });

  test("an error frame during the session surfaces rather than hanging", async () => {
    stub([SETUP_COMPLETE, { error: { message: "RESOURCE_EXHAUSTED" } }]);
    const session = new BidiSession({ model: "gemini-3.5-transcribe-live", modalities: ["TEXT"], timeoutMs: 5000 });
    await session.open();
    const events: string[] = [];
    for await (const ev of session.events()) { events.push(ev.kind); break; }
    expect(events).toEqual(["error"]);
    session.close();
  });
});

describe("transcription over bidi", () => {
  test("feeds PCM, keeps interims apart from the settled line, and hangs up on the final", async () => {
    const { sent, awaitFrames } = stub([SETUP_COMPLETE, ACTIVITY_START, INTERIM, INTERIM, FINAL, USAGE]);
    const seen: Array<[string, string]> = [];
    const result = await transcribeBidi(new Uint8Array(6_400), {
      model: "gemini-3.5-transcribe-live", timeoutMs: 5000, silenceMs: 100,
      onEvent: (kind, text) => seen.push([kind, text]),
    });
    expect(result.text).toBe("Acknowledged. Happy plan Gemini live transport check.");
    // Interims REPLACE rather than append; keeping them separate is what stops the
    // duplicated-words bug the same law prevents in dictation.ts.
    expect(result.interim).toEqual(["acknowledged", "acknowledged"]);
    expect(result.usage).toEqual({ input: 3163, output: 48, reasoning: 7, cacheRead: 3155 });
    expect(seen.filter(([k]) => k === "settle")).toHaveLength(1);
    // 6400 bytes at a 3200-byte frame = 2 audio frames, then silence, then the end marker.
    await awaitFrames(frames => frames.filter(f => f.realtimeInput).length >= 4);
    const realtime = sent.filter(f => f.realtimeInput);
    expect(realtime).toHaveLength(4);
    expect(realtime[3].realtimeInput).toEqual({ audioStreamEnd: true });
  });
});

describe("transport dispatch", () => {
  test("every gemini-bidi id resolves to the bidi transport under id and alias", () => {
    const ids = ["gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025", "gemini-3.5-live-translate-preview", "gemini-3.5-transcribe-live"];
    expect(LIVE_MODELS.filter(m => m.transport === "gemini-bidi").map(m => m.id).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const model = resolveLiveModel(id);
      expect(model.transport).toBe("gemini-bidi");
      for (const alias of model.aliases) expect(resolveLiveModel(alias).id).toBe(id);
      // A Gemini id must never open an OpenAI socket, and the refusal must name the
      // ACTUAL transport rather than sending the reader to codex-live.
      expect(() => realtimeModelId(id)).toThrow("BidiGenerateContent");
    }
  });

  test("capabilities are exactly what was proven live, per model", () => {
    // PROVEN: audio in, transcription out, live 2026-09-06 (1.7s to the final line).
    const stt = resolveLiveModel("gemini-transcribe-live");
    expect(stt.capabilities.dictation).toBe(true);
    requireLiveCapability(stt, "dictation");
    // NOT proven, so not claimed: an STT model refuses ['AUDIO'] outright (1007) and is
    // not a conversational model, so it can neither talk nor be parked.
    for (const capability of ["talk", "speechPlayback", "audioFile", "functionTools", "park"] as const) {
      expect(stt.capabilities[capability]).toBe(false);
      expect(() => requireLiveCapability(stt, capability)).toThrow("does not support");
    }

    // PROVEN: three spoken turns with real 24kHz PCM back, via manual activity signalling.
    const dialogue = resolveLiveModel("gemini-live");
    for (const capability of ["talk", "speechPlayback", "audioFile"] as const) {
      expect(dialogue.capabilities[capability]).toBe(true);
      requireLiveCapability(dialogue, capability);
    }
    // A dialogue model is not a transcriber, `setup.tools` was never exercised, and the
    // warm daemon's parked socket is an OpenAI session — none of the three is claimed.
    for (const capability of ["dictation", "functionTools", "park"] as const) {
      expect(dialogue.capabilities[capability]).toBe(false);
    }
    expect(dialogue.evidence).toContain("1007");

    // translate-live accepted a TEXT setup but answered NOTHING to a text turn, and its
    // audio path was never driven — so it stays entirely unclaimed.
    const translate = resolveLiveModel("gemini-translate-live");
    expect(Object.values(translate.capabilities).every(v => v === false)).toBe(true);
    expect(translate.evidence).toContain("answered NOTHING");
  });
});

test("pcm16 wav header describes the payload it wraps", () => {
  const wav = pcm16Wav(new Uint8Array(480), 24_000);
  expect(wav).toHaveLength(44 + 480);
  const view = Buffer.from(wav);
  expect(view.toString("ascii", 0, 4)).toBe("RIFF");
  expect(view.toString("ascii", 8, 12)).toBe("WAVE");
  expect(view.readUInt32LE(24)).toBe(24_000);
  expect(view.readUInt32LE(40)).toBe(480);
});
