import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { LIVE_MODELS, DEFAULT_LIVE_MODEL, resolveLiveModel, selectedLiveModel, realtimeModelId, requireLiveCapability, CODEX_LIVE_URL, liveModelArgument } from "../src/live-models.ts";
import { CodexLiveConnection, parseTrackedAccess, speakCodexLive, type LiveNatives, type NativePeer } from "../src/codex-live.ts";
import { parseArgs, runSpeech } from "../src/engine.ts";
import { openai, openRealtime } from "../src/providers.ts";
import { handleTalk, parkStatus, armPark } from "../src/talk-daemon.ts";
import { resolve } from "../src/registry.ts";

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of ["APIPLAN_LIVE_MODEL", "APIPLAN_REALTIME_MODEL", "APIPLAN_TTS_BASE", "OPENAI_API_KEY", "APIPLAN_TALK_PARK"]) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});

describe("live model selection", () => {
  test("preserves default and precedence without persisting changes", () => {
    expect(DEFAULT_LIVE_MODEL).toBe("gpt-realtime");
    expect(selectedLiveModel(undefined, {})).toBe("gpt-realtime");
    const env = { APIPLAN_REALTIME_MODEL: "legacy", APIPLAN_LIVE_MODEL: "new" };
    expect(selectedLiveModel("explicit", env)).toBe("explicit");
    expect(selectedLiveModel(undefined, env)).toBe("new");
    expect(selectedLiveModel(undefined, { APIPLAN_REALTIME_MODEL: "legacy" })).toBe("legacy");
    expect(env).toEqual({ APIPLAN_REALTIME_MODEL: "legacy", APIPLAN_LIVE_MODEL: "new" });
  });
  test("keeps documented mini variants separate and supports custom Realtime IDs", () => {
    expect(resolveLiveModel("realtime-mini").id).toBe("gpt-realtime-mini");
    expect(resolveLiveModel("realtime-2.1-mini").id).toBe("gpt-realtime-2.1-mini");
    expect(resolveLiveModel("custom-realtime-2026").evidence).toContain("unverified");
    expect(LIVE_MODELS.find(m => m.id === "gpt-realtime-2.1-mini")?.evidence).toContain("not been tested");
  });
  test("does not put live models on a Realtime socket", () => {
    expect(() => realtimeModelId("codex-live")).toThrow("WebRTC");
    expect(() => openRealtime("unused", "gpt-live-1-codex")).toThrow("WebRTC");
    expect(() => resolveLiveModel("gpt-live-unknown")).toThrow("Unknown live transport");
    const live = resolveLiveModel("codex-live");
    for (const capability of ["audioFile", "dictation", "functionTools", "park"] as const) {
      expect(() => requireLiveCapability(live, capability)).toThrow();
    }
  });
  test("voice flags do not change the text model or leak into its prompt", () => {
    for (const args of [["--live-model", "codex-live"], ["--realtime-model", "realtime-mini"], ["--live-model=custom-realtime"]]) {
      const o = parseArgs(["-m", "sol", "--speak", ...args, "hello"]);
      expect(o.model).toBe("sol"); expect(o.liveModel).toBeTruthy(); expect(o.prompt).toEqual(["hello"]);
    }
    expect(() => parseArgs(["--live-model"])).toThrow("needs a model");
    expect(() => parseArgs(["--live-model", "--play"])).toThrow("needs a model");
    expect(liveModelArgument(["talk", "--live-model=codex-live"])).toBe("codex-live");
    expect(liveModelArgument(["talk", "--model", "realtime-mini"])).toBe("realtime-mini");
    expect(() => liveModelArgument(["live-check", "--live-model"])).toThrow("needs a model");
    expect(() => liveModelArgument(["talk", "--live-model="])).toThrow("needs a model");
  });
  test("warm daemon reports the same resolved selection and never parks WebRTC", async () => {
    process.env.APIPLAN_LIVE_MODEL = "codex-live";
    process.env.APIPLAN_TALK_PARK = "on";
    const probe = spyOn(openai, "probe");
    try { armPark(); expect(probe).not.toHaveBeenCalled(); } finally { probe.mockRestore(); }
    expect(parkStatus().model).toBe("gpt-live-1-codex");
    const response = await handleTalk(new Request("http://localhost/talk", { method: "POST", body: JSON.stringify({ model: "codex-live" }) }));
    expect(response.status).toBe(400); expect(parkStatus().busy).toBe(false);
    process.env.APIPLAN_LIVE_MODEL = "realtime-2.1";
    expect(parkStatus().model).toBe("gpt-realtime-2.1");
  });
  test("playback-only constraints fail before reading credentials or loading native audio", async () => {
    const model = resolve("sol")!;
    expect(model).toBeTruthy();
    await expect(runSpeech(model, "hello", parseArgs(["--speak", "--live-model", "codex-live"]))).rejects.toThrow("playback-only");
    await expect(runSpeech(model, "hello", parseArgs(["--speak", "--play", "--out", "/tmp/unused.wav", "--live-model", "codex-live"]))).rejects.toThrow("playback-only");
  });
});

describe("AccountTracker handoff validation", () => {
  test("extracts only access material, never refresh or ID tokens", () => {
    const result = parseTrackedAccess(JSON.stringify({ ok: true, accessToken: "access", accountId: "account", expiresAt: 2000, refreshToken: "refresh", idToken: "id" }), 1000000);
    expect(result).toEqual({ token: "access", account: "account", source: "AccountTracker" });
  });
  test("rejects absent, malformed and expired credentials without echoing them", () => {
    for (const raw of ["private-invalid-json", JSON.stringify({ ok: false, accessToken: "secret" }), JSON.stringify({ ok: true, accessToken: "secret", expiresAt: 1 })]) {
      expect(() => parseTrackedAccess(raw)).toThrow();
      try { parseTrackedAccess(raw); } catch (error: any) { expect(error.message).not.toContain("secret"); expect(error.message).not.toContain("private-invalid-json"); }
    }
  });
});

