// dictation.ts — speech-to-text from the microphone, on the subscription.
//
// The Claude Code login covers a real streaming STT endpoint: the same WebSocket the
// Claude Code CLI (and ccvoice) dictate through. One socket per dictation, PCM16 in,
// transcript events out. Nothing is billed per token and no API key is ever read —
// the same contract as every other command here.
//
// The wire contract (measured live, 2026-08-16, and by ccvoice daily since July):
//   * `TranscriptInterim` / `TranscriptText` carry the text in a field named `data` —
//     not `text` — and each is the WHOLE current utterance so far (a REPLACE, never an
//     append; appending duplicates words).
//   * `TranscriptText` is the utterance's final form; `TranscriptEndpoint` closes the
//     utterance window — after it, the next event starts a fresh utterance.
//   * Every teardown MUST send {"type":"CloseStream"} first. A silently-closed socket
//     pins the account's stream cap and the NEXT dictation dies at connect (code 4029).
//   * The endpointer settles on audio time, not wall time: closing right after the
//     last word clips it ("commit." → "can"). Half a second of zero-PCM before
//     CloseStream cures it and costs nothing audible.
import { micCommand } from "./platform.ts";
import { anthropic, openai, openRealtime } from "./providers.ts";
import { resolveLiveModel, requireLiveCapability } from "./live-models.ts";

export type DictateOpts = {
  model?: string;
  /** Which subscription transcribes: "anthropic" (default) or "openai". */
  provider?: "anthropic" | "openai";
  /** BCP-47-ish language hint. Anthropic's engine takes one pinned language. */
  lang?: string;
  /** Stop by yourself after this many seconds of silence (0 = only Enter/Ctrl-C stops). */
  silenceStop?: number;
  onEvent?: (kind: "interim" | "settle" | "info", text: string) => void;
};

const RATE = 16000;       // Anthropic's linear16 contract
const OAI_RATE = 24000;   // realtime's floor — it rejects anything below 24 kHz
const PAD_MS = 500;

/**
 * The audio source. Normally the microphone; APIPLAN_DICTATE_INPUT=<file> replays a
 * recording at realtime pace instead (-re), which is how this file is tested at all —
 * a mic cannot be scripted, a wav can.
 */
function audioSource(rate: number): string[] | null {
  const f = process.env.APIPLAN_DICTATE_INPUT;
  if (f) return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-i", f,
    "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"];
  return micCommand(rate);
}

/** One dictation: mic → socket → final transcript. Resolves with the full text. */
export function dictate(o: DictateOpts = {}): Promise<string> {
  // A Gemini live id selects by MODEL rather than by `provider`, because it is a third
  // transport rather than a third subscription: the two providers above are a
  // subscription each, and this one is an API key. Routing on the resolved transport is
  // what stops `--dictate --live-model gemini-transcribe-live` from opening an OpenAI
  // socket to a Google model — the exact failure realtimeModelId() refuses for talk.
  if (o.model && resolveLiveModel(o.model).transport === "gemini-bidi") return dictateGeminiBidi(o);
  return (o.provider === "openai" ? dictateOpenAI : dictateAnthropic)(o);
}

/** Read raw keys from the tty so a bare Enter ends the dictation (q and Esc too). */
function stopKeys(onStop: () => void): () => void {
  if (!process.stdin.isTTY) return () => {};
  try { process.stdin.setRawMode?.(true); } catch { return () => {}; }
  const h = (b: Buffer) => {
    const c = b[0];
    if (c === 0x0d || c === 0x0a || c === 0x1b || c === 0x71 || c === 0x03) onStop();
  };
  process.stdin.on("data", h);
  process.stdin.resume();
  return () => { try { process.stdin.setRawMode?.(false); } catch {} process.stdin.off("data", h); process.stdin.pause(); };
}

// ─────────────────────────── Anthropic (Claude Code subscription) ───────────────────────────

