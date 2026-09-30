// gemini-live.ts — the BidiGenerateContent client: Google's Live API over one WebSocket.
//
// ── WHY THIS IS A SEPARATE TRANSPORT AND NOT A REALTIME SOCKET WITH DIFFERENT SETTINGS ──
// Gemini's Live API shares nothing with OpenAI's Realtime protocol but the word
// "WebSocket". Different endpoint, different auth (API key in the query string, not a
// bearer), and a completely different message vocabulary: one `setup` frame answered by
// `setupComplete`, then `clientContent`/`realtimeInput` up and `serverContent` down. So
// live-models.ts gives it its own `transport` tag and this file is its only client.
//
// ── THE ENDPOINT, AND A DOC THAT IS WRONG ABOUT IT ──
// APIPlan's own research note (.deify/gemini-research/GEMINI_CACHING.md §3.2) records the
// URL as
//   wss://…/google.ai.generativelanguage.v1beta.generative_service.BidiGenerateContent/channel?key=
// and that form DOES NOT WORK: probed live 2026-09-06, it fails the WebSocket handshake
// outright (`error`, no close frame). The form below is the one @google/genai itself
// builds (js-genai src/live.ts, `${websocketBaseUrl}/ws/google.ai.generativelanguage.
// ${apiVersion}.GenerativeService.${method}?${keyName}=${apiKey}`) — note `/ws` prefix,
// PascalCase `GenerativeService`, no `/channel` suffix — and it answered `{"setupComplete":{}}`
// in ~260 ms on the same probe. Three spellings differ between the two; the SDK wins
// because it was measured. (The SDK's own base-url helper leaves a double slash after the
// origin, which Google tolerates; the single-slash form is written here.)
//
// ── WHAT IS PROVEN, AND WHAT THE MODELS REFUSE ──
// Probed live 2026-09-06, one handshake per (model, modality), reading the 1007 close
// reason the server itself sends:
//   gemini-3.1-flash-live-preview                  ['TEXT'] → 1007 REFUSED   ['AUDIO'] → accepted
//   gemini-2.5-flash-native-audio-preview-12-2025  ['TEXT'] → 1007 REFUSED   ['AUDIO'] → accepted
//   gemini-3.5-live-translate-preview              ['TEXT'] → accepted       ['AUDIO'] → accepted
//   gemini-3.5-transcribe-live                     ['TEXT'] → accepted       ['AUDIO'] → 1007 REFUSED
// The server's words for the refusal: "The requested combination of response modalities
// (TEXT) is not supported by the model. models/gemini-3.1-flash-live-preview".
//
// That single table demolishes the shape a text-first client would take: the two DIALOGUE
// models cannot answer in text at all. And the two that accept a TEXT setup do not answer
// a text QUESTION — a `clientContent` turn carrying `{text}` to either one produces
// `setupComplete` and then silence to a 20-second timeout, twice, because they are
// audio-INPUT models (an STT engine and a speech-to-speech translator). What they answer
// is AUDIO, over `realtimeInput`.
//
// So the honest surface is audio-in, and it is proven end to end: 3.4 s of 16 kHz mono
// PCM16 fed to gemini-3.5-transcribe-live as 34 realtimeInput frames came back as
// `serverContent.interimInputTranscription` ("acknowledged") and then
// `serverContent.inputTranscription` ("Acknowledged. Happy plan Gemini live transport
// check.") in 1.7 s, with `voiceActivity` ACTIVITY_START/ACTIVITY_END framing it. That is
// dictation, live, and it is the capability this file flips.
//
// ── THE ONE NON-OBVIOUS THING: THE AUTOMATIC DETECTOR NEVER ENDS AN UTTERANCE ──
// The dialogue ids looked broken for three probes. Fed a clip and told the stream was
// over, gemini-3.1-flash-live-preview answered ONE `voiceActivity: ACTIVITY_START` and
// then nothing at all — no ACTIVITY_END, no model turn, no usage — for a full 60 s, and
// the same under a 1 s trailing-silence pad. Neither `audioStreamEnd` nor audio-time
// silence moved it. What works is disabling the server's automatic detector and marking
// the turn by hand:
//   setup.realtimeInputConfig.automaticActivityDetection.disabled = true
//   {realtimeInput:{activityStart:{}}} · audio frames · {realtimeInput:{activityEnd:{}}}
// With that, the SAME clip against the SAME model produced three complete turns in 17.4 s:
// 460,834 bytes of 24 kHz PCM16 (9.60 s, peak 26,822, ffprobe pcm_s16le/24000/1ch), an
// `outputTranscription` narrating each reply, `sessionResumptionUpdate` handles arriving
// unbidden, and a usageMetadata frame per turn. So the dialogue models are drivable, and
// `manualActivity` is the switch that makes them so — see converseBidi().
// The STT model is the opposite: its automatic detector settled in 1.7 s, so it is left on.
//
// ── CACHING, WHICH IS WHY THIS LANE EXISTS ──
// MEASURED, across three turns with a ~5.7k-token systemInstruction (well past the 4,096
// implicit floor for 3.x): promptTokenCount 5782 → 5955 → 6210, responseTokenCount 51 →
// 115 → 94, and `cachedContentTokenCount` ABSENT FROM EVERY TURN — zero occurrences in
// all three frames. The prompt grew turn over turn (the session accumulates context) and
// none of it ever came back as cached. What the frames DO carry that the HTTP route does
// not is a per-modality split: promptTokensDetails [{TEXT: 5674}, {AUDIO: 83}] and
// responseTokensDetails [{AUDIO: 51}] on turn one.
// So on this transport the implicit prefix cache did not report a single hit, and no
// counter suggests one occurred. This is a measurement of three turns in one session, not
// a proof that Live can never cache — but it is the honest answer to "does the Live API
// report cached tokens", and it is NO for every turn observed here. `bidiUsage` maps the
// field anyway, on the standing rule that a documented counter is forwarded rather than
// dropped: the day the server sends one, it is already read.
//
// And EXPLICIT caching is settled too, from both ends, which the research note had left
// "UNVERIFIED … not claimed either way":
//   · `POST /v1beta/cachedContents` pinned to a live id answers 400 INVALID_ARGUMENT —
//     "models/gemini-3.1-flash-live-preview only supports real-time bidirectional
//     streaming via WebSocket (bidiGenerateContent). Please use the Gemini Live API …
//     instead of createCachedContent." A cache cannot be created for a live model at all.
//   · a valid cache name (created against gemini-2.5-flash, 9,385 tokens) quoted in a Bidi
//     setup closes the socket 1007 — "Unknown name \"cachedContent\" at 'setup': Cannot
//     find field." The field does not exist in the setup message.
// So on this transport there is NO explicit cache and no observed implicit hit. The one
// cost lever that does exist is the sessionResumption handle the server volunteers
// unbidden (three arrived during the dialogue probe) — a way to continue a session rather
// than a way to re-read a prefix cheaply.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiApiKey } from "./gemini-media.ts";
import { geminiWireId } from "./registry.ts";
import type { Delta } from "./providers.ts";