function fixture() {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const messages: any[] = [];
  const peers: FakePeer[] = [];
  let ws: any;
  class FakePeer implements NativePeer {
    closed = 0; samples = 0; muted = false;
    constructor(public onEvent: any, public onLevel: any) { peers.push(this); }
    async createOffer() { return "v=0\r\nfake-offer"; }
    async acceptAnswer(answer: string) { expect(answer).toContain("v=0"); }
    async waitForOpen() { this.onEvent(null, JSON.stringify({ type: "session.started", session: { id: "rtc_test" } })); }
    pushAudio(samples: Float32Array) { this.samples += samples.length; }
    setMuted(muted: boolean) { this.muted = muted; }
    async close() { this.closed++; }
  }
  const natives = { LiveWebRtcPeer: FakePeer, AudioCapture: class { stop() {} } } as unknown as LiveNatives;
  const options = {
    natives, access: { token: "subscription-token", account: "account-id", source: "fixture" },
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response("v=0\r\nfake-answer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_test" } });
    }) as typeof fetch,
    socket: (url: string, headers: Record<string, string>) => {
      expect(url).toBe("wss://api.openai.com/v1/live/rtc_test");
      expect(headers.Authorization).toBe("Bearer subscription-token");
      ws = { readyState: 0, onopen: null, onclose: null, onerror: null, onmessage: null,
        send(raw: string) { messages.push(JSON.parse(raw)); },
        close() { ws.readyState = 3; ws.onclose?.({ code: 1000 }); },
      };
      queueMicrotask(() => { ws.readyState = 1; ws.onopen?.(); });
      return ws as WebSocket;
    },
  };
  return { requests, messages, peers, options, emit: (event: any) => ws.onmessage?.({ data: JSON.stringify(event) }), getSocket: () => ws };
}

describe("Codex native transport", () => {
  test("signals with subscription JSON, opens sideband and closes all owned resources", async () => {
    const f = fixture();
    const conn = await CodexLiveConnection.connect({ ...f.options, instructions: "persona", voice: "cedar" });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].url).toBe(CODEX_LIVE_URL);
    expect(f.requests[0].init.headers).toMatchObject({ Authorization: "Bearer subscription-token", "chatgpt-account-id": "account-id", "Content-Type": "application/json" });
    expect(JSON.parse(f.requests[0].init.body as string)).toEqual({ sdp: "v=0\r\nfake-offer", session: { model: "gpt-live-1-codex", instructions: "persona", audio: { output: { voice: "cedar" } }, delegation: { type: "client" } } });
    expect(conn.metrics.sessionStarted).toBe(true);
    conn.pushAudio(new Float32Array(320)); expect(f.peers[0].samples).toBe(320);
    conn.speak("hello", "warmly"); expect(f.messages[0].type).toBe("response.create");
    expect(f.messages[0].response.instructions).toContain("hello");
    await conn.close(); await conn.close();
    expect(f.peers[0].closed).toBe(1); expect(f.getSocket().readyState).toBe(3);
    expect(f.messages.at(-1).type).toBe("session.close");
    expect(() => conn.speak("after close")).toThrow("not connected");
  });
  test("a denied call closes its peer and never opens a sideband or alternative route", async () => {
    const f = fixture();
    let calls = 0;
    await expect(CodexLiveConnection.connect({ ...f.options, fetch: (async () => {
      calls++; return Response.json({ error: { message: "Voice session access denied.", code: "forbidden" } }, { status: 403 });
    }) as typeof fetch })).rejects.toThrow("Voice session access denied");
    expect(calls).toBe(1); expect(f.peers[0].closed).toBe(1); expect(f.getSocket()).toBeUndefined();
  });
  test("abort tears down a connected call", async () => {
    const f = fixture(), abort = new AbortController();
    const conn = await CodexLiveConnection.connect({ ...f.options, signal: abort.signal });
    abort.abort(); await conn.close();
    expect(f.peers[0].closed).toBe(1); expect(f.getSocket().readyState).toBe(3);
  });
  test("speech waits for non-silent output and a completed turn", async () => {
    const f = fixture();
    const baseSocket = f.options.socket;
    f.options.socket = (url, headers) => {
      const socket = baseSocket(url, headers) as any;
      const send = socket.send;
      socket.send = (raw: string) => {
        send(raw);
        if (JSON.parse(raw).type === "response.create") queueMicrotask(() => {
          f.peers[0].onLevel(null, 0.25);
          f.emit({ type: "turn.done", turn: { role: "assistant", transcript: "hello" } });
        });
      };
      return socket;
    };
    const report = await speakCodexLive("hello", { ...f.options, timeoutMs: 3000 });
    expect(report.peakOutputLevel).toBe(0.25); expect(report.transcript).toBe("hello");
    expect(f.peers[0].muted).toBe(true); expect(f.peers[0].closed).toBe(1);
  });
});

test("subscription speech failure cannot silently consume an API key", async () => {
  delete process.env.APIPLAN_TTS_BASE;
  process.env.OPENAI_API_KEY = "must-not-be-used";
  const credentials = spyOn(openai, "creds").mockReturnValue({ token: "subscription-token", source: "test" });
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    onerror?: () => void;
    constructor() { queueMicrotask(() => this.onerror?.()); }
    close() {}
  } as any;
  try {
    await expect(openai.speak!({ text: "hello", voice: "cedar", format: "wav", liveModel: "gpt-realtime" })).rejects.toThrow("connection failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { globalThis.WebSocket = originalSocket; credentials.mockRestore(); fetchSpy.mockRestore(); }
});