function dictateAnthropic(o: DictateOpts): Promise<string> {
  const mic = audioSource(RATE);
  if (!mic) throw new Error("no microphone capture available — install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`).");
  const c = anthropic.creds();
  const say = o.onEvent ?? (() => {});
  const lang = o.lang || "en";

  const qs = new URLSearchParams({
    encoding: "linear16", sample_rate: String(RATE), channels: "1",
    endpointing_ms: "300", utterance_end_ms: "1000", language: lang,
    use_conversation_engine: "true", stt_provider: "deepgram-nova3",
    // ~290ms faster to the first word than the default interim mode. Measured.
    forward_interims: "typed",
  });
  const base = process.env.APIPLAN_ANTHROPIC_BASE?.replace(/^http/, "ws") || "wss://api.anthropic.com";
  const ws = new WebSocket(`${base}/api/ws/speech_to_text/voice_stream?${qs}`, {
    // The subscription token is only accepted for Claude Code traffic — same law as chat.
    headers: { Authorization: `Bearer ${c.token}`, "x-app": "cli", "anthropic-client-platform": "cli" },
  } as any);

  return new Promise<string>((resolve, reject) => {
    const settled: string[] = [];
    let live = "";
    let lastSpokeAt = Date.now();
    let stopping = false;
    let micProc: ReturnType<typeof Bun.spawn> | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    let silenceTimer: ReturnType<typeof setInterval> | null = null;
    let restoreKeys = () => {};

    const finalText = () => [...settled, live].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const cleanup = () => {
      if (keepAlive) clearInterval(keepAlive);
      if (silenceTimer) clearInterval(silenceTimer);
      restoreKeys();
      try { micProc?.kill(); } catch {}
      try { ws.close(); } catch {}
    };
    // The transcript survives every exit path — a dictation whose words vanish on a
    // hiccup teaches you to never trust it. Even an error resolves with what was heard.
    const finish = () => { const t = finalText(); cleanup(); resolve(t); };

    const stop = () => {
      if (stopping) return;
      stopping = true;
      say("info", "finishing…");
      try {
        // Silence pad first (the endpointer needs audio time to settle the last word),
        // then the mandatory CloseStream. The server answers by closing the socket.
        ws.send(new Uint8Array(RATE * 2 * PAD_MS / 1000));
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch { finish(); return; }
      setTimeout(finish, 4000);          // server never closed — take what we have
    };

    ws.onopen = () => {
      say("info", `listening (${lang}) — Enter finishes, Ctrl-C too`);
      restoreKeys = stopKeys(stop);
      process.on("SIGINT", stop);
      micProc = Bun.spawn(mic, { stdout: "pipe", stderr: "ignore" });
      (async () => {
        const reader = micProc!.stdout.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done || stopping) break;
            if (ws.readyState !== WebSocket.OPEN) break;
            ws.send(value);
          }
        } catch { /* mic or socket went away; close handlers own it */ }
      })();
      // The server drops a quiet stream; a KeepAlive every 8s holds it open through
      // thinking pauses. (Same interval Claude Code itself uses.)
      keepAlive = setInterval(() => { try { ws.send(JSON.stringify({ type: "KeepAlive" })); } catch {} }, 8000);
      if (o.silenceStop && o.silenceStop > 0) {
        silenceTimer = setInterval(() => {
          if (!stopping && Date.now() - lastSpokeAt > o.silenceStop! * 1000 && finalText()) stop();
        }, 500);
      }
    };

    ws.onmessage = (e: any) => {
      let ev: any;
      try { ev = JSON.parse(String(e.data)); } catch { return; }
      switch (ev.type) {
        case "TranscriptInterim":
        case "TranscriptText":
          live = String(ev.data ?? "").trim();
          if (live) { lastSpokeAt = Date.now(); say("interim", [...settled, live].filter(Boolean).join(" ")); }
          break;
        case "TranscriptEndpoint":
          if (live) { settled.push(live); live = ""; say("settle", settled.join(" ")); }
          break;
        case "Error":
          say("info", `stream error: ${ev.message ?? JSON.stringify(ev).slice(0, 120)}`);
          break;
      }
    };
    ws.onerror = () => { if (!stopping) { cleanup(); reject(new Error("dictation connection failed — is the Claude login fresh? (`claude`)")); } };
    // 4029 here means an earlier client died without CloseStream; the cap resets on its own.
    ws.onclose = (e: any) => {
      if (stopping) return finish();
      const t = finalText();
      if (t) { cleanup(); return resolve(t); }
      cleanup();
      reject(new Error(`dictation closed early (${e?.code ?? "?"}) ${String(e?.reason ?? "").slice(0, 120)}`));
    };
  });
}

