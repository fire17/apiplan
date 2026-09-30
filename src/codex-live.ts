import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CODEX_LIVE_URL } from "./live-models.ts";

export type LiveAccess = { token: string; account?: string; source: string };
export type LiveEvent = { type: string; [key: string]: any };
export type NativePeer = {
  createOffer(): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  waitForOpen(timeoutMs?: number): Promise<void>;
  pushAudio(samples: Float32Array): void;
  setMuted(muted: boolean): void;
  close(): Promise<void>;
};
export type LiveNatives = {
  LiveWebRtcPeer: new (onEvent: (error: Error | null, payload: string) => void,
    onLevel: (error: Error | null, level: number) => void,
    onFailure: (error: Error | null, message: string) => void) => NativePeer;
  AudioCapture: new (rate: number, onAudio: (error: Error | null, samples: Float32Array) => void) => { stop(): void };
};

/** Optional native dependency: normal Realtime callers never load it. */
export async function loadLiveNatives(): Promise<LiveNatives> {
  const configured = process.env.APIPLAN_LIVE_NATIVE_MODULE?.trim();
  const candidates = configured ? [configured] : [
    "@oh-my-pi/pi-natives",
    join(homedir(), ".om", "runtime-current", "node_modules", "@oh-my-pi", "pi-natives", "native", "index.js"),
  ];
  for (const candidate of candidates) {
    try {
      const mod = await import(isAbsolute(candidate) ? pathToFileURL(candidate).href : candidate);
      if (typeof mod.LiveWebRtcPeer === "function" && typeof mod.AudioCapture === "function") return mod;
    } catch {}
  }
  throw new Error("Codex live needs a native WebRTC build exporting LiveWebRtcPeer and AudioCapture. Set APIPLAN_LIVE_NATIVE_MODULE to its module path (an installed OM runtime is detected automatically).");
}

export function parseTrackedAccess(raw: string, now = Date.now()): LiveAccess {
  let value: any;
  try { value = JSON.parse(raw); } catch { throw new Error("AccountTracker returned invalid OAuth metadata."); }
  if (value?.ok !== true || typeof value.accessToken !== "string" || !value.accessToken.trim()) {
    throw new Error("AccountTracker has no active Codex subscription access. Check accounttracker codex status.");
  }
  if (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now / 1000)) {
    throw new Error("AccountTracker's Codex access is expired. Refresh the ChatGPT sign-in through Codex.");
  }
  return { token: value.accessToken, account: typeof value.accountId === "string" ? value.accountId : undefined, source: "AccountTracker" };
}

export async function resolveLiveAccess(): Promise<LiveAccess> {
  const configured = process.env.ACCOUNTTRACKER_BIN?.trim();
  const launcher = configured || join(homedir(), "Creations", "AccountTracker", "accounttracker");
  if (existsSync(launcher)) {
    const child = Bun.spawn([launcher, "codex", "oauth-access"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 5000);
    try {
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) { child.kill(); throw new Error("AccountTracker OAuth response exceeded its limit."); }
        chunks.push(value);
      }
      const code = await child.exited;
      if (timedOut || code !== 0) throw new Error(`AccountTracker OAuth handoff ${timedOut ? "timed out" : "failed"}. Check accounttracker codex status.`);
      return parseTrackedAccess(Buffer.concat(chunks).toString("utf8"));
    } finally { clearTimeout(timer); }
  }
  if (configured) throw new Error("ACCOUNTTRACKER_BIN does not exist.");
  // Keep APIPlan portable when AccountTracker is not installed; its existing reader rejects API-key sign-ins.
  const { openai } = await import("./providers.ts");
  const c = openai.creds();
  return { token: c.token, account: c.account, source: c.source };
}

export function liveHeaders(access: LiveAccess, sessionId: string): Record<string, string> {
  const version = process.env.APIPLAN_CODEX_CLIENT_VERSION || "0.153.4";
  return {
    Authorization: `Bearer ${access.token}`, "OpenAI-Alpha": "quicksilver=v2",
    "User-Agent": `Codex Desktop/${version}`, originator: "Codex Desktop", version,
    "x-session-id": sessionId, "session-id": sessionId, "thread-id": sessionId,
    ...(access.account ? { "chatgpt-account-id": access.account } : {}),
  };
}