/** Where the socket goes. Overridable so a test can point it at a local stub. */
const WS_BASE = () => process.env.APIPLAN_GEMINI_WS_BASE ?? "wss://generativelanguage.googleapis.com";
const API_VERSION = () => process.env.APIPLAN_GEMINI_API_VERSION ?? "v1beta";

/**
 * The URL, key included. Never logged, never put in an error: an error string travels
 * into receipts and terminals, and a key in a query parameter is a key in a query
 * parameter. `socketForm()` below is the loggable half.
 */
export function bidiUrl(key: string): string {
  return `${WS_BASE()}/ws/google.ai.generativelanguage.${API_VERSION()}.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
}
/** The same URL with the query stripped — safe to print, log and put in a receipt. */
export const socketForm = () =>
  `${WS_BASE()}/ws/google.ai.generativelanguage.${API_VERSION()}.GenerativeService.BidiGenerateContent`;

/** PCM16 mono → .wav. Local rather than imported: providers.ts's copy is private, and
 *  importing that module for 8 lines would drag the whole credential layer into a client
 *  that needs an API key and nothing else. */
export function pcm16Wav(pcm: Uint8Array, rate = 24_000): Uint8Array {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.from(pcm)]));
}

/**
 * What one server frame contributed — the SAME event vocabulary the OpenAI realtime path
 * hands its callers, so a consumer can switch transports without learning a second
 *语汇. `transcript` is the piece Gemini adds: on this transport the INPUT transcription
 * is a first-class server event rather than something a separate STT call produces.
 */
export type BidiEvent =
  | { kind: "ready" }
  /** A settled chunk of the model's own text output (translate-live's TEXT modality). */
  | { kind: "text"; text: string }
  /** Model audio, PCM16 24 kHz mono, exactly as `inlineData` delivered it. */
  | { kind: "audio"; pcm: Uint8Array }
  /** What the server heard. `final` distinguishes `inputTranscription` from
   *  `interimInputTranscription`, which is a REPLACE of the current utterance. */
  | { kind: "transcript"; text: string; final: boolean; of: "input" | "output" }
  /** The model finished a turn. */
  | { kind: "turn"; usage?: Delta["usage"] }
  /** Token counts, whenever the server volunteered them. */
  | { kind: "usage"; usage: Delta["usage"]; raw: Record<string, unknown> }
  /** Speech boundaries the server's VAD detected. */
  | { kind: "activity"; state: "start" | "end"; offset?: string }
  /** The server will disconnect soon; `sessionResumptionUpdate` carries the handle. */
  | { kind: "goaway"; detail: string }
  | { kind: "resumable"; handle: string }
  | { kind: "error"; error: string };

/**
 * Google's Live usageMetadata → this gateway's Delta.usage.
 *
 * INCLUSIVE, and deliberately NOT subtracted here. `promptTokenCount` is the whole prompt
 * with `cachedContentTokenCount` as a breakdown OF it, exactly as the HTTP route reports
 * it (providers-gemini.ts:419-486 records the measurement: promptTokenCount 3163 against
 * cachedContentTokenCount 3155 for an 8-token question). api.ts's normalizeTally() owns
 * the single conversion to this gateway's exclusive footing, so subtracting a second time
 * here would drive the uncached remainder negative. `uncachedInput()` below is for a
 * caller that wants the partition for a REPORT rather than for a tally.
 *
 * The live shape differs from the HTTP one in ONE field name, verified in the SDK's own
 * live usage-metadata converter (js-genai src/converters/_live_converters.ts:2637-2744):
 * output is `responseTokenCount` here, `candidatesTokenCount` there. Both are read, so a
 * frame in either spelling maps — the HTTP name is not rejected merely for being the
 * other route's.
 *
 * `thoughtsTokenCount` is folded INTO output and reported again as `reasoning`, because
 * Google's own total identity is "prompt + thoughts + response candidates" — three
 * addends, so thoughts are NOT already inside the output counter — and thinking bills as
 * output. `toolUsePromptTokenCount` stays unmapped: its containment relative to
 * promptTokenCount is documented nowhere, and an unknown containment must not be guessed
 * in either direction.
 */
export function bidiUsage(um: unknown): Delta["usage"] | undefined {
  if (!um || typeof um !== "object") return undefined;
  const rec = um as Record<string, unknown>;
  const num = (k: string) => (typeof rec[k] === "number" ? (rec[k] as number) : undefined);
  const input = num("promptTokenCount");
  const response = num("responseTokenCount") ?? num("candidatesTokenCount");
  const thoughts = num("thoughtsTokenCount");
  const cached = num("cachedContentTokenCount");
  const output = response === undefined && thoughts === undefined ? undefined : (response ?? 0) + (thoughts ?? 0);
  if (input === undefined && output === undefined && cached === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(thoughts !== undefined ? { reasoning: thoughts } : {}),
    ...(cached !== undefined ? { cacheRead: cached } : {}),
  };
}

/**
 * The FRESH share of the prompt, for a caller that wants to show the partition rather
 * than add it to a tally: promptTokenCount − cachedContentTokenCount, which is the
 * inclusive basis stated once and applied once. Undefined when the vendor reported no
 * input at all — a missing counter is not a zero.
 */
export function uncachedInput(usage: Delta["usage"] | undefined): number | undefined {
  if (!usage || usage.input === undefined) return undefined;
  return usage.input - (usage.cacheRead ?? 0);
}

/** One server frame → the events it contributed, in order. Pure, so it is testable
 *  without a socket, and every branch below is a shape read off a live frame. */
export function bidiEvents(frame: unknown): BidiEvent[] {
  if (!frame || typeof frame !== "object") return [];
  const f = frame as Record<string, unknown>;
  const out: BidiEvent[] = [];

  // An error can arrive as a FRAME rather than as a close, so it is read before anything
  // else: a rejection parsed as content is the one failure that looks like success.
  if (f.error && typeof f.error === "object") {
    const e = f.error as Record<string, unknown>;
    out.push({ kind: "error", error: typeof e.message === "string" ? e.message : "bidi stream error" });
    return out;
  }
  if (f.setupComplete) out.push({ kind: "ready" });

  const sc = f.serverContent;
  if (sc && typeof sc === "object") {
    const s = sc as Record<string, unknown>;
    const turn = s.modelTurn;
    if (turn && typeof turn === "object") {
      const parts = (turn as Record<string, unknown>).parts;
      for (const raw of Array.isArray(parts) ? parts : []) {
        if (!raw || typeof raw !== "object") continue;
        const p = raw as Record<string, unknown>;
        if (typeof p.text === "string" && p.text) out.push({ kind: "text", text: p.text });
        const inline = p.inlineData;
        if (inline && typeof inline === "object") {
          const d = (inline as Record<string, unknown>).data;
          if (typeof d === "string" && d) out.push({ kind: "audio", pcm: new Uint8Array(Buffer.from(d, "base64")) });
        }
      }
    }
    // Transcriptions. The interim form REPLACES the current utterance rather than
    // appending to it (same law dictation.ts records for Anthropic's STT), which is why
    // `final` is carried instead of being inferred from arrival order.
    for (const [key, final, of] of [
      ["interimInputTranscription", false, "input"],
      ["inputTranscription", true, "input"],
      ["outputTranscription", true, "output"],
    ] as const) {
      const t = s[key];
      if (t && typeof t === "object") {
        const text = (t as Record<string, unknown>).text;
        if (typeof text === "string" && text) out.push({ kind: "transcript", text, final, of });
      }
    }
    if (s.turnComplete) out.push({ kind: "turn", usage: bidiUsage(f.usageMetadata) });
  }

  const va = f.voiceActivity;
  if (va && typeof va === "object") {
    const v = va as Record<string, unknown>;
    const type = String(v.type ?? "");
    if (type === "ACTIVITY_START" || type === "ACTIVITY_END") {
      out.push({ kind: "activity", state: type === "ACTIVITY_START" ? "start" : "end",
        ...(typeof v.audioOffset === "string" ? { offset: v.audioOffset } : {}) });
    }
  }

  // Usage rides on its own frame as often as on a turn boundary, so it is published
  // whenever it appears — and NOT swallowed by the turnComplete branch above, which only
  // attaches it when the two share a frame.
  if (f.usageMetadata) {
    const usage = bidiUsage(f.usageMetadata);
    if (usage) out.push({ kind: "usage", usage, raw: f.usageMetadata as Record<string, unknown> });
  }

  if (f.goAway) {
    const g = f.goAway as Record<string, unknown>;
    out.push({ kind: "goaway", detail: typeof g.timeLeft === "string" ? g.timeLeft : "" });
  }
  if (f.sessionResumptionUpdate && typeof f.sessionResumptionUpdate === "object") {
    const r = f.sessionResumptionUpdate as Record<string, unknown>;
    if (r.resumable && typeof r.newHandle === "string") out.push({ kind: "resumable", handle: r.newHandle });
  }
  return out;
}

export type BidiOpts = {
  /** A live model id — vendor spelling or the registry's `gemini-key-` marked one; the
   *  route marker is stripped for the wire either way (geminiWireId). */
  model: string;
  /** What the model may answer in. The per-model table at the top of this file says which
   *  are accepted; a refusal is a 1007 close naming the model. */
  modalities?: Array<"TEXT" | "AUDIO">;
  /** Persona / rules for the whole session. Wrapped as a Content — the wire wants
   *  `{parts:[{text}]}`, not a bare string (js-genai wraps it through tContent). */
  system?: string;
  /** Realtime function-tool declarations. NOT declared as a capability: `setup.tools` is
   *  a real wire key but no functionCall has been driven over this transport here. */
  tools?: Array<Record<string, unknown>>;
  /** Ask for input/output transcription events. On an STT model the input one IS the
   *  product, so it defaults ON. */
  transcribeInput?: boolean;
  transcribeOutput?: boolean;
  /**
   * Turn the server's AUTOMATIC voice-activity detector OFF and mark turn boundaries by
   * hand (`activityStart` / `activityEnd`).
   *
   * THIS IS WHAT MAKES THE DIALOGUE MODELS WORK AT ALL, and it was not obvious. With the
   * automatic detector on, gemini-3.1-flash-live-preview logged one `ACTIVITY_START` and
   * then nothing — no ACTIVITY_END, no model turn, no usage — for a full 60 s, under BOTH
   * `audioStreamEnd` and a 1 s trailing-silence pad. The automatic detector never
   * declared the utterance finished, so generation never began. With it disabled and the
   * boundaries sent explicitly, the same clip produced three complete turns in 17 s with
   * real audio and usage on every one.
   *
   * On an STT model the automatic detector works fine (it settled in 1.7 s), so this
   * defaults off and is opted into by the conversation path.
   */
  manualActivity?: boolean;
  /**
   * REMOVED AS AN OPTION — an explicit CachedContent CANNOT be referenced over this
   * socket, and that is now measured rather than doc-unverified.
   *
   * Two live probes, 2026-09-06, and they agree from both ends:
   *   · `POST /v1beta/cachedContents` pinned to a live id answers 400 INVALID_ARGUMENT:
   *     "models/gemini-3.1-flash-live-preview only supports real-time bidirectional
   *     streaming via WebSocket (bidiGenerateContent). Please use the Gemini Live API …
   *     instead of createCachedContent." So a cache cannot even be CREATED for a live
   *     model.
   *   · Quoting a valid cache name (created against gemini-2.5-flash, 9,385 tokens) in a
   *     Bidi setup closes the socket 1007: "Invalid JSON payload received. Unknown name
   *     \"cachedContent\" at 'setup': Cannot find field." The field does not exist in the
   *     setup message, which matches the SDK: js-genai's MLDev setup writer emits 18 keys
   *     and this is not one of them.
   * The failure is a CONNECTION-KILLING 1007, not a silent ignore, so accepting the option
   * would hand a caller a broken session for a field the vendor has no concept of. The
   * honest interface is not to offer it — and, since a caller cannot ask for it, the
   * cachedContentTokenCount that bidiUsage() maps can only ever come from the vendor's
   * free IMPLICIT cache, which reported no hit in any turn measured here.
   */
  /** Resume a previous session by handle, or `{}` to merely ask for handles. */
  resumeHandle?: string;
  signal?: AbortSignal;
  /** Hard ceiling on the whole session. */
  timeoutMs?: number;
  key?: string;
};

/**
 * A live Bidi session. Deliberately shaped like the realtime path's socket usage —
 * construct, await `ready`, push turns, consume events — so talk/dictation code can hold
 * either transport behind one variable.
 *
 * Pre-`setupComplete` frames are QUEUED rather than dropped: the SDK does the same
 * (js-genai src/live.ts queues into `messageQueue` until the handshake resolves), and a
 * server that answers faster than the caller subscribes must not lose its first frame.
 */
export class BidiSession {
  private ws: WebSocket | null = null;
  private queue: BidiEvent[] = [];
  private waiters: Array<(e: BidiEvent | null) => void> = [];
  private closed = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private closeDetail = "";
  /** Every usageMetadata this session reported, in order — the receipt's raw material. */
  readonly usageFrames: Array<Record<string, unknown>> = [];

  constructor(private readonly o: BidiOpts) {}

  /** Connect and wait for `setupComplete`. Rejects with the server's own close reason,
   *  which is where a modality refusal is stated. */
  open(): Promise<void> {
    const key = this.o.key ?? geminiApiKey();
    const timeoutMs = this.o.timeoutMs ?? 60_000;
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      let ws: WebSocket;
      try {
        // Bun accepts an options bag the DOM lib does not declare. perMessageDeflate off:
        // the payload is base64 PCM, which is incompressible.
        const Socket = WebSocket as unknown as new (url: string, options: { perMessageDeflate: boolean }) => WebSocket;
        ws = new Socket(bidiUrl(key), { perMessageDeflate: false });
      } catch (e) {
        // The URL never reaches the message: it carries the key.
        return reject(new Error(`gemini live could not connect: ${e instanceof Error ? e.message : String(e)} (${socketForm()})`));
      }
      this.ws = ws;
      const timer = setTimeout(() => this.fail(new Error(`gemini live timed out after ${timeoutMs}ms`)), timeoutMs);
      this.o.signal?.addEventListener("abort", () => this.fail(new Error("gemini live aborted")), { once: true });

      ws.onopen = () => ws.send(JSON.stringify({ setup: this.setupFrame() }));
      ws.onmessage = (e: MessageEvent) => {
        const raw = typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer).toString("utf8");
        let frame: unknown;
        try { frame = JSON.parse(raw); } catch { return; }
        if (frame && typeof frame === "object" && (frame as Record<string, unknown>).usageMetadata) {
          this.usageFrames.push((frame as Record<string, unknown>).usageMetadata as Record<string, unknown>);
        }
        for (const ev of bidiEvents(frame)) {
          // `ready` IS the handshake, and open()'s promise is how a caller consumes it.
          // Queueing it as well would put a synthetic first event in front of every
          // consumer — which is exactly what made the first `for await` see "ready" where
          // the server's first real frame belonged.
          if (ev.kind === "ready") {
            clearTimeout(timer);
            this.readyResolve?.();
            this.readyResolve = null; this.readyReject = null;
            continue;
          }
          // An error BEFORE the handshake is a failed open() and must reject it. After the
          // handshake, open() is already settled, so the error belongs to the stream.
          if (ev.kind === "error" && this.readyReject) { clearTimeout(timer); this.fail(new Error(ev.error)); return; }
          this.emit(ev);
        }
      };
      ws.onerror = () => { clearTimeout(timer); this.fail(new Error(`gemini live connection failed (${socketForm()})`)); };
      ws.onclose = (e: CloseEvent) => {
        clearTimeout(timer);
        const code = e && typeof e === "object" && "code" in e ? String(e.code) : "?";
        const reason = e && typeof e === "object" && "reason" in e ? String(e.reason ?? "").slice(0, 200) : "";
        this.closeDetail = `${code} ${reason}`.trim();
        // A close BEFORE setupComplete is the server refusing the setup, and its reason is
        // the diagnosis (a 1007 names the unsupported modality and the model). Surfacing
        // it as the open() rejection is the difference between a fixable message and a
        // mysterious hang.
        this.fail(new Error(`gemini live closed (${this.closeDetail})`));
        this.finish();
      };
    });
  }

  /** The setup frame. Key names and nesting verified against js-genai's MLDev setup
   *  converter (_live_converters.ts:1021-1262): camelCase, everything under one `setup`,
   *  the scalar knobs nested inside `setup.generationConfig`. */
  setupFrame(): Record<string, unknown> {
    const o = this.o;
    const wantTranscript = o.transcribeInput ?? true;
    return {
      model: `models/${geminiWireId(o.model)}`,
      generationConfig: { responseModalities: o.modalities ?? ["AUDIO"] },
      ...(o.system ? { systemInstruction: { parts: [{ text: o.system }] } } : {}),
      ...(o.tools?.length ? { tools: o.tools } : {}),
      ...(wantTranscript ? { inputAudioTranscription: {} } : {}),
      ...(o.transcribeOutput ? { outputAudioTranscription: {} } : {}),
      // See BidiOpts.manualActivity: on a dialogue model the automatic detector never
      // ended the utterance, so generation never started. Disabling it is what turned a
      // 60-second silence into three complete turns.
      ...(o.manualActivity ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } : {}),
      // No `cachedContent`: the field does not exist in this message and sending it closes
      // the socket 1007 ("Unknown name \"cachedContent\" at 'setup'"). See BidiOpts.
      ...(o.resumeHandle !== undefined ? { sessionResumption: o.resumeHandle ? { handle: o.resumeHandle } : {} } : {}),
    };
  }

  /** A complete text turn. Accepted by the wire on every id; ANSWERED by none of the four
   *  probed (both TEXT-capable ids are audio-input models and stayed silent), so this
   *  exists for a future text-capable live model and for the stub tests. */
  sendText(text: string, turnComplete = true): void {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete } });
  }

  /** Stream microphone audio. 16 kHz mono PCM16 is what the models were probed with. */
  sendAudio(pcm: Uint8Array, rate = 16_000): void {
    this.send({ realtimeInput: { audio: { mimeType: `audio/pcm;rate=${rate}`, data: Buffer.from(pcm).toString("base64") } } });
  }

  /**
   * Declare the utterance finished, the way that matches the detector in use.
   *
   * `manualActivity` → `activityEnd`, which is the ONLY thing that ends a turn on the
   * dialogue models (measured: `audioStreamEnd` and a silence pad both left them waiting
   * indefinitely). Otherwise → `audioStreamEnd`, which the STT model settles on happily.
   */
  endAudio(): void {
    this.send(this.o.manualActivity ? { realtimeInput: { activityEnd: {} } } : { realtimeInput: { audioStreamEnd: true } });
  }

  /** Mark the start of a hand-signalled utterance. No-op unless `manualActivity`, so a
   *  caller can drive both detectors through one code path. */
  beginAudio(): void {
    if (this.o.manualActivity) this.send({ realtimeInput: { activityStart: {} } });
  }

  /** Trailing silence, in milliseconds — the endpointer's audio-time cure. */
  sendSilence(ms: number, rate = 16_000): void {
    this.sendAudio(new Uint8Array(Math.round((rate * 2 * ms) / 1000)), rate);
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("gemini live socket is not open");
    this.ws.send(JSON.stringify(frame));
  }

  /** Events in arrival order. Ends when the socket closes. */
  async *events(): AsyncGenerator<BidiEvent> {
    while (true) {
      const ev = this.queue.shift() ?? (this.closed ? null : await new Promise<BidiEvent | null>(r => this.waiters.push(r)));
      if (!ev) return;
      yield ev;
    }
  }

  close(): void { try { this.ws?.close(); } catch {} this.finish(); }
  /** The server's own last words — the close code and reason. */
  get closedBecause(): string { return this.closeDetail; }

  private emit(ev: BidiEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(ev); else this.queue.push(ev);
  }
  private fail(e: Error): void {
    if (this.readyReject) { const reject = this.readyReject; this.readyResolve = null; this.readyReject = null; reject(e); }
    this.finish();
  }
  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }
}

export type BidiTranscript = { text: string; interim: string[]; usage?: Delta["usage"]; closedBecause: string };

/**
 * One bounded dictation over Bidi: feed PCM, collect the transcription, hang up.
 *
 * This is the transport's PROVEN product. Live 2026-09-06 against
 * gemini-3.5-transcribe-live: 108,486 bytes of 16 kHz PCM16 in 34 frames → two
 * `interimInputTranscription` events ("acknowledged") and one final
 * `inputTranscription` ("Acknowledged. Happy plan Gemini live transport check.") 1.7 s
 * after setup, framed by voiceActivity ACTIVITY_START/END.
 */
export async function transcribeBidi(
  pcm: Uint8Array,
  o: Omit<BidiOpts, "modalities"> & {
    silenceMs?: number;
    /** How long to keep listening after the transcript settles, in case a usageMetadata
     *  frame is still in flight. See the exit rule below. */
    usageGraceMs?: number;
    onEvent?: (kind: "interim" | "settle" | "info", text: string) => void;
  },
): Promise<BidiTranscript> {
  const session = new BidiSession({ ...o, modalities: ["TEXT"], transcribeInput: true });
  const say = o.onEvent ?? (() => {});
  await session.open();
  say("info", `listening on ${o.model}`);

  const settled: string[] = [];
  const interim: string[] = [];
  let usage: Delta["usage"] | undefined;

  // 100 ms frames, the cadence a live microphone delivers.
  const chunk = 3_200;
  for (let i = 0; i < pcm.length; i += chunk) session.sendAudio(pcm.subarray(i, i + chunk));
  // Trailing silence BEFORE audioStreamEnd: the endpointer needs audio time to settle the
  // last word, and closing on the final syllable clips it.
  session.sendSilence(o.silenceMs ?? 700);
  session.endAudio();

  // Two facts decide the exit, and both were measured. (1) The server holds an idle socket
  // open indefinitely: after the final transcription it sent nothing for the remaining
  // 23 s of a 25 s probe, so waiting for a close that never comes would hang. (2) When a
  // usageMetadata frame does arrive it arrives AFTER the content — ~2.5 s after
  // generationComplete on the dialogue path — so hanging up the instant the transcript
  // settles throws the token counts away, silently, which is the exact "dropped optional
  // counter" fault Delta.usage's contract warns about.
  // So the final transcription starts a short GRACE window instead of ending the loop:
  // usage ends it early, and the window ends it otherwise. (gemini-3.5-transcribe-live
  // sent no usage at all in its probe, so for that model the window simply elapses.)
  const deadline = setTimeout(() => session.close(), o.timeoutMs ?? 30_000);
  let grace: Timer | null = null;
  try {
    for await (const ev of session.events()) {
      if (ev.kind === "transcript" && ev.of === "input") {
        if (ev.final) {
          settled.push(ev.text);
          say("settle", settled.join(" "));
          if (usage) break;
          grace ??= setTimeout(() => session.close(), o.usageGraceMs ?? 1_200);
        } else { interim.push(ev.text); say("interim", ev.text); }
      }
      if (ev.kind === "usage") { usage = ev.usage; if (settled.length) break; }
      if (ev.kind === "error") throw new Error(ev.error);
    }
  } finally { clearTimeout(deadline); clearTimeout(grace ?? undefined); session.close(); }

  return { text: settled.join(" ").replace(/\s+/g, " ").trim(), interim, ...(usage ? { usage } : {}), closedBecause: session.closedBecause };
}

export type BidiReply = {
  /** The model's spoken answer, PCM16 mono 24 kHz, concatenated in arrival order. */
  pcm: Uint8Array;
  /** What the server heard (inputTranscription) and what it said (outputTranscription). */
  heard: string;
  said: string;
  /** One entry per completed turn, in order. */
  usage: Array<Delta["usage"]>;
  turns: number;
  closedBecause: string;
};

/**
 * A spoken exchange with a native-audio DIALOGUE model: PCM in, PCM out, N turns.
 *
 * PROVEN LIVE 2026-09-06 against gemini-3.1-flash-live-preview — three turns in 17.4 s,
 * 460,834 bytes of 24 kHz PCM16 back (9.60 s of audio, peak amplitude 26,822, confirmed
 * by ffprobe as pcm_s16le/24000/1ch), with `outputTranscription` narrating the reply
 * ("Acknowledged. I'm ready for your questions or instructions.") and a usageMetadata
 * frame on every turn.
 *
 * The audio is RETURNED, never played: whether a live call plays it is the caller's
 * decision, and this function is also how a test proves the bytes are real without
 * making noise.
 */
export async function converseBidi(
  pcm: Uint8Array,
  o: Omit<BidiOpts, "modalities" | "manualActivity"> & { turns?: number; rate?: number; onEvent?: (kind: "heard" | "said" | "info", text: string) => void },
): Promise<BidiReply> {
  // AUDIO because the dialogue models refuse TEXT (1007), and manual activity because
  // their automatic detector never ends an utterance. Both are measured, not preferences.
  const session = new BidiSession({ ...o, modalities: ["AUDIO"], manualActivity: true, transcribeInput: true, transcribeOutput: true });
  const say = o.onEvent ?? (() => {});
  const want = Math.max(1, o.turns ?? 1);
  const rate = o.rate ?? 16_000;
  await session.open();
  say("info", `speaking with ${o.model}`);

  const audio: Uint8Array[] = [];
  const heard: string[] = [];
  const said: string[] = [];
  const usage: Array<Delta["usage"]> = [];
  let turn = 0;

  const feed = () => {
    turn += 1;
    session.beginAudio();
    const chunk = 3_200;                      // 100 ms at 16 kHz mono PCM16
    for (let i = 0; i < pcm.length; i += chunk) session.sendAudio(pcm.subarray(i, i + chunk), rate);
    session.endAudio();
  };
  feed();

  const deadline = setTimeout(() => session.close(), o.timeoutMs ?? 90_000);
  try {
    for await (const ev of session.events()) {
      if (ev.kind === "audio") audio.push(ev.pcm);
      else if (ev.kind === "transcript") {
        if (ev.of === "input") { heard.push(ev.text); say("heard", ev.text); }
        // Output transcription streams word by word, so it accumulates rather than replaces.
        else { said.push(ev.text); say("said", ev.text); }
      } else if (ev.kind === "turn") {
        // usageMetadata lands on the turnComplete frame here, ~2.5 s after the audio ends.
        usage.push(ev.usage);
        if (turn >= want) break;
        feed();
      } else if (ev.kind === "error") throw new Error(ev.error);
    }
  } finally { clearTimeout(deadline); session.close(); }

  const total = audio.reduce((n, a) => n + a.length, 0);
  const pcmOut = new Uint8Array(total);
  let at = 0;
  for (const a of audio) { pcmOut.set(a, at); at += a.length; }
  return {
    pcm: pcmOut,
    heard: heard.join(" ").replace(/\s+/g, " ").trim(),
    said: said.join("").replace(/\s+/g, " ").trim(),
    usage, turns: turn, closedBecause: session.closedBecause,
  };
}

/** Text → 16 kHz mono PCM16, via the OS voice. The only way to hand these models a real
 *  utterance without a microphone, which is what makes `live-check` scriptable at all. */
export async function sayToPcm(text: string): Promise<Uint8Array> {
  const aiff = join(tmpdir(), `apiplan-gl-${process.pid}.aiff`);
  const raw = join(tmpdir(), `apiplan-gl-${process.pid}.pcm`);
  try {
    const spoke = Bun.spawn(["say", "-o", aiff, text], { stdout: "ignore", stderr: "pipe" });
    if (await spoke.exited !== 0) throw new Error("`say` could not synthesize the check phrase (macOS only).");
    const conv = Bun.spawn(["ffmpeg", "-v", "error", "-i", aiff, "-ar", "16000", "-ac", "1", "-f", "s16le", raw, "-y"], { stdout: "ignore", stderr: "pipe" });
    if (await conv.exited !== 0) throw new Error("ffmpeg could not convert the check phrase — install ffmpeg (`brew install ffmpeg`).");
    return new Uint8Array(readFileSync(raw));
  } finally {
    for (const f of [aiff, raw]) { try { unlinkSync(f); } catch {} }
  }
}

export type GeminiLiveCheck = {
  heard?: string;
  said?: string;
  audioBytes?: number;
  peakPcm16?: number;
  seconds?: number;
  wav?: string;
  turns?: number;
  usage: Array<Delta["usage"]>;
  /** promptTokenCount − cachedContentTokenCount per turn: the inclusive partition made
   *  explicit, so a reader sees whether ANY of the prompt was served from cache. */
  uncachedInput: Array<number | undefined>;
  elapsedMs: number;
  closedBecause: string;
};

/**
 * A bounded, real exchange with one Gemini live model — what `apiplan live-check
 * --live-model gemini-live` runs.
 *
 * It cannot be the Realtime check ("read this sentence back"), because these models refuse
 * a text modality; so it synthesizes the phrase, feeds it as audio, and reports what came
 * back. The two shapes correspond to the two proven capabilities: a dictation model
 * answers with a transcript, a dialogue model answers with speech (whose bytes are
 * verified for real amplitude, then written to a .wav only when `--out` asks — a check
 * must never make noise or litter).
 */
export async function checkGeminiLive(
  model: { id: string; capabilities: { dictation: boolean } },
  text: string,
  o: { out?: string; timeoutMs?: number } = {},
): Promise<GeminiLiveCheck> {
  const started = Date.now();
  const pcm = await sayToPcm(text);

  if (model.capabilities.dictation) {
    const result = await transcribeBidi(pcm, { model: model.id, timeoutMs: o.timeoutMs ?? 30_000 });
    if (!result.text) throw new Error(`gemini live returned no transcription (closed ${result.closedBecause || "without a reason"}).`);
    const usage = result.usage ? [result.usage] : [];
    return { heard: result.text, usage, uncachedInput: usage.map(uncachedInput), elapsedMs: Date.now() - started, closedBecause: result.closedBecause };
  }

  const reply = await converseBidi(pcm, { model: model.id, timeoutMs: o.timeoutMs ?? 60_000, transcribeOutput: true });
  let peak = 0;
  for (let i = 0; i + 1 < reply.pcm.length; i += 2) {
    peak = Math.max(peak, Math.abs(Buffer.from(reply.pcm.buffer, reply.pcm.byteOffset + i, 2).readInt16LE(0)));
  }
  // Silence is a FAILURE, not a pass with zero bytes — the same rule the Realtime check
  // applies ("returned only silent audio"). A socket that completes a turn and delivers
  // nothing audible has not proven the transport.
  if (!reply.pcm.length || !peak) throw new Error(`gemini live returned no audible audio (${reply.pcm.length} bytes, closed ${reply.closedBecause || "without a reason"}).`);
  const wav = o.out ? (writeFileSync(o.out, pcm16Wav(reply.pcm, 24_000)), o.out) : undefined;
  return {
    heard: reply.heard || undefined,
    said: reply.said || undefined,
    audioBytes: reply.pcm.length,
    peakPcm16: peak,
    seconds: Number((reply.pcm.length / 48_000).toFixed(2)),   // 24 kHz mono PCM16 = 48,000 B/s
    ...(wav ? { wav } : {}),
    turns: reply.turns,
    usage: reply.usage,
    uncachedInput: reply.usage.map(uncachedInput),
    elapsedMs: Date.now() - started,
    closedBecause: reply.closedBecause,
  };
}