// ─────────────────────────── OpenAI (Codex / ChatGPT subscription) ───────────────────────────

/**
 * The same realtime socket `talk` speaks through also transcribes: a session with
 * input transcription on and no responses ever created is a dictation machine. The
 * ChatGPT token is accepted exactly as in talk.ts (GA shape — no OpenAI-Beta header),
 * `server_vad` settles the utterances, and `conversation.item.input_audio_transcription
 * .completed` carries each settled line. gpt-4o-transcribe streams interim deltas too.
 */
function dictateOpenAI(o: DictateOpts): Promise<string> {
  const selected = resolveLiveModel(o.model);
  requireLiveCapability(selected, "dictation");
  const mic = audioSource(OAI_RATE);
  if (!mic) throw new Error("no microphone capture available — install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`).");
  const c = openai.creds();
  const say = o.onEvent ?? (() => {});
  const model = selected.id;
  const stt = process.env.APIPLAN_STT_MODEL || "gpt-4o-transcribe";

  const ws = openRealtime(c.token, model);

  return new Promise<string>((resolve, reject) => {
    const settled: string[] = [];
    let live = "";
    let lastSpokeAt = Date.now();
    let stopping = false;
    let micProc: ReturnType<typeof Bun.spawn> | null = null;
    let silenceTimer: ReturnType<typeof setInterval> | null = null;
    let restoreKeys = () => {};

    const finalText = () => [...settled, live].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const cleanup = () => {
      if (silenceTimer) clearInterval(silenceTimer);
      restoreKeys();
      try { micProc?.kill(); } catch {}
      try { ws.close(); } catch {}
    };
    const finish = () => { const t = finalText(); cleanup(); resolve(t); };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      say("info", "finishing…");
      // Whisper may still be transcribing the last turn — give it a moment to land.
      setTimeout(finish, 1500);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          // Dictation wants no reply: text-only modalities and interrupt_response off
          // keep the model silent; we simply never send response.create.
          output_modalities: ["text"],
          audio: {
            input: {
              // 16 kHz is rejected outright ("integer_below_min_value, expected >= 24000")
              // and the rejection kills the whole session.update — so 24 kHz, always.
              format: { type: "audio/pcm", rate: OAI_RATE },
              transcription: { model: stt, ...(o.lang ? { language: o.lang } : {}) },
              // The transcription of an utterance only STARTS once server_vad closes it —
              // deltas then burst out all at once. There are no word-live interims on this
              // endpoint, so the one speed knob is how fast an utterance closes: 500ms of
              // silence (down from 700) settles noticeably sooner without splitting words.
              // APIPLAN_STT_MODEL=gpt-4o-mini-transcribe trades a little accuracy for speed.
              turn_detection: { type: "server_vad", threshold: 0.65, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: false, interrupt_response: false },
            },
          },
        },
      }));
    };

    ws.onmessage = (e: any) => {
      let ev: any;
      try { ev = JSON.parse(String(e.data)); } catch { return; }
      switch (ev.type) {
        case "session.updated":
          say("info", `listening (${stt}${o.lang ? ", " + o.lang : ""}) — Enter finishes, Ctrl-C too`);
          restoreKeys = stopKeys(stop);
          process.on("SIGINT", stop);
          micProc = Bun.spawn(mic, { stdout: "pipe", stderr: "ignore" });
          (async () => {
            const reader = micProc!.stdout.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done || stopping) break;
                if (ws.readyState !== WebSocket.OPEN) break;
                ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.from(value).toString("base64") }));
              }
            } catch { /* handled by close */ }
          })();
          if (o.silenceStop && o.silenceStop > 0) {
            silenceTimer = setInterval(() => {
              if (!stopping && Date.now() - lastSpokeAt > o.silenceStop! * 1000 && finalText()) stop();
            }, 500);
          }
          break;
        case "conversation.item.input_audio_transcription.delta":
          if (ev.delta) { live += ev.delta; lastSpokeAt = Date.now(); say("interim", [...settled, live.trim()].filter(Boolean).join(" ")); }
          break;
        case "conversation.item.input_audio_transcription.completed": {
          const t = String(ev.transcript ?? "").trim();
          live = "";
          if (t) { settled.push(t); lastSpokeAt = Date.now(); say("settle", settled.join(" ")); }
          break;
        }
        case "error":
          // Before the session is accepted, an error means dictation never starts —
          // this exact hang shipped once (the 16 kHz rejection): reject, don't wait.
          if (!micProc && !stopping) { cleanup(); reject(new Error(`realtime session refused: ${ev.error?.message ?? "unknown"}`)); }
          else say("info", `error: ${ev.error?.message ?? "unknown"}`);
          break;
      }
    };
    ws.onerror = () => { if (!stopping) { cleanup(); reject(new Error("dictation connection failed — is the Codex login fresh? (`codex`)")); } };
    ws.onclose = (e: any) => {
      if (stopping) return finish();
      const t = finalText();
      if (t) { cleanup(); return resolve(t); }
      cleanup();
      reject(new Error(`dictation closed early (${e?.code ?? "?"}) ${String(e?.reason ?? "").slice(0, 120)}`));
    };
  });
}