export function liveSession(instructions: string, voice: string) {
  return { model: "gpt-live-1-codex", instructions, audio: { output: { voice } }, delegation: { type: "client" } };
}

export function liveCallId(location: string | null): string {
  const id = location?.split("?", 1)[0].split("/").find(part => /^rtc_[\w-]+$/.test(part));
  if (!id) throw new Error("Codex live signaling returned no valid call ID.");
  return id;
}

type ConnectOptions = {
  voice?: string;
  instructions?: string;
  signal?: AbortSignal;
  onEvent?: (event: LiveEvent) => void;
  onOutputLevel?: (level: number) => void;
  access?: LiveAccess;
  natives?: LiveNatives;
  fetch?: typeof fetch;
  socket?: (url: string, headers: Record<string, string>) => WebSocket;
};

/** WebRTC carries Opus media; the subscription-authenticated sideband carries v3 control events. */
export class CodexLiveConnection {
  private peer?: NativePeer;
  private ws?: WebSocket;
  private closed = false;
  private closing?: Promise<void>;
  private abort = () => { void this.close(); };
  readonly metrics = { sessionStarted: false, outputFrames: 0, peakOutputLevel: 0, inputSamples: 0, authSource: "", connected: false };
  private constructor(private options: ConnectOptions) {}

  static async connect(options: ConnectOptions = {}): Promise<CodexLiveConnection> {
    const connection = new CodexLiveConnection(options);
    try { await connection.open(); return connection; }
    catch (error) { await connection.close(); throw error; }
  }

  private event(payload: string, fromPeer = false): void {
    if (this.closed) return;
    let event: LiveEvent;
    try { event = JSON.parse(payload); } catch { return; }
    if (!event || typeof event.type !== "string") return;
    if (event.type === "session.started") this.metrics.sessionStarted = true;
    if (fromPeer && this.ws?.readyState === WebSocket.OPEN && event.type !== "error") return;
    this.options.onEvent?.(event);
  }

  private failure(message: string): void {
    if (!this.closed) this.options.onEvent?.({ type: "error", message });
  }

