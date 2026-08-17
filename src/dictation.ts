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
import { anthropic, openai } from "./providers.ts";

export type DictateOpts = {
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
  const mic = audioSource(OAI_RATE);
  if (!mic) throw new Error("no microphone capture available — install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`).");
  const c = openai.creds();
  const say = o.onEvent ?? (() => {});
  const model = process.env.APIPLAN_REALTIME_MODEL || "gpt-realtime";
  const stt = process.env.APIPLAN_STT_MODEL || "gpt-4o-transcribe";

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${c.token}` },
  } as any);

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
              turn_detection: { type: "server_vad", threshold: 0.65, prefix_padding_ms: 300, silence_duration_ms: 700, create_response: false, interrupt_response: false },
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