// ─────────────────────────── Google Gemini Live (BidiGenerateContent) ───────────────────────────

/**
 * Dictation over Gemini's Live socket. A THIRD transport, not a third provider: it
 * authenticates with a Gemini API key rather than a subscription token, and speaks
 * BidiGenerateContent rather than either STT protocol above.
 *
 * PROVEN LIVE 2026-09-06 against gemini-3.5-transcribe-live: 3.4 s of 16 kHz mono PCM16
 * came back as two `interimInputTranscription` events and one final `inputTranscription`
 * 1.7 s after setup. Same 16 kHz rate as the Anthropic path, so `audioSource` and its
 * APIPLAN_DICTATE_INPUT file-replay seam are reused unchanged — which is also how this
 * path is testable at all, since a microphone cannot be scripted.
 *
 * The mic is read to EXHAUSTION and then transcribed in one bounded exchange, rather than
 * streamed live. That is honest about what was measured: the server's automatic detector
 * settles this model reliably at the END of an utterance, and a Ctrl-C-able infinite
 * streaming session was never driven. So this serves a bounded clip — a file replay, or a
 * mic run stopped by Enter — and does not pretend to be an open-ended session.
 */
async function dictateGeminiBidi(o: DictateOpts): Promise<string> {
  const selected = resolveLiveModel(o.model);
  requireLiveCapability(selected, "dictation");
  const source = audioSource(RATE);
  if (!source) throw new Error("no microphone capture available — install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`).");
  const say = o.onEvent ?? (() => {});

  const proc = Bun.spawn(source, { stdout: "pipe", stderr: "ignore" });
  const chunks: Uint8Array[] = [];
  let stopped = false;
  const restoreKeys = stopKeys(() => { stopped = true; try { proc.kill(); } catch {} });
  say("info", `capturing for ${selected.id} — Enter finishes`);
  try {
    const reader = proc.stdout.getReader();
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally { restoreKeys(); try { proc.kill(); } catch {} }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (!total) throw new Error("captured no audio — is the microphone working? (macOS: check the terminal's mic permission)");
  const pcm = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { pcm.set(c, at); at += c.length; }

  const { transcribeBidi } = await import("./gemini-live.ts");
  const result = await transcribeBidi(pcm, {
    model: selected.id,
    onEvent: (kind, text) => say(kind, text),
  });
  return result.text;
}
