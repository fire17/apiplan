// talk.ts — a spoken conversation with the model: microphone in, voice out, on the
// subscription. The realtime socket already carries audio both ways (see providers.ts);
// this adds the two ends ffmpeg gives us and the turn-taking in between.
//
// Turn-taking is the server's job: `server_vad` means OpenAI decides when you stopped
// talking, so there is no push-to-talk and no silence heuristic of our own to get wrong.
import { openai } from "./providers.ts";
import { micCommand, speakerCommand } from "./platform.ts";

const RATE = 24000;

export type TalkOpts = {
  model?: string;
  voice?: string;
  /** Persona / behaviour for the whole conversation, not one line. */
  direction?: string;
  /** Speak first instead of waiting to be spoken to. `true` opens using the persona's
   *  own instructions; a string is a one-off direction for the opening line only. */
  greet?: boolean | string;
  /** Let your voice cut the model off mid-sentence. Needs headphones — on speakers the
   *  model hears itself through the microphone and interrupts itself forever. */
  barge?: boolean;
  /** Phrases that end the call. When your transcribed turn contains one (as a whole
   *  word), the model says a short goodbye and the conversation closes. Default off. */
  hangup?: string[];
  onEvent?: (kind: "you" | "model" | "info", text: string) => void;
};

export async function talk(o: TalkOpts = {}): Promise<void> {
  const mic = micCommand(RATE);
  const spk = speakerCommand(RATE);
  if (!mic) throw new Error("no microphone capture available — install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`).");
  if (!spk) throw new Error("no audio playback available — ffplay ships with ffmpeg; install it.");

  const c = openai.creds();
  const model = o.model || process.env.APIPLAN_REALTIME_MODEL || "gpt-realtime";
  const say = o.onEvent ?? (() => {});

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${c.token}` },
  } as any);

  // Whisper finishes transcribing your turn AFTER the model has already answered, so
  // printing each line as it arrives shows the reply above the question. Hold the reply
  // until your line is printed — with a timeout, so a missing transcript can't eat it.
  let pendingReply: string | null = null;
  let replyTimer: ReturnType<typeof setTimeout> | null = null;
  const flushReply = () => {
    if (replyTimer) { clearTimeout(replyTimer); replyTimer = null; }
    if (pendingReply) { say("model", pendingReply); pendingReply = null; }
  };

  // A whole-word match against the hangup phrases, punctuation-insensitive, so "Okay,
  // bye!" ends the call but "goodbyes are hard" (contains "goodbye"? no — word boundary)
  // and "combine" (contains "bye"? no — word boundary) do not.
  const hangupWords = (o.hangup ?? []).map((p) => p.toLowerCase().trim()).filter(Boolean);
  const isHangup = (text: string) => {
    const norm = ` ${text.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim()} `;
    return hangupWords.some((p) => norm.includes(` ${p} `));
  };
  let closing = false;
  let firstAudioReported = false;

  let greeted = false;
  // Audio arrives far faster than it plays, so "the model stopped generating" is NOT
  // "the speaker stopped making noise". Muting on generation-end reopened the mic while
  // seconds of reply were still coming out of the speaker — which the mic then captured
  // and Whisper transcribed as the user talking. Track the playback clock instead.
  let playingUntil = 0;
  const queueAudio = (bytes: number) => {
    playingUntil = Math.max(playingUntil, Date.now()) + (bytes / 2 / RATE) * 1000;
  };
  const stillAudible = () => Date.now() < playingUntil + 250;   // + a little room for the speaker's own latency
  let player: ReturnType<typeof Bun.spawn> | null = null;
  let speaking = false;          // the model currently has audio in flight
  let playerChecked = false;
  const startPlayer = () => {
    player = Bun.spawn(spk, { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
    // A player that dies on startup is indistinguishable from silence, so check once
    // and say so. (A wrong flag killed it instantly and the whole thing looked mute.)
    if (!playerChecked) {
      playerChecked = true;
      const p = player;
      setTimeout(() => {
        if (p.exitCode !== null && p.exitCode !== 0) say("info", `audio player exited (${p.exitCode}) — you will hear nothing; check ffplay`);
      }, 700);
    }
  };
  /** End of a reply: close stdin so the player drains what is queued, then exits. */
  const endPlayer = () => {
    try { player?.stdin?.flush?.(); } catch {}
    try { player?.stdin?.end?.(); } catch {}
    player = null;                 // the next reply spawns a fresh one, with a fresh clock
  };
  /** Barge-in: kill it mid-word, discarding whatever is still queued. */
  const stopPlayer = () => {
    try { player?.kill(); } catch {}
    player = null;
  };

  const micProc = Bun.spawn(mic, { stdout: "pipe", stderr: "ignore" });

  const close = () => {
    try { ws.close(); } catch {}
    try { micProc.kill(); } catch {}
    stopPlayer();
  };
  process.on("SIGINT", () => { close(); process.exit(0); });

  await new Promise<void>((resolve) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          ...(o.direction ? { instructions: o.direction } : {}),
          audio: {
            input: {
              format: { type: "audio/pcm", rate: RATE },
              transcription: { model: "whisper-1" },
              // 0.5 was low enough that room noise opened a turn, and Whisper answers
              // near-silence with a canned hallucination ("Thank you for watching.").
              // A higher bar plus a longer pause means a turn needs actual speech.
              turn_detection: { type: "server_vad", threshold: 0.65, prefix_padding_ms: 300, silence_duration_ms: 800 },
            },
            output: { voice: o.voice || "cedar", format: { type: "audio/pcm", rate: RATE } },
          },
        },
      }));
      say("info", o.greet ? "connecting — it will speak first. Ctrl-C to stop." : "listening — speak, and it answers. Ctrl-C to stop.");
      pumpMic();
    };

    // Microphone → socket. While the model is speaking we stop sending, unless barge-in
    // was asked for: on speakers its own voice re-enters the microphone and it
    // interrupts itself in a loop.
    async function pumpMic() {
      const reader = micProc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (stillAudible() && !o.barge) continue;
          if (ws.readyState !== WebSocket.OPEN) break;
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.from(value).toString("base64") }));
        }
      } catch { /* the socket or the mic went away; onclose handles it */ }
    }

    ws.onmessage = (e: any) => {
      let ev: any;
      try { ev = JSON.parse(String(e.data)); } catch { return }
      switch (ev.type) {
        case "session.updated":
          // Only now are the instructions live, so an opening line spoken before this
          // would be in the default assistant persona rather than yours.
          if (o.greet && !greeted) {
            greeted = true;
            ws.send(JSON.stringify({ type: "response.create",
              ...(typeof o.greet === "string" ? { response: { instructions: o.greet } } : {}) }));
          }
          break;
        case "input_audio_buffer.speech_started":
          // Barge-in: drop whatever is still queued so the model stops mid-word.
          if (speaking && o.barge) { stopPlayer(); startPlayer(); speaking = false; playingUntil = 0; }
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (ev.transcript?.trim()) say("you", ev.transcript.trim());
          flushReply();
          if (!closing && ev.transcript && isHangup(ev.transcript)) {
            closing = true;
            say("info", "heard a goodbye — closing after the reply");
            // Let it sign off in its own voice, then the response.done below hangs up.
            ws.send(JSON.stringify({ type: "response.create",
              response: { instructions: "The person is ending the call. Say a brief, warm goodbye in one short sentence and nothing else." } }));
          }
          break;
        case "response.output_audio.delta":
        case "response.audio.delta":
          if (ev.delta) {
            // First audible byte: report latency from an externally-supplied start
            // stamp (LX_T0_MS), so a launcher can measure call → first spoken word.
            if (!firstAudioReported) {
              firstAudioReported = true;
              const t0 = Number(process.env.LX_T0_MS);
              if (t0 > 0) say("info", `first word in ${Date.now() - t0}ms`);
            }
            speaking = true;
            if (!player) startPlayer();
            // flush(): Bun's stdin is a buffered sink, so without it the audio sits in
            // the buffer instead of reaching the speaker.
            const buf = Buffer.from(ev.delta, "base64");
            queueAudio(buf.length);
            try { player!.stdin!.write(buf); player!.stdin!.flush?.(); } catch {}
          }
          break;
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done":
          if (ev.transcript?.trim()) {
            pendingReply = ev.transcript.trim();
            replyTimer = setTimeout(flushReply, 4000);   // transcript never came; print anyway
          }
          break;
        case "response.done":
          speaking = false;
          endPlayer();
          if (closing) {
            // Give the queued goodbye audio time to drain out of the speaker, then hang up.
            setTimeout(() => { say("info", "goodbye — call ended"); close(); resolve(); }, Math.max(0, playingUntil - Date.now()) + 400);
          }
          break;
        case "error":
          say("info", `error: ${ev.error?.message ?? "unknown"}`);
          break;
      }
    };
    ws.onerror = () => { say("info", "connection failed"); close(); resolve(); };
    ws.onclose = () => { close(); resolve(); };
  });
}