  private async open(): Promise<void> {
    const o = this.options;
    o.signal?.throwIfAborted();
    o.signal?.addEventListener("abort", this.abort, { once: true });
    const natives = o.natives ?? await loadLiveNatives();
    const access = o.access ?? await resolveLiveAccess();
    this.metrics.authSource = access.source;
    o.signal?.throwIfAborted();
    this.peer = new natives.LiveWebRtcPeer(
      (error, payload) => error ? this.failure(error.message) : this.event(payload, true),
      (error, level) => {
        if (error) return this.failure(error.message);
        if (this.closed || !Number.isFinite(level)) return;
        this.metrics.outputFrames++;
        this.metrics.peakOutputLevel = Math.max(this.metrics.peakOutputLevel, level);
        o.onOutputLevel?.(level);
      },
      (error, message) => this.failure(error?.message ?? message),
    );
    const offer = await this.peer.createOffer();
    o.signal?.throwIfAborted();
    const headers = liveHeaders(access, crypto.randomUUID());
    const response = await (o.fetch ?? fetch)(CODEX_LIVE_URL, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify({ sdp: offer, session: liveSession(o.instructions ?? "You are a helpful voice assistant. Respond briefly and naturally.", o.voice || "cedar") }),
      signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      // Never echo arbitrary upstream bodies, which can contain request metadata.
      let detail = "";
      try {
        const body: any = await response.json();
        if (body?.error?.message === "Voice session access denied.") detail = " Voice session access denied.";
        else if (typeof body?.error?.code === "string" && /^[a-z_]{1,60}$/.test(body.error.code)) detail = ` ${body.error.code}.`;
      } catch {}
      throw new Error(`Codex live subscription signaling refused (HTTP ${response.status}).${detail} No API-key fallback was attempted.`);
    }
    const answer = await response.text();
    if (!answer.startsWith("v=0")) throw new Error("Codex live returned an invalid SDP answer.");
    const callId = liveCallId(response.headers.get("location"));
    o.signal?.throwIfAborted();
    await this.peer.acceptAnswer(answer);
    await this.peer.waitForOpen(15000);
    o.signal?.throwIfAborted();
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.openSideband(callId, headers); lastError = undefined; break; }
      catch (error) { lastError = error; o.signal?.throwIfAborted(); if (attempt < 2) await Bun.sleep(200 * 2 ** attempt); }
    }
    if (lastError) throw lastError;
    if (this.closed) throw new Error("Codex live connection closed during startup.");
    this.metrics.connected = true;
  }

  private openSideband(callId: string, headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`;
      const ws = this.options.socket?.(url, headers) ?? new WebSocket(url, { headers, perMessageDeflate: false } as any);
      this.ws = ws;
      let opened = false, settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); ws.close(); reject(error);
      };
      const timer = setTimeout(() => fail(new Error("Codex live control channel timed out.")), 10000);
      ws.onopen = () => {
        if (settled || this.closed) return fail(new Error("Codex live connection was closed."));
        opened = settled = true; clearTimeout(timer); resolve();
      };
      ws.onmessage = event => this.event(String(event.data));
      ws.onerror = () => opened ? this.failure("Codex live control channel failed.") : fail(new Error("Codex live control channel connection failed."));
      ws.onclose = event => {
        if (!opened) fail(new Error(`Codex live control channel closed (${event.code}).`));
        else if (!this.closed) this.failure(`Codex live control channel closed (${event.code}).`);
      };
    });
  }

  send(event: LiveEvent): void {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) throw new Error("Codex live is not connected.");
    this.ws.send(JSON.stringify(event));
  }

  speak(text: string, direction?: string): void {
    this.send({ type: "response.create", response: { conversation: "none",
      instructions: ["Say the following text aloud, word for word. Do not translate, paraphrase, add or omit anything.", direction ? `Vocal direction: ${direction}` : "", text].filter(Boolean).join("\n\n") } });
  }

  pushAudio(samples: Float32Array): void {
    if (this.closed || !this.metrics.connected || !samples.length) return;
    this.metrics.inputSamples += samples.length;
    this.peer?.pushAudio(samples);
  }

  setMuted(muted: boolean): void { this.peer?.setMuted(muted); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.options.signal?.removeEventListener("abort", this.abort);
    const ws = this.ws;
    this.ws = undefined;
    if (ws?.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: "session.close" })); } catch {} }
    try { ws?.close(1000, "done"); } catch {}
    this.closing = this.peer?.close().catch(() => {}) ?? Promise.resolve();
    return this.closing;
  }
}

export type LiveSpeechReport = CodexLiveConnection["metrics"] & { transcript: string; elapsedMs: number };

/** Playback is native; the current native peer does not expose decoded PCM for file export. */
export async function speakCodexLive(text: string, options: ConnectOptions & { direction?: string; timeoutMs?: number } = {}): Promise<LiveSpeechReport> {
  const started = Date.now();
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  let conn: CodexLiveConnection | undefined;
  let transcript = "", lastAudio = 0, responseDone = false, failure: Error | undefined;
  const timer = setTimeout(() => abort.abort(new Error("Codex live speech timed out.")), options.timeoutMs ?? 60000);
  try {
    conn = await CodexLiveConnection.connect({ ...options, signal,
      onOutputLevel: level => { if (level > 0.0001) lastAudio = Date.now(); options.onOutputLevel?.(level); },
      onEvent: event => {
        if (event.type === "output_transcript.added") transcript += event.item?.text ?? "";
        if (event.type === "turn.done" && event.turn?.role === "assistant") { transcript = event.turn.transcript ?? transcript; responseDone = true; }
        if (event.type === "response.done") responseDone = true;
        if (event.type === "error") failure = new Error(event.message ?? event.error?.message ?? "Codex live speech failed.");
        options.onEvent?.(event);
      },
    });
    conn.setMuted(true);
    conn.speak(text, options.direction);
    while (true) {
      signal.throwIfAborted();
      if (failure) throw failure;
      // A server turn can finish before RTP playback drains; require a quiet tail as well.
      if (responseDone && lastAudio && Date.now() - lastAudio > 900) break;
      await Bun.sleep(50);
    }
    return { ...conn.metrics, transcript, elapsedMs: Date.now() - started };
  } finally { clearTimeout(timer); await conn?.close(); }
}
