// talk.ts — a spoken conversation with the model: microphone in, voice out, on the
// subscription. The realtime socket already carries audio both ways (see providers.ts);
// this adds the two ends ffmpeg gives us and the turn-taking in between.
//
// Turn-taking is the server's job: `server_vad` means OpenAI decides when you stopped
// talking, so there is no push-to-talk and no silence heuristic of our own to get wrong.
import { openai, openRealtime, speakRealtime } from "./providers.ts";
import { micCommand, speakerCommand, ensureDir, stereoEnabled, initStereo, panChunk, panReset, panGains, stereoRecheck, voiceGain, trimMono } from "./platform.ts";
import { dirname, basename } from "node:path";
import { unlinkSync } from "node:fs";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { VpCapture, type VpEvent } from "./aec.ts";

const RATE = 24000;

/** How a call ended — callers (the daemon, /lx) stream a richer end-event from this. */
export type TalkResult = {
  reason: "hangup" | "timeout" | "mic-lost" | "error" | "closed";
  detail?: string;
};

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
  /** Append every event as one JSON line to this file (also `APIPLAN_TALK_LOG`), flushed
   *  as it happens — so a launcher can TAIL the conversation live, and failures are
   *  diagnosable after the fact. Never contains audio bytes or the auth token. */
  logFile?: string;
  /** Realtime function-tool definitions ({type:"function", name, description, parameters}).
   *  Only names declared here are ever dispatched — the allow-list is structural. */
  tools?: Array<Record<string, unknown>>;
  /** Executes one declared tool. talk() itself never runs shell/eval — whatever this
   *  does is the caller's code, and only names present in `tools` reach it. */
  // May return a string, or a structured value that is JSON-serialized before it reaches the model.
  onTool?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  /** A pre-opened realtime WebSocket owned by the caller (the warm daemon's parked
   *  socket). May already be OPEN — talk() must not wait for onopen in that case. */
  socket?: WebSocket;
  /** The caller already sent session.update and saw session.updated (parked socket).
   *  talk() skips the connect-time config and fires the greeting from the open path,
   *  carrying the persona in response.instructions so the park stays generic. */
  skipSessionUpdate?: boolean;
  /** default true = install process signal/exit handlers (the CLI path). false = a
   *  long-lived daemon calls talk() repeatedly; per-call process.on handlers would
   *  accumulate and an uncaughtException rethrow would take the whole daemon down. */
  manageSignals?: boolean;
  onEvent?: (kind: "you" | "model" | "info", text: string) => void;
  /** Inbound control channel: a file that other processes (e.g. a set_monitor watcher)
   *  append `{text, mode}` lines to. Each becomes context spoken INTO the live call —
   *  mode "graceful" waits for the current sentence to finish, "interrupt" barges in.
   *  Defaults to `<logFile>.inject`; also exported as APIPLAN_TALK_INJECT for tools. */
  injectFile?: string;
};

export async function talk(o: TalkOpts = {}): Promise<TalkResult> {
  const mic = micCommand(RATE);
  // LiveMind stereo voice field (canon 023): the MOUTH leans right, the MIND leans left.
  // The interleave happens in-process (panChunk) so his knob is live — the player only
  // needs to be told the layout. LIVEMIND_STEREO=0 restores the exact mono path of before.
  const stereo = stereoEnabled();
  const spk = speakerCommand(RATE, stereo ? "stereo" : "mono");
  if (!mic) throw new Error("no microphone capture available — install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`).");
  if (!spk) throw new Error("no audio playback available — ffplay ships with ffmpeg; install it.");

  // ── DUPLEX BARGE-IN (--barge / LM_BARGE=1) IS OFF BY DEFAULT (call 31192, 2026-08-20) ──
  // Duplex barge leaves the mic OPEN while the mouth plays, so on speakers our own voice
  // reaches the server VAD and the speech_started handler cancels the reply we are still
  // speaking. Measured in call 31192, the FIRST live run with it on: 40 self-cuts, every one
  // of them within 200ms of an input_audio_buffer.speech_started, the greeting cut 688ms in,
  // seven times over — and the leak then transcribed as a `you` turn, so the mouth answered
  // itself for ~30 turns. The flag alone therefore no longer switches duplex on: it also
  // needs APIPLAN_BARGE_OK=1, an explicit "I am on headphones" from whoever starts the call.
  // OFF-BY-DEFAULT STAYS until ONE live call runs duplex with zero self-cuts; when that call
  // exists, drop the env requirement — never the evidence gate in speech_started.
  // The LOCAL mouth-barge (canon 027, further down) is untouched by this: it is the
  // no-duplex path and it never even ran in 31192 (`stillAudible() && !o.barge` skipped it),
  // which is why that call's log carries zero "mouth interrupted" lines.
  // `let`, not `const`: the self-disarm belt below retreats a duplex call to half-duplex
  // when its cuts stop being followed by anything he said (redteam S3).
  let bargeOn = !!o.barge && process.env.APIPLAN_BARGE_OK === "1";
  const c = openai.creds();
  const model = o.model || process.env.APIPLAN_REALTIME_MODEL || "gpt-realtime";
  // gpt-4o-mini-transcribe hallucinates far less than whisper-1 on near-silence; override
  // via env if a deployment needs whisper-1 back.
  const transcribeModel = process.env.APIPLAN_TRANSCRIBE || "gpt-4o-mini-transcribe";

  // Structured event log: one JSON line per event, flushed immediately. A launcher TAILS
  // this for live monitoring, and it is how every reliability fix gets verified. Never
  // write audio bytes or the bearer token here.
  const logPath = o.logFile || process.env.APIPLAN_TALK_LOG || "";
  let logw: { write: (s: string) => void; flush?: () => void } | null = null;
  if (logPath) { try { ensureDir(dirname(logPath)); logw = Bun.file(logPath).writer(); } catch {} }
  const rec = (obj: Record<string, unknown>) => {
    if (!logw) return;
    // ENOSPC KILLED A LIVE CALL (63395, 19:54:29 — mid-word, mid-reply, on a disk at 100%).
    // The try/catch here is real but it only catches a SYNCHRONOUS throw. Bun's FileSink.flush()
    // returns a PROMISE, and a rejected promise nobody awaits becomes an unhandled rejection,
    // which reaches the uncaughtException handler below, which calls close() and rethrows. So
    // the highest-frequency write in the process — the log — could take the whole call down,
    // while archWrite/archRoll/saveMindState (all sync, all guarded) could not.
    // The log is EVIDENCE, never the conversation: losing a line is survivable, losing his call
    // mid-sentence is not. Same law the archive already states — "must never break the call".
    try {
      logw.write(JSON.stringify({ t: Date.now(), ...obj }) + "\n");
      const f = logw.flush?.() as any;
      if (f && typeof f.catch === "function") f.catch(() => {});   // ENOSPC / EIO: drop the line, keep the call
    } catch {}
  };
  const emit = o.onEvent ?? (() => {});
  // `extra` rides into the LOG event only, never into the emitted text — that is how a turn is
  // ANNOTATED without one of his words being changed, held, or dropped. SPREAD FIRST: the
  // canonical fields win, so an annotation is structurally incapable of altering what he said.
  // ROTATION CONTEXT CARRY (canon 024, requirement (b)): the tail of the conversation, in
  // memory, so a successor session can be SEEDED with what was actually said and the handover
  // stays invisible — no greeting reset, no lost thread. Bounded; never audio, never the token.
  // CLASSIFIED AT THE SOURCE (live defect, call 11776 — the MIND's design order: "the rotation
  // engine's session-seeding must FILTER control-instructions out of the seed, or re-apply the
  // CURRENT persona fresh instead of replaying old preloads"). A successor must inherit the
  // CONVERSATION and never the control plane, and the only place that difference is still KNOWN
  // is here, as the line is said: `he` is HIS voice (sacred — never filtered, never edited),
  // `mouth` is the model's own reply, `mind` is a MIND narrator line played through the voice.
  // Deciding it later from text alone would be guesswork; a field, decided at the source, is free.
  type Turn = { who: "he" | "mouth" | "mind"; text: string; echo?: boolean };
  const convTail: Turn[] = [];
  // True only while the MIND's own narrator line is being announced (see sendInjected). A flag,
  // not a new log field, so every existing jsonl record stays byte-identical.
  let mindNarrating = false;
  // When the MIND's own voice last spoke to him. The MIND answers through the narrator, which never
  // creates a response on this socket — so without this the answer watch would call a turn the MIND
  // answered "unanswered". A voice he heard is an answer, whichever half of the system produced it.
  let lastMindSpokeAt = 0;
  const say = (kind: "you" | "model" | "info", text: string, extra?: Record<string, unknown>) => {
    emit(kind, text); rec({ ...extra, ev: kind, text });
    if (kind !== "info" && text.trim()) {
      // THE SEED MIRRORS THE MODEL'S CONTEXT — no more, and never less. The ONE turn class the
      // engine removes from the model's context is the echo it deleted there (`conversation.item.
      // delete`, three belts agreeing, no residual): re-seeding that into a successor as something
      // HE said contradicts the deletion the engine already made. Everything else — including a
      // merely SUSPECT turn — stays, because flag-never-drop is this file's law for his words and
      // a suspect turn is still in the live model's context right now. Nothing is removed from the
      // log or the dashboard either way: this flag reaches the successor's context and nowhere else.
      convTail.push({ who: kind === "you" ? "he" : mindNarrating ? "mind" : "mouth", text: text.trim(),
        ...(kind === "you" && extra?.echo_deleted_from_context ? { echo: true } : {}) });
      if (convTail.length > 20) convTail.shift();
    }
  };
  // FRESH PERSONA — the second half of the same order. `o.direction` is the persona as it was at
  // LAUNCH and it is never mutated; a MIND {"session":…} swap changes only the live socket, so a
  // rotation seeded from o.direction silently REVERTS the persona to text that may be hours stale
  // (on 11776 that text still ordered the mouth to stay silent and still claimed he was out
  // walking, three hours after both stopped being true). This is what is actually in force.
  let livePersona = o.direction ?? "";
  let personaAt = Date.now();
  let personaSrc: "launch" | "mind" = "launch";
  /** Content fingerprint — two seeds can be compared in the log without either being logged. */
  const sha8 = (s: string) => { try { return createHash("sha256").update(s).digest("hex").slice(0, 8); } catch { return "?"; } };

  // Inbound control channel — where injected context (monitor reports, mid-call context)
  // is read from. Exported in the env so an in-process tool (set_monitor) knows where a
  // background watcher should append its triggers.
  const injectPath = o.injectFile || process.env.APIPLAN_TALK_INJECT || (logPath ? logPath + ".inject" : "");
  if (injectPath) process.env.APIPLAN_TALK_INJECT = injectPath;

  // `let`, not `const`: at a rotation the microphone, every response.create, the heartbeat, the
  // inject flush and the tool replies must ALL follow the new socket in one assignment. Every
  // `ws.` site in this file is therefore "the socket that is live right now" — see the ROTATION
  // block below close(), and the one rule that keeps it honest: inside a handler `sock` is who
  // spoke and `ws` is who may be spoken to; they are never conflated.
  let ws = o.socket ?? openRealtime(c.token, model);
  rec({ ev: "info", text: `talk start model=${model} voice=${o.voice || "cedar"}${o.socket ? " (parked socket)" : ""}${o.tools?.length ? ` tools=${o.tools.length}` : ""}` });
  // Which voice-field mode actually engaged (stereo / mono-sum / off) — a silently collapsed
  // field sounds exactly like a working one, so it is stated in the log at every call start.
  initStereo((m) => rec({ ev: "info", text: m }));
  // Forensics anchor: log the engine's git sha so log analysis never infers the running
  // code version from process start times (verified pain: 61139 judged on unshipped code).
  try {
    const sha = new TextDecoder().decode(Bun.spawnSync(["git", "-C", dirname(new URL(import.meta.url).pathname), "rev-parse", "--short", "HEAD"]).stdout).trim();
    if (sha) rec({ ev: "info", text: `engine ${sha}` });
  } catch { /* never block a call on git */ }

  // ── LANE 15 (canon 011): SPEECH SURVIVES A RESTART ───────────────────────────
  // fire17's law: a restart that cuts the mouth mid-sentence must not lose the sentence —
  // resume from where it stopped on the new call, and "הפה ידע מה הדבר האחרון שנאמר"
  // (the new mouth must know the last thing actually spoken).
  // Everything the engine knew about a MIND line — its text, how much of it was actually
  // HEARD, and what was still queued behind it — lived in memory and died with the call
  // (measured 2026-08-20: of 13 real calls, 5 ended while the last MIND line was still
  // playing and 5 more died with a line HELD in the queue, with nothing recording either).
  // No second player process: ONE small JSON on disk, rewritten at every start / progress /
  // end / cut of a MIND line, plus ONE line in the NEXT call's log at start. The MIND
  // already reads the log, so it learns the last thing actually spoken and the exact
  // unspoken remainder. The engine never writes an inject and never re-speaks on its own —
  // resuming stays the MIND's judgement, and mouth immediacy is untouched.
  const mindStatePath = process.env.APIPLAN_MIND_STATE === "" ? "" :
    (process.env.APIPLAN_MIND_STATE || `${process.env.HOME}/.livemind/mind-last-spoken.json`);
  const callId = logPath ? basename(logPath).replace(/\.jsonl$/, "") : `talk-${process.pid}`;
  let carry: any = null;   // LANE 15 review fix 0: previous call's mind fields survive mouth-only writes
  try {
    if (mindStatePath && fs.existsSync(mindStatePath)) {
      const s = JSON.parse(fs.readFileSync(mindStatePath, "utf8"));
      const age = Date.now() - (Number(s.t) || 0);
      // Gate on the LINE's own clock (review fix 1): a later mouth-only write must not
      // renew a stale line; started_at stays meaningful because of the carry fix.
      const lineAge = Date.now() - (Number(s.started_at) || Number(s.t) || 0);
      const maxAge = Number(process.env.APIPLAN_MIND_RESUME_MAX_AGE_MS) || 900000;
      if (age >= 0 && lineAge >= 0 && lineAge < maxAge && (s.text || s.mouth_last || s.queued?.length)) {
        carry = s;
        const spokeAge = Math.round(lineAge / 1000);
        // review fix 3: the barged remainder is already in `remainder` — never list it twice
        const q: string[] = Array.isArray(s.queued) ? s.queued.filter((l: string) => String(l).trim() !== String(s.remainder || "").trim()) : [];
        say("info",
          `last spoken ${spokeAge}s ago on ${s.call} [${s.status}] — mind ${s.spoken_chars}/${s.chars} chars`
          + (s.spoken ? ` — HEARD-TAIL: ${String(s.spoken).slice(-160)}` : "")
          + (s.remainder ? ` — UNSPOKEN: ${s.remainder}` : " — nothing unspoken")
          + (s.mouth_last ? ` — MOUTH LAST: ${String(s.mouth_last).slice(-160)}` : "")
          + (s.mouth_remainder ? ` — MOUTH WAS CUT after "${String(s.mouth_heard || "").slice(-80)}" — MOUTH UNSPOKEN: ${s.mouth_remainder}` : "")
          + (q.length ? ` — never left the queue (${q.length}): ${q.join(" ⏎ ")}` : "")
          + ` — state ${mindStatePath}; resuming is YOUR call, the engine will not speak it`);
      }
    }
  } catch { /* a bad state file must never block a call */ }

  // THE MOUTH'S OWN VOICE SWITCH (fire17, canons 035/040): he can tell the mouth to be quiet
  // and it stays quiet — "אתה צריך לשתוק" — and it can bring ITSELF back when he addresses it
  // again — "אתה יכול לדבר". Both directions, because a mouth that can only be silenced by
  // someone else has to wait for the MIND to notice he wants it back.
  // It lives HERE rather than in the tools module because suppressAuto lives here: a tool that
  // wrote a file and hoped somebody read it would be one more race in a night full of them.
  // The persona still carries the behaviour (his dual-layer law: mechanism AND knowing); this is
  // the mechanism half, and it works even if the persona forgets.
  const MOUTH_TOOL = {
    type: "function", name: "mouth_voice",
    description: "Your own voice switch. Call with state='mute' when the human tells you to be "
      + "quiet, state='unmute' when he tells you to speak again or addresses you directly after "
      + "silencing you, and state='read' to check whether you are currently muted. When muted you "
      + "produce no spoken replies at all; the human can always still be heard.",
    parameters: { type: "object", additionalProperties: false, required: ["state"],
      properties: { state: { type: "string", enum: ["mute", "unmute", "read"] } } },
  };
  // Structural allow-list: a tool name the caller never declared is never dispatched,
  // no matter what the model asks for. The mouth's own switch is always declared.
  const toolNames = new Set([MOUTH_TOOL.name, ...(o.tools ?? []).map((t: any) => t?.name).filter(Boolean)]);

  // The microphone-input half of the session config.
  // Transcription stays at connect time: hot-adding it mid-response required resending the
  // whole input, and resending turn_detection mid-response makes the server abort the call
  // (observed live). The ~90ms it would save is dominated by the warm-daemon path anyway.
  const audioInput: Record<string, unknown> = {
    format: { type: "audio/pcm", rate: RATE },
    // gpt-4o-mini-transcribe hallucinates far less than whisper-1 on near-silence.
    transcription: { model: transcribeModel },
    // Filter room noise / speaker bleed BEFORE VAD. near_field assumes headphones (which
    // barge-in already requires); far_field suits a laptop/room mic.
    noise_reduction: { type: bargeOn ? "near_field" : "far_field" },
    // 0.5 was low enough that room noise opened a turn, and Whisper answers near-silence
    // with a canned hallucination. A higher bar plus a longer pause needs actual speech.
    // silence_duration_ms is how long you must pause before it decides you're done and
    // replies — too low and it jumps in mid-thought. Raise the default and let it be tuned.
    // idle_timeout_ms makes the model SELF-PROMPT after silence ("still there?") — off by
    // default (it nags), opt in with APIPLAN_IDLE_TIMEOUT_MS to notice a walked-away user.
    turn_detection: {
      type: "server_vad", threshold: 0.65, prefix_padding_ms: 300,
      silence_duration_ms: Number(process.env.APIPLAN_VAD_SILENCE_MS) || 1100,
      ...(process.env.APIPLAN_IDLE_TIMEOUT_MS ? { idle_timeout_ms: Number(process.env.APIPLAN_IDLE_TIMEOUT_MS) } : {}),
      // create_response:false → the server still detects turns and TRANSCRIBES your speech,
      // but never auto-generates a reply. The model then speaks ONLY when something sends an
      // explicit response.create (i.e. an injected line). This is "mouthpiece" mode: a live
      // agent (the MIND) hears you via the transcript and answers through the voice, while the
      // realtime model itself stays silent — and it can't echo-loop on its own audio/noise.
      ...(process.env.APIPLAN_VAD_CREATE_RESPONSE === "0" ? { create_response: false } : {}),
    },
  };

  /** The session config in ONE place. The LIVE variant and the PARKED variant differ only by
   *  SUBTRACTION, so they can never drift apart — and the two drifts that matter are both fatal
   *  in silence: a parked session that kept `idle_timeout_ms` would SELF-PROMPT into a live
   *  conversation after a stretch of being parked (the warm daemon's own config hardcodes it),
   *  and one that lost `transcription` would sound perfect while writing an EMPTY record. */
  const sessionBody = (input: Record<string, unknown>, instructions?: string) => ({
    type: "realtime",
    output_modalities: ["audio"],
    ...(instructions ? { instructions } : {}),
    tools: [MOUTH_TOOL, ...(o.tools ?? [])], tool_choice: "auto",
    audio: { input, output: { voice: o.voice || "cedar", format: { type: "audio/pcm", rate: RATE } } },
  });
  /** PARKED input. It still TRANSCRIBES (so the successor is not born mute-of-record the moment
   *  it takes over) but it may never answer and may never self-prompt. It is also never appended
   *  to — that is the structural half of the one-ACTIVE invariant; this is the belt. */
  const parkedInput = (() => {
    const td: Record<string, unknown> = { ...(audioInput.turn_detection as Record<string, unknown>), create_response: false };
    delete td.idle_timeout_ms;
    return { ...audioInput, turn_detection: td };
  })();

  // Whisper finishes transcribing your turn AFTER the model has already answered, so
  // printing each line as it arrives shows the reply above the question. Hold the reply
  // until your line is printed — with a timeout, so a missing transcript can't eat it.
  // A queue, not a single slot: fast consecutive turns must not overwrite an unflushed one.
  // Each held reply carries WHO it really is. A MIND line spoken through the mouth (the narrator
  // fallback in sendInjected) comes back as an ordinary mouth transcript, arrives here long after
  // the flag that would have classified it was cleared, and so used to be filed as the mouth's own
  // words — the one path on which "Mind here —" survived into a successor's seed.
  const pending: Array<{ text: string; mind: boolean }> = [];
  let replyTimer: ReturnType<typeof setTimeout> | null = null;
  const flushReply = () => {
    if (replyTimer) { clearTimeout(replyTimer); replyTimer = null; }
    while (pending.length) {
      const p = pending.shift()!;
      mindNarrating = p.mind;                     // classification only — the record and the text are identical
      try { say("model", p.text); } finally { mindNarrating = false; }
    }
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
  // The duration of the last committed speech segment, so a whisper hallucination on
  // noise can't fire the IRREVERSIBLE hangup: a real "bye" needs real speech behind it.
  let speechStartedAt = 0;
  let lastSpeechMs = 0;
  // Per-turn snapshots of those two numbers: pushed at speech_stopped, consumed by that turn's
  // transcript (FIFO, 4 deep — turns and transcripts arrive in order on this socket, and a
  // bounded ring means one lost transcript can never strand the pairing for long). The globals
  // above stay for the gates that legitimately mean "the latest turn" (E128, hangup); the echo
  // timing belt reads THIS turn's pair or it does not fire at all.
  const speechTurns: Array<{ startedAt: number; ms: number; stopAt: number; prevStopAt: number }> = [];
  let userSpeaking = false;   // VAD says the human is mid-turn — MIND lines HOLD (stack law)
  let lastSpeechStopAt = 0;   // sustained-silence gate: MIND may speak only after ~2.5s of real quiet
  let prevSpeechStopAt = 0;   // the quiet clock BEFORE the current turn overwrote it — an echo turn puts it back
  // P9 (hands verify pass): a resend raises SEVERAL segments back to back — four on 97289 inside
  // 800ms — so putting back only the ONE clock this echo turn overwrote leaves the 2.5s quiet gate
  // measuring from the PREVIOUS echo, not from his last genuine turn, which is what the MIND's
  // order says ("release the latch so HELD lines flow after the normal 2.5s quiet gate measured
  // from the last GENUINE turn"). Bounded ring of recent turn-end clocks, each marked the moment a
  // transcript proves it was our own voice; the rule then states itself: lastSpeechStopAt is the
  // newest stop no echo verdict has claimed. Order-independent — a verdict landing out of order
  // walks the clock back one more hop each time.
  const stopHistory: Array<{ stopAt: number; echo: boolean }> = [];
  // ── P9: this turn's echo verdict, carried OUT of the transcript block ──────────────
  // THE MIND's order, verbatim (bus 2026-08-23 03:00:56, call 97289): "a you-turn flagged as echo
  // must NOT count as 'user speaking' / 'new user turn' for the stack law, and the mouth must not
  // auto-reply to it." The verdict is computed deep inside the transcript handler; the stale-queue
  // law and the auto-reply gates live outside that block, so the verdict travels in these.
  let echoTurnSuspect = false;   // echoish || bulkAppended — the SAME `suspect` the annotation stamps
  let echoTurnEchoish = false;   // text belt alone — the narrower bar the reply-cancel belt uses
  let echoTurnTeeth = false;     // echoTeeth() already ruled on this turn's reply; never second-guess it
  let echoTurnShort = false;     // under the min-transcript bar (the MIND's +1, measured below)
  let echoTurnChars = 0;         // that turn's non-space character count, for the echo line
  // ── E605/E606: this turn's EXTERNAL-SUSPECT verdict, carried out of the transcript block ──
  // MARK, NEVER SUPPRESS. The verdict is computed at commit time inside the annotation branch;
  // the auto-reply belt that consumes it lives outside that block, exactly like the P9 verdicts
  // above. It gates ONE thing — the mouth's own auto-reply — and nothing else: the you-record,
  // the archive and the canon are already written byte-identical before this is ever read.
  let externalMarked = false;    // non-Hebrew AND xconv-adjacent (the E606 rule)

  let greeted = false;
  // ── PRESENCE-GATED OPENING (LM_GREET) ─ call 31599, 2026-08-20 ──────────────────
  // WHY THIS IS AN ENGINE KNOB AND NOT PERSONA TEXT (the MIND's finding, measured live):
  // the opening line is not the model's idea. The ENGINE sends a `response.create` at
  // connect — the parked-socket path in onOpen, the fresh path in `session.updated` — so
  // the model is executing an explicit request to speak. No instruction inside the persona
  // or now.txt ("do not greet", "stay silent") can cancel a response the engine itself
  // asked for: the text is read AS the direction for that opening line, never as a veto of
  // it. On 31599 the no-greet direction was in context and the mouth still opened the call.
  // Muting the audio would not be the fix either — a muted greeting still burns a response,
  // still enters the transcript, and still leaks into the mic as an echo turn. So the gate
  // has to sit on EMISSION, which is exactly what these modes move (never WHAT is sent):
  //   presence (DEFAULT, his design) — nothing is emitted at connect. A one-shot opener is
  //     ARMED and fires only after the FIRST you-turn that arrives UNFLAGGED by the echo
  //     belts, so the mouth's first words always land on a proven listener. A restart into
  //     an empty room then costs nothing, no empty-room speech enters the human record, and
  //     31599's greeting-echo race becomes UNREACHABLE: with no connect-time emission there
  //     is no greeting audio to bounce back through the speakers as a you-turn at all.
  //   1 / legacy / on / connect — greet at connect, byte-for-byte as before. The escape
  //     hatch for an ATTENDED restart, where somebody is already sitting there listening.
  //   0 / off — never greet; the opener is disarmed too.
  //
  // WHY PRESENCE IS THE DEFAULT AND NOT JUST A KNOB (decided 2026-08-20, W36 verify).
  // The original filing asked only for a knob ("needs an engine knob (e.g. LM_GREET=0 /
  // config flag) so restarts while he is away stay silent"); the MIND then UPGRADED that
  // ask with a fold order, and the fold order is the authority here — his words verbatim:
  //   "the opening line should WAIT for an unflagged you-turn instead of assuming a
  //    listener; then the restart costs nothing, no empty-room speech enters the human
  //    record, and the greeting-echo race from 31599 becomes unreachable."
  // A knob defaulting to speak-first still speaks into an empty room on every unattended
  // restart, and the launcher does NOT export LM_GREET today — so a default of `legacy`
  // would mean the fold order never actually runs. Hence: presence is the default AND the
  // fallback for any unrecognised value (silence is the fail-safe), legacy is the explicit
  // attended-restart escape hatch, and the connect say-info below is LOUD about which mode
  // is live so no launcher is ever surprised by a mouth that opens — or one that does not.
  // HONEST SCOPE of the legacy invariant: legacy is byte-identical to ec768e4 in its CONNECT
  // EMISSION only. The half-duplex belt also refuses to resend the greeting's overlap window
  // in legacy mode (that is defect 1's fix, by design) — same greeting on the wire, one less
  // echo door behind it.
  //   announce (LM_GREET=announce) — THE MOUTH SAYS IT CAME UP. His order, call 25908,
  //     you-event t=1787444645847, byte-exact from the LOG (canon 104):
  //       "מגניב, בוא תוסיף בבקשה שהמוח יוסיף שהוא, זה טוב שהוא, ראיתי שהוא קרא על הפה בהתחלה,
  //        אבל הפה לא קן אותי כשהוא עלה, אז גם כמובן הקונטקסט שלו צריך להמשיך מהסשן הקודם בלי
  //        בעיות, אבל הוא כן צריך לבוא ולהעלות ולהגיד לי שהוא עלה."
  //     Measured on that very call: ZERO model events before his first you-turn at 156.28s — the
  //     presence opener was FOLDED into the VAD reply to his first words ("opening line folded
  //     into his first answer"), so the mouth never announced anything; the only restart notice
  //     either that call or 97289 ever got came from a MIND inject. announce is the mode that
  //     answers the ask: ONE short opener per CONNECTION, fired from `session.updated` (never at
  //     open — before the ack the persona is not live, so the line would speak in the default
  //     assistant voice), carrying the persona + the folded NOW state so his second half —
  //     "הקונטקסט שלו צריך להמשיך מהסשן הקודם" — holds by construction.
  //     DERIVED, mine and not his (labelled as the god-file demands): the guards below — skip if
  //     he is already speaking, one per connection, and the two-sentence / never-a-list cap. The
  //     cap is L42's lesson paid for live: a greeting once read a list aloud 3x into an empty room.
  //     HONEST COST: announce deliberately gives up presence's empty-room guarantee. That is the
  //     trade he asked for, and it is why the connect say-info names the mode LOUDLY.
  const greetMode = (process.env.LM_GREET ?? "presence").trim().toLowerCase();
  const GREET_LEGACY = greetMode === "1" || greetMode === "legacy" || greetMode === "on" || greetMode === "true" || greetMode === "connect";
  const GREET_ANNOUNCE = greetMode === "announce";
  const GREET_OFF = greetMode === "0" || greetMode === "off" || greetMode === "false";
  const GREET_PRESENCE = !GREET_LEGACY && !GREET_OFF && !GREET_ANNOUNCE;
  let openerArmed = false;      // presence mode: an opening line is owed, waiting for HIM
  // ONE OPENER DECISION PER CONNECTION — and `greeted` is NOT that flag. The presence FOLD path
  // spends the one-shot by clearing `openerArmed` while leaving `greeted` false, and the arm site
  // in `session.updated` is gated on `!greeted` — so any LATER ack on the same live socket (a
  // rotation promotion, or the MIND's mid-call {"session":…} swap, which sends session.update and
  // draws a fresh session.updated) re-arms a one-shot that was already declared spent, and the
  // mouth can open in the middle of a call. Every path that SPENDS the opener sets this instead.
  let announcedThisConn = false;
  /** THE EMPTY-ROOM PREDICATE — one definition, seven readers (it was inlined seven times).
   *  announce is LEGACY-shaped here on purpose: the mode exists to speak before anybody has
   *  spoken, so a belt that cancels replies "because nobody has spoken yet" would cancel the
   *  very opener the mode is for. presence and legacy are byte-identical to before. */
  const emptyRoomNow = () => !GREET_LEGACY && !GREET_ANNOUNCE && speechStartedAt === 0;
  // Audio arrives far faster than it plays, so "the model stopped generating" is NOT
  // "the speaker stopped making noise". Muting on generation-end reopened the mic while
  // seconds of reply were still coming out of the speaker — which the mic then captured
  // and Whisper transcribed as the user talking. Track the playback clock instead.
  let playingUntil = 0;
  const queueAudio = (bytes: number) => {
    playingUntil = Math.max(playingUntil, Date.now()) + (bytes / 2 / RATE) * 1000;
  };
  const stillAudible = () => Date.now() < playingUntil + 250;   // + a little room for the speaker's own latency

  // ── LANE 18 (canon 014): mac output-mute awareness — "אני צריך שתדע לזהות מתי המחשב
  // שלי על ווליום השתק ומתי לא, כדי שהבלבולים האלה לא יקרו יותר". Design law (E107 +
  // EVA amendment): NO standing poll — one async osascript read ONLY at speak moments,
  // cached 5s, never blocking the mouth path (fire-and-forget; warn uses last-known
  // state, ≤5s stale). While muted/vol0, mind/mouth speech is likely UNHEARD: mark it
  // in the LOG (ev:info spoken-while-muted) so nobody diagnoses a broken chain from
  // silence, and announce on unmute how many lines he may have missed (replay = MIND's
  // call from the LOG). ponytail: osascript on demand; CoreAudio listener only if this
  // ever needs to be event-driven.
  let spkState = "unknown"; let spkAt = 0; let mutedSpoken = 0;
  const speakerCheck = () => {
    if (Date.now() - spkAt < 5000) return;
    spkAt = Date.now();
    try {
      const p = Bun.spawn(["osascript", "-e", "get volume settings"], { stdout: "pipe", stderr: "ignore" });
      new Response(p.stdout).text().then((out) => {
        const vol = Number(/output volume:(\d+)/.exec(out)?.[1] ?? NaN);
        const muted = /output muted:true/.test(out);
        const prev = spkState;
        spkState = muted ? "muted" : vol === 0 ? "vol0" : Number.isNaN(vol) ? "unknown" : vol <= 15 ? "low" : "ok";
        if (prev !== spkState && (spkState === "muted" || spkState === "vol0"))
          say("info", `mac output ${spkState} — speech from here is likely UNHEARD`);
        if ((prev === "muted" || prev === "vol0") && (spkState === "ok" || spkState === "low") && mutedSpoken) {
          say("info", `mac output audible again — ${mutedSpoken} line(s) were spoken while ${prev}; he may have missed them (replay from LOG if he asks)`);
          mutedSpoken = 0;
        }
      }).catch(() => { spkState = "unknown"; });
    } catch { spkState = "unknown"; }
  };
  const warnIfUnheard = (who: string) => {
    if (spkState === "muted" || spkState === "vol0") {
      mutedSpoken++;
      say("info", `spoken-while-muted — output ${spkState}, ${who} speech likely UNHEARD`);
    }
  };

  // Barge-in bookkeeping (R7): to interrupt CORRECTLY we must tell the server how much
  // was actually heard (conversation.item.truncate) and drop the cancelled response's
  // in-flight deltas — otherwise the model's context contains words the user never heard,
  // and ghost audio plays after the interrupt.
  let curResponseId: string | null = null;   // response currently generating
  let responseActive = false;                 // a response is mid-generation (safe to cancel)
  let curResponseBornAt = 0;                  // E128: when the active response was born — the empty-transcript
                                              // gate may only cancel a reply born from ITS OWN segment
  let mindResponse = false;                   // current response was MIND/tool-initiated (never noise-cancel it)
  let pendingMindHistory = "";                // MIND line to record in conversation AFTER it is spoken
  let mindBusy = false;                       // a MIND narrator line is generating or playing (serializes the queue)
  let mindPlayer: any = null;                 // the MIND voice's own ffplay child (killed on barge/exit)
  // USER-BARGES-MIND bookkeeping (fire17's law, voice, 2026-08-20: "אם אני אומר הודעה,
  // אתה חייב לתת לפה להתפרץ ולעצור את מה שהמיינד מדבר... המוח חייב לקטוע את עצמו ולהבין
  // איפה הוא נקטע"): the line now playing, so an interrupt can estimate how much was
  // actually heard (cut) and re-queue the unspoken remainder for re-weave.
  let mindLine: { text: string; ms: number; startAt: number; cut: number; who?: string } | null = null;
  // LANE 15: the SAME object as mindLine, but never nulled when playback ends — the state
  // file must still know the last line and how much of it was heard after it finished.
  let mindLast: { text: string; ms: number; startAt: number; cut: number; who?: string } | null = null;
  let mindQueue: { text: string; who?: string }[] = [];   // bound to the live inject queue below — the lines never spoken
  let mindStatus = "idle";
  let mindStateAt = 0;
  let mouthLast = "";             // the mouth's own last completed reply (it dies with the socket too)
  // Total transcript chars generated for the reply in flight. mouthBuf keeps only the LAST
  // 2000 chars (a memory bound), so on a long reply it is a tail window — the barge split below
  // needs the true length or it places the cut too late and records words he never heard.
  let mouthChars = 0;
  // MOUTH BARGE record (canon 027 — fire17, voice, 2026-08-20: "גם איפה שהם היו, וגם בהתאם
  // לאיפה הם עצרו, וגם בהתאם למה אני אמרתי"). The last time HIS voice cut the mouth mid-reply:
  // where it was cut (heard-ms, and the word boundary that implies), what he heard, what he
  // never heard, and whether the response was still generating. All three pieces of the resume
  // already existed in this engine — conversation.item.truncate carries heard-ms, the LANE 15
  // clock maps ms to chars, overlap recovery carries his interjection — so this record is
  // ASSEMBLY, not new machinery. Written by the local detector in pumpMic; read by the resume
  // half and by saveMindState (LANE 15), so a call that dies mid-barge still resumes.
  // `confirmed` is filled a beat later: null = still waiting, false = nothing followed the cut
  // (a possible self-barge on speaker leak — the record is then discarded, never resumed).
  let mouthBarge: {
    at: number; heardMs: number; queuedMs: number; itemId: string | null; responseId: string | null;
    cancelled: boolean; said: string; heard: string; remainder: string; peak: number; sustainMs: number;
    confirmed: boolean | null; consumed: boolean;
  } | null = null;
  /** How much of a line was actually HEARD: elapsed/duration, rounded DOWN to a word
   *  boundary — the same clock the barge cut uses, so words he never heard are never
   *  recorded as spoken. A frozen `cut` (barge / call end) always wins. */
  const spokenChars = (L: { text: string; ms: number; startAt: number; cut: number }) => {
    if (L.cut >= 0) return L.cut;
    const raw = Math.min(L.text.length, Math.max(0, Math.round(((Date.now() - L.startAt) / (L.ms || 1)) * L.text.length)));
    const wb = L.text.lastIndexOf(" ", raw);
    return wb > 0 ? wb : raw;
  };
  /** Persist the MIND's speech state (atomic tmp+rename — a reader never sees half a file;
   *  the tmp name carries the pid so two live calls can never interleave one write).
   *  `status` undefined keeps the current one; force=false throttles to <=1/s (the mic-pump
   *  progress marker — that is what survives a SIGKILL mid-sentence). */
  const saveMindState = (status?: string, force = true) => {
    if (!mindStatePath) return;
    if (status) mindStatus = status;
    if (!force && Date.now() - mindStateAt < 1000) return;
    if (!mindLast && !mouthLast && !mindQueue.length && !mouthBarge) return;   // never clobber the previous call's record with blanks
    mindStateAt = Date.now();
    try {
      const n = mindLast ? spokenChars(mindLast) : 0;
      // THREE-WAY RESUME, the MOUTH slot: where his voice cut the mouth's reply and what it
      // never got to say. Rides the SAME state file as the MIND slot (no second file), so a call
      // that dies mid-barge still resumes with the remainder intact. Emitted UNCONDITIONALLY and
      // in BOTH branches below: the no-mind branch spreads the previous call's record (`carry`),
      // so a mouth field that rode that spread would resurrect an already-resumed cut on the next
      // restart, while the mind branch would silently drop it instead. Always three keys, blank
      // when there is no live cut.
      const MB = mouthBarge;
      const mb = { mouth_heard: MB ? MB.heard.slice(-300) : "", mouth_remainder: MB ? MB.remainder : "",
        mouth_cut_at: MB ? MB.at : 0 };
      const st = mindLast ? {
        t: Date.now(), call: callId, log: logPath, status: mindStatus,
        text: mindLast.text, chars: mindLast.text.length, ms: Math.round(mindLast.ms),
        started_at: mindLast.startAt, spoken_chars: n,
        spoken: mindLast.text.slice(0, n),
        remainder: mindLast.text.slice(n).trim(),
        mouth_last: mouthLast, queued: mindQueue.slice(0, 8).map((q) => q.text), ...mb,
        mouth: suppressAuto ? "closed" : "open",
      } : {
        text: "", chars: 0, ms: 0, started_at: 0, spoken_chars: 0, spoken: "", remainder: "",
        status: mindStatus, call: callId,
        ...(carry ?? {}),                       // review fix 0: A's mind fields survive B's mouth-only writes
        t: Date.now(), log: logPath,
        mouth_last: mouthLast, queued: mindQueue.slice(0, 8).map((q) => q.text), ...mb,
        mouth: suppressAuto ? "closed" : "open",
      };
      ensureDir(dirname(mindStatePath));
      const tmp = `${mindStatePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st));
      fs.renameSync(tmp, mindStatePath);
    } catch { /* state must never break the call */ }
  };
  // ── ON-AIR PUBLISHER (hands L252, 2026-08-23) ────────────────────────────────────────
  // ~/.livemind/playback.json {"v":1,"on_air":bool,"src":"mouth"|"mind"|"","call","ts"} — TRUE
  // exactly while OUR OWN audio is in the room: the same predicate the vp barge arms on
  // (`stillAudible() || mindPlayer`, onVpBarge). Written on every flip and as a 1 s heartbeat,
  // atomically (tmp+rename). Readers (lm-ptt's mic meter first) treat a missing or stale
  // (>1.5 s) file as NOT on air — fail OPEN, the meter then shows the raw mic as before.
  // Born of call 14838 14:06 — the pill pegged full on speaker leak while the MOUTH talked;
  // lm-ptt's raw device capture cannot know by itself when the speaker is ours.
  const playbackPath = process.env.APIPLAN_PLAYBACK_STATE === "" ? "" :
    (process.env.APIPLAN_PLAYBACK_STATE || `${process.env.HOME}/.livemind/playback.json`);
  let pbLastKey = ""; let pbLastWrite = 0;
  const publishPlayback = (off = false) => {
    if (!playbackPath) return;
    try {
      const onAir = !off && (stillAudible() || !!mindPlayer);
      const src = mindPlayer ? "mind" : onAir ? "mouth" : "";
      const key = `${onAir}|${src}`; const now = Date.now();
      if (key === pbLastKey && now - pbLastWrite < 1000) return;
      pbLastKey = key; pbLastWrite = now;
      ensureDir(dirname(playbackPath));
      const tmp = `${playbackPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, on_air: onAir, src, call: callId, ts: now }));
      fs.renameSync(tmp, playbackPath);
    } catch { /* state must never break the call */ }
  };
  const playbackTimer = playbackPath ? setInterval(publishPlayback, 100) : null;
  (playbackTimer as any)?.unref?.();
  let recoveryHeldReply = false;              // a VAD auto-reply cancelled ONLY by the overlap-recovery window — released once the echo discriminator has ruled (call 3357)
  let pendingMouthReply = false;              // a VAD auto-reply cancelled only because MIND audio was playing — release it after
  let pendingMouthAt = 0;                     // when it was parked — canon 044: a hold that never releases is a mute
  // THE ORGAN FLOOR (fire17, canon 029, from a live bug: the mouth cut EVA off mid-sentence).
  // His law: the MIND may interrupt the mouth — and the reason he GAVE is currency, not rank
  // ("כי הוא בעצם אומר דברים יותר עדכניים מהפה") — but EVA never cuts the mouth and the mouth
  // never cuts EVA: both JOIN THE QUEUE and speak after. One signal serves both halves of that
  // (EVA's own analysis, E368/E369): while any organ's audio is in the room the floor is TAKEN,
  // so (1) the mouth holds its reply instead of talking over her, and (2) mic frames are dropped
  // so her voice is never transcribed as HIS turn — the same protection the narrator already has.
  // Organs publish a claim to ~/.livemind/floor.json: {"who":"eva","until":<epoch ms>}.
  // Only holders in INTERRUPT_OK may cut a voice already speaking; everyone else waits for quiet
  // in their own process. Adding an organ is a line in that set, not a new arbitration layer.
  const FLOOR_FILE = `${process.env.HOME}/.livemind/floor.json`;
  const INTERRUPT_OK = new Set(["mind"]);     // currency, not rank — extend only for fresher-info organs
  const FLOOR_MAX_MS = Number(process.env.APIPLAN_FLOOR_MAX_MS) || 30000;   // canon 044 cap
  // THE EXTERNAL CONVERSATION (fire17, canon 045): "אני מדבר פה עם חבר שלי עכשיו בחדר ואנחנו
  // בשיחה משלנו, ופתאום האייג'נטים מתחילים לדבר ופותים אותי ובעצם סתם נכנסים במילים שלי...
  // שיהיה איזשהו flag כזה שהמערכת תבין שיש שיחות אחרות שקורות במקביל, ולשים לב טוב לא להתפרץ".
  // Caps is OFF while that happens, so this engine sees NOTHING — no VAD, no transcript, no
  // turn. EARS (its own capture) publishes the acoustic fact and nothing else:
  //     ~/.livemind/external-conversation.json  {"v":1,"active":true,"since":<ms>,"until":<ms>}
  // A boolean and timestamps by design: the audio behind it is Side Tangent (canon 047) and no
  // content, level or transcript of it may exist anywhere in this system.
  // It is a HARD HOLD, not a drop: MIND lines queue exactly as they do for his own turn, and
  // they flow the moment the room is his again. `until` is a LEASE the producer refreshes ~2x/s,
  // so a dead EARS frees the mouth within 1.5s — the flag can never latch the call into silence.
  const XCONV_FILE = `${process.env.HOME}/.livemind/external-conversation.json`;
  let xconvUntil = 0, xconvSince = 0;
  const xconvHeld = () => Date.now() < xconvUntil;
  // ── EXTERNAL-SUSPECT MARK (E605 + E606) ──────────────────────────────────────────
  // WHAT WAS RETRACTED FIRST, so nobody rebuilds it: quarantining a you-turn by TIME alone
  // (inside/±Nms of a window) is unbuildable. Eva measured it — a leak always commits AFTER
  // the window closes, because the recogniser needs the audio to end, so the strict form
  // catches zero leaks; and his own closest real turn sits +14.7s from a close against the
  // furthest leak at +12.1s, so any pad wide enough to catch leaks swallows HIS words.
  // Eva's law, verbatim: "THE THRESHOLD BELONGS TO THE CONSEQUENCE, NOT TO THE SIGNAL — 60s
  // proximity right for marking is catastrophic for suppressing."
  // WHAT THIS IS INSTEAD: language is the population SELECTOR (non-Hebrew), xconv proximity is
  // the DECIDER, and the consequence is a MARK plus the loss of the mouth's auto-reply — never
  // the commit, never the archive, never canon. Measured corridor on call 25908: the three
  // leaks commit at +0.7s / +2.8s / +12.1s past a close, the next non-Hebrew turn of any kind
  // at +316.0s (Eva's wider corpus: +193.2s). The threshold lives anywhere in that gap; 60s is
  // hers. Against HIS Hebrew turns the margin is half a second, which is precisely why nothing
  // here may suppress.
  // COST, stated honestly: a real English turn of his inside the window loses ONE auto-reply —
  // the MIND reads the mark in the LOG and answers. A swallowed turn is not recoverable, so
  // the two errors are not symmetric and the design takes the recoverable one.
  const EXTERNAL_MARK_ON = process.env.APIPLAN_EXTERNAL_MARK !== "0";           // fail-OPEN: 0 = today's behaviour, mechanism inert
  const EXTERNAL_MARK_MS = Math.max(0, Number(process.env.APIPLAN_EXTERNAL_MARK_MS ?? 60000));
  // The file publishes {active,since,until} and NOTHING else (canon 045/047) — when a window
  // closes it goes back to {active:false,since:0,until:0}, so the CLOSE TIME exists nowhere on
  // disk. It is observable only by watching the transition, so the engine keeps its own ring of
  // the closes IT saw. Bounded and in RAM: no history of a private conversation is ever written.
  const xconvCloses: number[] = [];
  const XCONV_RING = 32;
  /** ms since the most recent OBSERVED close at or before `at`; -1 when none is known.
   *  FAIL-OPEN BY CONSTRUCTION: an empty ring — EARS never ran, the file is missing, stale or
   *  unparseable (the poll tick's own try/catch swallows all three) — returns -1, i.e. NOT
   *  adjacent, i.e. nothing is ever marked. A dead sensor can never cost him a reply. */
  const xconvSinceClose = (at: number) => {
    for (let i = xconvCloses.length - 1; i >= 0; i--) { const d = at - xconvCloses[i]; if (d >= 0) return d; }
    return -1;
  };
  /** Adjacent = a window is open right now, or one closed within EXTERNAL_MARK_MS. The open
   *  case is HANDS' derivation, not in the MIND's wording: a transcript committing while the
   *  room is still busy is the same population, and it can only ever add a mark. */
  const xconvAdjacent = (at: number) => {
    if (xconvHeld()) return true;
    const d = xconvSinceClose(at);
    return d >= 0 && d <= EXTERNAL_MARK_MS;
  };
  /** THE DECIDER, one expression, no side effects — extracted and run for real by
   *  ~/Creations/LiveMind/hands/tests/external-mark.test.mjs. `hasHebrew` is the engine's own
   *  script test (the same one the language profile uses), so "non-Hebrew" can never drift
   *  apart from what the rest of this file means by it. */
  const externalSuspect = (t: string, at: number) => EXTERNAL_MARK_ON && !!t.trim() && !hasHebrew(t) && xconvAdjacent(at);
  const HOLD_MAX_MS = Number(process.env.APIPLAN_HOLD_MAX_MS) || 12000;     // a hold is not a mute
  let organFloorUntil = 0, organFloorWho = "", floorBogusAt = 0;
  let mutedSinceAt = 0, lastMutedNoteAt = 0;   // canon 044: a closed mouth announces itself
  // responseActive only flips true on the SERVER's response.created echo, which lags our
  // response.create send. awaitingResponse bridges that gap: set true synchronously at every
  // response.create we send, cleared on response.created / response.done / cancel. Without it,
  // two injects (or an inject + a queue flush) fired in the same tick both see !responseActive
  // and both send response.create — the server rejects all but the first, silently dropping or
  // reordering the injected reports. (Root cause of the inject-ordering backlog.)
  let awaitingResponse = false;
  let micMuted = false;                        // when true, mic frames are dropped (not sent to the model)
  // suppressAuto: when true, the mouth may NOT answer on its own — any VAD auto-response is
  // cancelled the instant it starts, so the mouth speaks ONLY injected (MIND) lines. The MIND
  // flips this LIVE via an inject {"autospeak":true|false} — instant open/close of the mouth.
  // Default from env (APIPLAN_VAD_CREATE_RESPONSE=0 → start closed); otherwise open so the mouth
  // gives its quick opener before the MIND takes over with the truth.
  let suppressAuto = process.env.APIPLAN_VAD_CREATE_RESPONSE === "0";
  let lastSuppressEchoAt = 0;   // throttle for the suppressed-auto-reply visibility echo
  let lastEmptyRoomAt = 0;      // same, for the empty-room cancel (a parked session self-prompts every ~15s)
  let lastOpenerHeldAt = 0;     // same, for the held-opener notice (it re-arms on every turn while the mouth is closed)
  // ECHO-DEDUPE BELT (EVA integrity finding 2026-08-20: three ev:"you" turns were the
  // system's OWN sentences re-heard through the speakers — one even survived the 2000
  // loudness bar at high volume, leak/speech margin is only ~1.15x). Recent spoken texts
  // (MIND lines + mouth replies) are kept; a RECOVERED turn whose transcript near-matches
  // one is speaker echo: discarded from the log and deleted from the model's context.
  // Applies ONLY to recovered turns — a live turn is never censored.
  // Entries carry the wall clock they were spoken at: a LIVE turn may only be suspected of
  // echoing something said in the last ~45s (speaker leak returns within one playback), while
  // the recovery path stays age-blind, exactly as before.
  const recentSpoken: Array<{ t: number; text: string }> = [];
  let mouthBuf = "";
  const rememberSpoken = (t: string) => { if (t.trim()) { recentSpoken.push({ t: Date.now(), text: t }); if (recentSpoken.length > 6) recentSpoken.shift(); } };
  // Hoisted so a window loop never rebuilds them (this runs inside ws.onmessage, the same
  // handler that writes audio deltas to the player's stdin — a long block would stutter it).
  const echoNorm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const echoGrams = (s: string) => { const g = new Set<string>(); for (let i = 0; i + 1 < s.length; i++) g.add(s.slice(i, i + 2)); return g; };
  const dice = (A: Set<string>, B: Set<string>) => {    // bigram Dice, diacritic/punct-insensitive
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const g of A) if (B.has(g)) inter++;
    return (2 * inter) / (A.size + B.size);
  };
  // SLIDING BEST-WINDOW (EVA forensics 2026-08-20). The old fixed `t.length * 2` tail window
  // caps Dice at ~2/3 even for a PERFECT tail echo — grams(t) holds n-1 members inside a window
  // holding ~2n-1, so 2(n-1)/(3n-2) -> 0.667, and the measured ceiling band 0.667-0.79 STRADDLES
  // the 0.75 bar. Clipped-tail echoes are exactly what leak recovery produces (mute, late unmute,
  // loud-trim), so the belt was blind to its own main case (two known specimens scored 0.69).
  // Comparing against the best window of the SAME normalized length restores the margin.
  // Cost: grams(t) built ONCE, windows strided n/8, <= 6 short cached strings.
  const echoBest = (t: string, s: string) => {
    const nt = echoNorm(t), ns = echoNorm(s);
    if (nt.length < 2 || ns.length < 2) return 0;
    const A = echoGrams(nt);
    if (ns.length <= nt.length * 1.2) return dice(A, echoGrams(ns));
    let best = dice(A, echoGrams(ns.slice(-nt.length)));      // the exact tail is always tested
    const step = Math.max(1, Math.floor(nt.length / 8));      // strided: ~8 probes per window length
    for (let i = 0; i + nt.length <= ns.length; i += step) best = Math.max(best, dice(A, echoGrams(ns.slice(i, i + nt.length))));
    return best;
  };
  /** Best match against anything we spoke within `maxAgeMs`, AND the line it matched — the
   *  source line is what the residual test below strips, so it must travel with the score.
   *  Costs NOTHING when leak is impossible: no ring, a too-short transcript, or a ring whose
   *  newest line is already older than the window (recentSpoken is push-ordered by time). */
  const echoScore = (t: string, maxAgeMs = Infinity): { score: number; src: string } => {
    const nt = echoNorm(t);
    if (!recentSpoken.length || nt.length < ECHO_MIN_CHARS) return { score: 0, src: "" };
    const now = Date.now();
    if (now - recentSpoken[recentSpoken.length - 1]!.t > maxAgeMs) return { score: 0, src: "" };
    // EXACT / PREFIX FAST PATH, before Dice (call 31192, 2026-08-20). Two of that loop's
    // shapes never reached the Dice pass at all: the length floor of 8 returned 0 for
    // "Perfect."(7) / "I'm here."(6) / "Exactly."(7) / "Hey."(3) before anything was compared,
    // and a leak that our own barge detector CUT mid-word leaves only the opening of the line
    // on the wire ("Hey." off "Hey, welcome back! The mind voice is restored...") — a prefix,
    // not a near-match. Normalized equality, or a prefix of a line we just spoke, is
    // CERTAINTY rather than similarity, so it scores 1 outright and skips the window search.
    // The floor is its own knob: the only cost of a false positive here is one auto-reply the
    // mouth does not give (his words are never touched), but a rig where he answers in very
    // short words can raise it.
    for (const s of recentSpoken) {
      if (now - s.t > maxAgeMs) continue;
      const ns = echoNorm(s.text);
      if (ns.length >= ECHO_MIN_CHARS && (ns === nt || ns.startsWith(nt))) return { score: 1, src: s.text };
    }
    if (nt.length < 8) return { score: 0, src: "" };   // Dice keeps its own, higher floor
    let score = 0, src = "";
    for (const s of recentSpoken) {
      if (now - s.t > maxAgeMs) continue;
      const sc = echoBest(t, s.text);
      if (sc > score) { score = sc; src = s.text; }
    }
    return { score, src };
  };
  const ECHO_BAR = 0.75;        // text belt on the RECOVERY path — one of FOUR conditions to delete
  const ECHO_LIVE_BAR = 0.9;    // a LIVE turn is never deleted, only flagged + answered-not, so the
                                // bar stays high: being wrong costs one auto-reply, never his words
  // Shortest transcript the belt will judge at all. Below it, a match carries no information
  // (one bigram matches any line containing it) — "כן" must never be explained away.
  const ECHO_MIN_CHARS = Math.max(2, Number(process.env.APIPLAN_ECHO_MIN_CHARS) || 3);
  // How long the mouth stays silent after a self-echo turn. Sized from call 31192's own
  // cadence: the loop's turns landed 1.4-2.1s apart, so one window covers the NEXT turn in a
  // cascade — including the ASR-garbage turns ("Yalla.", "Metsuya ?", "אני שומע." — the mouth's
  // own Hebrew mis-transcribed) that no text belt can ever match. Each new flag re-arms it.
  const ECHO_HOLD_MS = Math.max(0, Number(process.env.APIPLAN_ECHO_HOLD_MS) || 2500);
  // ── MIN-TRANSCRIPT BAR (the MIND's +1, bus 2026-08-23 03:01:58) ───────────────────
  // "a 1-character you-turn ('A', 97289) got a full mouth reply — the empty-transcript gate lets
  // <=2-char transcripts through; add a min-transcript-length gate." MEASURED BEFORE CHOSEN
  // (hands, corpus = 3 call logs, 155 you-turns): length 1 → 3 turns, every one machine junk
  // ("A" ×1 on 97289, the very turn that drew this order; "E" ×2 on 88125, one already flagged
  // echo_leak_fragment); length 2 → ZERO turns; length 3 → ZERO. So the bar is ONE character, not
  // three: he answers in two-character Hebrew words constantly ("כן", "לא", "אה") and a blind <3
  // would have killed real answers for a class the corpus never shows. APIPLAN_SHORT_OK is the
  // allow-list that protects those answers for anyone who raises the bar — stated honestly, at the
  // default bar of 2 it is never consulted, so it is safety, not measurement.
  const SHORT_MIN_CHARS = Math.max(0, Number(process.env.APIPLAN_MIN_TRANSCRIPT_CHARS ?? 2));
  const SHORT_OK = new Set((process.env.APIPLAN_SHORT_OK ?? "כן לא אה או מה זה לך בו נו OK ok yes no").split(/\s+/).filter(Boolean));
  let echoHoldUntil = 0;        // until this wall clock a VAD auto-reply is an answer to our own voice
  // ── LEAK-FRAGMENT QUARANTINE (call 96642 @ 02:15:53 — three fake "you" turns) ─────────
  // Overlap recovery resent 8.4s of speaker leak (`audio resent (8.4s): overlap-...wav`) and
  // the recogniser turned it into "Hallo." / "Ismét elő." / "我不会。" — garbage in three
  // languages this call never spoke. The TEXT belt scored 0.00 on all three (garbled leak
  // matches no line we said), the TIMING belt fired alone, and a lone timing belt may only
  // FLAG — so all three entered the model's context as if he had said them. The same machinery
  // that DID remove the 02:17:04 turn (sim 0.87) was blind here by construction.
  // THE BELT: a SHORT fragment carved out of a resend that carries not one character of the
  // script this call is actually spoken in is the recogniser guessing at our own loudspeaker,
  // never his speech. The profile is LEARNED from his own unflagged turns, so an English-only
  // call never arms it and no setting can lie about which language he is speaking.
  // HIS WORDS NEVER LEAVE THE LOG: identical treatment to the sim path — removed from the
  // MODEL'S context only, still emitted, still archived, byte-identical, with the evidence.
  const LEAK_FRAG_CHARS = Math.max(0, Number(process.env.APIPLAN_LEAK_FRAG_CHARS) || 24);   // 0 disables the belt
  const LEAK_FRAG_MIN_TURNS = Math.max(1, Number(process.env.APIPLAN_LEAK_FRAG_MIN_TURNS) || 8);
  // Load-bearing short words are NEVER explained away (the same instinct as echoResidual's floor).
  const LEAK_FRAG_KEEP = new Set(["ok", "yes", "no", "stop", "wait", "mute", "כן", "לא"]);
  const hasHebrew = (t: string) => /[\u0590-\u05FF]/.test(t);
  let cleanTurns = 0, cleanHebrew = 0;   // language profile, learned from his OWN unflagged turns
  /** True when a transcript is a short fragment with no character of the script the call is
   *  spoken in. Consulted ONLY for resend-carved turns, and only once the profile has real
   *  evidence — before that, and on a call he speaks Latin-script in, it always returns false. */
  const leakFragment = (t: string) => {
    if (!LEAK_FRAG_CHARS) return false;
    const n = echoNorm(t);
    if (!n || n.length > LEAK_FRAG_CHARS || LEAK_FRAG_KEEP.has(n)) return false;
    return cleanTurns >= LEAK_FRAG_MIN_TURNS && cleanHebrew / cleanTurns >= 0.2 && !hasHebrew(t);
  };
  /** What the transcript says that our own recent speech does NOT explain. Clause by clause: a
   *  clause we clearly said is stripped, everything else survives. A SHORT clause is never
   *  explained away — "כן" is one bigram and would match any line containing it, yet a yes/no
   *  is the most load-bearing thing he says. Under 4 normalized chars, it stays. */
  const echoResidual = (t: string, s: string) => {
    const ns = echoNorm(s);
    return t.split(/(?<=[.!?…。！？؟])\s+|\n+/)
      .filter((p) => {
        const np = echoNorm(p);
        if (!np) return false;
        if (np.length < 4) return true;                       // a short answer is never "explained"
        return !(echoBest(p, s) >= 0.6 || ns.includes(np));
      }).join(" ").trim();
  };
  /** Information-free = our own speech explains the transcript ENTIRELY. No slack: anything at
   *  all left over is his, and his words are never deleted. The `?` clause is a redundant belt. */
  const infoFree = (r: string) => echoNorm(r).length === 0 && !/[?？؟]/.test(r);
  let curItemId: string | null = null;       // assistant item whose audio is playing
  let itemFirstDeltaAt = 0;                  // wall clock of that item's first audio delta
  let itemQueuedMs = 0;                      // how much audio of it we handed the player
  const cancelledResponses = new Set<string>();

  // ─── GAPLESS TURN ARCHIVE (fire17's never-lose law, 2026-08-20) ───────────────
  // Tee every mic frame to per-turn WAVs BEFORE any drop (mute / barge / backpressure),
  // so what the human said survives even when the model never heard it (the lost
  // 2-minute caps-on message, 2026-08-20). Segments roll when the mouth starts a reply
  // (= the user-turn boundary per fire17), on mute flips, and at a 10-minute failsafe;
  // segments that never rise above the silence floor are deleted. APIPLAN_ARCHIVE=0 off.
  const archOn = process.env.APIPLAN_ARCHIVE !== "0" && process.env.LM_PRIVATE !== "1";
  // Privacy switch (fire17, voice, 2026-08-20): archive_mode "always" (default) keeps
  // every frame even while muted; "caps-only" archives only what the model can hear.
  // Read live from settings.json (2s cache) so the dashboard toggle applies instantly.
  let archMode = "always"; let archModeAt = 0;
  const archAllowed = () => {
    const now = Date.now();
    if (now - archModeAt > 2000) {
      archModeAt = now;
      try { archMode = JSON.parse(fs.readFileSync(`${process.env.HOME}/.livemind/settings.json`, "utf8")).archive_mode || "always"; }
      catch { archMode = "always"; }
    }
    if (archMode === "off") return false;   // PRIVATE (canon 019): the app switch stops every archive write, live
    return archMode !== "caps-only" || !micMuted;
  };

  // ── CANON 048 (fire17, voice, 2026-08-22): CAPS ON + he is speaking + the mic is MUTED
  // → unmute IMMEDIATELY, "באופן מכניסטי אוטומטית". Caps ON *is* his standing order to be
  // heard; a mute that survives it is always a bug (a park, a forgotten {"mute":true}, a
  // stale gate) and today it costs him a whole sentence until lm-ptt's 5s heartbeat heals it.
  // WHY HERE AND NOT IN lm-ptt: the speech evidence lives ONLY in this process (the muted-frame
  // accumulator below + the VP child); lm-ptt is a blind keyboard gate and a second capture is
  // a recorded dead end (device contention). NO FIGHT WITH THE HEARTBEAT BY CONSTRUCTION: this
  // fires only while caps is ON, and lm-ptt asserts mute=false in exactly that state — both
  // writers push the same direction. Caps OFF → this never fires and his mute stands.
  // The caps fact reaches us the way stereo.json / settings.json do: a small file lm-ptt
  // publishes (~/.livemind/caps.json, 150ms cadence), read here with a 500ms cache.
  //   { caps: bool, inject: "<the inject path lm-ptt gates>", ts: epoch_ms,
  //     audio_out: [ { pid, ppid, bundle } ] }   // CoreAudio processes running OUTPUT right now
  // SOLE EXCEPTION (his): other media playing — he may have silenced the mic on purpose to
  // listen to it. OUR OWN playback must never count: every player we spawn (mouth ffplay,
  // MIND narrator ffplay) is a DIRECT CHILD of this process, so ppid === process.pid is the
  // exact exclusion (verified live: narrator pid 31270 ppid 96642 = the engine). corespeechd
  // is excluded too — measured, it flips to output-running WITH our own playback and never
  // independently, so counting it would disable this law permanently.
  const AUTOUNMUTE_MS = Number(process.env.APIPLAN_AUTOUNMUTE_MS ?? 400);   // 0 disables the law
  const CAPS_PATH = `${process.env.HOME}/.livemind/caps.json`;
  const AUDIO_OUT_IGNORE = new Set(["com.apple.CoreSpeech"]);
  let capsJson: any = null; let capsReadAt = 0; let autoUnmutedAt = 0;
  // CANON 041 (his voice, 2026-08-22): "אני רוצה להיות מסוגל לדבר בפרטיות כשהקפסולה סגורה."
  // Caps closed = REAL privacy. Recordings still CONTINUE (041 keeps never-lose at full scope,
  // and canon 047's caps-off archive keeps receiving engine turn-WAVs) — what stops is REACH.
  // Enforced at TRANSCRIPT PRODUCTION rather than per organ (E535): if a caps-closed turn never
  // becomes a `you` event, the mouth, every organ and the canon are compliant BY CONSTRUCTION
  // instead of by each of them remembering. That is his "חייב להיות לפי הקוד" applied to reach.
  //
  // The witness is the LAST MOMENT CAPS WAS SEEN ON, sampled from the file lm-ptt publishes —
  // never from `micMuted`, which is lm-ptt's OPINION of caps and was wrong often enough that
  // canon 048's sensor had to be built. A turn is caps-closed only if caps was never witnessed
  // ON at any point inside it.
  //
  // FAILS TOWARD PUBLISHING, on purpose: no publisher, a stale file, or a caps.json that gates a
  // DIFFERENT call all leave `capsOnAt` fresh, so an absent sensor can never silently swallow his
  // words. Privacy he can verify is worth more than privacy that might be a dead file.
  let capsOnAt = Date.now();
  const capsWitness = () => {
    const j = capsNow();
    if (!j) { capsOnAt = Date.now(); return; }                                   // no publisher → assume heard
    if (Date.now() - (Number(j.ts) || 0) > 4000) { capsOnAt = Date.now(); return; }   // stale → assume heard
    if (j.inject && injectPath && String(j.inject) !== injectPath) { capsOnAt = Date.now(); return; }  // gates another call
    if (j.caps === true) capsOnAt = Date.now();
  };
  const capsNow = () => {
    const now = Date.now();
    if (now - capsReadAt > 500) {
      capsReadAt = now;
      try { capsJson = JSON.parse(fs.readFileSync(CAPS_PATH, "utf8")); } catch { capsJson = null; }
    }
    return capsJson;
  };
  // true only when we can SEE foreign audio output. An absent/old file is "unknown", and the
  // law wins over the unknown (his exception names media he can hear, not a missing sensor) —
  // it is logged either way so a wrong unmute is never a mystery.
  const foreignAudioOut = (j: any): { on: boolean; who: string } => {
    const list = Array.isArray(j?.audio_out) ? j.audio_out : null;
    if (!list) return { on: false, who: "unknown (no audio_out in caps.json)" };
    const foreign = list.filter((a: any) => a && a.pid !== process.pid && a.ppid !== process.pid
      // ppid is the general rule (our players are direct children), and the two live player
      // handles are the belt: a reparented child (ppid 1) was reproduced in test and would
      // otherwise read as foreign media.
      && a.pid !== player?.pid && a.pid !== mindPlayer?.pid
      && !AUDIO_OUT_IGNORE.has(String(a.bundle || "")));
    return { on: foreign.length > 0, who: foreign.map((a: any) => `${a.bundle || "pid " + a.pid}`).join(", ") };
  };
  // Called from the muted-frame path the moment speech evidence crosses the bar.
  const autoUnmuteIfCapsOn = (evidence: string) => {
    if (AUTOUNMUTE_MS <= 0 || !micMuted) return;
    if (Date.now() - autoUnmutedAt < 3000) return;              // anti-flap if something re-mutes us
    const j = capsNow();
    if (!j || j.caps !== true) return;                          // no publisher, or caps is OFF → his mute stands
    if (Date.now() - (Number(j.ts) || 0) > 4000) return;        // stale file: lm-ptt is dead, do not act on a ghost
    if (j.inject && injectPath && String(j.inject) !== injectPath) return;   // caps gates ANOTHER call (parked ≠ ours)
    const media = foreignAudioOut(j);
    if (media.on) {
      say("info", `auto-unmute held — caps is ON and you are speaking, but other media is playing (${media.who}); canon 048 exception`,
        { auto_unmute_held: true, media: media.who });
      return;
    }
    autoUnmutedAt = Date.now();
    micMuted = false;
    archRoll("auto-unmute (canon 048)");
    say("info", `auto-unmuted — caps ON and you were talking into a muted mic (${evidence}${media.who === "unknown (no audio_out in caps.json)" ? ", media state unknown" : ""})`,
      { auto_unmute: true, evidence, media: media.who });
  };
  const archDir = `${process.env.HOME}/.livemind/recordings/${logPath ? basename(logPath).replace(/\.jsonl$/, "") : `talk-${process.pid}`}`;
  let archFd = -1; let archBytes = 0; let archPeak = 0; let archN = 0; let archPath = "";
  let archLastResp = "";
  const archHeader = (len: number) => {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + len, 4); h.write("WAVEfmt ", 8);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(len, 40);
    return h;
  };
  const archRoll = (why: string) => {
    if (archFd < 0) return;
    try {
      const fd = archFd; archFd = -1;
      fs.writeSync(fd, archHeader(archBytes), 0, 44, 0);   // patch the placeholder header
      fs.closeSync(fd);
      if (archPeak < 500) fs.unlinkSync(archPath);          // pure room noise, no speech
      else say("info", `turn archived (${why}): ${archPath}`);
    } catch { /* archive must never break the call */ }
    archBytes = 0; archPeak = 0; archPath = "";
  };
  const archWrite = (frame: Uint8Array) => {
    if (!archOn || !archAllowed()) return;
    try {
      if (archFd < 0) {
        fs.mkdirSync(archDir, { recursive: true });
        archPath = `${archDir}/turn-${String(++archN).padStart(3, "0")}-${Date.now()}.wav`;
        archFd = fs.openSync(archPath, "w");
        fs.writeSync(archFd, archHeader(0));                 // placeholder; patched on roll
      }
      fs.writeSync(archFd, frame);
      archBytes += frame.length;
      for (let i = 0; i + 1 < frame.length; i += 32) {       // sparse peak scan — cheap
        const v = Math.abs((frame[i] | (frame[i + 1] << 8)) << 16 >> 16);
        if (v > archPeak) archPeak = v;
      }
      if (archBytes > RATE * 2 * 600) archRoll("10min failsafe");
    } catch { /* archive must never break the call */ }
  };

  let player: ReturnType<typeof Bun.spawn> | null = null;
  let speaking = false;          // the model currently has audio in flight
  let playerChecked = false;
  let playerRestarts = 0;        // guard against a death-loop if ffplay can't start at all
  const startPlayer = () => {
    panReset("mouth");   // fresh player, fresh byte alignment: a half-sample carried from the dead one would shift everything after it
    stereoRecheck((m) => rec({ ev: "info", text: m }));   // AirPods can arrive mid-call: re-decide mono-sum, ≤1 probe/30s
    const p = Bun.spawn(spk, { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
    player = p;
    // Per-player death watch (not once-ever): a player that dies MID-CALL — device change,
    // audio-unit reset, SIGPIPE — used to leave the turn a silent black hole while the
    // playback clock kept gating the mic. Restart it (bounded) and stop gating the mic for
    // audio no one heard. Bounded so a player that simply can't start never spins.
    p.exited.then((code) => {
      if (player !== p) return;                 // already replaced by endPlayer/stopPlayer — normal
      if (closed || closing) return;
      playingUntil = 0;
      if (++playerRestarts > 5) { say("info", `audio player keeps dying (${code ?? "?"}) — continuing without playback`); player = null; return; }
      say("info", `audio player died (${code ?? "?"}) — restarting`);
      startPlayer();
    });
    // A player that dies on STARTUP is indistinguishable from silence, so check once and
    // say so. (A wrong flag killed it instantly and the whole thing looked mute.)
    if (!playerChecked) {
      playerChecked = true;
      setTimeout(() => {
        if (p.exitCode !== null && p.exitCode !== 0) say("info", `audio player exited (${p.exitCode}) — you will hear nothing; check ffplay`);
      }, 700);
    }
  };
  // Players that were handed off by endPlayer() and are STILL AUDIBLE while they drain.
  // Without this set they were unreachable: endPlayer() nulled `player`, so a later
  // stopPlayer() killed nothing and the mouth's tail kept playing UNDER the MIND's voice —
  // the residual "still there was more" overlap. (fire17, 2026-08-18.)
  const draining = new Set<any>();
  /** End of a reply: close stdin so the player drains what is queued, then exits. */
  const endPlayer = () => {
    try { player?.stdin?.flush?.(); } catch {}
    try { player?.stdin?.end?.(); } catch {}
    if (player) {                  // still audible until the buffer runs out — keep it killable
      const p = player;
      draining.add(p);
      try { p.exited.then(() => draining.delete(p)); } catch { draining.delete(p); }
    }
    player = null;                 // the next reply spawns a fresh one, with a fresh clock
  };
  /** Barge-in: kill it mid-word, discarding whatever is still queued. SIGKILL, not TERM —
   *  ffplay has audio buffered ahead, and on TERM it keeps draining that buffer for a beat,
   *  which is exactly the "two voices at once" overlap when an injection interrupts.
   *  Kills the DRAINING players too — a finished-generating reply is still coming out of the
   *  speaker, and that tail is what the MIND used to talk over. */
  const stopPlayer = () => {
    const hadLive = !!player;
    const droppedMs = paceClear();          // canon 013: the un-written queue dies FIRST, so the
    pace.paused = false;                    // kill below only ever silences ≤ LOOKAHEAD ms of pipe
    try { player?.kill(9); } catch {}
    player = null;
    const n = draining.size;
    for (const p of draining) { try { p.kill(9); } catch {} }
    draining.clear();
    // Evidence in the log that the mouth was actually silenced — `n` is the tail that used to
    // keep playing under the MIND's voice (unreachable before the draining set existed).
    if (hadLive || n || droppedMs) say("info", `mouth silenced (live=${hadLive ? 1 : 0} draining-tail=${n}${droppedMs ? ` queued-dropped=${droppedMs}ms` : ""})`);
  };
  // Note: the player is spawned lazily on the first audio byte (below), NOT pre-spawned —
  // ffplay with -autoexit on a still-empty stdin exits immediately (code 123). The
  // low-latency flags on speakerCommand() still cut real audible latency once it starts.

  // ── PACED PLAYER (fire17, typed, canon 013: "a built in blazingly fast responsive media
  // player... instead of sigkills lets mechanistically pause") ────────────────────────────
  // The engine no longer dumps a whole reply into ffplay's buffer ahead of realtime: chunks
  // queue HERE, and a 20ms pump writes only enough to stay LOOKAHEAD ms ahead of the wall
  // clock. Every control (pause / clear / kill) is therefore felt within that window —
  // ffplay can never be holding seconds of future audio again. The schedule clocks
  // (queueAudio/playingUntil/itemQueuedMs) still advance at ENQUEUE time, unchanged: they
  // describe what is scheduled, not what has left the pipe.
  const PACE_LOOKAHEAD_MS = Math.max(80, Number(process.env.LM_PACE_LOOKAHEAD_MS) || 240);
  const pace = { q: [] as { pcm: Buffer; ms: number }[], aheadUntil: 0, timer: null as any, paused: false, endPending: false };
  const pacePump = () => {
    if (pace.timer) return;
    pace.timer = setInterval(() => {
      if (pace.paused) return;
      const now = Date.now();
      if (pace.aheadUntil < now) pace.aheadUntil = now;
      while (pace.q.length && pace.aheadUntil - now < PACE_LOOKAHEAD_MS) {
        const c = pace.q.shift()!;
        if (!player || player.exitCode !== null) startPlayer();   // spawn at WRITE time — an empty-stdin ffplay exits 123
        try { player!.stdin!.write(c.pcm); player!.stdin!.flush?.(); } catch { playingUntil = 0; }
        pace.aheadUntil += c.ms;
      }
      if (!pace.q.length) {
        if (pace.endPending) { pace.endPending = false; endPlayer(); }
        if (pace.aheadUntil <= Date.now()) { clearInterval(pace.timer); pace.timer = null; }
      }
    }, 20);
  };
  /** Enqueue one already-panned/trimmed PCM chunk with its MONO duration. */
  const paceFeed = (pcm: Buffer, ms: number) => { pace.q.push({ pcm, ms }); pacePump(); };
  /** End-of-reply: close the player's stdin only after the queue has drained through it. */
  const paceEnd = () => { pace.endPending = true; pacePump(); };
  /** Drop everything not yet written; returns the dropped milliseconds (for the log). */
  const paceClear = () => { const n = pace.q.reduce((s, c) => s + c.ms, 0); pace.q.length = 0; pace.endPending = false; pace.aheadUntil = 0; return Math.round(n); };
  // ── MECHANISTIC PAUSE (canon 013/014): SIGSTOP freezes every audible child inside one
  // audio callback — mouth stream, draining tails, and the MIND's file-playing narrator
  // alike — and SIGCONT resumes from the exact frozen sample. No kills, no respawns.
  const pauseAll = () => {
    pace.paused = true;
    for (const p of [player, ...draining, mindPlayer]) { try { p?.kill("SIGSTOP"); } catch {} }
  };
  const resumeAll = () => {
    pace.paused = false;
    for (const p of [player, ...draining, mindPlayer]) { try { p?.kill("SIGCONT"); } catch {} }
    pacePump();
  };

  let micProc: ReturnType<typeof Bun.spawn> | null = null;
  let closed = false;
  // ── ARCH-A BARGE-IN (LM_BARGE_VP=1) — OFF by default, and OFF means byte-identical ──
  // The capture child (aec.ts) IS the microphone: macOS VoiceProcessingIO cancels our own
  // loudspeaker inside CoreAudio, before the sample is captured, and a Silero gate on that
  // CLEANED signal decides what is a barge. Measured on this rig 2026-08-21 (three rounds of
  // three, narration through the speakers, cleaned peaks 21101/27223/21926 at prob 0.95-0.998).
  // WHAT STAYS IN THE ENGINE: the arming (below), the refractory, and every cut decision —
  // the child scores voice, the engine decides what a barge MEANS, on machinery that exists.
  let vp: VpCapture | null = null;
  let vpDown = false;              // it failed once — this call never tries it again
  let vpBargeAt = 0;               // last child event that PASSED the arming gate below
  let vpEv: VpEvent | null = null; // that event, for the record and the log
  // FRESHNESS, not arming — the two were one env var in v2 and they are different jobs.
  // LM_BARGE_VP_ARM_MS now names the CONVERGENCE warmup and lives in aec.ts (default 2500ms);
  // this is the much shorter window in which an event may still influence a frame decision.
  const VP_FRESH_MS = Math.max(100, Number(process.env.LM_BARGE_VP_FRESH_MS) || 800);
  /** A barge is "fresh" for one short window — long enough for the next mic frame to reach
   *  the detectors below, short enough that a stale event can never cut a later reply. */
  const vpFresh = () => vpBargeAt > 0 && Date.now() - vpBargeAt < VP_FRESH_MS;
  /** The MOUTH's event-driven cut, wired inside the socket scope (it needs the mouth's own
   *  state). DEFECT 2.2: in duplex the frame-loop disjunct `(stillAudible() && !bargeOn)` is
   *  false by construction, so with caps OFF nothing cut a speaking mouth at all — his own
   *  acceptance bar (canon 059, "repeated (incl. caps-off)") could not have passed. */
  let vpMouthCut: (() => void) | null = null;
  /** ARMING (the engine's half of the gate, redteam P1-6): evidence is banked ONLY while our
   *  own audio is actually in the air. A voice in a quiet room is not a barge — it is a turn,
   *  and the normal path already handles it. This is also the reference cross-check arch A
   *  cannot get from the canceller: the engine knows exactly when it is rendering. */
  const onVpBarge = (e: VpEvent) => {
    if (closed || vpDown) return;
    // CONVERGENCE ARMING belt (aec.ts owns the gate; this is the second lock on the same door).
    if (!vp?.armed) return;
    if (!(stillAudible() || mindPlayer)) return;
    vpBargeAt = Date.now(); vpEv = e;
    // CAPS DECISION (a) FOR THE MOUTH, event-driven. Everything else in this design rides a mic
    // FRAME, and in duplex the mouth's frame branch never runs — so this is the one cut that has
    // to be driven by the event itself. It touches PLAYBACK and the model's own item; it sends
    // no audio anywhere, so the absolute invariant (nothing gated reaches the model) is intact.
    try { vpMouthCut?.(); } catch { /* a barge must never break the call */ }
  };
  /** FAIL-SAFE (P0-5). Any failure — missing binary, TCC denial, zero frames, a dead child —
   *  reverts to the ordinary ffmpeg mic LIVE: the child is killed, its stdout ends, and the
   *  mic supervisor respawns micCommand() on its next turn. The call never goes deaf. */
  const vpRevert = (why: string) => {
    vpDown = true; vp = null; vpBargeAt = 0; vpEv = null;
    // DEFECT 4.2 — THE FOUNDING INVARIANT. The mic path reverts to ffmpeg correctly, but the
    // CALL did not: duplex outlived the canceller, leaving his frames flowing to a server VAD
    // that is listening to our own speakers. That is exactly the configuration of call 31192
    // (40/40 self-cuts). Duplex exists ONLY because arch A cancels the leak at capture; when the
    // canceller dies, duplex must die with it. Half-duplex brings its own mic gate, local barge
    // and overlap recovery, so nothing of his is lost — the mouth merely finishes its sentence.
    if (bargeOn) {
      bargeOn = false;
      say("info", `vp capture down (${why}) — duplex DISARMED, full retreat to half-duplex for the rest of this call (duplex with no canceller IS call 31192; restart to re-arm)`,
        { duplex_disarmed: true, reason: "vp_down", why });
    }
  };
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  // ─── CALL ROTATION: THE 60-MINUTE CAP IS A SCHEDULE, NOT A SURPRISE ──────────────
  // MEASURED on this rig, five capped calls: the server closes the session exactly
  // session_start + 3600.00s (3600.005 / 3600.013 / 3600.034 / 3600.018 / 3599.996 — spread
  // 40ms), anchored on the SOCKET, not on process start. Today `apiplan talk` simply DIES there
  // (error -> ws.onclose -> done -> close -> the process exits) and a human or the MIND notices
  // and relaunches by hand. The measured holes between consecutive calls: 27.0s and 45.0s of
  // real deafness (Eva's 23s/41s are the LAUNCH gap; the socket needs another ~4.2s before the
  // microphone even exists), and once 21m38s when nobody noticed. NOTHING is captured in that
  // window — micLoop() is started from onOpen, so with no socket there is no mic child, no
  // archive and no transcript: those seconds do not exist anywhere. That is the SACRED
  // violation this block removes, and it is unbounded, which is the real severity.
  //
  // HIS DESIGN (canon 024, voice: "שהיוזר אפילו לא ישים לב שמשהו השתנה ברקע... אסור ששום דבר
  // ייפול בין המקטעים האלה", and the addendum "אולי אפילו לקרוא ל[חדשה] ולראות שזה רץ בשקט רגע
  // לפני שמחליפים את הערוץ"): overlap-then-cut, never cut-then-start. Before the cap, open the
  // NEXT session PARKED (deaf + silent), watch it run quietly, seed it with the conversation so
  // far, and hand the microphone over in ONE synchronous assignment at a quiet moment.
  //
  // WHY IN-PROCESS AND NOT A SECOND `apiplan talk`. Every control-plane consumer resolves a call
  // by its --log path from `ps` (lm-calls, lm-remind's active_call, the hub registry, lm-ptt).
  // Rotating in place keeps the pid, the LOG, the .inject path, the archive dir, the mic child,
  // the player and the mind-state file CONSTANT, so the rotation is invisible above this file:
  // a reminder written 1ms before the swap and one written 1ms after land in the same queue and
  // both get spoken. Two processes would move the call's identity at exactly the instant his
  // words are most at risk, orphan any in-flight inject line, and leave lm-ptt's mic gate armed
  // on the wrong call. This is also NOT a restart in canon 007's sense — nothing is killed and
  // nothing is relaunched; the call continues and only its transport is renewed.
  //
  // THE ONE-ACTIVE INVARIANT, structurally: mic frames are appended at exactly ONE send site
  // (in pumpMic) and it targets `ws`; every response.create in this file targets `ws`. So a
  // socket that is not `ws` is mechanically DEAF — no audio in, therefore no transcript out,
  // therefore it can never produce a duplicate turn — and mechanically MUTE. Parking adds
  // create_response:false and the removal of idle_timeout_ms on top of that.
  //
  // ROLLBACK LADDER — degraded is exactly TODAY, never worse. R1 successor won't connect ->
  // backoff and retry, the live call is never disturbed. R2 the cap fires with no successor ->
  // reconnect IN PLACE (the mic never stopped, the gap is archived and re-fed). R3 the successor
  // dies right after the swap -> the predecessor socket is deliberately HELD OPEN past its drain
  // for the whole revert window (ROT_REVERT_MS), so taking the floor back is a real option and
  // not just a comment. R3b opening the
  // successor KILLS the live session -> promote it, write the verdict to disk and never attempt
  // the overlap again on this machine. R4 everything fails -> the call ends exactly where it
  // ends today and the launcher takes over.
  //
  // ARMING — OPT-IN, and it stays opt-in until a live rotation has actually been watched.
  // LIVEMIND_ROTATE=1 (or on/true/yes) arms the engine. With the variable ABSENT — which is every
  // launcher on this machine today, `~/Creations/LiveMind/livemind` included — or set to 0,
  // nothing below runs: no successor socket is ever opened, no rotation timer is ever started,
  // no rotation line is ever emitted, and the next restart behaves byte for byte like ec768e4.
  // An overlap that has never once been proven on a real call must not arm itself on his.
  const ROT_ON = /^(1|on|true|yes)$/i.test(process.env.LIVEMIND_ROTATE ?? "");
  // The cap, in minutes. LIVEMIND_ROTATE_MIN=2 proves a whole rotation on a throwaway 3-minute
  // call instead of burning an hour of his; every marker below scales with it.
  const ROT_CAP_MS = Math.max(30000, (Number(process.env.LIVEMIND_ROTATE_MIN) || 60) * 60000);
  // Pre-open lead: 180s at the real cap — the same lead the warm daemon already chose. It is a
  // straight tax on the SUCCESSOR's own hour (its cap starts when ITS socket opens), which is
  // why it is bounded rather than generous. Steady-state period becomes ~58 min.
  const ROT_LEAD_MS = Math.min(Number(process.env.LIVEMIND_ROTATE_LEAD_MS) || 180000, Math.max(3000, Math.round(ROT_CAP_MS * 0.05)));
  // HARD FLOOR — swap by here whether or not a quiet moment ever came. 58:00 of a 60:00 cap is
  // 120s of margin under the earliest cap ever measured, and that margin is also what the
  // swap-back rollback needs: a still-live predecessor to fall back into.
  const ROT_FLOOR_MS = Math.round(ROT_CAP_MS * (58 / 60));
  // Only if he is literally mid-utterance AT the floor: a little grace beats a split turn.
  const ROT_GRACE_MS = Math.round(ROT_CAP_MS * (0.5 / 60));
  // How far under a server-stated expires_at we insist on being.
  const ROT_EXP_MARGIN_MS = Math.min(60000, Math.round(ROT_CAP_MS / 60));
  const ROT_VERIFY_MS = 2000;    // "see it run quietly for a moment" before the channel moves
  const ROT_ACK_MS = 3000;       // wait for the un-park to be acknowledged before swapping
  const ROT_CONNECT_MS = 12000;  // a successor that has not configured itself by here is dropped
  const ROT_DRAIN_MS = 5000;     // how long the predecessor may finish speaking / reporting
  // R3 SWAP-BACK WINDOW — and, because it is longer than the drain, how long the predecessor
  // SOCKET is kept open (silent) after its drain ends. The two used to disagree: the revert was
  // gated on 10s while the socket was closed at 5s, so a successor dying in between fell through
  // to a reconnect while the log claimed a zero-gap fallback existed. The window is now real.
  const ROT_REVERT_MS = 10000;
  const ROT_QUIET_MS = 2500;     // the same sustained-silence bar the MIND's own stack gate uses
  let rotState: "off" | "armed" | "opening" | "parked" | "seeded" | "unparking" | "done" = ROT_ON ? "off" : "done";
  let rotGap = false;            // there is NO live session right now (cap fired without a swap)
  let succ: WebSocket | null = null;    // the PARKED successor — deaf and silent until the swap
  let prevWs: WebSocket | null = null;  // the outgoing socket, draining its last seconds
  let sessT0 = 0;                // when THIS session's cap clock started (session.created)
  let sessExpiresAt = 0;         // the server's own deadline in ms, when it states one
  let rotN = 0;
  let rotResending = false;      // a resend is streaming — a swap would split it in half
  let rotTimer: ReturnType<typeof setInterval> | null = null;
  // R3b self-demotion: if opening a successor ever kills the live session, overlap is disabled
  // for this call AND for every future call on this machine.
  const rotConcPath = `${process.env.HOME}/.livemind/rotation-concurrency.json`;
  let rotConcurrent = true;
  // Off-mode purity: with rotation unarmed nothing in this block runs — the demotion verdict
  // is only ever read by rotTick, which never ticks when off (W39 verify LOW).
  if (ROT_ON) try { if (fs.existsSync(rotConcPath)) rotConcurrent = JSON.parse(fs.readFileSync(rotConcPath, "utf8")).concurrent !== false; } catch {}
  /** unix SECONDS or ms -> ms. The server states expires_at in seconds; a future shape change to
   *  ms must not be read as 1970 (the same guard the warm daemon uses). */
  const expiresMs = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : 0; };

  const close = () => {
    if (closed) return; closed = true;
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (playbackTimer) { clearInterval(playbackTimer); pbLastKey = ""; publishPlayback(true); }   // final write: on_air=false
    try { ws.close(); } catch {}
    // ROTATION: a parked successor and a draining predecessor are real sockets. A call that ends
    // mid-rotation must leak neither past process exit (the warm daemon's own orphaned-socket
    // warning is about exactly this).
    if (rotTimer) { clearInterval(rotTimer); rotTimer = null; }
    rotState = "done";
    try { succ?.close(); } catch {}
    try { prevWs?.close(); } catch {}
    succ = null; prevWs = null;
    const m = micProc;
    try { m?.kill(); } catch {}
    if (m) setTimeout(() => { try { m.kill(9); } catch {} }, 500);   // escalate if ffmpeg ignores TERM
    stopPlayer();
    // LANE 15: freeze how much he ACTUALLY heard before the audio dies, so the next call
    // resumes exactly there instead of repeating the sentence or dropping it.
    if (mindLine) mindLine.cut = spokenChars(mindLine);
    if (mindPlayer) { try { mindPlayer.kill("SIGKILL"); } catch {} mindPlayer = null; }
    saveMindState(mindLine ? "cut-by-call-end" : "call-end");
    archRoll("call end");
    try { const f = logw?.flush?.() as any; if (f && typeof f.catch === "function") f.catch(() => {}); } catch {}
  };
  // Clean up the child ffmpeg/ffplay on EVERY exit path, not just Ctrl-C: a leftover
  // ffmpeg keeps the mic device open and the next run fails with "device busy".
  // A daemon that calls talk() repeatedly passes manageSignals:false — per-call process
  // handlers would accumulate, and the uncaughtException rethrow would kill the daemon.
  if (o.manageSignals !== false) {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { close(); process.exit(0); });
    process.on("exit", () => { try { close(); } catch {} });
    // RECORD WHERE IT CAME FROM. Call 63395 died on "uncaught ENOSPC ... write" and the line
    // named no stack, so which of a dozen write paths threw had to be reasoned out afterwards
    // instead of read. A fatal event is exactly the wrong place to be economical with evidence.
    process.on("uncaughtException", (e) => {
      rec({ ev: "info", text: `uncaught ${String((e as any)?.message ?? e).slice(0, 200)}`,
            fatal: true, code: (e as any)?.code ?? null, stack: String((e as any)?.stack ?? "").slice(0, 800) });
      close(); throw e;
    });
  }

  return await new Promise<TalkResult>((resolve) => {
    const done = (result: TalkResult) => { close(); resolve(result); };
    let result: TalkResult | null = null;   // set by the specific enders; onclose falls back to "closed"

    // Connect watchdog: a stalled TLS/WS upgrade (network, or realtime-session rate limit)
    // otherwise hangs forever with no event. Fail loudly instead. Cleared on the first
    // server message (see onmessage) and in close(). A parked socket is already live, so
    // its first message (or our first send) clears it just the same.
    let connected = false;
    connectTimer = setTimeout(() => {
      if (!connected) { say("info", "connect timed out — no response from the realtime endpoint (network or rate limit)"); done({ reason: "timeout" }); }
    }, Number(process.env.APIPLAN_CONNECT_MS) || 12000);

    /** The persona for a parked-socket greeting travels in response.instructions —
     *  NEVER in session config — so the daemon's parked session stays generic. */
    const greetInstructions = () =>
      [o.direction, typeof o.greet === "string" ? o.greet : ""].filter(Boolean).join("\n\n");

    /** LM_GREET=announce, the one-off direction for the opener. Two sentences, never a list —
     *  L42 was a greeting that read a list aloud three times into an empty room. */
    const ANNOUNCE_DIRECTION =
      "Right now, before anything else: say ONE short opening line, per the FIRST GREETING LAW above, "
      + "using the NOW state you were given — say that you are UP and back on the line, and continue "
      + "the thread from the previous session (his last words, and what is still owed him). "
      + "AT MOST TWO SENTENCES. NEVER read a list. Then stop and listen.";
    /** `livePersona` and not `o.direction`: it is the persona actually in force (a MIND
     *  {"session":…} swap moves it), and on a fresh socket this payload OVERRIDES the session
     *  instructions for the opener — so the persona has to be inside it. */
    const announceInstructions = () =>
      [livePersona, typeof o.greet === "string" ? o.greet : "", ANNOUNCE_DIRECTION].filter(Boolean).join("\n\n");

    /** Emit the opening line. The payload is EXACTLY what each path has always sent — a
     *  parked socket carries the persona in response.instructions (so the daemon's parked
     *  session stays generic), a fresh connect already has the persona live in the session
     *  and carries only a one-off direction — so LM_GREET moves WHEN it is sent, never what.
     *  One-shot by construction: `greeted` and `openerArmed` both close here. */
    const sendGreeting = (why?: string, instructions?: string) => {
      if (greeted || closed || closing || ws.readyState !== WebSocket.OPEN) return;
      greeted = true; openerArmed = false; announcedThisConn = true;
      // `instructions` is the LM_GREET=announce carrier and nothing else: on a fresh socket the
      // realtime API treats response.instructions as an OVERRIDE of the session instructions for
      // that one response, so the announce payload has to carry the live persona itself or the
      // opener would speak in the default assistant voice. Every other caller passes nothing and
      // gets the exact payload it has always sent.
      const gi = instructions ?? (o.skipSessionUpdate ? greetInstructions() : (typeof o.greet === "string" ? o.greet : ""));
      ws.send(JSON.stringify({ type: "response.create", ...(gi ? { response: { instructions: gi } } : {}) }));
      awaitingResponse = true;
      if (why) say("info", why);
    };

    const onOpen = () => {
      if (o.skipSessionUpdate) {
        // Parked socket: session.updated will never arrive, so nothing may be gated on it.
        // Tools are per-call: merge them in with a minimal update that touches NOTHING
        // else (partial session.update merges; the observed abort was from resending
        // turn_detection MID-RESPONSE, which this is not — no response is in flight yet).
        // PARKED-SOCKET PERSONA (W36 verify, HIGH). The persona/direction is deliberately kept
        // OUT of the park's own session config so the daemon's parked session stays generic —
        // it has always travelled on the CONNECT GREETING instead (greetInstructions(), below).
        // Under presence/off there IS no connect greeting, so that carrier is gone: without
        // this, every warm-socket call answers him in the default assistant voice for its whole
        // life, and under LM_GREET=0 by construction forever. The fix rides the per-call
        // session.update that already exists here — the park is generic until a call claims it,
        // and this update is that claim — so the persona is in force BEFORE his first turn can
        // be answered. The ONE case excluded is the one that still HAS a carrier — legacy WITH a
        // greeting — so its connect emission stays byte-identical to ec768e4; a legacy call with
        // no greeting has no carrier either and gets the persona here too. When the presence
        // opener does fire later it still sends greetInstructions() (persona + greet) as
        // response.instructions: same text, and an override rather than an append, so the two
        // carriers cannot drift into two different personas.
        const parkPersona = !(GREET_LEGACY && o.greet) && o.direction ? o.direction : "";
        if (parkPersona || o.tools?.length) {
          ws.send(JSON.stringify({ type: "session.update", session: { type: "realtime",
            ...(parkPersona ? { instructions: parkPersona } : {}),
            ...(o.tools?.length ? { tools: o.tools, tool_choice: "auto" } : {}) } }));
          if (parkPersona) say("info", `persona carried into the warm session (${parkPersona.length} chars) — no connect greeting to carry it (GREET MODE ${!o.greet ? "NONE" : GREET_OFF ? "OFF" : GREET_ANNOUNCE ? "ANNOUNCE" : "PRESENCE"})`,
            { park_persona: true, chars: parkPersona.length });
        }
        if (o.greet && !greeted && !announcedThisConn) {
          // A parked socket never reaches session.updated, so announce fires HERE or never — and
          // the persona travels in response.instructions on this path exactly as legacy's does.
          if (GREET_ANNOUNCE) sendGreeting("mouth opener sent (announce) — parked socket, there is no session ack to wait for (LM_GREET=announce)",
            [greetInstructions(), ANNOUNCE_DIRECTION].filter(Boolean).join("\n\n"));
          else if (GREET_LEGACY) sendGreeting();
          else if (GREET_PRESENCE) openerArmed = true;   // held until his first unflagged turn
        }
      } else {
        ws.send(JSON.stringify({ type: "session.update", session: sessionBody(audioInput, o.direction) }));
      }
      // ROTATION: the cap clock belongs to the SOCKET, not to the process — measured, the server
      // closes exactly 3600.00s after the connection and session.created lands ~2ms after it. Arm
      // here so even a parked-socket call rotates, and let session.created refine the anchor with
      // the server's own numbers.
      if (!sessT0) sessT0 = Date.now();
      if (ROT_ON && !rotTimer) rotTimer = setInterval(rotTick, 1000);
      // The mode is ANNOUNCED: under presence/off the mouth is silent at connect by design,
      // and a silence nobody can tell from a dead mouth is how an outage runs undetected.
      // LOUD by policy (W36): presence is the DEFAULT and the launcher does not export
      // LM_GREET, so the line states the active mode, whether it came from the env or from
      // the default, and the one-word escape hatch back to speak-first. A silent mouth must
      // never be indistinguishable from a dead one — or from a mode nobody chose.
      const greetSrc = process.env.LM_GREET ? `LM_GREET=${greetMode}` : "LM_GREET unset → presence DEFAULT";
      const greetModeName = !o.greet ? "none" : GREET_LEGACY ? "legacy" : GREET_ANNOUNCE ? "announce" : GREET_OFF ? "off" : "presence";
      say("info", !o.greet ? `listening — speak, and it answers. GREET MODE: NONE (no greeting requested for this call; ${greetSrc}). Ctrl-C to stop.`
        : GREET_ANNOUNCE ? `GREET MODE: ANNOUNCE (${greetSrc}) — it SPEAKS ONE SHORT OPENER as soon as the session is acked, listener or not, and exactly once per connection. LM_GREET=presence holds the opener until you speak, LM_GREET=0 for never. Ctrl-C to stop.`
        : GREET_LEGACY ? `GREET MODE: LEGACY (${greetSrc}) — connecting, and it SPEAKS FIRST at connect, listener or not. Ctrl-C to stop.`
        : GREET_OFF ? `GREET MODE: OFF (${greetSrc}) — it NEVER opens; the mouth still answers when you speak. LM_GREET=presence to restore the held opening, LM_GREET=1 to speak first. Ctrl-C to stop.`
        : `GREET MODE: PRESENCE (${greetSrc}) — NOTHING is said at connect; the opening line is held and released by your first words. LM_GREET=1 for the old speak-first behaviour, LM_GREET=0 for never. Ctrl-C to stop.`,
        { greet_mode: greetModeName, greet_env: process.env.LM_GREET ?? null, greet_default: !process.env.LM_GREET });
      micLoop();
      startInjectLoop();
      // Keepalive pings (defense): keeps NAT/proxy paths warm during long one-sided
      // stretches. No terminate-on-silence rule — the server legitimately sends nothing
      // while idle (measured 199s of healthy silence), so silence is not death here.
      heartbeat = setInterval(() => { if (!closed && ws.readyState === WebSocket.OPEN) { try { (ws as any).ping?.(); } catch {} } }, 15000);
    };
    // A parked socket has already fired its open event — a late onopen assignment would
    // never run and the call would hang forever. Run the open path directly instead.
    if (ws.readyState === WebSocket.OPEN) queueMicrotask(onOpen); else ws.onopen = onOpen;

    // Microphone → socket, supervised: ffmpeg (avfoundation) dies on device change,
    // sleep/wake, or another app grabbing the mic. Without a supervisor the WS stays open
    // and the user talks into a void with no signal. Respawn with backoff instead.
    async function micLoop() {
      let tries = 0;
      while (!closed) {
        // ARCH A: with LM_BARGE_VP=1 the VPIO child replaces ffmpeg entirely — the OS can
        // only cancel audio it captured itself, so the canceller has to BE the microphone.
        // vpDown (set by the fail-safe) makes this same supervisor take ffmpeg back, live.
        // SPAWN-ONCE (aecmic2's own mitigation note): the helper recovers from an AirPods/BT or
        // device-format switch BY ITSELF (measured: retap + converter rebuild, 1.5-2.3s). So the
        // child is started once per call and kept across mic respawns — respawning it would pay
        // the ~3.5s activation cost again and fight the device for the very same unit.
        if (vp?.down) vp = null;                 // the fail-safe already ran (or is one tick away)
        if (!vp && !vpDown) vp = VpCapture.start(RATE, { onBarge: onVpBarge, onDown: vpRevert, log: say });
        const startedAt = Date.now();
        let firstVp: Uint8Array | null = null;
        if (vp && !vp.handedOver) {
          // NEVER-DEAF HANDOVER (defect 3.4). The VPIO child is measured at +3 656ms to its
          // FIRST buffer on this rig, before pipeA's python/numpy/onnxruntime import — and
          // micLoop re-enters this on every mic respawn and every rotation. Handing it the mic
          // immediately would leave the call deaf for that whole window, with nothing captured
          // and therefore NOTHING ARCHIVED: a direct never-lose regression, invisible in the log.
          // So both run: ffmpeg carries the microphone exactly as today (live in ~150ms) until
          // the VP child's first cleaned byte lands, then the mic swaps over mid-flight and
          // ffmpeg is killed. aec.ts reads that first byte and hands it back, so the switch
          // drops nothing; the small overlap it can cost is a few tens of ms of DOUBLE-archived
          // audio, which is the safe direction (a duplicate is recoverable, a gap is not).
          const ff = Bun.spawn(mic, { stdout: "pipe", stderr: "ignore" });
          micProc = ff;
          vp.whenFirstByte.then((v) => {
            if (!v || closed) return;
            firstVp = v;
            say("info", `mic handover: ffmpeg → VPIO cleaned capture after ${Date.now() - startedAt}ms — the activation window was NOT deaf and every frame of it is archived`,
              { vp_handover: true, ms: Date.now() - startedAt });
            try { ff.kill(9); } catch {}
          }).catch(() => {});
          await pumpMic(ff);
          // ffmpeg died for a reason OTHER than the handover (device change, sleep/wake): fall
          // through to the ordinary backoff below and re-enter with the SAME vp child alive.
          if (closed) return;
          if (!firstVp) {
            if (ws.readyState !== WebSocket.OPEN && !rotHold()) return;
            if (Date.now() - startedAt > 10000) tries = 0;
            if (++tries > 6) { say("info", "microphone gone — ending call"); done({ reason: "mic-lost" }); return; }
            say("info", `microphone restarting (try ${tries})`);
            await Bun.sleep(Math.min(250 * 2 ** (tries - 1), 4000));
            continue;
          }
        }
        // `vp` can be nulled by the fail-safe between the handover and this line, so the VP
        // stream is taken ONLY while the child is still the live one — otherwise ffmpeg, today.
        const onVp = !!vp && (vp.handedOver || !!firstVp);
        micProc = onVp ? vp!.proc : Bun.spawn(mic, { stdout: "pipe", stderr: "ignore" });
        // The handover chunk is real microphone audio either way — it is handed to whichever
        // pump runs, so it is archived and sent even if the VP child died in the same instant.
        await pumpMic(micProc, firstVp ?? undefined);
        // ROTATION: a socket that is BETWEEN sessions is not a dead call. Keeping the mic child
        // alive across a handover is the entire reason the successor has no deaf window — kill it
        // here and the fix would manufacture the very hole it exists to remove.
        if (closed || (ws.readyState !== WebSocket.OPEN && !rotHold())) return;
        if (Date.now() - startedAt > 10000) tries = 0;   // ran a while → fresh budget
        if (++tries > 6) { say("info", "microphone gone — ending call"); done({ reason: "mic-lost" }); return; }
        say("info", `microphone restarting (try ${tries})`);
        await Bun.sleep(Math.min(250 * 2 ** (tries - 1), 4000));
      }
    }

    // Pump one ffmpeg's stdout until it ends. While the model is speaking we stop sending,
    // unless barge-in was asked for: on speakers its own voice re-enters the mic and it
    // interrupts itself in a loop.
    //
    // OVERLAP RECOVERY (fire17, voice, 2026-08-20: "אני צריך לראות את זה באפליקציה מיד
    // איך שאמרתי את זה"): in no-barge mode, speech spoken WHILE the mouth talks is
    // frame-dropped below — the model never hears it, so it never transcribes and never
    // reaches the dashboard (it survives only in the archive). Fix: track the dropped
    // window (it sits at known byte offsets of the CURRENT archive segment — segments
    // roll exactly at mouth-reply start), and once playback ends, auto-resend that slice
    // through the proven resendAudio path with auto-reply SUPPRESSED — the server
    // transcribes it (words land on the dashboard seconds later, and in the model's
    // context so the mouth's next answer knows them) but the response.created cancel
    // (suppressAuto) guarantees the mouth never answers the recovered turn on its own.
    // Live frames re-entering the model was the historical echo bug (see playingUntil
    // note) — this path never re-opens it: no audio flows during playback, and the
    // recovered turn cannot auto-fire a reply.
    // ponytail: single-shot at playback end; if a mouth reply runs very long, his words
    // surface only after it ends — chunked mid-playback recovery is the revisit.
    let ovStart = -1; let ovEnd = 0; let ovPath = ""; let ovAt = 0; let ovSrc = "";
    let recovering = false;
    // USER BARGES MIND (fire17's law: his voice outranks everything, including the MIND's
    // own audio). While the MIND narrator plays, mic frames are gated (echo-safe) but still
    // observed LOCALLY: sustained loud audio well above speaker-leak level means the human
    // is talking over the MIND → kill the MIND's player mid-word, unblock the mic so his
    // words reach transcription, and re-queue the unspoken remainder as STALE for re-weave.
    // Echo-safety (the absolute invariant): nothing is ever SENT to the model while gated —
    // detection is local peak-scanning only, and the leak source (mindPlayer) is dead
    // before frames flow, so the model can never transcribe MIND/mouth speaker audio.
    // Worst mis-tune (leak peaks above threshold, e.g. very loud speakers): the MIND cuts
    // itself spuriously — degraded, but no loop and nothing speaks on its own. Tune with
    // APIPLAN_MIND_BARGE_PEAK (0 disables) / APIPLAN_MIND_BARGE_MS.
    // CALIBRATED 2026-08-20 from this rig's real archives (opus verify sweep, 587s of
    // audio): speaker leak peaks 400-1789; his close-mic speech p90 1642-2194, max ~3400.
    // 6500 was above BOTH — barge was dead code and recovery never fired. The workable
    // absolute band is ~1800-2000 (margin only ~1.15x — env-tune per rig, contrast-based
    // calibration is the revisit). Sustain uses a LEAKY accumulator: natural speech dips
    // (1690→389→1570 inside 300ms measured) defeat a consecutive-frames rule.
    const envBar = (name: string, dflt: number) => {
      const v = process.env[name];
      return v === undefined || v === "" ? dflt : Number(v);   // ""≠0: only an explicit 0 disables
    };
    // MEASURED BRACKET ON THE NARRATOR'S OWN LEAK (call 35497, his complaint 19:16). A cut
    // fired at 4/438 chars, ~593ms into audible narrator, with no speech_started anywhere in
    // the preceding 10s — and the engine's OWN recovery pass on that same window then logged
    // "overlap recovery skipped — nothing above the leak bar (100ms loud)". RECOVER_PEAK is
    // 2000. So in that window: >=250ms of frames cleared 1800, and only 100ms cleared 2000.
    // The narrator's leak therefore lives BETWEEN THE TWO BARS, and this detector listens at
    // the lower one — the code already says so at the mouth-barge cross-reference below. The
    // MIND cutting itself on its own voice is the "worst mis-tune" this file names, and it is
    // not new: 29 cuts across 101 MIND lines on 96642, the loved-state call.
    // NOT silently retuned here. Level alone may not be able to separate them on this rig —
    // his close-mic speech runs p90 1642-2194 against a leak band that reaches ~2000 — so
    // raising this bar trades spurious self-cuts for missed quiet barges, which is HIS ear's
    // call, testable with one env var (APIPLAN_MIND_BARGE_PEAK=2200) and no rebuild. The
    // durable separator is the VPIO echo-cancelled mic (LM_BARGE_VP), currently off because
    // its binary is unversioned — see hands/research/settings-drift-2026-08-22.md.
    const BARGE_PEAK = envBar("APIPLAN_MIND_BARGE_PEAK", 1800);
    const BARGE_SUSTAIN = Number(process.env.APIPLAN_MIND_BARGE_MS) || 250;
    // ── MIND BARGE NEEDS SPEECH EVIDENCE (MIND spec 2026-08-23 05:18; hands engine lane) ──
    // A LOUD SOUND IS NOT A HUMAN INTERRUPTING. The two legs above (level bar + leaky sustain)
    // measure ENERGY, and on a rig whose canceller is down the loudest energy in the room is
    // OUR OWN NARRATOR. Measured, not argued (hands, 2026-08-23, call 25908 turn-633 archive,
    // 50ms blocks): his real close-mic speech in that same file peaks 1867-3634 with a
    // continuous 900-2000 floor between syllables; the burst train that fired the 05:11:00.746
    // cut peaks 8343 / 10589 / 9458 / 12833 / 16898 / 26056 in 50-150ms stabs with a ~130 floor
    // between them. The call's own log says why: `vp capture down` at 03:21:13 — 19s after
    // bring-up — so every frame after that ran on the RAW ffmpeg mic. The sibling P9 lane
    // measured the same uncancelled leak at 6110-8397 (clipping 32768) on call 97289 and
    // concluded no level bar can separate it from him. That is the whole class:
    //   25908 05:11:00.746  peak 13492, no VAD turn open, no transcript after the cut
    //   97289 03:00:47.628  peak  4569, same shape
    // and he then had to ask what the mind had said. HIS LAW IS UNCHANGED — "הקול שלך מעל הכל",
    // his voice outranks the MIND's audio — so the cut is not weakened, it is EVIDENCED: a peak
    // may only ARM a short confirmation window (the accumulator keeps running), and the cut
    // fires the moment SPEECH EVIDENCE lands inside it:
    //   vp        the VPIO-cleaned child's speech verdict (scored on the cancelled signal, so by
    //             construction it cannot be our own speakers) — the launcher exports
    //             LM_BARGE_VP=1 by default since 0d063fc, so this is the normal source;
    //   vad-open  the server already has a turn open (userSpeaking) when the peak lands;
    //   vad-late  a server input_audio_buffer.speech_started that arrives INSIDE the window.
    // No evidence by expiry → NO CUT, and the candidate is logged with its peak and loud-ms so
    // the calibration corpus grows instead of the mystery (P9 asked for exactly this).
    // COST, STATED, NEVER ABSORBED SILENTLY: a barge whose evidence is already present when the
    // sustain completes costs 0ms (vp events lead the peak in practice); a barge confirmed later
    // costs the arrival delay, bounded by APIPLAN_MIND_BARGE_CONFIRM_MS (400ms default — the
    // engine's own AUTOUNMUTE_MS budget, "he must lose a word, not a sentence", and 2-8x longer
    // than the 50-150ms stabs measured above while sitting inside his 300-700ms real-speech
    // sustain). APIPLAN_MIND_BARGE_REQUIRE_SPEECH=0 restores today's peak-only behaviour exactly.
    // KNOWN COST OF THE DEFAULT (say it out loud): on a rig where the canceller is DOWN there is
    // no evidence source at all, so mind-barge stops cutting and every candidate is logged
    // `no evidence source`. That is the deliberate trade the P9 lane recommended — "a barge that
    // can only cut our own voice is worse than no barge" — and it is one env var to undo.
    const envInt = (name: string, dflt: number) => {           // RECOVER_TAIL_MS idiom: a typo'd env falls back, never becomes NaN
      const n = envBar(name, dflt);
      return Number.isFinite(n) ? n : dflt;
    };
    // ── THE MIND'S OWN EVIDENCE, VERBATIM (spec 2026-08-23 05:18:11, engine-lane-barge-needs-
    // speech-evidence.md; his forensics + Eva's). Quoted, never paraphrased — the confirmation
    // window below exists ONLY because of it:
    //
    //   "the MIND-barge detector cuts narrator audio on RAW MIC PEAK ALONE. Evidence: 05:11:00 on
    //    25908 'mind interrupted by user — spoke 48/589 chars (peak 13492 vs bar 1800)' with NO VAD
    //    speech_started open and 'overlap recovery skipped — nothing above the leak bar (100ms
    //    loud)' — a 100ms loud transient, almost certainly computer playback; he then had to ask
    //    'what did the mind say'. Same shape 97289 03:00:47 (60/239 chars, peak 4569, no VAD) — the
    //    barge he apologised for may not have been him."
    //   "A loud sound is not a human interrupting."
    //
    // HANDS' ONE CORRECTION TO THAT EVIDENCE (mine, labelled as mine — the verdict is unchanged,
    // only one fact is): the "(100ms loud)" recovery line does NOT measure the pre-cut window. The
    // cut branch ends with `ovStart = -1; ovEnd = 0;`, so the recovery pass that printed it was
    // measuring a window RE-OPENED after the SIGKILL. It proves the loud thing STOPPED at the cut,
    // not that it only lasted 100ms. The archive envelope measured directly (turn-633 wav, 50ms
    // blocks) says the same thing louder: 50-150ms stabs of 8343-26056 over a ~130 floor, against
    // his real speech in that same file — 1867-3634, continuous 900-2000 floor, 2.3s sustained.
    const BARGE_REQUIRE_SPEECH = envInt("APIPLAN_MIND_BARGE_REQUIRE_SPEECH", 1);
    const BARGE_CONFIRM_MS = Math.max(0, envInt("APIPLAN_MIND_BARGE_CONFIRM_MS", 400));
    // PURE by design (no Date.now, no closure state) so hands/tests/mind-barge-evidence.test.mjs
    // can extract THIS body by anchor and run the engine's own decision instead of a copy.
    const mindBargeVerdict = (o: {
      mode: number; now: number; candAt: number; confirmMs: number;
      sustained: boolean; vpLive: boolean; vpFresh: boolean;
      userSpeaking: boolean; speechStartedAt: number;
    }): { verdict: "cut" | "arm" | "reject" | "hold"; evidence: string } => {
      const evidence = o.vpFresh ? "vp"
        : o.userSpeaking ? "vad-open"
        : (o.candAt > 0 && o.speechStartedAt >= o.candAt ? "vad-late" : "");
      if (o.mode <= 0) return { verdict: o.sustained ? "cut" : "hold", evidence: "peak-only" };
      if (o.candAt > 0) {                                       // window open: evidence wins, expiry rejects
        if (evidence) return { verdict: "cut", evidence };
        if (o.now - o.candAt >= o.confirmMs) return { verdict: "reject", evidence: o.vpLive ? "" : "no evidence source" };
        return { verdict: "hold", evidence: "" };
      }
      if (!o.sustained) return { verdict: "hold", evidence: "" };
      if (evidence) return { verdict: "cut", evidence };        // already proven when the peak completes → 0ms cost
      return { verdict: "arm", evidence: "" };
    };
    // ── MOUTH-BARGE bars (canon 027: the mic must hear him DURING the mouth's reply) ──
    // Same signal and the same leaky accumulator as the MIND pair above, with its own knobs:
    // the mouth's window is longer and its leak louder, and the MIND pair must not be
    // disturbed to tune it. Number.isFinite on every knob (the RECOVER_TAIL_MS idiom): a
    // typo'd env must fall back to its default, never become NaN — a NaN bar or tail would
    // hold `playingUntil` at NaN, and stillAudible() would then be false forever: the mic gate
    // never closes again and live speaker audio flows into the session. That is the historical
    // echo loop, reopened by one bad env var, so it is guarded structurally here.
    // CALIBRATED 2026-08-20 by replaying THIS rig's real archives through this exact detector.
    // The windows come from the engine's own log, never guessed: archRoll("mouth reply") opens
    // a segment at the reply's first audio delta, and the recovery decision that follows labels
    // it — "overlap recovery skipped" = leak-only (128 windows), "recovering speech spoken
    // during mouth reply" = he really spoke (16 windows). Every fire on a leak-only window was
    // then checked against the log for a VAD input_audio_buffer.speech_started within
    // [-2.5s, +3s]: a fire WITH one is him (recovery missed him at its own 2000 bar), a fire
    // WITHOUT one is a possible SELF-BARGE — the only thing that may never ship.
    //   bar / sustain   fires on leak-only   of those, VAD-confirmed him   unexplained   caught
    //   1800 / 150ms         5 / 128                    4                      1         7/16
    //   1800 / 200ms         2 / 128                    2                      0         5/16
    //   2000 / 150ms         4 / 128                    3                      1         6/16
    //   2000 / 200ms         1 / 128                    1                      0         5/16  <- shipped
    //   2000 / 250ms         0 / 128                    0                      0         1/16
    // 2000 is also the recovery bar, already calibrated above this rig's measured leak max
    // (1789). A 1400 bar — the first draft of this block — fired on 7% of leak-only windows
    // with unexplained cuts among them, i.e. BELOW the loudness this rig's own leak is
    // documented to reach: a self-barge generator. That is why the bar never goes under the
    // number leak is known to hit.
    // NO CONTRAST GUARD. A floor-times-margin bar was built and measured twice: sampled in the
    // grace window it never once exceeded 2000 on this rig (inert — it was pure decoration),
    // and sampled as a lagged running max it tracks HIS voice as readily as the leak and cut
    // the catch from 5/16 to 2/16 while removing zero self-barges. One measured absolute bar
    // plus the UNCONFIRMED line below (the feedback channel) beats a guard that only deletes
    // true barges.
    // PROVENANCE, honestly: the audio corpus is ~/.livemind/recordings (372 turn WAVs) with 18
    // call logs in /tmp/livemind-*.jsonl. All of it is MONO-era except call 20127, which ran on
    // the stereo field (canon 023) and was spot-checked separately: leak p90 580-802, max 1832
    // across its 4 clean windows — the same band as mono, so the stereo pan did not move the
    // leak floor. Re-measure if the pan gains change materially (they are logged in `bars:`).
    // RE-MEASURED 2026-08-20 on call 31192, at fire17's HIGH speaker volume (30 leak-only mic
    // windows from ~/.livemind/recordings/livemind-31192, turns 001-030, he silent throughout):
    //   leak instantaneous peak  max 2311  (per-window p90 249-1102) — ABOVE this 2000 bar
    //   leak sustained above bar max 85ms at EVERY bar 1600-2200 → 0/30 windows would fire
    //   his own speech in the same call, same volume: window peaks 1147-2569, sustained 256-853ms
    // Two honest conclusions. (1) The 2000/200ms pair still holds on this rig, but its margin is
    // now SUSTAIN, not level: raise APIPLAN_MOUTH_BARGE_MS before ever raising the bar, because
    // the bar can no longer be put above the leak without also being above him. (2) The contrast
    // guard stays removed, re-evaluated against THIS incident rather than the old corpus: the
    // grace-window floor predicts the same window's later leak between 0.34x and 15.9x (grace as
    // quiet as 108 while the leak later hit 1721), so an auto-floor sampled there would have been
    // noise. What replaces it is the self-disarm below — measurement, not decoration.
    const mouthKnob = (name: string, dflt: number) => { const v = envBar(name, dflt); return Number.isFinite(v) ? v : dflt; };
    // 0 disables the mouth barge entirely; every other value is a raw PCM peak bar.
    const MOUTH_BARGE_PEAK = mouthKnob("APIPLAN_MOUTH_BARGE_PEAK", 2000);
    // Leaky sustain (see the MIND pair): speech dips mid-word, so a consecutive-frames rule
    // never accumulates. Clamped to one frame — 0 does NOT disable the detector, PEAK=0 does.
    const MOUTH_BARGE_SUSTAIN = Math.max(20, mouthKnob("APIPLAN_MOUTH_BARGE_MS", 200));
    // Grace: the opening stretch carries his own trailing words (VAD closed his turn ~1.1s
    // earlier) and the player's spin-up transient — never cut there. Measured NEUTRAL on this
    // rig (0/200/400/600/1000ms all score 1 fire / 5 caught); it stays as a cheap guard for a
    // rig whose leak opens with a transient. Mis-tune to avoid: a grace LONGER than a whole
    // reply makes the detector unreachable for that reply.
    const MOUTH_BARGE_GRACE = mouthKnob("APIPLAN_MOUTH_BARGE_GRACE_MS", 400);
    // Kill tail: ffplay stays audible ~40-100ms after SIGKILL (measured, see the MIND barge) —
    // hold the mic gate that long after a cut, or our own tail transcribes as him.
    const MOUTH_BARGE_TAIL = mouthKnob("APIPLAN_MOUTH_BARGE_TAIL_MS", 250);
    // Self-report window. A real barge is followed within a beat by one of three things: his
    // next turn, the recovered audio of the words he spoke under the playback, or the resume
    // consumer taking the record. None of the three inside this window = the cut is announced
    // UNCONFIRMED and the record is DISCARDED — a cough or a chair scrape is not a barge to
    // resume, and a stale record would otherwise attach itself to his next real turn. 0
    // disables the check (and with it the auto-discard).
    const MOUTH_BARGE_CONFIRM = mouthKnob("APIPLAN_MOUTH_BARGE_CONFIRM_MS", 6000);
    const MUTEDWARN_PEAK = envBar("APIPLAN_MUTEDWARN_PEAK", 1800);   // no leak risk while muted — can be aggressive
    // How much of the window's END may be playback teardown rather than speech — see the
    // transient rule in recoverOverlap. Number.isFinite: a typo'd env falls back to the default
    // rather than silently disabling the guard; only an explicit 0 turns it off.
    const RECOVER_TAIL_MS = (() => { const v = envBar("APIPLAN_RECOVER_TAIL_MS", 400); return Number.isFinite(v) ? v : 400; })();
    // ── HALF-DUPLEX DUCK (LIVEMIND_HALF_DUPLEX, default on for the MIND window) ──
    // The MIND's design addendum, 2026-08-20: duck the MIC CAPTURE while our own audio plays
    // and restore ~300ms after it stops, so the speaker-leak echo class dies BY CONSTRUCTION
    // instead of being recognised after the fact. What 099e723 ALREADY does, checked in code
    // before building anything: live mic frames never reach the session while the MIND narrator
    // plays (`mindPlayer && mindLine` -> continue, in every mode, barge included) and never
    // while the mouth plays unless duplex barge is on (`stillAudible() && !bargeOn` -> continue).
    // The append path was therefore already half-duplex, and the mouth window needs no second
    // gate. TWO holes remained, both measured on his own calls:
    //   1. NO TAIL ON THE MIND WINDOW. playingUntil for a MIND line is set to start+ms, but
    //      ffplay is audible ~250ms LATER than that clock (APIPLAN_MIND_START_MS exists to
    //      compensate exactly that bias), so stillAudible()'s +250ms of slack is already spent
    //      when the audio really ends — and the capture pipeline hands us those frames later
    //      still. Call 96316 @20:00:51.262: a live you-turn that is the verbatim TAIL of the
    //      MIND line spoken seconds earlier, echo_sim 1.00, echo_recovered=false.
    //   2. THE RESEND DOOR. Frames refused at the append gate are still ARCHIVED, and overlap
    //      recovery resends that archive into the model when playback ends — the one door a
    //      half-duplex gate must close too (see the recovery trigger in pumpMic).
    // THE TRADE, stated honestly: with the duck on, speech spoken UNDER our own audio does not
    // reach the model at all — that is what half-duplex MEANS. It is not lost: every frame is
    // still archived to WAV (the never-lose law is untouched) and no transcript is ever deleted
    // by this. A real interjection is still caught LIVE by the local loudness detectors — WHEN
    // ARMED: APIPLAN_MIND_BARGE_PEAK kills the narrator mid-word and reopens the mic,
    // APIPLAN_MOUTH_BARGE_PEAK cancels+truncates the mouth's reply; either set to 0 disables
    // that belt by design, and a fully-disarmed rig has no live path during its window. Full-duplex
    // interjection is the BARGE feature's job and is explicitly out of scope while barge is off.
    // MUTUALLY EXCLUSIVE WITH DUPLEX BARGE by definition: when bargeOn, mic frames flow during
    // playback BY DESIGN, so the duck yields entirely and 099e723's own duplex guards (the
    // bargeEvidenceAt self-cut gate) stay in force unchanged.
    // Modes: "mind" (default) = tail on both windows + a MIND window is never resent; "all" also
    // stops resending a MOUTH window (his in-reply words then rest on the mouth barge alone);
    // "0"/"off" restores 099e723 exactly — one extra comparison per mic frame and nothing else.
    const HD_MODE = (() => {
      const v = String(process.env.LIVEMIND_HALF_DUPLEX ?? "").trim().toLowerCase();
      if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
      if (v === "all" || v === "1" || v === "on" || v === "true" || v === "yes") return "all";
      return "mind";
    })();
    const HD_ON = HD_MODE !== "off";
    // Restore delay after the last of our own audio. Finite and clamped by construction: a
    // typo'd env must never latch the mic shut, and a NaN here would make every comparison
    // false — the historical echo loop, reopened by one bad env var.
    const HD_TAIL = (() => { const v = envBar("LIVEMIND_HALF_DUPLEX_TAIL_MS", 300); return Number.isFinite(v) && v >= 0 ? Math.min(v, 5000) : 300; })();
    let duckMindUntil = 0; // MIND tail: re-armed by every frame seen while the narrator plays
    let duckMs = 0;        // continuous ms swallowed by the window now open
    let duckSrc = "";      // which of our two voices opened it
    /** Mic is ducked: our own audio is on the air, or stopped less than HD_TAIL ms ago.
     *  TWO CLOCKS, because the two voices know their end differently — and NEITHER may outlive
     *  the audio it ducks for. The MOUTH rides `playingUntil` itself rather than a clock of its
     *  own: every place the engine zeroes it (a barge, a dead player, silenceMouth, a failed
     *  write) means the audio is GONE, and the mic must reopen in that same instant exactly as
     *  it does at 099e723 — his words right after a cut are the entire point of a barge, and a
     *  duck that kept holding there would eat them. The MIND cannot use that clock: playingUntil
     *  for a narrator line is start+ms while ffplay is audible ~250ms LATER (the spin-up bias
     *  APIPLAN_MIND_START_MS exists for), which is the hole being closed — so its tail is
     *  re-armed by frames seen while its player is ALIVE and therefore expires HD_TAIL after the
     *  real end of the audio, or HD_TAIL after a barge kills the player, never later.
     *  A non-finite clock makes both comparisons false: the duck fails OPEN, like 099e723,
     *  rather than latching the mic shut. */
    const ducked = () => {
      if (!HD_ON || bargeOn) return false;
      const now = Date.now();
      return (playingUntil > 0 && now < playingUntil + HD_TAIL) || now < duckMindUntil;
    };
    /** One mic frame observed while our own audio plays: re-arm the MIND tail and count it.
     *  Called only from the two playing branches, never from the tail — a tail must expire. */
    const duckFrame = (ms: number, src: string) => {
      if (!HD_ON || bargeOn) return;
      if (src === "mind") duckMindUntil = Date.now() + HD_TAIL;
      if (!duckSrc) duckSrc = src;
      duckMs += ms;
    };
    /** The mic just reopened. Forensics only (never chat): one line per window that swallowed
     *  a real stretch of audio, so a silent stretch is never diagnosed as a broken mic. */
    const duckRelease = () => {
      if (duckMs > 500) say("info", `half-duplex: mic ducked ${Math.round(duckMs)}ms during ${duckSrc} playback (+${HD_TAIL}ms tail)`,
        { half_duplex_ducked_ms: Math.round(duckMs), duck_src: duckSrc, tail_ms: HD_TAIL });
      duckMs = 0; duckSrc = "";
    };
    // ── STUCK-LATCH TIMEOUT (the userSpeaking latch) ─────────────────────────────────
    // `userSpeaking` is raised by the server's input_audio_buffer.speech_started and cleared
    // ONLY by speech_stopped (or, since call 86130, by a mute flip). Whenever the server
    // holds a VAD segment open over a SILENT room, the stack law muzzles the MIND for the
    // whole stretch: measured on call 20127, one segment ran 10.4s with not a single mic
    // frame above the voice bar, and 8-10s of dead air inside an open turn recurs. The 120s
    // failsafe in injectContext is a last resort, not a fix.
    // OBSERVED SILENCE, never a plain clock: the latch clears only when no mic frame has
    // reached LATCH_PEAK for the required stretch — i.e. when the ROOM is quiet, the only
    // honest evidence that his turn ended. Two stretches, because the two cases differ:
    //   · segment opened by a blip and NO voice ever heard inside it → LATCH_MS (4s).
    //     Nothing of his is in flight; holding the MIND is pure loss.
    //   · voice WAS heard → he is mid-turn and merely pausing → LATCH_HOLD_MS (12s), and
    //     flushInjectQueue's 2.5s sustained-silence gate stacks on top: nothing can speak
    //     before 14.5s of continuous quiet inside a live turn.
    // CALIBRATION, replayed frame-for-frame through this exact predicate over all 136 VAD
    // segments of calls 20127 + 31192 (audio from ~/.livemind/recordings, 100ms peak blocks).
    // "clip" = the latch released and he spoke again inside that same segment afterwards:
    //   fast/slow   releases   clips   dead air freed
    //     4s /  6s      7         4         52.8s
    //     4s /  8s      4         4         49.6s
    //     4s / 10s      5         1         50.3s
    //     4s / 12s      4         0         49.6s   <- shipped
    //     3s / 12s      5         1         53.6s
    //     5s / 12s      3         0         46.5s
    // 12s is the first slow stretch with ZERO clips in the corpus; higher buys nothing
    // (identical at 15s and 20s) and costs responsiveness, and the longest genuine mid-turn
    // pause measured is 6.3s — less than half of it.
    // If a release ever does catch him mid-thought it self-heals twice: the RE-LATCH below
    // re-arms the hold within LATCH_RELATCH_MS of his voice, and a MIND line he talks over is
    // cut by the MIND barge detector (APIPLAN_MIND_BARGE_PEAK) within ~250ms. APIPLAN_LATCH_MS=0
    // disables the whole timeout (back to the 120s failsafe alone).
    const LATCH_MS = (() => { const v = envBar("APIPLAN_LATCH_MS", 4000); return Number.isFinite(v) && v >= 0 ? v : 4000; })();
    const LATCH_HOLD_MS = (() => { const v = envBar("APIPLAN_LATCH_HOLD_MS", 12000); return Number.isFinite(v) && v >= 0 ? v : 12000; })();
    // Same measured band as every other loudness gate on this rig (speaker leak max 1789,
    // his close-mic speech p90 1642-2194): "is there a voice in the room at all".
    const LATCH_PEAK = (() => { const v = envBar("APIPLAN_LATCH_PEAK", 1800); return Number.isFinite(v) ? v : 1800; })();
    // Leaky sustain behind the re-latch — one loud frame is a chair scrape, not a turn.
    const LATCH_RELATCH_MS = (() => { const v = envBar("APIPLAN_LATCH_RELATCH_MS", 300); return Number.isFinite(v) && v > 0 ? v : 300; })();
    let lastVoiceAt = 0;        // last mic frame at/above LATCH_PEAK, or last you_delta
    let latchVoiceMs = 0;       // leaky accumulator behind the re-latch
    let latchHadVoice = false;  // any voice heard inside THIS latch? (picks which stretch applies)
    let latchTimedOut = false;  // the latch was cleared by timeout, not by the server
    let bargeMs = 0; let lastBargeAt = 0;
    let bargeCandAt = 0; let bargeCandPeak = 0; let bargeCandMs = 0;   // the open speech-evidence confirmation window
    let mouthBargeMs = 0; let lastMouthBargeAt = 0; let mouthBargeTailUntil = 0;
    // Last moment the LOCAL mic evidence cleared bar+sustain — the duplex self-cut guard.
    let bargeEvidenceAt = 0;
    // SELF-DISARM. The UNCONFIRMED line below is the mis-tune feedback channel; on a rig whose
    // leak clears the bar it would otherwise print once per cut, forever. Two unconfirmed cuts
    // in a row and the detector stands down for the rest of the call (his words are never
    // touched by this — the overlap-recovery path stays fully armed either way).
    let mouthBargeArmed = true; let mouthBargeUnconfirmed = 0;
    // REDTEAM 2026-08-22 (P0-A). The two belts shared ONE counter, so a duplex phantom and a
    // local phantom summed. Call 96642: duplex cut UNCONFIRMED 22:57:20 (1) -> duplex DISARMED
    // 23:44:31 ("2 unconfirmed") -> the FIRST local unconfirmed cut at 00:21:24 read "3" and
    // stood the local belt down on a streak of one. A belt must only ever judge its own path.
    let duplexUnconfirmed = 0;
    // LIVE sustain bar for the local cut. Starts at the configured MOUTH_BARGE_SUSTAIN and only
    // ever RISES, and only when the belt below would otherwise have stood the last barge path
    // down (see the ESCALATE branch). The configured value stays the number the bars line
    // reports, so a raised bar is always visibly a runtime decision, never a silent default.
    let mouthBargeSustain = MOUTH_BARGE_SUSTAIN;
    /** THE BARGE FLOOR — he can always cut the mouth. The local detector is live whenever it is
     *  armed OR duplex is down, because a ducked mic makes it the only path there is. Stated
     *  here at the USE site rather than as a re-arm at each disarm: duplex is stood down from
     *  three places (the two belts and the vp-capture-down retreat, which cannot even see this
     *  flag), and only a use-site rule is immune to the ORDER they fire in. Call 96642 died of
     *  that ordering: local belt at 00:21:24 while duplex was still up, duplex already down
     *  since 23:44:31 — two individually-sane belts, zero barge paths, 20 minutes of ducked
     *  mic, and at 02:16 "ניסיתי להתפרץ לפה וזה לא עבד ההתפרצות". */
    const localBargeLive = () => mouthBargeArmed || !bargeOn;
    // REDTEAM (P1-D). `Math.max(x*4, 800)` is 4x only for the default 200ms; a rig tuned to
    // APIPLAN_MOUTH_BARGE_MS=20 would escalate 40x. The cap is a multiple of what the operator
    // chose, full stop — and it is bounded above so it can never exceed a short reply's whole
    // playable window (grace 400ms + a 500ms item + tail 250ms = 750ms of cuttable time; a
    // sustain past that makes short replies uncuttable BY CONSTRUCTION, which is his law
    // inverted). See MOUTH_BARGE_GRACE / itemQueuedMs in the cut gate below.
    const MOUTH_BARGE_SUSTAIN_MAX = Math.min(MOUTH_BARGE_SUSTAIN * 4, 600);
    let mutedSpeechMs = 0; let mutedWarnAt = 0;
    // ── VOLUME-SCALED BARS (lane b) ───────────────────────────────────────────────
    // Every bar above is an ABSOLUTE PCM peak calibrated at ONE output volume. His volume moves:
    // turn it down and the leak falls under the bar (the detectors go deaf — no barge, no
    // recovery); turn it up and the leak clears the bar (SELF-BARGE, and in call 31192 a full
    // echo loop, whose mic turns measure leak peaks 429–1795 — i.e. touching the 1800/2000 bars).
    // A cheap live reference fixes the anchor: during a mouth reply's GRACE window the only thing
    // in the mic is OUR OWN audio, so its peak IS this rig's current leak floor. Sampled per
    // reply, kept as the MEDIAN of the last few (contamination by his trailing words inflates a
    // sample, and a median resists that), it says how far the rig has drifted from the volume the
    // bars were calibrated at.
    //
    // HONEST ABOUT THE PRIOR NEGATIVE RESULT (see "NO CONTRAST GUARD" above): a floor×margin bar
    // was built twice and failed twice — inert in the grace window, and as a lagged running max it
    // tracked HIS voice and halved the catch. This is deliberately NOT that. It is a RATIO anchored
    // to a measured baseline (so at the calibration volume it reproduces the shipped bars exactly),
    // it is a median over replies rather than a running max, it ignores windows near his speech, it
    // needs LEAK_MIN samples before it moves at all, it is clamped to 0.5–2×, and it is DEFAULT OFF.
    // Enable with LIVEMIND_ADAPTIVE_BARS=1; LIVEMIND_LEAK_LOG=1 measures and reports without
    // touching a single bar — run one call with it to harvest the numbers before enabling.
    // WHAT IT CANNOT DO: the reference conflates speaker volume with mic gain (it measures the
    // whole speaker→mic path). Both move the leak bars the same way, so that is right for them.
    // MUTEDWARN is different — it is a bar on HIS voice, and only the mic-gain half of the drift
    // is real for it — so it scales DOWN ONLY: a quieter rig makes it more sensitive (harmless,
    // the mic is muted, nothing is sent, and the existing comment already says it can be
    // aggressive), while a louder rig must never be allowed to raise it into deafness and let him
    // talk into a stuck mute unwarned again.
    // NOT REACHED IN BARGE MODE: the mouth-barge block that samples this sits under
    // `stillAudible() && !o.barge`, so with LM_BARGE=1 no reference is collected and every bar
    // stays exactly as shipped.
    const ADAPTIVE_BARS = /^(1|on|true|yes)$/i.test(String(process.env.LIVEMIND_ADAPTIVE_BARS ?? ""));
    const LEAK_LOG = ADAPTIVE_BARS || /^(1|on|true|yes)$/i.test(String(process.env.LIVEMIND_LEAK_LOG ?? ""));
    // The leak floor the shipped bars were calibrated against: this rig's grace-window leak p90
    // measured 580–802 (call 20127, stereo field). 800 ⇒ scale 1.0 ⇒ today's bars, unchanged.
    const LEAK_BASE = Math.max(1, mouthKnob("LIVEMIND_LEAK_BASE", 800));
    const LEAK_MIN = Math.max(1, mouthKnob("LIVEMIND_LEAK_MIN", 4));      // replies before the scale may move
    const LEAK_CLAMP = 2;                                                 // never scale a bar past 0.5–2×
    // A bar must always clear the leak it sits above. This rig's leak/speech margin is only ~1.15×
    // (leak max 1789, his speech p90 1642) — 1.25 sits just over the leak and just under his voice.
    const LEAK_MARGIN = mouthKnob("LIVEMIND_LEAK_MARGIN", 1.25);
    // REDTEAM (P0-B). How far above the measured leak floor a cut's peak must sit before the
    // belt stops calling it leak. 3x is deliberately generous: this rig's leak/speech margin
    // is ~1.15x at the TOP of the leak distribution, but leakRef is its MEDIAN (128 in call
    // 96642 against a 2000 bar), so 3x still sits far under his voice.
    const LEAK_ESCALATE_RATIO = mouthKnob("LIVEMIND_LEAK_ESCALATE_RATIO", 3);
    const leakRing: number[] = [];
    let leakRef = 0, barScale = 1, gracePeak = 0, graceReply = 0, leakLogAt = 0, leakLogged = 0;
    /** One grace-window frame of our own audio. `pk` is already computed by the caller — free. */
    const noteLeakFrame = (pk: number, played: number, replyAt: number) => {
      if (replyAt !== graceReply) { flushLeakSample(); graceReply = replyAt; gracePeak = 0; }
      if (played > 0 && played < MOUTH_BARGE_GRACE && pk > gracePeak) gracePeak = pk;
    };
    /** Close one reply's window: keep its peak unless his voice could have been in it. */
    function flushLeakSample() {
      const pk = gracePeak; gracePeak = 0;
      // His turn closes ~1.1s before the reply's first delta, so his trailing words can bleed into
      // the opening of the grace window. Skip a sample taken that close to his speech; the median
      // covers whatever slips through.
      if (pk <= 0 || Date.now() - lastSpeechStopAt < 1000) return;
      leakRing.push(pk);
      if (leakRing.length > 8) leakRing.shift();
      if (leakRing.length < LEAK_MIN) return;
      const s = [...leakRing].sort((a, b) => a - b);
      leakRef = s[s.length >> 1]!;
      const want = Math.min(LEAK_CLAMP, Math.max(1 / LEAK_CLAMP, leakRef / LEAK_BASE));
      const moved = Math.abs(want - barScale) / (barScale || 1);
      barScale = want;
      if (LEAK_LOG && (moved > 0.25 || !leakLogged) && Date.now() - leakLogAt > 60000) {
        leakLogAt = Date.now(); leakLogged = 1;
        say("info", `leak reference ${leakRef} (median of ${leakRing.length}, base ${LEAK_BASE}) — bars ×${barScale.toFixed(2)}`
          + (ADAPTIVE_BARS ? ` APPLIED: mouthbarge ${scaleBar(MOUTH_BARGE_PEAK)} barge ${scaleBar(BARGE_PEAK)} recover ${scaleBar(envBar("APIPLAN_RECOVER_PEAK", 2000))}`
                           : " (measure-only — set LIVEMIND_ADAPTIVE_BARS=1 to apply)"),
          { leak_ref: leakRef, leak_samples: leakRing.length, bar_scale: Number(barScale.toFixed(3)), applied: ADAPTIVE_BARS });
      }
    }
    /** A bar at the CURRENT output volume. Off ⇒ the shipped number, byte for byte. A leak bar is
     *  never returned below what the measured leak itself can reach (deafness is degraded, a
     *  self-barge is a loop); `downOnly` is the MUTEDWARN case above — no leak, so no margin, and
     *  never raised. */
    const scaleBar = (base: number, downOnly = false) => {
      if (!ADAPTIVE_BARS || base <= 0 || barScale === 1) return base;
      const scaled = Math.round(base * barScale);
      return downOnly ? Math.min(base, scaled) : Math.max(scaled, Math.round(leakRef * LEAK_MARGIN));
    };
    // Auditability: a live log must always record which thresholds were in force.
    // pan= rides along because the whole mouth-barge calibration is a LOUDNESS measurement and
    // the stereo knob (canon 023) changes the acoustic field live, mid-call — a forensic reading
    // of a cut must show the gains that were in force when it fired, next to the bars it beat.
    say("info", `bars: duplex=${bargeOn ? "ON(APIPLAN_BARGE_OK)" : o.barge ? "requested-but-OFF(set APIPLAN_BARGE_OK=1)" : "off"} barge=${BARGE_PEAK}/${BARGE_SUSTAIN}ms mouthbarge=${MOUTH_BARGE_PEAK}/${MOUTH_BARGE_SUSTAIN}ms grace=${MOUTH_BARGE_GRACE}ms killtail=${MOUTH_BARGE_TAIL}ms confirm=${MOUTH_BARGE_CONFIRM}ms recover=${envBar("APIPLAN_RECOVER_PEAK", 2000)} tail=${RECOVER_TAIL_MS}ms echo=${ECHO_BAR}/${ECHO_LIVE_BAR} latch=${LATCH_MS}/${LATCH_HOLD_MS}ms@${LATCH_PEAK}(relatch ${LATCH_RELATCH_MS}ms) mutedwarn=${MUTEDWARN_PEAK} pan=${stereoEnabled() ? `mouth ${panGains("mouth").l}/${panGains("mouth").r}` : "mono"}`
      + ` trim=mouth ${voiceGain("mouth")}/mind ${voiceGain("mind")} adaptive=${ADAPTIVE_BARS ? `on base ${LEAK_BASE} min ${LEAK_MIN} margin ${LEAK_MARGIN}` : LEAK_LOG ? "measure-only" : "off"}`
      + ` halfduplex=${HD_ON ? `ON(${HD_MODE})` : "off"}${HD_ON ? ` tail=${HD_TAIL}ms` : ""}${HD_ON && bargeOn ? " YIELDED(duplex barge)" : ""}`);
    const framePeak = (v: Uint8Array) => {
      let pk = 0;
      for (let i = 0; i + 1 < v.length; i += 32) {           // sparse scan — same cost profile as the archive's
        const s = Math.abs((v[i] | (v[i + 1] << 8)) << 16 >> 16);
        if (s > pk) pk = s;
      }
      return pk;
    };
    let savedSuppress = false; let suppressRestoreAt = 0;
    let recoverSentAt = 0;   // restore-keying: only a transcript arriving AFTER the resend committed may restore suppressAuto
    // RESEND PROVENANCE — the two numbers the timing belt is built from (both already appear in
    // the log; keeping them in memory is what lets a turn be judged without any new audio path)
    // and the id of the item the SERVER built from the resent audio. Deletion is bound to that
    // id: a live or later item can never reach the delete branch, whatever it says.
    let lastResendAt = 0; let lastResendMs = 0;
    let recoveredItemId: string | null = null;
    async function recoverOverlap(path: string, start: number, end: number) {
      try {
        // Loudness bar (fire17, two live incidents 2026-08-20: the mouth's greeting and a
        // MIND line's tail came back as fake "you" turns): the dropped window is mostly
        // SPEAKER LEAK, and leak is speech-shaped — duration cannot tell it from the human,
        // only loudness can (close mic beats speaker bleed). Recovery therefore requires
        // sustained audio above a real-speech peak bar, and resends only the loud region.
        // APIPLAN_RECOVER_PEAK tunes the bar (default 2000 — calibrated: leak maxes 1789
        // on this rig, his speech sustains 300-700ms above 1800; 6500 was NEVER-RECOVER);
        // 0 disables recovery entirely.
        const RECOVER_PEAK = scaleBar(envBar("APIPLAN_RECOVER_PEAK", 2000));
        if (RECOVER_PEAK <= 0) return;
        const len = end - start;
        if (len < RATE * 2 * 0.4) return;                     // <400ms can't be real speech (same bar as the hangup guard)
        for (let i = 0; i < 60; i++) {                        // wait for a quiet, response-free moment (max ~30s)
          if (!userSpeaking && !stillAudible() && !responseActive && !awaitingResponse && !mindBusy) break;
          await Bun.sleep(500);
        }
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        const fd = fs.openSync(path, "r");
        const buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, 44 + start); // 44 = WAV header; offsets are archive data bytes
        fs.closeSync(fd);
        if (got < RATE * 2 * 0.4) return;
        // Scan 50ms blocks; require ≥200ms above the bar, then trim the resend to the loud
        // region (±300ms padding) so leak-only stretches never re-enter the model.
        const BLK = Math.round(RATE * 2 * 0.05);
        // TEARDOWN-TRANSIENT GUARD (EVA forensics 2026-08-20, specimen 44292@15:14:55). A click at
        // playback teardown is SHORT and ISOLATED; his voice is neither. So a loud block in the
        // last TAIL_MS is only HELD — never discarded on position alone — and it is held only
        // while three things are true: it sits in the tail, nothing was loud in the preceding
        // ISO_MS (an open loud region is speech still going, and it keeps counting AND keeps
        // extending lastLoud so the +-padding trim never truncates his last words), and the
        // contiguous held run is still shorter than ISO_MS. The moment a held run reaches ISO_MS
        // it is folded back in whole — a 200ms+ burst is speech, wherever it lands. Replay of
        // S3's exact window: 250ms -> 100ms countable, 150ms held -> SKIP; a 300ms onset in the
        // tail -> folded back, RECOVER, resend end untruncated.
        const TAIL_MS = RECOVER_TAIL_MS;
        const ISO_MS = 200;
        const tailFrom = TAIL_MS > 0 ? got - Math.round(RATE * 2 * (TAIL_MS / 1000)) : got;
        const isoBlocks = Math.round(ISO_MS / 50);
        let firstLoud = -1; let lastLoud = -1; let loudMs = 0; let tailLoudMs = 0; let tailRun = 0;
        for (let b = 0; b * BLK < got; b++) {
          if (framePeak(buf.subarray(b * BLK, Math.min(got, (b + 1) * BLK))) < RECOVER_PEAK) { tailRun = 0; continue; }
          if (b * BLK >= tailFrom && (lastLoud < 0 || b - lastLoud > isoBlocks)) {
            tailRun++;
            if (tailRun * 50 >= ISO_MS) {                     // too long to be a click — it is speech
              loudMs += tailRun * 50; tailLoudMs -= (tailRun - 1) * 50;
              if (firstLoud < 0) firstLoud = b - (tailRun - 1);
              lastLoud = b; tailRun = 0;                      // contiguity now carries it (isolation test above)
            } else tailLoudMs += 50;
            continue;
          }
          tailRun = 0;
          if (firstLoud < 0) firstLoud = b;
          lastLoud = b; loudMs += 50;
        }
        if (loudMs < 200) { say("info", `overlap recovery skipped — nothing above the leak bar (${loudMs}ms loud${tailLoudMs > 0 ? `, ${tailLoudMs}ms isolated in the ${TAIL_MS}ms teardown tail — held`: ""})`); return; }
        if (!archOn || !archAllowed()) { say("info", "overlap recovery skipped — archive off (private mode leaves no WAV to resend from)"); return; }
        const from = Math.max(0, (firstLoud - 6) * BLK);
        const to = Math.min(got, (lastLoud + 7) * BLK);
        const slice = buf.subarray(from, to);
        const tmp = `${archDir}/overlap-${Date.now()}.wav`;
        fs.writeFileSync(tmp, Buffer.concat([archHeader(slice.length), slice]));
        // REENTRANT-SAFE suppress (root cause of the 14:19 mouth outage, call 86130: two
        // recoveries fired back-to-back; the second saved the first's forced `true` as the
        // restore baseline, so suppressAuto restored to TRUE forever and 22 auto-replies
        // died silently). The baseline is captured ONLY when no window is armed.
        if (!suppressRestoreAt) savedSuppress = suppressAuto;
        suppressRestoreAt = Date.now() + 20000;
        recoverSentAt = 0;                                    // armed: transcripts landing BEFORE the resend commits never restore
        suppressAuto = true;                                  // transcribe only — never auto-answer the recovered turn
        say("info", `recovering speech spoken during mouth reply (${(slice.length / 2 / RATE).toFixed(1)}s loud-trimmed of ${(got / 2 / RATE).toFixed(1)}s)`);
        await resendAudio(tmp);
        try { fs.unlinkSync(tmp); } catch {}
        recoverSentAt = Date.now();
        // Failsafe restore is a timer, NOT an in-try sleep: holding `recovering` for 15s
        // silently dropped every overlap window that opened meanwhile (verified defect).
        setTimeout(() => { if (suppressRestoreAt) { suppressAuto = savedSuppress; suppressRestoreAt = 0; } }, 15000);
      } catch { /* recovery must never break the call */ }
      finally { recovering = false; }
    }
    /** `first` is the handover chunk aec.ts already read off the VP child (never-lose: it is
     *  processed here BEFORE anything else, so the switch from ffmpeg loses not one frame). */
    async function pumpMic(proc: ReturnType<typeof Bun.spawn>, first?: Uint8Array) {
      const reader = proc.stdout.getReader();
      let pending: Uint8Array | undefined = first;
      try {
        while (true) {
          let value: Uint8Array | undefined;
          if (pending) { value = pending; pending = undefined; }
          else { const r = await reader.read(); if (r.done) break; value = r.value; }
          if (value?.length) archWrite(value);                 // never-lose: archive BEFORE any drop below
          if (value?.length) capsWitness();                    // canon 041: witness caps ground truth per frame, before any gate
          // NEVER-LOSE, UNDER ARCH A — read this before trusting an archive from a VP call:
          // these bytes ARE the microphone, so "raw" here means the VPIO capture. macOS
          // cancelled OUR OWN loudspeaker before the sample existed, so the archive holds
          // exactly what the capture device produced, as it always has — minus our echo.
          // Nothing of HIS is filtered: VPIO cancels the far-end reference, never the
          // near-end talker (his cleaned speech measured 21101-27223 peak on this rig).
          // WATCHDOG SOURCE GUARD (live-trial defect, call 40028): note() feeds the VP
          // liveness watchdog, so it must see ONLY the VP child's own frames. During the
          // never-deaf handover window this pump carries FFMPEG — its first frame (~210ms)
          // falsely marked the capture "live" and latched handedOver, arming the 200ms
          // dead-watchdog against a child that legitimately takes ~3.5s to first audio
          // (isolated repro: real first PCM at +3527ms). One ffmpeg jitter gap later,
          // duplex was DISARMED at call start. Frames count only when this proc IS the child.
          if (value?.length && proc === vp?.proc) vp.note(value); // watchdog: liveness + all-zero (TCC) detector
          // ── STUCK-LATCH TIMEOUT / RE-LATCH (bars and calibration above) ────────────
          // Rides the frames we already have, ahead of every drop below — no timer, no poll,
          // and framePeak runs only while a latch is actually open. Muted frames are skipped:
          // a mute flip already synthesizes the stop (call 86130).
          if (LATCH_MS > 0 && value?.length && !micMuted && (userSpeaking || latchTimedOut)) {
            const nowL = Date.now();
            if (stillAudible() || mindBusy || mindPlayer || ducked()) {
              // UNOBSERVABLE WINDOW. While OUR audio plays, these frames carry speaker leak,
              // so a peak proves nothing about him — freeze the clock rather than time out
              // blind, and never let our own leak drive a re-latch.
              lastVoiceAt = nowL; latchVoiceMs = 0;
            } else {
              const pkL = framePeak(value);
              const fMsL = (value.length / 2 / RATE) * 1000;
              if (pkL >= LATCH_PEAK) { lastVoiceAt = nowL; latchVoiceMs += fMsL; if (userSpeaking) latchHadVoice = true; }
              else latchVoiceMs = Math.max(0, latchVoiceMs - fMsL);
              const needL = latchHadVoice ? LATCH_HOLD_MS : LATCH_MS;
              if (userSpeaking && lastVoiceAt && nowL - lastVoiceAt >= needL) {
                // The SERVER's segment stays open — this clears only OUR latch, so held MIND
                // lines may flow. speechTurns is NOT pushed and lastSpeechMs is NOT touched:
                // the turn is not over, and the echo timing belt must keep pairing this turn's
                // real start and duration with its real transcript (31/31 corpus).
                latchTimedOut = true; userSpeaking = false; latchVoiceMs = 0;
                lastSpeechStopAt = nowL;   // flushInjectQueue's 2.5s quiet gate still applies
                say("info", `user-speaking latch timed out — ${Math.round((nowL - lastVoiceAt) / 100) / 10}s with no voice above ${LATCH_PEAK} (${latchHadVoice ? "pause inside a live turn" : "blip, no voice ever"}, VAD turn open ${((nowL - speechStartedAt) / 1000).toFixed(1)}s); releasing ${injectQueue.length} held MIND line(s)`,
                  { latch_timeout: true, quiet_ms: nowL - lastVoiceAt, need_ms: needL, had_voice: latchHadVoice,
                    open_ms: nowL - speechStartedAt, bar: LATCH_PEAK, held: injectQueue.length });
                if (injectQueue.length) setTimeout(flushInjectQueue, 0);
              } else if (latchTimedOut && !userSpeaking && latchVoiceMs >= LATCH_RELATCH_MS) {
                // RE-LATCH — the half that makes the timeout safe. He resumed inside the still
                // open server segment, where no second speech_started will ever come, so the
                // hold is re-armed LOCALLY. speechStartedAt is deliberately left at the
                // server's real segment start: the echo timing belt and the 120s failsafe in
                // injectContext both read it.
                latchTimedOut = false; latchVoiceMs = 0; userSpeaking = true; latchHadVoice = true; lastVoiceAt = nowL;
                say("info", "user speaking again (local VAD, server turn still open) — MIND lines hold");
              }
            }
          }
          // CAPS DECISION (a). A confident VP barge cuts PLAYBACK even with the mic muted —
          // he expects caps-off to still stop the voice — while WHAT REACHES THE MODEL keeps
          // every gate it has today. The frame is let past the mute gate ONLY when one of the
          // two playback branches below will take it, and each of those ends in `continue`, so
          // a muted frame still cannot reach input_audio_buffer.append. Their overlap-capture
          // sites are muted-guarded for the same reason (muted audio is never resent either).
          const vpCut = vpFresh() && ((!!mindPlayer && !!mindLine) || (stillAudible() && !bargeOn));
          // DEFECT 2.3. The mute body does THREE jobs, and only one of them is "drop the frame".
          // Letting a vpCut frame skip the whole body silenced the "speaking while muted" warning
          // in exactly the window he is most likely to talk (it is the fix for the 13:37
          // muted-deafness incident quoted below) and weakened the stale-window discard. So the two
          // protections run for EVERY muted frame; only the `continue` stays behind the vpCut test.
          if (micMuted) {
            // A mute flip rolls the archive segment — a pending overlap window into the old
            // segment is no longer a live turn (verified defect: a window resent 4.5 min
            // later as fresh speech). Discard it; the audio itself stays archived.
            if (ovStart >= 0) { ovStart = -1; ovEnd = 0; ovPath = ""; ovSrc = ""; }
            // Talking into a stuck/forgotten mute is silent deafness (root cause of the
            // 13:37 "הפה לא עונה לי" — mic muted, never unmuted, zero feedback). Say so.
            if (value?.length) {
              if (framePeak(value) >= scaleBar(MUTEDWARN_PEAK, true)) mutedSpeechMs += (value.length / 2 / RATE) * 1000; else mutedSpeechMs = Math.max(0, mutedSpeechMs - 200);
              // CANON 048: two independent speech witnesses, either is enough — the level
              // accumulator above (same bar the warning already trusts) and a fresh VP barge
              // (the cleaned-signal detector, the stronger "that was HIM"). Firing at
              // AUTOUNMUTE_MS (400ms default) instead of the warning's 1000ms is the whole
              // point: he must lose a word, not a sentence.
              if (mutedSpeechMs >= AUTOUNMUTE_MS || vpFresh()) {
                autoUnmuteIfCapsOn(vpFresh() ? "VP voice detected" : `${Math.round(mutedSpeechMs)}ms of speech above the bar`);
                if (!micMuted) { mutedSpeechMs = 0; mutedWarnAt = 0; }   // unmuted: the warning is moot, the frame now flows below
              }
              if (micMuted && mutedSpeechMs > 1000 && Date.now() - mutedWarnAt > 10000) {
                mutedWarnAt = Date.now(); mutedSpeechMs = 0;
                say("info", "speaking while muted — the mouth cannot hear you");
              }
            }
            if (micMuted && !vpCut) continue;                  // muted: drop mic frames so the model never hears them (canon 048: an auto-unmute one branch up lets THIS frame through — the mute is gone, so the gate is gone with it)
          }
          // MIND narrator playing: frames NEVER flow in ANY mode (o.barge only trades off
          // the MOUTH's playback — the narrator's audio must not reach the model even with
          // headphones-mode on; verified gap). Detect the human barging locally.
          if (mindPlayer && mindLine) {
            // HALF-DUPLEX: these frames are our own narrator coming back through the mic. They
            // are already refused below (`continue`); holding the duck open here is what makes
            // the mic stay shut for HD_TAIL ms AFTER the player exits — the ffplay spin-up bias
            // means the audio is still in the air when playingUntil has already expired.
            duckFrame(value?.length ? (value.length / 2 / RATE) * 1000 : 0, "mind");
            if (value?.length && archFd >= 0 && !micMuted) {   // caps decision (a): a MUTED frame never opens a window — muted audio is never resent
              if (ovStart < 0) { ovStart = archBytes - value.length; ovPath = archPath; ovAt = Date.now(); }
              ovSrc = "mind";   // OUTSIDE the open-guard: MIND is the stricter label and always wins —
                                // a window opened under the mouth that then carries narrator leak must
                                // never be resent under a "mouth" label (verify catch, 2026-08-20)
              if (ovPath === archPath) ovEnd = archBytes;
            }
            saveMindState("speaking", false);   // LANE 15: <=1/s progress — a SIGKILL still leaves the spoken prefix on disk
            if (value?.length && BARGE_PEAK > 0) {
              const fMs = (value.length / 2 / RATE) * 1000;
              // Leaky accumulator — real speech dips below any bar mid-word; a strict
              // consecutive rule never accumulates 250ms (measured).
              const pkM = framePeak(value);
              bargeMs = pkM >= scaleBar(BARGE_PEAK) ? bargeMs + fMs : Math.max(0, bargeMs - fMs);
              // DEFECT 5.1 — THE NARRATOR JOIN IS AN **AND**, NEVER AN OR. v2 let a VP event
              // fire this cut with the engine's own level bar bypassed; the sibling lane measured
              // three events during a live narrator line at peaks 19079 / 4469 / 8372, prob
              // 0.97-1.0, and named the 4.5k/8.4k ones narrator-LEAK candidates — VPIO may not
              // fully suppress a loud narrator through this path, and the child's VAD cannot tell
              // that leak from him (his own quiet-end barge measured 2 574: level does not
              // separate them). So the engine's detector keeps BOTH of its legs — the leaky
              // sustain accumulator AND the level bar — and the VP event is only ever an extra
              // requirement on top when the child is live. When it is off, this line is HEAD's,
              // character for character, and the loved-state narrator barge is untouched.
              // Worst case therefore stays the engine's stated one: a leaked narrator can at most
              // cut the NARRATOR ITSELF (which ends the leak), never the mouth mid-reply, and it
              // never sends gated audio. Re-fit for VPIO levels with APIPLAN_MIND_BARGE_PEAK.
              const vpNarrOk = !vp || (vpFresh() && pkM >= scaleBar(BARGE_PEAK));
              // EVIDENCE GATE (see the mindBargeVerdict block above). `sustained` is HEAD's exact
              // trigger; what changes is only what happens when it is true and nothing proves he spoke.
              const sustained = bargeMs >= BARGE_SUSTAIN && vpNarrOk && Date.now() - lastBargeAt > 1000;
              if (bargeCandAt) { bargeCandMs += fMs; bargeCandPeak = Math.max(bargeCandPeak, pkM); }
              const bv = mindBargeVerdict({
                mode: BARGE_REQUIRE_SPEECH, now: Date.now(), candAt: bargeCandAt, confirmMs: BARGE_CONFIRM_MS,
                sustained, vpLive: !!vp, vpFresh: vpFresh(), userSpeaking, speechStartedAt,
              });
              if (bv.verdict === "arm") {
                // ARM ONLY. THE ABSOLUTE INVARIANT IS UNTOUCHED: this branch writes three counters
                // and falls through to the `continue` below exactly like a quiet frame — it never
                // touches micMuted, never clears the gate, never sends a frame. The window listens
                // to audio we are ALREADY dropping.
                bargeCandAt = Date.now(); bargeCandPeak = pkM; bargeCandMs = fMs;
              } else if (bv.verdict === "reject") {
                say("info", `mind barge candidate rejected — no speech evidence (peak ${Math.round(bargeCandPeak)}, ${Math.round(bargeCandMs)}ms loud, ${Math.round(Date.now() - bargeCandAt)}ms window${bv.evidence ? `, ${bv.evidence}` : ", vp live"})`,
                  { mind_barge_rejected: true, cand_peak: Math.round(bargeCandPeak), cand_loud_ms: Math.round(bargeCandMs),
                    cand_window_ms: Math.round(Date.now() - bargeCandAt), cand_bar: scaleBar(BARGE_PEAK), vp_live: !!vp });
                bargeCandAt = 0; bargeCandPeak = 0; bargeCandMs = 0;
                bargeMs = 0; lastBargeAt = Date.now();          // the 1s cooldown now bounds the echo rate too
              } else if (bv.verdict === "cut") {
                const confirmMs = bargeCandAt ? Math.max(0, Date.now() - bargeCandAt) : 0;
                bargeCandAt = 0; bargeCandPeak = 0; bargeCandMs = 0;
                bargeMs = 0; vpBargeAt = 0; lastBargeAt = Date.now();
                const L = mindLine;
                // startAt is biased by ffplay spin-up (~250ms measured) and the cut rounds
                // DOWN to a word boundary — never record words he did not hear as spoken.
                const raw = Math.min(L.text.length, Math.round(((Date.now() - L.startAt) / L.ms) * L.text.length));
                const wb = L.text.lastIndexOf(" ", raw);
                L.cut = wb > 0 ? wb : Math.max(0, raw);
                try { mindPlayer.kill("SIGKILL"); } catch {}   // exited handler records the spoken prefix only
                playingUntil = Date.now() + 250;               // swallow the kill tail — reopening at 0 lets the tail transcribe
                // THE PEAK THAT DID IT (MIND lane, 2026-08-22). Every cut before tonight was
                // unfalsifiable from the log alone: the line said a cut happened, never what
                // crossed the bar. Four calls had to be re-derived by hand to bracket the
                // narrator's own leak, and two agents produced two different numbers (1800-2000
                // from one window, 2441 from another) precisely because the evidence was absent.
                // Now the trigger carries its own peak, the bar it cleared, and how far into the
                // narrator it fired — so any future "he was cut without barging" is one grep.
                const cutAtMs = Math.max(0, Date.now() - L.startAt);
                say("info", `mind interrupted by user — spoke ${L.cut}/${L.text.length} chars (peak ${Math.round(pkM)} vs bar ${scaleBar(BARGE_PEAK)}, ${cutAtMs}ms into the line${vp ? ", vp live" : ""}, evidence ${bv.evidence}${confirmMs ? ` +${confirmMs}ms` : ""})`,
                  { mind_cut: true, cut_peak: Math.round(pkM), cut_bar: scaleBar(BARGE_PEAK), cut_at_ms: cutAtMs, cut_chars: L.cut, line_chars: L.text.length, vp_live: !!vp,
                    cut_evidence: bv.evidence, cut_confirm_ms: confirmMs });
                const rest = L.text.slice(L.cut).trim();
                if (rest) { injectQueue.push({ text: rest, who: L.who }); queueStale = true; }   // remainder is STALE — re-weave against his words
                saveMindState("cut-by-user");                              // LANE 15: cut point + remainder outlive the call
                ovStart = -1; ovEnd = 0; ovPath = ""; ovSrc = "";   // his live speech supersedes overlap recovery here
              }
            }
            continue;
          }
          // MOUTH PLAYING (fire17, canon 027: the mic must hear him DURING the mouth's reply,
          // stop at word granularity, and know how much was actually spoken). The gate below
          // keeps his audio out of the SESSION while the mouth plays — which is also why server
          // VAD can never fire input_audio_buffer.speech_started in this window, so the ws barge
          // path (response.cancel + conversation.item.truncate) is structurally unreachable in
          // exactly the window barge exists for. That is the verified root cause of "ספרת על
          // הסוף": he interrupted a count to twenty and the mouth counted to the end, his words
          // seen only post-hoc by overlap recovery. The fix does NOT unmute the session — that
          // would feed speaker echo straight into VAD, which is self-barge by construction — it
          // detects the barge LOCALLY on the frames we are already dropping, exactly like the
          // MIND barge above, and then runs the same cancel+truncate the ws path would have run.
          // DUPLEX EVIDENCE (call 31192). With duplex opted in, the frames below flow straight
          // to the server, its VAD hears our own speakers, and the ws barge path cuts the mouth
          // mid-word. Measure here the same local level+sustain the mouth-barge path uses, so
          // that cancel can demand proof the ROOM was loud rather than trusting a VAD that is
          // listening to us. Measured on 31192's own mic archive at his HIGH speaker volume
          // (30 leak-only windows, 4096B frames): the leak never sustained more than 85ms above
          // 2000 — one frame — while his real speech sustained 256-853ms. SUSTAIN is the
          // discriminator, not level: the leak's instantaneous peak reached 2311, i.e. ABOVE the
          // 2000 bar. Inert unless bargeOn, so the default no-duplex path is unchanged.
          if (bargeOn) {
            if (!stillAudible()) mouthBargeMs = 0;                  // never bank energy across replies
            else if (value?.length && MOUTH_BARGE_PEAK > 0) {
              const fMs = (value.length / 2 / RATE) * 1000;
              mouthBargeMs = framePeak(value) >= MOUTH_BARGE_PEAK ? mouthBargeMs + fMs : Math.max(0, mouthBargeMs - fMs);
              if (mouthBargeMs >= MOUTH_BARGE_SUSTAIN) bargeEvidenceAt = Date.now();
            }
            // ARCH A: a VP barge IS the local proof the self-cut guard at speech_started
            // demands — it was scored on the CLEANED signal, so by construction it cannot be
            // our own speakers. This is the evidence call 31192 never had.
            if (vpFresh()) bargeEvidenceAt = Date.now();
          }
          if (stillAudible() && !bargeOn) {
            // HALF-DUPLEX: the mouth's own audio, already refused by this branch at 099e723 —
            // the duck adds only the tail (its own +250ms of slack is measured against the
            // player's clock, not the speaker's). No second gate: never double-gate a path the
            // engine already closes. The mouth's tail rides playingUntil itself, so it costs
            // HD_TAIL minus the 250ms stillAudible() already holds — 50ms at the defaults — and
            // it disappears the instant a barge zeroes that clock. This call only labels and
            // counts the window for the forensic line.
            duckFrame(value?.length ? (value.length / 2 / RATE) * 1000 : 0, "mouth");
            if (value?.length && archFd >= 0 && !micMuted) {   // overlap capture: his words during mouth playback (never from a MUTED frame — caps decision (a))
              if (ovStart < 0) { ovStart = archBytes - value.length; ovPath = archPath; ovAt = Date.now(); ovSrc = "mouth"; }
              if (ovPath === archPath) ovEnd = archBytes;      // segment rolled mid-window → keep what we had
            }
            bargeMs = 0;
            // SELF-BARGE GUARD — the hard part. These frames carry SPEAKER ECHO of the mouth
            // itself (the whole reason the gate exists), so a naive "any audio = barge" detector
            // would cut every reply on its own voice. Four layers, each measured on this rig:
            //   1. LEVEL. Speaker leak peaks 400-1789; his close-mic speech runs p90 1642-2194,
            //      max ~3400 (587s of archives) — the same loudness discriminator overlap
            //      recovery already trusts, at the same 2000 bar, reused rather than reinvented.
            //   2. SUSTAIN, leaky. A teardown click or a syllable of leak cannot accumulate
            //      200ms; natural speech dips mid-word (1690→389→1570 inside 300ms, measured),
            //      so the accumulator leaks instead of demanding consecutive loud frames.
            //   3. GRACE. No cut in the opening window, where his own trailing words and the
            //      player's spin-up transient live.
            //   4. REFRACTORY + KILL TAIL. After a cut the mic gate is held for the tail and no
            //      second cut may fire for 1s — our own teardown can never re-trigger this.
            // NEVER ON OUR OWN LINES: a MIND narrator line (mindBusy) and any response WE asked
            // for (mindResponse — an injected MIND fallback, a tool result, the greeting) are
            // owned by their own machinery, which re-weaves remainders and keeps the mouth's
            // history honest. Cutting those here would kill a verbatim line with no re-weave and
            // record words as spoken that were never heard, so the detector stays off for them.
            // The failing case — he asks the mouth something and interrupts its own auto-reply —
            // is exactly the case that IS covered.
            // WORST MIS-TUNE (speakers loud enough that leak clears the bar): the mouth cuts
            // itself. Bounded and self-reporting — nothing loops, nothing speaks on its own, his
            // words are never lost (the overlap window stays armed), and an unfollowed cut is
            // announced UNCONFIRMED and discarded. Tune APIPLAN_MOUTH_BARGE_PEAK (0 disables).
            // HONEST NOTE (2026-08-22, found by red-team, and it was an ERROR not a design):
            // this whole block is nested inside `if (stillAudible() && !bargeOn)`, so
            // localBargeLive() is CONSTANT TRUE here and mouthBargeArmed gates nothing. The floor
            // was written as if this expression carried it; it does not. The local self-disarm
            // belt is therefore GONE on this path, not bounded, and the `else if` disarm branch
            // below is unreachable. What actually bounds a leak cascade now is the LEAK-SHAPED
            // test in the confirm timer — a cut far above the measured leak floor is his voice
            // and must never raise the bar against him; only a leak-shaped one escalates.
            if (value?.length && MOUTH_BARGE_PEAK > 0 && localBargeLive() && !mindBusy && !mindResponse && Date.now() >= mouthBargeTailUntil) {
              const fMs = (value.length / 2 / RATE) * 1000;
              const pk = framePeak(value);
              const played = itemFirstDeltaAt ? Date.now() - itemFirstDeltaAt : 0;
              // LANE b: the grace window is our own audio by construction — read the rig's live leak
              // floor off the peak we just computed. Costs one compare per frame.
              noteLeakFrame(pk, played, itemFirstDeltaAt);
              const mouthBar = scaleBar(MOUTH_BARGE_PEAK);
              mouthBargeMs = pk >= mouthBar ? mouthBargeMs + fMs : Math.max(0, mouthBargeMs - fMs);
              // `played <= itemQueuedMs + tail` keeps the cut bound to the MOUTH's own timeline:
              // audio always arrives faster than it plays, so inside a reply (and through its
              // drain) played never exceeds what we queued. Past that, whatever still gates the
              // mic is not the mouth — e.g. the ~250ms of MIND gate slack after the narrator's
              // player exits — and a cut there would truncate a finished item for nothing.
              // ARCH-A JOIN (half-duplex mouth): a VP barge — Silero on the VPIO-cleaned signal,
              // sustained on the child's own gate — stands in for this accumulator's SUSTAIN leg,
              // and the level leg stays in the AND for the same reason as the MIND join above:
              // the child scores VOICE, the engine still demands the room was LOUD on this frame.
              // EVERYTHING below then runs unchanged: the cut, the truncate, the kill tail, the
              // mouthBarge record, saveMindState and the UNCONFIRMED self-report. No new cut path
              // was written for arch A. GRACE and TAIL still apply: they bind the cut to the
              // MOUTH's own timeline, which a VP event knows nothing about.
              // HONEST SCOPE (defect 6.3, resume-design G-C): what is delivered here is the CUT
              // and its record. The three-way "mouth-cut resume" assembly can now FIRE — but its
              // release guard (`!responseActive && !awaitingResponse && !mindBusy && !prevRespId`)
              // is usually already false in duplex by the time his transcript lands, so the
              // continuation is LOGGED and not spoken. That is named debt, not a claim; the
              // resume path below now says so out loud instead of going quiet.
              if ((mouthBargeMs >= mouthBargeSustain || (vpFresh() && pk >= mouthBar)) && played >= MOUTH_BARGE_GRACE
                  && played <= itemQueuedMs + MOUTH_BARGE_TAIL) {
                // REFRACTORY. Energy accumulated while the refractory blocks must NOT bank for
                // the next cut, or the second cut fires the instant the second expires with no
                // sustain of its own — reset and keep listening.
                if (Date.now() - lastMouthBargeAt <= 1000) { mouthBargeMs = 0; vpBargeAt = 0; continue; }
                // With a VP barge the sustain that fired is the CHILD's (voiced ms on the
                // cleaned signal), not this accumulator's — record that number, never a zero.
                const sustained = Math.round(mouthBargeMs || (vpEv?.voiced_ms ?? 0));
                mouthBargeMs = 0; vpBargeAt = 0; lastMouthBargeAt = Date.now();
                // HEARD-MS: the same clock the ws barge path uses (first audio delta vs the audio
                // handed to the player), MINUS the player spin-up — ffplay is audible ~200-300ms
                // after the first delta arrives (the engine's own APIPLAN_MIND_START_MS exists to
                // compensate exactly this on the MIND path, and a fresh player is spawned after
                // every cut, so the full bias applies to the very next reply).
                // NOTE, precisely: when the response is still generating, silenceMouth() below
                // routes through bargeNow(), whose truncate uses the RAW delta-arrival clock — so
                // the server is told ~one spin-up MORE was heard than the split here assumes. The
                // asymmetry is deliberate and one-directional: our remainder starts slightly
                // earlier than the server's idea of what was said, so at worst a word he already
                // heard is repeated. A word he never heard can never be dropped.
                const spinUp = Number(process.env.APIPLAN_MIND_START_MS) || 250;
                const heardMs = itemFirstDeltaAt ? Math.max(0, Math.min(played - spinUp, itemQueuedMs)) : 0;
                // WORD GRANULARITY — an honest approximation, stated as such. Playback is cut AT
                // ONCE (a sub-word audio tail is unavoidable) and the spoken WORD boundary is
                // derived from heard-ms against the reply transcript, rounded DOWN to a space,
                // exactly as spokenChars() does for a MIND line. It is an approximation because
                // response.audio_transcript.delta and response.audio.delta are SEPARATE streams
                // that need not stay in step, and because chars are a proxy for time; the
                // round-down plus the spin-up subtraction bias it toward counting FEWER words as
                // heard, which is the safe direction — a word he heard may be re-said, a word he
                // never heard is never recorded as spoken. `mouthChars` supplies the true length
                // when mouthBuf has been clamped to its last 2000 chars, so a long reply splits
                // at the right place instead of inside its tail window.
                const said = mouthBuf.trim() || mouthLast;
                const full = Math.max(said.length, mouthChars);
                const dropped = full - said.length;                 // chars the 2000-char clamp dropped
                const rawFull = itemQueuedMs > 0 ? Math.round((heardMs / itemQueuedMs) * full) : 0;
                const raw = Math.max(0, Math.min(said.length, rawFull - dropped));
                const wb = said.lastIndexOf(" ", raw);
                const heardChars = wb > 0 ? wb : raw;
                const cancelling = responseActive && !mindResponse;
                const itemId = curItemId;
                silenceMouth();   // cancel + truncate when still generating; always kills live AND draining players
                // Deltas still in flight would respawn the player mid-cut (the ghost-audio bug).
                if (curResponseId) { cancelledResponses.add(curResponseId); responsesCancelled++; sessResponsesCancelled++; }
                if (!cancelling && itemId) {
                  // Generation already finished while the speaker was still talking: nothing to
                  // cancel, yet the model's context holds words he never heard. Truncate anyway —
                  // that is precisely what conversation.item.truncate is for.
                  try { ws.send(JSON.stringify({ type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: Math.round(heardMs) })); } catch {}
                }
                // Swallow the kill tail: reopening the gate at 0 sends ffplay's last ~40-100ms
                // into the session and the server transcribes OUR voice as his (the post-barge
                // self-hear window — the MIND barge swallows it the same way). MOUTH_BARGE_TAIL
                // is finite by construction (mouthKnob), so playingUntil can never become NaN.
                mouthBargeTailUntil = playingUntil = Date.now() + MOUTH_BARGE_TAIL;
                // BELT INTERACTION. The echo corpus must contain what LEAKED — and only that.
                // The unspoken remainder never reached the speakers, so storing it would let the
                // recovery path delete HIS words for matching audio that never played. While the
                // response is still generating, response.done is the one writer of this ring
                // (line "rememberSpoken(mouthBuf)"), so trimming mouthBuf to the heard prefix
                // here makes that single write store exactly the audible part — no second ring
                // slot, no never-spoken text in the corpus, and mouthLast then means "what the
                // mouth actually said". When generation already finished, response.done has
                // already stored the reply and nothing more is added.
                if (cancelling) mouthBuf = said.slice(0, heardChars);
                // State for the resume half. The overlap window is deliberately LEFT ARMED
                // (unlike the MIND barge, which supersedes it): his interjection STARTED before
                // the cut and only the archive holds those frames, so recovery is the only path
                // carrying his opening words — the live turn after the gate reopens carries the
                // rest. Partial overlap between the two is annotated by the belt, never deleted.
                const mb = {
                  at: Date.now(), heardMs: Math.round(heardMs), queuedMs: Math.round(itemQueuedMs),
                  itemId, responseId: curResponseId, cancelled: cancelling,
                  said, heard: said.slice(0, heardChars), remainder: said.slice(heardChars).trim(),
                  peak: pk, sustainMs: sustained, confirmed: null as boolean | null, consumed: false,
                };
                mouthBarge = mb;
                say("info", `mouth interrupted by user — cut at ${mb.heardMs}ms of ${mb.queuedMs}ms`
                  + ` (${heardChars}/${full} chars, peak ${pk} vs bar ${mouthBar}, ${sustained}ms sustained${cancelling ? ", response cancelled" : ", audio tail only"})`
                  + (mb.remainder ? ` — UNSPOKEN: ${mb.remainder.slice(0, 160)}` : ""),
                  { mouth_barge: true, heard_ms: mb.heardMs, queued_ms: mb.queuedMs,
                    heard_chars: heardChars, chars: full, peak: pk, bar: mouthBar,
                    leak_ref: leakRef || undefined, bar_scale: barScale !== 1 ? Number(barScale.toFixed(3)) : undefined,
                    sustain_ms: sustained, cancelled: cancelling, item_id: itemId });
                saveMindState(undefined, true);   // FORCED: a cut is the one thing that must survive a SIGKILL
                // SELF-REPORTING MIS-TUNE. A real barge is followed by his turn (the gate reopens
                // after the kill tail), by the recovered audio of what he said under the playback
                // (a resend commits), or by the resume half consuming this record. None of the
                // three = the cut was probably our own speaker leak, or a cough: say so, and
                // DISCARD the record so it can never attach itself to his next real turn.
                if (MOUTH_BARGE_CONFIRM > 0) {
                  const seenAt = speechStartedAt; const resendAt = lastResendAt;
                  // CAPS-(a) SELF-CONFIRM (reverify A2.4): same rule as the duplex belt below —
                  // a muted-mic cut cannot be confirmed by channels the mute itself closes.
                  const mutedAtCut = micMuted;
                  setTimeout(() => {
                    if (closed || mb.confirmed !== null) return;
                    mb.confirmed = mutedAtCut || mb.consumed || speechStartedAt !== seenAt || lastResendAt !== resendAt;
                    if (mb.confirmed) {
                      mouthBargeUnconfirmed = 0;
                      // REDTEAM (P1-D). Escalation was one-way for the life of the call: one
                      // early phantom raised HIS bar permanently, even after the room proved
                      // itself (he lowers the volume, plugs headphones, the leak drops). A
                      // confirmed cut is evidence the current bar works — walk it back down.
                      if (mouthBargeSustain > MOUTH_BARGE_SUSTAIN) {
                        mouthBargeSustain = Math.max(MOUTH_BARGE_SUSTAIN, Math.round(mouthBargeSustain / 2));
                        say("info", `mouth barge de-escalated to ${MOUTH_BARGE_PEAK}/${mouthBargeSustain}ms — a confirmed cut proves the bar is not leak`,
                          { mouth_barge_deescalated: true, sustain_ms: mouthBargeSustain });
                      }
                      return;
                    }
                    // REDTEAM (P0-B) — DO NOT ESCALATE AGAINST HIM. "Unconfirmed" means the three
                    // confirmation channels stayed quiet; it does NOT mean leak. The engine already
                    // measures the leak floor (leakRef, the median grace-window peak of our own
                    // audio). Call 96642's disarming cut: pk 2584, leakRef 128 — twenty times the
                    // leak. That was not the speakers, it was a confirmation channel that failed
                    // (his words landed under a ducked mic, no speech_started, no resend). Raising
                    // the sustain there raises the bar against HIS voice and fixes nothing.
                    // Only a cut whose peak sits within reach of the measured leak is leak-shaped.
                    if (leakRef > 0 && pk > leakRef * LEAK_ESCALATE_RATIO) {
                      say("info", `mouth barge UNCONFIRMED but NOT leak-shaped — peak ${pk} is ${(pk / leakRef).toFixed(1)}x the measured leak floor ${leakRef}; bar left at ${MOUTH_BARGE_PEAK}/${mouthBargeSustain}ms (a confirmation channel failed, not the speakers)`,
                        { mouth_barge_unconfirmed: true, not_leak: true, peak: pk, leak_ref: leakRef, sustain_ms: mouthBargeSustain });
                      if (mouthBarge === mb) mouthBarge = null;
                      return;
                    }
                    // Second unconfirmed cut in a row = this rig's leak is clearing the bar.
                    // Stand the detector down for the rest of the call instead of cutting every
                    // reply; the operator sees exactly why, and one restart with a raised
                    // APIPLAN_MOUTH_BARGE_PEAK (or MOUTH_BARGE_MS, see the calibration note)
                    // re-arms it. Nothing of his is lost — overlap recovery is untouched.
                    // HIS ONE UNCONDITIONAL LAW HAS NO OFF SWITCH — "הקול שלך מעל הכל".
                    // Call 96642 proved these belts compose into its violation: duplex stood
                    // itself down at 23:44:31, this belt at 00:21:24, and from then on the mouth
                    // was uninterruptible BY CONSTRUCTION (half-duplex ducked his mic for 20
                    // minutes across that call, so the server never heard him either). At 02:16
                    // he reported it: "ניסיתי להתפרץ לפה וזה לא עבד ההתפרצות". Each belt is sane
                    // alone; nothing forbade BOTH being down. So: while duplex is already down,
                    // this detector is the ONLY path and never disarms. It ESCALATES the sustain
                    // bar instead — the very remedy this message recommends ("sustain separates
                    // leak from speech far better than level"), applied live instead of demanding
                    // a restart he never gets mid-conversation. At the cap it STAYS ARMED: a
                    // spurious cut is recoverable (remainder resumes, overlap recovery resends),
                    // an uninterruptible mouth is not.
                    if (++mouthBargeUnconfirmed >= 2 && mouthBargeArmed && !bargeOn) {
                      const before = mouthBargeSustain;
                      mouthBargeSustain = Math.min(MOUTH_BARGE_SUSTAIN_MAX, mouthBargeSustain * 2);
                      mouthBargeUnconfirmed = 0;
                      say("info", mouthBargeSustain > before
                        ? `mouth barge ESCALATED ${MOUTH_BARGE_PEAK}/${before}ms -> ${MOUTH_BARGE_PEAK}/${mouthBargeSustain}ms — NOT disarmed: duplex is already down, so this is the last path by which he can cut the mouth`
                        : `mouth barge HELD ARMED at ${MOUTH_BARGE_PEAK}/${mouthBargeSustain}ms (sustain cap) — duplex is down, so disarming would leave him unable to interrupt the mouth at all; a spurious cut is the accepted cost`,
                        { mouth_barge_escalated: true, bar: MOUTH_BARGE_PEAK, sustain_ms: mouthBargeSustain, was_sustain_ms: before, capped: mouthBargeSustain === MOUTH_BARGE_SUSTAIN_MAX });
                    } else if (mouthBargeUnconfirmed >= 2 && mouthBargeArmed) {
                      // UNREACHABLE at HEAD: the cut gate above only runs while !bargeOn, and
                      // bargeOn is monotone (set false at 893/2536, never true). Kept ONLY so the
                      // path exists if the cut gate is ever allowed to run in duplex; if it is
                      // still dead at the next pass, delete it rather than let it read as a belt.
                      mouthBargeArmed = false;
                      say("info", `mouth barge DISARMED for this call — ${mouthBargeUnconfirmed} unconfirmed cuts in a row at bar ${MOUTH_BARGE_PEAK}/${MOUTH_BARGE_SUSTAIN}ms. Speaker leak is clearing the bar; raise APIPLAN_MOUTH_BARGE_MS (sustain separates leak from speech far better than level) and restart to re-arm.`,
                        { mouth_barge_disarmed: true, unconfirmed: mouthBargeUnconfirmed, bar: MOUTH_BARGE_PEAK, sustain_ms: MOUTH_BARGE_SUSTAIN });
                    }
                    say("info", `mouth barge UNCONFIRMED — no user turn and no recovered speech in ${MOUTH_BARGE_CONFIRM}ms after the cut (peak ${pk} vs bar ${mouthBar}${leakRef ? `, leak ref ${leakRef}` : ""}); record discarded. If this repeats, raise APIPLAN_MOUTH_BARGE_PEAK`,
                      { mouth_barge_unconfirmed: true, peak: pk, bar: mouthBar, leak_ref: leakRef || undefined, sustain_ms: sustained });
                    if (mouthBarge === mb) mouthBarge = null;
                  }, MOUTH_BARGE_CONFIRM);
                }
              }
            }
            continue;
          }
          // BELT (caps decision (a)). A muted frame is let past the gate above ONLY to reach
          // the two playback branches, and both end in `continue`. If one of their predicates
          // flipped between the two evaluations (playingUntil expiring mid-frame is a real
          // race), the frame stops HERE: a muted frame can never reach the model, ever, by any
          // path. Unreachable when the mute gate is doing its ordinary job.
          if (micMuted) continue;
          // ORGAN FLOOR — the mic half (canon 029 / EVA's E366-E368: three false `you` turns from
          // ONE line of hers). Her audio is in the room; these frames are her, not him. Dropped
          // for the MODEL only — archWrite() above already ran, so the never-lose archive keeps
          // every byte and anything he says over her is still recoverable from it.
          if (Date.now() < organFloorUntil) continue;
          bargeMs = 0;
          // HALF-DUPLEX TAIL. Our own audio stopped less than HD_TAIL ms ago, so these frames
          // still carry it — the speaker's own latency plus the capture pipeline's. Nothing is
          // appended, and the overlap window stays open because this tail belongs to OUR
          // playback, not to his turn. Self-limiting: ducked() reads a clock only the two
          // playing branches above extend, so a tail can never hold itself open.
          if (ducked()) { duckMs += value?.length ? (value.length / 2 / RATE) * 1000 : 0; continue; }
          duckRelease();                                       // mic open again — report a window that swallowed real audio
          if (ovStart >= 0 && !recovering) {                   // playback just ended → recover the dropped window
            // HALF-DUPLEX, THE SECOND DOOR — the one calls 58020 and 96316 actually leaked
            // through. The frames we refused to append are still archived, and this is where
            // they were resent INTO the model. For a MIND window that resend IS the echo:
            // 96316 fired recovery 7/7 on pure leak (8.4s, 4.2s, 5.3s, 5.3s, 4.8s …) and
            // 58020 @18:38 resent 21.8s of one MIND line, which came back as five fake "you"
            // turns — one of them only FLAGGED by the belts, so it entered the model's context
            // as his words. His own voice needs nothing from recovery here: the MIND barge
            // listens at a LOWER bar than recovery does (BARGE_PEAK 1800/250ms vs RECOVER_PEAK
            // 2000/200ms), so it catches nearly everything recovery could — the exceptions this
            // knowingly drops are an utterance under ~250ms of sustain and anything inside the
            // barge's 1s refractory; with APIPLAN_MIND_BARGE_PEAK=0 there is no live belt at all
            // and the window is fully deaf. The MOUTH window keeps recovery by default as a
            // PRECAUTION, not on measured benefit — in the 58020/31192/96316 corpus recovery
            // never once returned genuine speech (22/22 resend-sourced turns were echo). It is
            // kept because the mouth barge sits at a HIGHER bar than recovery and self-disarms,
            // so removing both belts at once is not something to do blind; LIVEMIND_HALF_DUPLEX=all
            // closes that door too (unless the mouth barge has self-disarmed — then recovery is
            // the only belt left and stays open), and the 099e723 TEETH stay armed either way.
            // THE GREETING DOOR (call 31599, 2026-08-20 — the mouth's FIRST utterance came back as
            // a you-turn). The duck was NOT the gap: playingUntil arms on the greeting's first
            // audio delta through the same queueAudio bookkeeping as every other reply, and that
            // call's own log shows 8683ms of mic ducked during it. The leak was THIS door — the
            // window was labelled "mouth", HD_MODE is "mind", so 8.6s of pure speaker leak was
            // resent, transcribed at sim 0.98, and the server built a reply off it before the
            // belts could delete the item. `!speechStartedAt` = the human has not spoken ONCE in
            // this call, so nothing recovery could be carrying exists yet and the window is our
            // own opening line by construction. It is the same class the gate already closes: the
            // mouth-barge belt is disarmed for a greeting anyway (`!mindResponse`), exactly as it
            // is for a MIND line. TRADE, stated honestly: words he speaks OVER the greeting reach
            // the archive and this log line but not the model — he says them again to a mouth that
            // is now listening. Nothing of his is ever deleted, and the moment he has spoken once
            // this condition is false forever: normal mouth-window recovery is untouched.
            const hdPreTurn = !speechStartedAt;
            // P0-3 (risk register): `!bargeOn` made this door ALWAYS OPEN in duplex, so a MIND
            // overlap window — pure narrator leak — was handed to recoverOverlap() and resent
            // into the model as if it were his speech. That is the exact mechanism of calls
            // 58020 and 96316 (7/7 recovery on pure leak; 21.8s of one MIND line came back as
            // five fake "you" turns). AEC does not fix it — the archive holds capture audio,
            // so recovery resends the narrator either way. The half-duplex resend POLICY is a
            // property of HD_ON alone; duplex never had a reason to switch it off.
            // ...and the MIND clause is independent of HD_ON as well (the redteam's exact closing
            // action, 3.4): a narrator-leak window must never be resent in ANY configuration. With
            // LIVEMIND_HALF_DUPLEX=off, v2 still handed pure MIND leak to recoverOverlap — the
            // calls-58020/96316 door, left ajar.
            // REDTEAM (P2-F). This read of mouthBargeArmed was the documented escape hatch:
            // "unless the mouth barge has self-disarmed — then recovery is the only belt left and
            // stays open". Since the floor landed, mouthBargeArmed is never written false on any
            // reachable path, so under HD_MODE=all the hatch is welded shut forever. The condition
            // it MEANT to express is "the local belt is still trustworthy" — which after the floor
            // is "its bar has not been escalated away from what the operator configured".
            const localBeltTrusted = mouthBargeArmed && mouthBargeSustain <= MOUTH_BARGE_SUSTAIN * 2;
            const hdBlock = ovSrc === "mind" || (HD_ON && (hdPreTurn || (HD_MODE === "all" && localBeltTrusted)));
            const hdSecs = (ovEnd - ovStart) / 2 / RATE;
            if (hdBlock) {
              // PHANTOM-CUT ACCOUNTING (W36 verify). A GENUINE barge over the greeting leaves a
              // mouth-barge record whose ONLY carrier is this window: the barge deliberately leaves
              // the overlap window ARMED because "recovery is the only path carrying his opening
              // words". Refusing the resend here means the MOUTH_BARGE_CONFIRM timer sees no new
              // speech_started and no new resend — so a cut we refused ON PURPOSE reads as an
              // unconfirmed phantom: his record is discarded, and two of those DISARM the
              // mouth-barge belt for the rest of the call. A window blocked by policy is accounted
              // for, not a phantom. The record survives for the three-way resume when he says those
              // words again (he must — they never reached the model), and the belt stays armed.
              const mbAcct = hdPreTurn && mouthBarge && mouthBarge.confirmed === null && mouthBarge.at >= ovAt ? mouthBarge : null;
              // The verdict is EVIDENCE, so it breaks the streak too (W38 verify): setting
              // `confirmed` makes the MOUTH_BARGE_CONFIRM timer early-return above the line that
              // resets `mouthBargeUnconfirmed`, so a cut we confirmed BY POLICY used to leave the
              // counter standing — two refused-then-accounted cuts plus one later phantom would
              // DISARM the belt on a streak a genuine cut had already broken.
              if (mbAcct) { mbAcct.confirmed = true; mouthBargeUnconfirmed = 0; }
              if (hdSecs >= 0.4) say("info", `half-duplex: ${hdPreTurn && ovSrc !== "mind" ? "greeting (no user turn yet)" : ovSrc || "playback"} overlap window NOT resent (${hdSecs.toFixed(1)}s — archived only, never fed back to the model)${mbAcct ? ` — the mouth cut inside it (${mbAcct.heardMs}ms heard) is ACCOUNTED: refused on purpose, not a phantom` : ""}`,
                // SACRED ADDRESSABILITY (W36 verify). "Archived only" is not enough on a belt
                // that suppresses words which were never transcribed: without a name, his
                // over-the-greeting words are an anonymous byte range inside a rolling segment,
                // with no you-turn, no transcript and nothing an operator can feed back. The
                // record therefore CARRIES the evidence — the segment path, the window's data
                // byte offsets (data bytes: the WAV header's 44 sit before them, exactly as
                // recoverOverlap reads them) and the wall clock it opened at — so the window is
                // findable forever and replayable verbatim on demand via {"audio": <file>}.
                { half_duplex_no_resend: true, src: ovSrc || "playback", pre_first_turn: hdPreTurn || undefined, window_s: Number(hdSecs.toFixed(2)),
                  mouth_cut_accounted: mbAcct ? true : undefined, mouth_cut_heard_ms: mbAcct ? mbAcct.heardMs : undefined,
                  archive: ovPath, start_byte: ovStart, end_byte: ovEnd, at: ovAt });
            } else if (Date.now() - ovAt < 30000) {            // a stale window is not a live turn (mute gaps, long stalls)
              recovering = true;
              recoverOverlap(ovPath, ovStart, ovEnd);          // async; never blocks the mic pump
            }
            ovStart = -1; ovEnd = 0; ovPath = ""; ovSrc = "";
          }
          // ROTATION: while a handover or an in-place reconnect is in flight the socket may be
          // CLOSED for a beat. Do NOT break the pump — every frame above was already archived
          // (archWrite runs before every drop), and breaking here kills the mic child.
          if (ws.readyState !== WebSocket.OPEN) { if (rotHold()) continue; break; }
          if ((ws as any).bufferedAmount > 512 * 1024) continue;   // backpressure: drop rather than pile in memory
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.from(value).toString("base64") }));
        }
      } catch { /* the socket or the mic went away; the loop above handles it */ }
    }

    // RESEND (fire17's never-lose law, 2026-08-20): {"audio":"<file>"} streams a saved
    // recording into the model exactly as live speech — transcoded to the session format,
    // mute BYPASSED (an explicit resend IS intent to be heard), 700ms silence tail so the
    // server VAD closes the turn and the mouth answers as if it was just spoken.
    async function resendAudio(path: string) {
      // ROTATION: a resend streams over seconds. Swapping in the middle would send its head to one
      // session and its tail to another — half a recording heard, half lost. The quiet gate reads
      // this flag, so a rotation simply waits for the resend to finish.
      rotResending = true;
      try {
        if (!(await Bun.file(path).exists())) { say("info", `audio resend failed: not found ${path}`); return; }
        const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
          "-f", "s16le", "-ac", "1", "-ar", String(RATE), "-"], { stdout: "pipe", stderr: "ignore" });
        const reader = p.stdout.getReader();
        let sent = 0;
        while (true) {
          const { done: rdone, value } = await reader.read();
          if (rdone) break;
          if (ws.readyState !== WebSocket.OPEN) return;
          for (let i = 0; i < value.length; i += 32768) {
            while ((ws as any).bufferedAmount > 512 * 1024) await Bun.sleep(20);
            ws.send(JSON.stringify({ type: "input_audio_buffer.append",
              audio: Buffer.from(value.subarray(i, i + 32768)).toString("base64") }));
            sent += Math.min(32768, value.length - i);
          }
        }
        if (!sent) { say("info", `audio resend failed: empty or unreadable ${path}`); return; }
        ws.send(JSON.stringify({ type: "input_audio_buffer.append",
          audio: Buffer.alloc(RATE * 2 * 0.7).toString("base64") }));   // silence tail closes the turn
        lastResendAt = Date.now(); lastResendMs = (sent / (RATE * 2)) * 1000;   // timing-belt provenance
        recoveredItemId = null;                                                  // re-arm: the NEXT commit is this resend's item
        say("info", `audio resent (${(sent / (RATE * 2)).toFixed(1)}s): ${basename(path)}`);
      } catch (e) { say("info", `audio resend failed: ${String(e).slice(0, 120)}`); }
      finally { rotResending = false; }
    }

    /** The mouth's own mute switch (canons 035/040). Engine-side, so it is state and not a wish.
     *  Muting answers the call and STOPS — a mouth told to be quiet must not narrate its own
     *  silence. Unmuting answers and lets it speak, which is the point: he addressed it again. */
    const runMouthTool = (item: any) => {
      let state = "read";
      try { state = String(JSON.parse(item.arguments || "{}").state || "read"); } catch {}
      if (state === "mute") { suppressAuto = true; suppressRestoreAt = 0; say("info", "mouth CLOSED (self-muted on his word)", { mouth_self: "mute" }); }
      else if (state === "unmute") { suppressAuto = false; suppressRestoreAt = 0; say("info", "mouth OPEN (self-unmuted on his word)", { mouth_self: "unmute" }); }
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      const output = state === "read"
        ? (suppressAuto ? "You are currently MUTED." : "You are currently able to speak.")
        : (suppressAuto ? "You are now muted. Say nothing further until he tells you to speak."
                        : "You can speak again. Answer him briefly.");
      try {
        ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output } }));
      } catch { return; }
      // A muted mouth gets no response.create — the silence IS the answer.
      if (!suppressAuto && !closing) { try { ws.send(JSON.stringify({ type: "response.create" })); awaitingResponse = true; } catch {} }
    };

    /** Dispatch ONE declared tool call, reply with its output, and let the model speak
     *  the result. Failures become a sentence the model can just say — a tool error must
     *  never take the call down. */
    const runTool = async (item: any) => {
      // ROTATION: capture the socket that ASKED. A tool can take seconds, and a rotation in that
      // window would send the result to a session that has never heard of this call_id — a server
      // error, and a result the model never sees. The reply belongs to the session that asked.
      const asked = ws;
      let output: string;
      try {
        const args = item.arguments ? JSON.parse(item.arguments) : {};
        const raw = await o.onTool!(item.name, args);
        // Handlers may return a string OR a structured object (JSON tool output is
        // common). String(obj) is "[object Object]" — serialize non-strings instead.
        output = typeof raw === "string" ? raw : JSON.stringify(raw);
      } catch (err: any) {
        output = `The tool could not run: ${String(err?.message ?? err).slice(0, 200)}`;
      }
      // Preview the result in the sidecar (not just its length) so the operator watching
      // the call can SEE what a tool did — e.g. the exact command a set_monitor armed.
      rec({ ev: "info", text: `tool ${item.name} → ${output.slice(0, 200).replace(/\s+/g, " ")}` });
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (asked !== ws) {
        // The session that asked is gone. Hand the answer to the live one as CONTEXT instead of
        // as a reply to a call_id it never made — nothing is lost, nothing errors.
        say("info", `tool ${item.name} result stranded by a rotation — carried into the new session as context`, { rotation: true, tool_stranded: item.name });
        try {
          ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "system",
            content: [{ type: "input_text", text: `[Live state update from the MIND — absorb silently, do not mention or respond to this]: result of ${item.name}: ${output}` }] } }));
        } catch {}
        return;
      }
      ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output } }));
      if (!closing) { ws.send(JSON.stringify({ type: "response.create" })); awaitingResponse = true; }
    };

    // ── Inbound context injection ────────────────────────────────────────────────
    // Other processes (a set_monitor watcher, a mid-call context push) append {text,mode}
    // lines to injectPath. Each is spoken INTO the live call: mode "graceful" waits for the
    // current sentence to finish; "interrupt" barges in so the model answers on it at once.
    // ADDRESSEE ROUTING (fire17, canons 027/028): when he calls EVA by name the MOUTH is
    // SILENT — not "Eva will answer you", not an acknowledgment: nothing. Eva answers in her own
    // voice. Mechanistic, exactly like the noise gates ("I don't want it to be up to the prompt"):
    // the persona can forget, this cannot. A name counts as an ADDRESS only when it opens the
    // turn, is set off by a comma, or lands in the first three words — a mid-sentence mention
    // ("המוח אמר לאווה") leaves the mouth answering normally, because silencing it on a real
    // question is the error he would actually hear. Organs with no voice of their own (lab,
    // hands, coach, doctor) are deliberately NOT gated here: the mouth owes him one sentence
    // for those (canon 028 mode 3), which is the persona's job, not this gate's.
    const EVA_NAMES = (process.env.APIPLAN_EVA_NAMES || "אווה,איווה,אוה,איבה,אבה,איב,eva,eve").split(",");
    const addressedToEva = (t: string): boolean => {
      const words = (t || "").trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.toLowerCase());
      if (!words.length) return false;
      for (const raw of EVA_NAMES) {
        const n = raw.trim().toLowerCase(); if (!n) continue;
        const i = words.indexOf(n);
        if (i < 0) continue;
        // PRE-RELAUNCH AUDIT 2026-08-22 (P1). `i <= 2` makes any mention in the first three
        // words an address, so a QUESTION ABOUT her — "מה אווה שמרה עד עכשיו" — silences the
        // mouth and routes to an organ that may not even be running; nothing answers him. An
        // address is a vocative: the name OPENS the turn, or it is set off by a comma.
        // Verified against the same case set as the original: the three real vocatives still
        // fire, the three questions-about-Eva no longer do.
        if (i === 0) return true;
        const after = t.split(raw)[1]?.[0];
        if (after === ",") return true;
      }
      return false;
    };
    let evaAddressedAt = 0;   // his last Eva-addressed turn — the mouth stays out of it
    const injectQueue: { text: string; who?: string }[] = [];
    mindQueue = injectQueue;   // LANE 15: close() records the lines that never got spoken
    let injectOff = 0;
    // EVA'S VOICE (canon 010/011, fire17 to her: "תבחרי לך קול נעים" — a girl's voice of her
    // own, distinct from the MIND's). Read HERE, once per utterance, exactly like the stereo
    // gains: writing ~/.livemind/eva-voice.txt moves her voice on her very next line — no
    // restart, no work, and nobody has to remember it. APIPLAN_EVA_VOICE overrides the file.
    const evaVoice = () => {
      if (process.env.APIPLAN_EVA_VOICE) return process.env.APIPLAN_EVA_VOICE;
      try { return fs.readFileSync(`${process.env.HOME}/.livemind/eva-voice.txt`, "utf8").trim() || "shimmer"; }
      catch { return "shimmer"; }
    };
    const sendInjected = (text: string, who?: string) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      // THE MIND'S OWN VOICE — mechanistic verbatim by construction. Driving the mouth's
      // conversational model with "say this word for word" instructions proved FLAKY: it
      // paraphrased, translated (English→Spanish live), summarized long lines, and with a
      // pending user question freelanced replies instead. So MIND lines no longer go through
      // the mouth's model at all: a dedicated narrator connection (speakRealtime — the same
      // engine as `apiplan speak`) renders the exact words as audio in a DISTINCT voice
      // (APIPLAN_MIND_VOICE, default "ash"), and we play it directly. The mouth cannot
      // reword what it never speaks — and the human hears by ear which tier is talking.
      // The echo string is unchanged — every MIND write→verify count-delta in the body
      // counts this exact line. WHO rides in the sidecar record instead.
      say("info", "injected context", who ? { who } : undefined);
      mindBusy = true;
      // ORGAN VOICES: an organ line ({"text":…,"who":"eva"}) is rendered by the SAME narrator,
      // through the SAME queue and the SAME never-interrupt gates — only the voice differs.
      const mindVoice = who === "eva" ? evaVoice() : (process.env.APIPLAN_MIND_VOICE || "ash");
      speakRealtime(c, { text, voice: mindVoice }, 60000).then(async (r) => {
        if (closed) { mindBusy = false; return; }
        // MIND priority (code-enforced handoff): silence the mouth right as the MIND's audio is
        // ready — no dead air, no overlap. Unconditional: the mouth's audio outlives its response,
        // so checking responseActive alone let the MIND play over the mouth's tail.
        silenceMouth();
        // A breath before the MIND speaks — the hard cut straight into MIND audio read as
        // "חד וטיפה מורגש" (sharp) to fire17's ear. A short silence cushion makes the
        // takeover land like a natural turn-take. Tune by ear via APIPLAN_MIND_CUSHION_MS.
        const cushion = Number(process.env.APIPLAN_MIND_CUSHION_MS) || 180;
        await new Promise((res) => setTimeout(res, cushion));
        if (closed) { mindBusy = false; return; }
        const f = `/tmp/apiplan-mind-${Date.now()}.wav`;
        await Bun.write(f, r.bytes);
        const ms = ((r.bytes.length - 44) / 2 / RATE) * 1000;
        playingUntil = Math.max(playingUntil, Date.now()) + ms;   // mic stays gated while the MIND talks (echo-safe)
        // Low-latency flags: without them ffplay holds a read-ahead buffer that stays
        // audible ~40-100ms after SIGKILL — the post-barge self-hear window (verified).
        // STEREO FIELD (canon 023): the MIND speaks 100% left + 50% right. The gains are
        // read HERE, once per utterance, so editing ~/.livemind/stereo.json mid-call moves
        // the field on the very next MIND line (≤1 utterance of lag, no restart, no work).
        // `-af` is safe on THIS path only: ffplay fixes its filter graph at spawn and this
        // player is per-utterance — the mouth's long-lived stdin player interleaves in JS.
        // Measured: the filter adds no spawn cost (107.1 vs 107.9 ms/spawn over 20 runs).
        // Gains come from platform.ts — the SAME loader the mouth uses, so one knob file, one
        // kill switch, and one mono decision: on a mono sink panGains() returns unity and this
        // filter collapses to a flat duplicate, keeping the MIND exactly as loud as the MOUTH.
        // byte 22 of the WAV header is the channel count: the pan expression reads c0 only,
        // so if the narrator ever returns stereo we play it flat instead of dropping a side.
        // The TRIM rides in the same coefficients (or in a bare volume= when there is no pan to
        // fold it into): one filter, no second graph, no extra spawn cost. The explicit `k*c0`
        // form is load-bearing — af_pan renormalizes ONLY coefficient-less terms, and measurement
        // confirms this form passes c0 at unity, so what is written here is what is heard.
        // toFixed(4) keeps float dust (0.30000000000000004) out of argv.
        const mindGain = r.bytes[22] === 1 && stereoEnabled() ? panGains("mind") : null;
        const mindTrim = voiceGain("mind");
        const mindPan = mindGain
          ? ["-af", `pan=stereo|c0=${(mindGain.l * mindTrim).toFixed(4)}*c0|c1=${(mindGain.r * mindTrim).toFixed(4)}*c0`]
          : mindTrim < 1 ? ["-af", `volume=${mindTrim.toFixed(4)}`] : [];
        speakerCheck(); warnIfUnheard("mind");                        // LANE 18: async, cached 5s
        mindPlayer = Bun.spawn(["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet",
          "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0",
          ...mindPan, f],
          { stdout: "ignore", stderr: "ignore" });
        // startAt is biased by ffplay spin-up (measured 200-300ms before first audible
        // sample) so the barge cut never over-counts words as spoken.
        mindLine = mindLast = { text, ms, startAt: Date.now() + (Number(process.env.APIPLAN_MIND_START_MS) || 250), cut: -1, who };
        // FRESH LINE, FRESH ACCUMULATOR (his complaint on air, call 35497: "המוח לא אמור
        // להיקטע אליי אם לא התפרצתי אליו"). `bargeMs` is a LEAKY accumulator with call-long
        // lifetime; nothing zeroed it when a narrator line begins, so leak from the mouth
        // playback that just ended — or his own turn that just finished — was still loaded in
        // it and spent itself on the MIND's first words. The cuts cluster exactly there:
        // median cut at 13% of the line on 35497, 11% on 57043.
        // This is a partial belt, and the honest measurement says so: it cannot explain a cut
        // 593ms into audible narrator (case 4/438 chars). That one is a BAR problem — see the
        // BARGE_PEAK note — and this line does not pretend to fix it.
        bargeMs = 0;
        saveMindState("speaking");   // LANE 15: on disk BEFORE the first sample — a hard kill can never erase the line
        // The line is announced exactly as before — same record, same text. The flag only tells
        // convTail WHO said it, so a rotation can carry the words as conversation without teaching
        // the successor to speak as the MIND (11776's seed replayed four "Mind here —" lines into a
        // persona whose own rules forbid that phrase).
        mindNarrating = true; lastMindSpokeAt = Date.now();
        try { say("model", text); }   // the exact words now audible — the monitor/GUI see the true line
        finally { mindNarrating = false; }
        rememberSpoken(text); // echo-dedupe: a recovered "you" matching this is speaker leak
        mindPlayer.exited.then(() => {
          // If the user barged (pumpMic set cut), only the SPOKEN PREFIX goes into the
          // mouth's history — recording words that were never heard corrupts its context.
          const cut = mindLine?.cut ?? -1;
          const spoken = cut >= 0 ? text.slice(0, cut) : text;
          if (mindLast) mindLast.cut = cut >= 0 ? cut : text.length;
          if (!closed) saveMindState(cut >= 0 ? "cut-by-user" : "done");   // LANE 15 (review fix 2): close() owns the record after call end
          mindLine = null;
          mindPlayer = null; mindBusy = false;
          try { unlinkSync(f); } catch {}
          // Record the line in the mouth's conversation so it KNOWS it was said (one
          // answer, no repeats) — safe now, because the mouth never renders this item.
          if (spoken.trim()) {
            try { ws.send(JSON.stringify({ type: "conversation.item.create", item: {
              type: "message", role: "assistant", content: [{ type: "output_text", text: spoken }] } })); } catch {}
          }
          // MOUTH FIRST (fire17, 2026-08-20: "עכשיו נראה שהפה לא עונה לי"): a user turn
          // whose auto-reply was cancelled only because MIND audio was on the air gets
          // its reply NOW, before any more MIND lines flow.
          // BELT (W38 verify): a hold may NEVER discharge into an empty room. The hold site now
          // excludes emptyRoom, but a stale flag set before this belt existed — or by any future
          // path — would speak to nobody here, where no cancel branch can re-judge it (the
          // response.create below carries awaitingResponse). Same predicate as `emptyRoom`
          // itself (`emptyRoomNow()`, one definition for all seven readers), so LEGACY is
          // byte-identical: an attended restart has a listener by definition — and so is
          // ANNOUNCE, which speaks first by design.
          // ROTATION DRAIN (W37 verify): a predecessor session may still be finishing its sentence
          // into the SHARED player. Releasing here would start a second voice in it, and clearing
          // the flag would leave his turn unanswered — the "הוא לא מגיב לי" class this file has
          // closed twice. So the hold is KEPT, and rotDrainRelease() fires it the instant the
          // predecessor's last word is out (≤ the drain window, never longer).
          if (pendingMouthReply && prevRespId) say("info", "mouth reply still held — the previous session is finishing its sentence (rotation drain)", { rotation: true, drain_hold: true });
          else {
          if (pendingMouthReply && !emptyRoomNow()
              && !suppressAuto && !closing && !responseActive && !awaitingResponse && ws.readyState === WebSocket.OPEN) {
            say("info", "mouth reply released (was held behind mind audio)");
            try { ws.send(JSON.stringify({ type: "response.create" })); awaitingResponse = true; } catch {}
          }
          pendingMouthReply = false;
          }
          flushInjectQueue();
        });
      }).catch(() => {
        // Narrator unreachable → legacy best-effort path: out-of-band verbatim instruction
        // on the mouth's own socket (may paraphrase — better than silence).
        mindBusy = false;
        if (closing || ws.readyState !== WebSocket.OPEN) return;
        // THE MARK OF THIS PATH. `pendingMindHistory` is set here and nowhere else, so from this
        // line until response.done it means "the reply now being generated is the MIND's line,
        // spoken through the mouth". The transcript handler reads it to classify the turn `mind`
        // instead of `mouth` — without it a rotation seed carries the MIND's framing to the
        // successor as something the mouth itself said (the 11776 self-contradiction).
        pendingMindHistory = text;
        silenceMouth();   // fallback path speaks THROUGH the mouth — still must not overlap its tail
        const verbatim = `Say the following to the user now, word for word, in the exact language it is written in. Do not translate, do not paraphrase, do not add or omit anything:\n${text}`;
        ws.send(JSON.stringify({ type: "response.create", response: { conversation: "none", instructions: verbatim } }));
        awaitingResponse = true;
      });
    };
    // Cancel + truncate the response in flight (shared shape with the speech_started barge).
    const bargeNow = () => {
      if (!responseActive) return;
      try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
      responseActive = false; awaitingResponse = false;
      if (curResponseId) { cancelledResponses.add(curResponseId); responsesCancelled++; sessResponsesCancelled++; }
      if (curItemId) {
        const heardMs = itemFirstDeltaAt ? Math.max(0, Math.min(Date.now() - itemFirstDeltaAt, itemQueuedMs)) : 0;
        try { ws.send(JSON.stringify({ type: "conversation.item.truncate", item_id: curItemId, content_index: 0, audio_end_ms: Math.round(heardMs) })); } catch {}
      }
      stopPlayer(); speaking = false; playingUntil = 0;
      // A voice barge also silences the MIND's narrator audio (it has its own player).
      if (mindPlayer) { if (mindLine) mindLine.cut = spokenChars(mindLine); try { mindPlayer.kill("SIGKILL"); } catch {} mindPlayer = null; mindBusy = false; }   // review fix 4: state file records the heard prefix, not the full line
    };
    // THE MOUTH IS SILENCED BY CODE WHENEVER THE MIND IS ABOUT TO SPEAK (fire17's law,
    // 2026-08-18: "כשהמוח מדבר זה חייב להשתיק מיידית מבחינת קוד את הפה" — and the MIND's voice
    // must never come over the mouth's). bargeNow() ALONE IS NOT ENOUGH: it early-returns when
    // !responseActive, but the mouth's AUDIO OUTLIVES ITS RESPONSE (audio arrives far faster than
    // it plays — see the playingUntil note above), so a MIND line starting just after response.done
    // used to play ON TOP of the mouth's tail. This kills the mouth's audio unconditionally, and
    // additionally cancels/truncates the response when one is still generating. No agent has to
    // know any of this — the code enforces it on every MIND utterance.
    const silenceMouth = () => {
      // ROTATION DRAIN (W37 verify). A draining predecessor writes its last deltas into the SAME
      // player, and it is not `responseActive` — the swap cleared that. Killing only the player
      // would cut his sentence AND let rotQuiesce respawn one underneath the MIND's voice (it
      // restarts a dead player on the next delta). The MIND's priority law is absolute, so the
      // mouth must END here, not race: dropping prevRespId makes every further predecessor delta
      // fall out of the drain handler, and the player dies once, for good.
      if (prevRespId) { prevRespId = null; speaking = false; rec({ ev: "info", rotation: true, text: "predecessor drain cut — the MIND is taking the floor", drain_cut: true }); }
      if (responseActive && !mindResponse) bargeNow();       // still generating: cancel + truncate + stop
      else { stopPlayer(); speaking = false; playingUntil = 0; }   // done generating, still AUDIBLE: kill the tail
    };
    /** THE DUPLEX MOUTH CUT — one body, two triggers.
     *  `vad`  the server's speech_started (today's path, unchanged in shape and in its guard).
     *  `vp`   the VPIO child's own barge event (DEFECT 2.2 / caps decision (a)). In duplex the
     *         frame-loop's mouth branch is `stillAudible() && !bargeOn` — false by construction —
     *         so with caps OFF nothing here ever ran: the frame was dropped at the mute gate, the
     *         server never heard him, speech_started never fired, and the mouth kept talking. His
     *         acceptance bar names that case explicitly (canon 059: "repeated (incl. caps-off)").
     *         The event drives the cut instead of a frame. It touches PLAYBACK and the model's own
     *         item only — response.cancel / conversation.item.truncate — and sends NO audio, so
     *         the absolute invariant (nothing gated ever reaches the model) is untouched.
     *  Both triggers run the SAME cancel + truncate + kill-tail + record + confirm belt. */
    function duplexMouthCut(src: "vad" | "vp") {
      if (responseActive) ws.send(JSON.stringify({ type: "response.cancel" }));
      responseActive = false; awaitingResponse = false;
      if (curResponseId) { cancelledResponses.add(curResponseId); responsesCancelled++; sessResponsesCancelled++; }
      if (curItemId) {
        const heardMs = itemFirstDeltaAt
          ? Math.max(0, Math.min(Date.now() - itemFirstDeltaAt, itemQueuedMs))
          : 0;
        ws.send(JSON.stringify({ type: "conversation.item.truncate", item_id: curItemId, content_index: 0, audio_end_ms: Math.round(heardMs) }));
      }
      stopPlayer();                 // no eager restart — the next reply's delta spawns fresh
      speaking = false;
      playingUntil = 0;
      lastMouthBargeAt = Date.now();
      // GAP 5.3 — SWALLOW THE KILL TAIL, in duplex too. ffplay's last ~40-100ms is still in the
      // air after the player dies, and the local cut deliberately holds the gate for
      // MOUTH_BARGE_TAIL so the server never transcribes OUR voice as HIS. The duplex path had
      // no such gate: `ducked()` returns false whenever bargeOn, so setting playingUntil alone
      // (the verdict's one-liner) would swallow nothing here. This is the same window, enforced
      // on the one path that had none — and it is a mic GATE, not a mute: every frame is still
      // archived above, so his opening words survive in full and reach the model through his
      // live turn the instant the tail expires.
      mouthBargeTailUntil = Date.now() + MOUTH_BARGE_TAIL;
      // ── G-A + G-B (wave-2 resume-design §2) ────────────────────────────────────
      // G-A: this duplex cut wrote NO mouthBarge record, so the three-way resume
      // assembly ("mouth-cut resume", the `mouthBarge && tScript` branch) could never
      // fire in the very mode barge exists for — all three pieces existed in the
      // process and none of them were ever joined. G-B: it also never trimmed
      // `mouthBuf`, so response.done fed rememberSpoken() and mouthLast a tail he
      // never heard, corrupting the echo corpus the belts judge his turns against.
      // Both are closed here with the SAME clock, the same word-boundary split and the
      // same round-DOWN bias the local mouth-barge uses ("mouth interrupted by user"),
      // so a word he never heard can never be recorded as spoken.
      {
        // DEFECT 6.4 — FRESHNESS. `vpEv` is set in onVpBarge and never cleared, so a cut driven
        // by the RAW server VAD minutes later used to stamp an ancient VP event's numbers into
        // this record and into the log line — and every future calibration reads those numbers.
        // A `vad` cut with no fresh event records zeros, which is honest; a `vp` cut always has
        // one by construction.
        const ev = vpFresh() ? vpEv : null;
        const played = itemFirstDeltaAt ? Date.now() - itemFirstDeltaAt : 0;
        const spinUp = Number(process.env.APIPLAN_MIND_START_MS) || 250;
        const heardMsRec = itemFirstDeltaAt ? Math.max(0, Math.min(played - spinUp, itemQueuedMs)) : 0;
        const said = mouthBuf.trim() || mouthLast;
        const full = Math.max(said.length, mouthChars);
        const dropped = full - said.length;                 // chars the 2000-char clamp dropped
        const rawFull = itemQueuedMs > 0 ? Math.round((heardMsRec / itemQueuedMs) * full) : 0;
        const raw = Math.max(0, Math.min(said.length, rawFull - dropped));
        const wb = said.lastIndexOf(" ", raw);
        const heardChars = wb > 0 ? wb : raw;
        mouthBuf = said.slice(0, heardChars);               // G-B — parity with the local cut
        const mbD = {
          at: Date.now(), heardMs: Math.round(heardMsRec), queuedMs: Math.round(itemQueuedMs),
          itemId: curItemId, responseId: curResponseId, cancelled: true,
          said, heard: said.slice(0, heardChars), remainder: said.slice(heardChars).trim(),
          peak: Math.round(ev?.peak ?? 0), sustainMs: Math.round(ev?.voiced_ms ?? 0),
          confirmed: null as boolean | null, consumed: false,
        };
        mouthBarge = mbD;                             // G-A — the resume can now fire in duplex
        say("info", `mouth interrupted by user (duplex, ${src === "vp" ? "VP barge event" : "server VAD"}) — cut at ${mbD.heardMs}ms of ${mbD.queuedMs}ms`
          + ` (${heardChars}/${full} chars${mbD.sustainMs ? `, ${mbD.sustainMs}ms voiced on the cleaned signal` : ""})`
          + (mbD.remainder ? ` — UNSPOKEN: ${mbD.remainder.slice(0, 160)}` : ""),
          { mouth_barge: true, duplex: true, trigger: src, heard_ms: mbD.heardMs, queued_ms: mbD.queuedMs,
            heard_chars: heardChars, chars: full, peak: mbD.peak || undefined,
            sustain_ms: mbD.sustainMs || undefined, item_id: curItemId });
        saveMindState(undefined, true);   // FORCED: a cut is the one thing that must survive a SIGKILL
        // SELF-DISARM (redteam S3). Same shape as the local cut's MOUTH_BARGE_CONFIRM belt:
        // a REAL cut is followed by his turn, by recovered audio, or by the resume consuming
        // the record. Two duplex cuts in a row that nothing follows means the server VAD is
        // cutting on OUR OWN voice — retreat to half-duplex, which brings its own mic gate,
        // local barge and overlap recovery, and say so loudly. One restart re-arms. The
        // streak counter is SHARED with the local belt on purpose: both count the same thing.
        if (MOUTH_BARGE_CONFIRM > 0) {
          const seenAt = speechStartedAt; const resendAt = lastResendAt;
          // CAPS-(a) SELF-CONFIRM (reverify A2.4): a muted-mic cut closes every confirmation
          // channel by construction — treating it as unconfirmed would disarm duplex on his
          // second caps-off barge. The mute state at cut time IS the confirmation.
          const mutedAtCut = micMuted;
          setTimeout(() => {
            if (closed || mbD.confirmed !== null) return;
            mbD.confirmed = mutedAtCut || mbD.consumed || speechStartedAt !== seenAt || lastResendAt !== resendAt;
            if (mbD.confirmed) { duplexUnconfirmed = 0; return; }
            if (++duplexUnconfirmed >= 2 && bargeOn) {
              bargeOn = false;
              // Retreating to half-duplex means ducked() starts dropping mic frames during every
              // mouth reply, so the SERVER can no longer hear him: the local detector is now the
              // only barge path there is. Re-arm it even if its own belt stood it down earlier in
              // this call (96642: it had), and clear the shared streak so the fresh path is not
              // judged on cuts made under the old regime.
              // REDTEAM (P1-C): the count is read for the log BEFORE it is cleared — zeroing it
              // first made every future duplex-disarm line report "0 unconfirmed cuts in a row".
              const streak = duplexUnconfirmed;
              mouthBargeArmed = true; mouthBargeUnconfirmed = 0; duplexUnconfirmed = 0;
              say("info", `duplex barge DISARMED for this call — ${streak} unconfirmed cuts in a row. Back to half-duplex (mic gate + local barge + recovery, all intact); restart to re-arm.`,
                { duplex_disarmed: true, unconfirmed: streak });
            } else say("info", `duplex cut UNCONFIRMED (${src}) — nothing of his followed it within ${MOUTH_BARGE_CONFIRM}ms; record discarded`,
              { mouth_barge_unconfirmed: true, duplex: true, trigger: src, heard_ms: mbD.heardMs });
            if (mouthBarge === mbD) mouthBarge = null;
          }, MOUTH_BARGE_CONFIRM);
        }
      }
    }
    // WIRE the event-driven half (DEFECT 2.2). Guards, all of them deliberate:
    //  * bargeOn — half-duplex already cuts through the frame branch, which carries the full
    //    existing record+resume+DISARM path; this exists only for the duplex hole.
    //  * mindBusy / mindResponse / mindPlayer — the MIND's own lines are owned by their own
    //    machinery (re-weave, verbatim); the local detector refuses them and so does this.
    //  * localBargeLive() / MOUTH_BARGE_PEAK>0 — the self-disarm belt and the operator's OFF
    //    switch must govern this path exactly as they govern the frame path.
    //    REDTEAM CORRECTION (2026-08-22): the claim that "with the mic ducked this path is one of
    //    the two ways he can still cut the mouth" is FALSE. vpMouthCut early-returns on !bargeOn
    //    (first line below), so this path is DEAD in half-duplex — exactly the state the floor
    //    exists for — and localBargeLive() here is just mouthBargeArmed. The cleaned-signal
    //    detector is the one leak-immune path there is, and after a duplex-BELT retreat the VP
    //    child is still alive (only vpRevert kills it). Letting the TAIL/cut branch run in
    //    half-duplex is the real second path; it is NOT done here because duplexMouthCut() would
    //    then race the frame-loop cut, and that needs a live trial, not a redteam's guess.
    //  * GRACE / TAIL / 1s refractory — the cut stays bound to the MOUTH's own timeline, which
    //    a VP event knows nothing about, and our own teardown can never re-trigger it.
    //  * the arming gate lives in aec.ts and is re-checked in onVpBarge before we ever get here.
    // CANON 065 (call 88608, his verbatim: "I still heard you speaking after I kept talking...
    // the mouth like double responded"): the original single-branch gate `!responseActive`
    // silently ate every barge landing in the AUDIBLE DRAIN TAIL — audio outlives its response
    // (silenceMouth's own comment names the same disease), so on a long utterance the local cut
    // never fired, the tail kept playing, and the server's fresh answer to his barge played OVER
    // it = his double-response. Two changes, per his order ("a very simple, clean fix"):
    //   1. TAIL BRANCH — generation done but still audible: kill the tail (stopPlayer is
    //      already SIGKILL + draining-set), same refractory + tail gate. No new detection,
    //      no FP surface: same armed events, convergence-arming untouched.
    //   2. OBSERVABILITY — call 88608 had ZERO log traces of 12 speaking turns' worth of
    //      events because every gate returned silently. Each drop now names its gate once
    //      per second, so the next trial diagnoses itself.
    let vpDropLogAt = 0;
    const vpDrop = (gate: string) => {
      const now = Date.now();
      if (now - vpDropLogAt < 1000) return;
      vpDropLogAt = now;
      say("info", `vp barge dropped at gate [${gate}] — peak ${Math.round(vpEv?.peak ?? 0)}, ${Math.round(vpEv?.voiced_ms ?? 0)}ms voiced`,
        { vp_barge_dropped: true, gate, peak: Math.round(vpEv?.peak ?? 0) });
    };
    vpMouthCut = () => {
      if (closed || !bargeOn) return;
      if (mindPlayer || mindBusy || mindResponse) return vpDrop("mind-owns-the-floor");
      if (MOUTH_BARGE_PEAK <= 0 || !localBargeLive()) return vpDrop("self-disarm-belt");
      const now = Date.now();
      if (now < mouthBargeTailUntil || now - lastMouthBargeAt <= 1000) return vpDrop("refractory");
      if (speaking && responseActive) {
        if (!stillAudible()) return vpDrop("not-audible");
        const played = itemFirstDeltaAt ? now - itemFirstDeltaAt : 0;
        if (played < MOUTH_BARGE_GRACE) return vpDrop("grace");
        if (played > itemQueuedMs + MOUTH_BARGE_TAIL) return vpDrop("item-clock-expired");
        say("info", `mouth cut by VP barge${micMuted ? " while the mic is MUTED (caps off — his voice still stops the mouth; nothing he said was sent)" : ""} — peak ${Math.round(vpEv?.peak ?? 0)}, ${Math.round(vpEv?.voiced_ms ?? 0)}ms voiced on the cleaned signal`,
          { vp_mouth_cut: true, muted: micMuted || undefined, peak: Math.round(vpEv?.peak ?? 0), voiced_ms: Math.round(vpEv?.voiced_ms ?? 0) });
        duplexMouthCut("vp");
        return;
      }
      // TAIL BRANCH: nothing generating, but the speaker is still playing queued audio (live
      // player or draining hand-offs). His voice must stop it NOW — this was the leak he heard.
      if (!(stillAudible() || draining.size)) return vpDrop("silent");
      say("info", `mouth TAIL cut by VP barge — audio had outlived its response (canon 065); peak ${Math.round(vpEv?.peak ?? 0)}, ${Math.round(vpEv?.voiced_ms ?? 0)}ms voiced`,
        { vp_mouth_cut: true, tail: true, peak: Math.round(vpEv?.peak ?? 0), voiced_ms: Math.round(vpEv?.voiced_ms ?? 0) });
      stopPlayer(); speaking = false; playingUntil = 0;
      lastMouthBargeAt = now;
      mouthBargeTailUntil = now + MOUTH_BARGE_TAIL;
    };
    const injectContext = (text: string, mode: string, who?: string) => {
      // No chunking needed anymore: the MIND's narrator voice reads the whole text verbatim
      // by construction (the chunk-splitting workaround existed only because the mouth's
      // model summarized long instruction-driven lines).
      // MIND PRIORITY — code-enforced handoff (fire17's law, 2026-08-18, reconfirmed in
      // Hebrew: "כשהמוח מדבר זה חייב להשתיק מיידית מבחינת קוד את הפה"): interrupt mode cuts
      // the mouth NOW; graceful lets the current sentence land — and either way the moment
      // the MIND's audio is ready, sendInjected barges any mouth reply still on the air.
      // No agent has to know any of this; the code does it.
      // THE STACK LAW (fire17, voice, 2026-08-20: "אם אתה רואה שאני מקליט, אל תתפרץ אליי
      // בזמן דיבור... תשמור את הדברים שיש לך להגיד לי במחסנית"): while the human is
      // mid-turn, the MIND NEVER barges — any mode. Lines are HELD in the queue and the
      // hold is echoed, so the watching MIND can re-weave them against what he just said
      // ({"drop_queue":true} + one fresh line). Enforced here so it works from any
      // session — nobody has to remember. 120s failsafe in case speech_stopped is lost.
      // STALE-QUEUE AUTO-REPLACE (fire17, voice, 2026-08-20: "שזה לא משהו שהוא צריך לזכור
      // אלא חלק מהפלואו והמערכת של המחסנית משלבת את ההודעות האלה ביחד"): a fresh MIND line
      // arriving over stale lines REPLACES them by construction — the MIND sends its one
      // merged line and pileup is impossible; no drop_queue ritual needed ({"drop_queue"}
      // stays for manual control). Live evidence for the law: on call 22157 lines went
      // HELD→STALE repeatedly and nothing ever spoke.
      if (queueStale && injectQueue.length) {
        say("info", `stale queue auto-replaced (${injectQueue.length}) by fresh line`);
        injectQueue.length = 0;
        // PRE-RELAUNCH AUDIT 2026-08-22 (P1). The waited-notice describes the LINE that waited.
        // The line just died; the flag must die with it, or the next unrelated MIND line opens
        // with an apology for a wait that never happened — spoken, verbatim, in his ear.
        queueHeldForHim = false;
      }
      queueStale = false;   // a new inject IS the re-weave — it releases the stale hold
      if (xconvHeld()) {
        // CANON 045: a conversation he is having with someone else outranks anything the MIND
        // has to say, exactly as his own turn does. Queued, never dropped; `queueHeldForHim` is
        // deliberately NOT set — the "I wanted to say this earlier but you were speaking"
        // opener would be a lie about a turn that was never addressed to us.
        injectQueue.push({ text, who });
        say("info", `mind line HELD (external conversation — canon 045) — queue ${injectQueue.length}`);
        if (injectQueue.length > 1) say("info", `mind queue MERGE (${injectQueue.length} held) — weave into one`);
        return;
      }
      if (userSpeaking && Date.now() - speechStartedAt < 120000) {
        injectQueue.push({ text, who });
        queueHeldForHim = true;   // mind-never-interrupts: this line waited out his speech — it will open with the waited-notice
        say("info", `mind line HELD (user speaking) — queue ${injectQueue.length}`);
        // QUEUE MERGE LAW (fire17, voice, 2026-08-20: "כמה הודעות במקביל נכנסות למחסנית
        // במקום להתעדכן... זה צריך להיות הודעה אחת"): the queue must never grow past one —
        // this echo (once per growth) tells the watching MIND to {"drop_queue"} + weave
        // everything held into ONE fresh line.
        if (injectQueue.length > 1) say("info", `mind queue MERGE (${injectQueue.length} held) — weave into one`);
        return;
      }
      if (mode === "interrupt" && (responseActive || awaitingResponse)) bargeNow();
      // Same one-active guard as the queue flush: while a predecessor is finishing its sentence
      // the floor is not free, so a fresh MIND line QUEUES (≤ the drain window) instead of
      // speaking over the tail of the old voice.
      if (!responseActive && !awaitingResponse && !mindBusy && !prevRespId) { sendInjected(text, who); return; }
      injectQueue.push({ text, who });
      if (injectQueue.length > 1) say("info", `mind queue MERGE (${injectQueue.length} held) — weave into one`);   // queue-merge law: one woven line, never a stack
    };
    // Send at most ONE per call: sendInjected sets awaitingResponse, so the loop stops after one
    // and the next item waits for that response's response.done — the queue stays serialized and
    // ordered instead of firing every item at once (which the server would reject all-but-first).
    // SUSTAINED-SILENCE GATE (fire17, voice, 2026-08-20: the 1.2s flush caught him
    // mid-pause and the MIND talked over him): held lines flow only after ~2.5s of
    // continuous quiet — a short breath is NOT the end of his turn. If blocked, one
    // timer self-reschedules until the quiet arrives; caps state is irrelevant here.
    // STALE-QUEUE RE-WEAVE (fire17, voice, 2026-08-20: "היא משתגרת מהר מדי... בלי
    // שהמוח מנתח את מה שאמרתי עכשיו"): once a NEW user turn completes while lines sit
    // in the queue, those lines are STALE — they never auto-flush. Only {"drop_queue"}
    // (MIND re-weaves and sends fresh) or a new inject releases the hold.
    let queueStale = false;
    // MIND-NEVER-INTERRUPTS (fire17, voice 2026-08-21, call 96642: "תוודא שמה שהמוח רוצה
    // להגיד לי בעצם נדחף לתור, לאחרי שגם הפה יענה לי על הדבר האחרון שסיימתי להגיד...
    // ובחיים המוח לא יוכל לקטע אותי"): after a real turn of his, held MIND lines wait
    // until SOMETHING answered him (a mouth response created for that turn, or the MIND's
    // own voice) — not just until he stops talking. 20s failsafe so a mouth that never
    // answers cannot dam the MIND forever. And a line that waited out his speech opens
    // with a waited-notice, per his exact spec ("אה רציתי להגיד לך קודם אבל היית תוך כדי
    // דיבור") — added here in code so no MIND session has to remember it.
    let lastRealTurnAt = 0, lastRealTurnStart = 0, queueHeldForHim = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushInjectQueue = () => {
      flushTimer = null;
      if (queueStale) return;
      if (xconvHeld()) {   // canon 045 — retried, so the release needs no extra wiring
        if (injectQueue.length && !flushTimer) flushTimer = setTimeout(flushInjectQueue, 1000);
        return;
      }
      if (userSpeaking || Date.now() - lastSpeechStopAt < 2500) {
        if (injectQueue.length && !flushTimer) flushTimer = setTimeout(flushInjectQueue, 1000);
        return;
      }
      // PRE-RELAUNCH AUDIT 2026-08-22 (P1). "Wait for the mouth to answer him first" is only
      // meaningful when a mouth answer is POSSIBLE. With the mouth CLOSED (suppressAuto), or in
      // MOUTHPIECE mode (LM_MOUTHPIECE=1 -> APIPLAN_VAD_CREATE_RESPONSE=0, where the server never
      // creates a reply at all), lastResponseCreatedAt can never advance for his turn — so EVERY
      // MIND line waits the full 20s failsafe after EVERY turn of his, in exactly the mode where
      // the MIND is the only voice he has. Skip the wait when nothing can satisfy it.
      const mouthCanAnswer = !suppressAuto && process.env.APIPLAN_VAD_CREATE_RESPONSE !== "0";
      if (mouthCanAnswer && lastRealTurnAt > 0 && lastResponseCreatedAt < lastRealTurnStart && lastMindSpokeAt < lastRealTurnAt
          && Date.now() - lastRealTurnAt < 20000) {   // his last turn not yet answered — mouth speaks first
        if (injectQueue.length && !flushTimer) flushTimer = setTimeout(flushInjectQueue, 1000);
        return;
      }
      // `prevRespId` — the ONE-ACTIVE INVARIANT ACROSS A ROTATION (W37 verify). A predecessor
      // finishing its sentence is still audible in the shared player, and the swap force-clears
      // responseActive/awaitingResponse, so without this term a held line would flush into the
      // successor while the old voice is still speaking: two voices, one player, interleaved PCM.
      // Held, not dropped — rotDrainRelease() calls this again the moment the drain ends.
      while (injectQueue.length && !responseActive && !awaitingResponse && !mindBusy && !prevRespId) {
        const q = injectQueue.shift()!;
        let t = q.text;
        if (queueHeldForHim) { t = "I wanted to say this earlier but you were speaking. " + t; queueHeldForHim = false; }
        sendInjected(t, q.who);
      }
    };
    function startInjectLoop() {
      if (!injectPath) return;
      try { injectOff = Bun.file(injectPath).size || 0; } catch { injectOff = 0; }  // ignore pre-existing lines
      const tick = async () => {
        if (closed) return;
        try {
          const f = Bun.file(injectPath);
          if (await f.exists()) {
            const size = f.size;
            if (injectOff > size) injectOff = 0;              // file replaced/truncated
            if (size > injectOff) {
              const chunk = await f.slice(injectOff, size).text();
              const cut = chunk.lastIndexOf("\n");
              if (cut >= 0) {
                injectOff += Buffer.byteLength(chunk.slice(0, cut + 1), "utf8");
                for (const ln of chunk.slice(0, cut).split("\n")) {
                  const s = ln.trim(); if (!s) continue;
                  try {
                    const j = JSON.parse(s);
                    if (j.session) {           // live persona/context swap — no reconnect
                      if (!closed && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "session.update", session: { type: "realtime", instructions: String(j.session) } }));
                        // FRESH PERSONA: remember what is now in force. Without this the swap lives
                        // only on this socket and the next rotation reverts to the launch text.
                        livePersona = String(j.session); personaAt = Date.now(); personaSrc = "mind";
                        say("info", "persona updated live");
                      }
                    } else if (typeof j.mute === "boolean") {   // mic mute toggle — stop/resume sending mic audio to the model
                      // lm-ptt re-asserts the same state every 5s (heartbeat) — roll and echo
                      // only on a real CHANGE, or the archive fragments into 5s slivers.
                      if (micMuted !== j.mute) {
                        micMuted = j.mute;
                        archRoll(micMuted ? "mute flip" : "unmute flip");
                        say("info", micMuted ? "mic muted" : "mic unmuted");
                        // Stuck-latch fix (call 86130: speech_started then mic muted
                        // mid-speech → the server never sends speech_stopped → userSpeaking
                        // stayed true and held the MIND queue for 40s+). A mute IS the end
                        // of the audible turn — synthesize the stop.
                        if (micMuted && userSpeaking) {
                          userSpeaking = false;
                          latchTimedOut = false; latchVoiceMs = 0; latchHadVoice = false;
                          lastSpeechStopAt = Date.now();
                          if (speechStartedAt) lastSpeechMs = Date.now() - speechStartedAt;
                          if (injectQueue.length) setTimeout(flushInjectQueue, 2600);
                        }
                      }
                    } else if (typeof j.autospeak === "boolean") {   // MIND's mouth switch — may the model answer on its own?
                      suppressRestoreAt = 0;                          // MIND's explicit choice outranks a pending overlap-recovery restore
                      suppressAuto = !j.autospeak;
                      say("info", j.autospeak ? "mouth OPEN (auto-speak on)" : "mouth CLOSED (MIND-only)");
                    } else if (typeof j.pause === "boolean" || j.resume === true) {
                      // CANON 013/014 (fire17, typed): mechanistic pause of every audible agent
                      // voice — mouth stream, draining tails, MIND narrator — via SIGSTOP/SIGCONT.
                      // {"pause":true} holds, {"pause":false} or {"resume":true} releases. The ESC
                      // key (lm-ptt) writes exactly these lines.
                      const hold = j.pause === true;
                      if (hold) pauseAll(); else resumeAll();
                      say("info", hold ? "playback paused (mechanistic hold — ESC/resume releases)" : "playback resumed");
                    } else if (j.ping) {   // no-op probe: proves the inject channel is being read, with zero side effects
                      say("info", "pong");
                    } else if (j.context) {
                      // SILENT context preload (fire17's design, 2026-08-18): push state into the
                      // conversation as a system note WITHOUT triggering any speech — the model's
                      // very next answer already knows it, before the human even asks. This is how
                      // the MIND keeps the mouth in sync continuously, not just at launch.
                      ws.send(JSON.stringify({ type: "conversation.item.create", item: {
                        type: "message", role: "system",
                        // E415 — THE IDENTITY BOUNDARY RIDES EVERY PRELOAD, BY CONSTRUCTION.
                        // 2026-08-22 ~03:14 the mouth recited MIND-internal detail as if it were
                        // the mind, and he stopped the call to correct it: "you are the mouth, not
                        // the mind". The mechanism is structural, not a wording slip — the MIND
                        // pushes its knowledge in here, and nothing in the frame said whose
                        // knowledge it is. "Mind here —" marks the MIND's own SPOKEN lines; there
                        // was no equivalent mark on mind-supplied content the mouth speaks in its
                        // own name. Per his rule 1 the fix belongs in the engine, so the boundary
                        // is welded to the frame and no preload the MIND writes can omit it.
                        content: [{ type: "input_text", text: `[Live state update from the MIND — absorb silently, do not mention or respond to this. You are the MOUTH. What follows is the MIND's knowledge handed to you as background: it is never your own work and never your identity. If he asks who you are, you are the mouth; if he asks who did this work, the MIND or the organs did it, not you]: ${String(j.context)}` }] } }));
                      say("info", "context preloaded (silent)");
                    } else if (j.drop_queue) {   // MIND re-weave: discard held/unspoken lines before sending a fresh one
                      say("info", `queue dropped (${injectQueue.length} lines)`);
                      injectQueue.length = 0;
                      queueStale = false;
                      queueHeldForHim = false;   // audit P1: the notice belongs to the dropped line
                    } else if (typeof j.audio === "string") {   // resend a recording as live speech
                      resendAudio(j.audio);
                    } else if (j.text) injectContext(String(j.text), String(j.mode || "graceful"), j.who ? String(j.who) : undefined);
                  } catch {}
                }
              }
            }
          }
        } catch {}
        // CANON 044 WATCHDOG — his live complaint was "לפעמים הוא לא עונה באופן עקבי", and every
        // hold in this file is a promise to speak LATER. A promise nobody keeps is indistinguishable
        // from a mute, so one is force-kept here rather than waiting for the path that parked it.
        // PRE-RELAUNCH AUDIT 2026-08-22 (P0). This watchdog exists for a hold nobody is keeping.
        // A hold an ACTIVE gate is still asserting is not that: the organ floor and the
        // external-conversation hold are LIVE promises with their own release paths, and firing
        // here overrides them. Not theoretical — ears/xconv.py holds for up to XCONV_MAX_HOLD_MS
        // (180000) against this file's HOLD_MAX_MS (12000), and the response created below
        // carries awaitingResponse=true, the exact flag that makes response.created SKIP the
        // `xconv`/`organFloor` cancel gate. Without this term the mouth speaks into the
        // conversation he is having with someone else in the room 12s in — canon 045's own
        // complaint ("פתאום האייג'נטים מתחילים לדבר ופותים אותי"). The clock is RESTARTED, never
        // consumed, so the watchdog still catches the unexplained holds it was written for the
        // moment the gate lets go.
        if (pendingMouthReply && pendingMouthAt && Date.now() - pendingMouthAt > HOLD_MAX_MS
            && (Date.now() < organFloorUntil || xconvHeld())) {
          pendingMouthAt = Date.now();
        } else if (pendingMouthReply && pendingMouthAt && Date.now() - pendingMouthAt > HOLD_MAX_MS) {
          const heldFor = Math.round((Date.now() - pendingMouthAt) / 1000);
          pendingMouthAt = 0;
          if (!mindBusy && !mindPlayer && !suppressAuto && !closing && !responseActive && !awaitingResponse
              && !emptyRoomNow() && ws.readyState === WebSocket.OPEN) {
            say("info", `mouth reply force-released after ${heldFor}s held — a hold that long is a mute (canon 044)`, { forced_release: true, held_s: heldFor });
            try { ws.send(JSON.stringify({ type: "response.create" })); awaitingResponse = true; pendingMouthReply = false; } catch {}
          } else {
            say("info", `mouth reply DROPPED after ${heldFor}s held — the room moved on (canon 044)`, { forced_drop: true, held_s: heldFor });
            pendingMouthReply = false;
          }
        }
        // A CLOSED MOUTH IS NEVER INVISIBLE (canon 044). Whoever closed it — the MIND, the model
        // itself, an overlap suppress — it says so once a minute, with the elapsed time, so
        // "the mouth went quiet" is always answerable from the log instead of guessed at.
        if (suppressAuto) {
          if (!mutedSinceAt) mutedSinceAt = Date.now();
          if (Date.now() - lastMutedNoteAt > 60000) {
            lastMutedNoteAt = Date.now();
            // NOT "mouth ..." — PRE-RELAUNCH AUDIT 2026-08-22 (P0). lm-calls reads ACTIVE/PARKED
            // from the LAST `"text":"mouth [A-Z]*` in the log; a line starting `mouth still`
            // matches with an EMPTY capture, so this heartbeat silently flipped every PARKED
            // call back to ACTIVE 60s after it was parked (proved: grep -ao yields `"text":"mouth `).
            // Two ACTIVE calls breaks the one-ACTIVE-call invariant the MIND parks by.
            say("info", `mouth-closed heartbeat — CLOSED for ${Math.round((Date.now() - mutedSinceAt) / 1000)}s (nothing it hears will be answered until it is reopened)`, { mouth_closed_s: Math.round((Date.now() - mutedSinceAt) / 1000) });
          }
        } else { mutedSinceAt = 0; lastMutedNoteAt = 0; }
        // THE ORGAN FLOOR, read on the tick that already runs (canon 029) — no new timer.
        try {
          const held = organFloorUntil > Date.now();
          const f = Bun.file(FLOOR_FILE);
          if (await f.exists()) {
            const j = JSON.parse(await f.text());
            // CANON 044 — HIS BASELINE IS AN OPEN MOUTH. A claim is a promise about audio that
            // is playing RIGHT NOW, so one reaching minutes into the future is a bug or a dead
            // writer, and honouring it would hold the mouth shut exactly the way he is
            // complaining about. Cap it: the worst a broken claim can do is 30 seconds.
            // PRE-RELAUNCH AUDIT 2026-08-22 (P2). Clamping to now+FLOOR_MAX_MS is recomputed on
            // EVERY 150ms tick, so a stale claim with a far-future `until` renews its own 30s
            // window forever and the mic stays gated for the life of the call (proved in a
            // harness: 400 ticks later, headroom still 30000ms). A claim reaching past the cap
            // is a dead or broken writer, so IGNORE it rather than honour a rolling version of
            // it. Live producers (eva-voiced claim_floor) lease 1500ms and are unaffected.
            const rawUntil = Number(j?.until) || 0;
            if (rawUntil > Date.now() + FLOOR_MAX_MS) {
              if (Date.now() - floorBogusAt > 30000) {
                floorBogusAt = Date.now();
                say("info", `floor claim IGNORED — ${j?.who || "organ"} asked for ${Math.round((rawUntil - Date.now()) / 1000)}s, past the ${FLOOR_MAX_MS / 1000}s cap; a claim is about audio playing right now (canon 044)`, { floor_ignored: String(j?.who || "organ") });
              }
            } else
            if (rawUntil > Date.now() && !INTERRUPT_OK.has(String(j?.who || ""))) {
              const until = rawUntil;
              if (!held) say("info", `floor taken by ${j.who} — mic gated, mouth queues behind it`, { floor: String(j.who) });
              organFloorUntil = until; organFloorWho = String(j?.who || "organ");
            }
          }
          // CANON 045 read on the same tick, capped by the same canon-044 rule: a claim reaching
          // far into the future is a bug, and honouring it would be the mute he complains about.
          // (Audit P2: this read has its OWN try — a throw in the floor read above must never
          // take the xconv read and the two release paths down with it for every tick after.)
          try {
            const xf = Bun.file(XCONV_FILE);
            if (await xf.exists()) {
              const xj = JSON.parse(await xf.text());
              const xu = Math.min(Number(xj?.until) || 0, Date.now() + FLOOR_MAX_MS);
              if (xj?.active && xu > Date.now()) {
                if (!xconvHeld()) {
                  xconvSince = Date.now();
                  say("info", "external conversation in the room — voices HOLD (canon 045)", { external_conversation: true });
                }
                xconvUntil = xu;
              } else if (xconvSince) {
                // CANON 097 (his order, ask-pill 2026-08-23 02:04:11): "אם אחד המשפטים או
                // סייפאורדים נאמרת אז חוזרים למצב רגיל" — a spoken release phrase takes the hold
                // down at the producer (ears/xconv.py release_by_phrase). This branch honours a
                // producer that released ITS OWN hold — a phrase, caps-on, or the hard cap — on
                // THIS tick, instead of waiting out a lease we were handed before it changed its
                // mind (up to 1.5s of his voice still being held for nothing). Release-only: it
                // can never extend a hold, and an unreadable file still throws to the catch below
                // where the lease expires on its own (canon 045: every reader fails OPEN).
                xconvUntil = 0;
              }
            }
          } catch {}
          if (xconvSince && !xconvHeld()) {
            // The room is his again. Everything parked ONLY because of it flows now — held,
            // never dropped, the same contract the organ floor keeps.
            say("info", `external conversation ended after ${Math.round((Date.now() - xconvSince) / 1000)}s — voices released (canon 045)`, { external_conversation: false });
            xconvSince = 0;
            // THE ONLY PLACE A CLOSE IS OBSERVABLE (E606). This branch is reached by every
            // release path there is — lease expiry, the producer's own release (phrase, caps-on,
            // hard cap) and a vanished file — so the ring sees every window this call witnessed.
            xconvCloses.push(Date.now()); if (xconvCloses.length > XCONV_RING) xconvCloses.shift();
            if (injectQueue.length) setTimeout(flushInjectQueue, 0);
            // `!prevRespId` — PRE-RELAUNCH AUDIT 2026-08-22 (P1). The canonical release path
            // (mouth reply released — was held behind mind audio) holds on a rotation drain
            // because the predecessor socket is still finishing its sentence in the SHARED
            // player; releasing there starts a second voice in it. These two release sites were
            // added without that term. Calls run past the 3600s socket cap, so it is reachable.
            if (pendingMouthReply && !mindBusy && !mindPlayer && !prevRespId && !suppressAuto && !closing && !responseActive
                && !awaitingResponse && ws.readyState === WebSocket.OPEN) {
              say("info", "mouth reply released (was queued behind an external conversation)");
              try { ws.send(JSON.stringify({ type: "response.create" })); awaitingResponse = true; pendingMouthReply = false; } catch {}
            }
          }
          if (held && organFloorUntil <= Date.now()) {
            // The organ finished. Anything parked ONLY because it would have talked over that
            // organ flows now — held, never dropped ("במקום להצטרף לקיו ולהגיד דברים אחריה").
            say("info", `floor released by ${organFloorWho} — mouth may speak`, { floor_released: organFloorWho });
            organFloorWho = "";
            if (pendingMouthReply && !mindBusy && !mindPlayer && !prevRespId && !emptyRoomNow()
                && !suppressAuto && !closing && !responseActive && !awaitingResponse && ws.readyState === WebSocket.OPEN) {
              say("info", "mouth reply released (was queued behind organ audio)");
              try { ws.send(JSON.stringify({ type: "response.create" })); awaitingResponse = true; pendingMouthReply = false; } catch {}
            }
            if (injectQueue.length) setTimeout(flushInjectQueue, 0);
          }
        } catch {}
        if (!closed) setTimeout(tick, 150);
      };
      setTimeout(tick, 150);
    }

    // ── RESPONSE-LIFECYCLE ACCOUNTING (live defect, call 11776) ─────────────────────────────
    // The outage ran two minutes in silence because every reply-gating line this engine prints
    // lives INSIDE `case "response.created"`: when the server creates nothing there is nothing to
    // cancel, nothing stillborn and nothing to say, so a mouth that hears him perfectly and never
    // answers reads exactly like a quiet room. These counters are the counter-proof (a 0/0/N triple
    // IS the outage), and the watch below is the one instrument here that is CAUSE-AGNOSTIC: it
    // fires whether the silence came from a stuck create_response, a persona, a gate, or a seam.
    let responsesCreated = 0, responsesCancelled = 0, turnsTranscribed = 0, unansweredStreak = 0, responsesEmpty = 0;
    // The SAME four numbers for the CURRENT session only, reset at every swap (rotCommit). The
    // 0/0/N outage signature is a per-SESSION fact: read off the cumulative counters it survives
    // only as a delta between two rotation lines, i.e. nobody reads it. Both are reported.
    let sessResponsesCreated = 0, sessResponsesCancelled = 0, sessTurnsTranscribed = 0, sessResponsesEmpty = 0;
    // WHEN the server last created a response — not HOW MANY. A count snapshotted when his turn is
    // TRANSCRIBED is already too late to mean anything: on every one of the 24 calls in the corpus
    // `response.created` precedes `conversation.item.input_audio_transcription.completed` for the
    // same turn, so the snapshot always contained this turn's own answer and the watch measured
    // "did a SECOND response appear" — which is nearly never, hence a ~62% false-positive rate.
    // A timestamp compared against the turn's OWN start asks the real question instead.
    let lastResponseCreatedAt = 0;
    const ANSWER_WATCH_MS = Number(process.env.APIPLAN_ANSWER_WATCH_MS) || 2500;
    /** Exclusions are RECORDED, not silent — one line per reason per window. A bare `return` made
     *  the one cause-agnostic instrument indistinguishable from an instrument that never armed,
     *  and `suppress_auto` stuck true across a seam is itself a failure hypothesis. */
    const skipAt: Record<string, number> = {};
    const SKIP_THROTTLE_MS = Number(process.env.APIPLAN_ANSWER_SKIP_THROTTLE_MS) || 30000;
    /** His turn was transcribed — did ANYTHING answer it? Armed per genuine turn; pure record when
     *  rotation is off (off-mode purity: not one new line in the turn stream). Every legitimate
     *  silence is excluded first, so a line here means the mouth really did go deaf to him.
     *  `turnStart` is when HIS speech began; any response created at or after it is this turn's. */
    const watchAnswer = (turnAt: number, turnStart: number) => {
      setTimeout(() => {
        if (closed || closing) return;
        const skip = (reason: string) => {
          const now = Date.now();
          if (now - (skipAt[reason] ?? 0) < SKIP_THROTTLE_MS) return;
          skipAt[reason] = now;
          rec({ ev: "info", unanswered_skipped: true, reason, rot_n: rotN,
            responses_created: responsesCreated, responses_cancelled: responsesCancelled,
            responses_empty: responsesEmpty, turns_transcribed: turnsTranscribed,
            text: `answer watch armed and excluded (${reason}) — ${((now - turnAt) / 1000).toFixed(1)}s after his turn was transcribed` });
        };
        if (lastResponseCreatedAt >= turnStart) return skip("answered");   // a response was created FOR THIS TURN
        // DELIBERATE silences, not outages: the MIND holding the mouth shut ({"autospeak":false}),
        // or mouthpiece mode, where the MIND is the voice for the whole call by configuration.
        if (suppressAuto) return skip("suppress_auto");
        if (process.env.APIPLAN_VAD_CREATE_RESPONSE === "0") return skip("vad_cr_0");
        if (lastMindSpokeAt > turnAt) return skip("mind_answered");        // the MIND's voice answered him
        // Something IS already on its way to him: a reply in flight, a MIND line playing or queued,
        // audio still leaving the speaker, or a mouth reply held by a gate whose own release path
        // still owes him the answer. `speaking` is in here because audio outlives response.done.
        if (responseActive || awaitingResponse || mindBusy || mindPlayer || speaking || pendingMouthReply || injectQueue.length) return skip("in_flight");
        unansweredStreak++;
        const line = `turn ANSWERED BY NOBODY — ${((Date.now() - turnAt) / 1000).toFixed(1)}s after his turn was transcribed, no response had been created for it (streak ${unansweredStreak}; created ${responsesCreated}, cancelled ${responsesCancelled}, empty ${responsesEmpty}, turns ${turnsTranscribed}, rotations ${rotN})`;
        const extra = { unanswered_turn: true, streak: unansweredStreak, responses_created: responsesCreated,
          responses_cancelled: responsesCancelled, responses_empty: responsesEmpty,
          turns_transcribed: turnsTranscribed, rot_n: rotN };
        if (ROT_ON) say("info", line, extra); else rec({ ...extra, ev: "info", text: line });
      }, ANSWER_WATCH_MS);
    };

    // ─── ROTATION ENGINE (design, invariants and rollback ladder: see the block above close) ───
    let succOpenedAt = 0;                    // when the successor socket was created
    let succQuietAt = 0;                     // when it last acknowledged something we asked for
    let succUpdN = 0;                        // session.updated events it has acknowledged
    let succUnparkSeq = -1;                  // succUpdN at the moment the un-park was sent
    let succUnparkAt = 0;
    let succT0 = 0;                          // the successor's OWN cap clock (its session.created)
    let succExpiresAt = 0;
    let succCrResent = false;                // one-shot: corrective cr resend fired for THIS successor
    let succRetryAt = 0;                     // backoff gate after a failed pre-open
    let succTries = 0;
    let rotOpenAt = 0;                       // when a successor was last opened (takeover detector)
    let prevRespId: string | null = null;    // the ONE response the predecessor may finish speaking
    let prevUntil = 0;                       // its drain deadline
    let prevHoldUntil = 0;                   // and how long the socket stays OPEN after it, for R3
    let prevSpanning = false;                // the swap cut through an OPEN user turn
    let prevT0 = 0;                          // the predecessor's own cap clock — kept so R3 can go back
    let prevExpires = 0;
    let rotSwapAt = 0;                       // when the last swap happened (the R3 window)
    const prevTail: string[] = [];           // his words that landed on the predecessor AFTER the swap

    /** True while a handover is possible at all — a non-OPEN socket must not kill the mic pump
     *  while rotation can still produce a live one. Fails safe: close() sets rotState "done". */
    const rotHold = () => ROT_ON && !closed && rotState !== "done";
    /** The moment we MUST swap by. A server-stated expires_at may only ever TIGHTEN this: a field
     *  we have never once observed on this endpoint must not be able to EXTEND our exposure. */
    const rotFloorAt = () => {
      const base = sessT0 + ROT_FLOOR_MS;
      return sessExpiresAt > 0 ? Math.min(base, sessExpiresAt - ROT_EXP_MARGIN_MS) : base;
    };
    /** A quiet, relevant moment — his own words for the trigger. Every clause is an existing gate
     *  of this engine, reused rather than reinvented: nobody is speaking, nothing is generating,
     *  nothing is audible, nothing is held, and the room has been silent for the same 2.5s the
     *  MIND's own stack gate demands before it may speak. */
    const rotQuiet = () =>
      !userSpeaking && !latchTimedOut && !responseActive && !awaitingResponse && !mindBusy
      && !mindPlayer && !speaking && !stillAudible() && !recovering && !rotResending && !closing
      && injectQueue.length === 0 && Date.now() - lastSpeechStopAt >= ROT_QUIET_MS;

    const rotBackoff = () => { succTries++; succRetryAt = Date.now() + Math.min(15000, 2000 * 2 ** Math.min(3, succTries - 1)); };
    /** R1 — the successor failed. The LIVE call is never touched by this path. */
    const rotDrop = (why: string) => {
      const s = succ; succ = null;
      if (s) { try { s.onmessage = null; s.onclose = null; s.onerror = null; } catch {} try { s.close(); } catch {} }
      rotBackoff();
      rotState = "armed";
      say("info", `rotation: successor dropped (${why}) — retrying in ${Math.round((succRetryAt - Date.now()) / 1000)}s; the live session is untouched`,
        { rotation: true, rot_drop: why, rot_tries: succTries });
    };

    /** S1 — PRE-OPEN, parked. The socket is born deaf (nothing ever appends to it) and silent
     *  (create_response:false, no idle_timeout_ms). If this promotion ever happens before the
     *  socket opens (the takeover path), its onopen sends the LIVE config instead — `s === succ`
     *  is exactly the question "is this still the parked one". */
    const rotOpen = () => {
      if (succ || closed) return;
      let s: WebSocket;
      try { s = openRealtime(openai.creds().token, model); }   // fresh creds: the OAuth token may have been refreshed mid-call
      catch (e: any) {
        rotBackoff();
        say("info", `rotation: cannot open a successor — ${String(e?.message ?? e).slice(0, 160)}`, { rotation: true, rot_open_failed: true });
        return;
      }
      succ = s; succOpenedAt = rotOpenAt = Date.now(); succQuietAt = 0; succUpdN = 0;
      succUnparkSeq = -1; succUnparkAt = 0; succT0 = 0; succExpiresAt = 0; succCrResent = false;
      rotState = "opening";
      // FRESH PERSONA at birth too: `livePersona` is the launch text until the MIND swaps it, and
      // whatever it is now is what the successor is configured with — never a persona from before.
      s.onopen = () => { try { s.send(JSON.stringify({ type: "session.update", session: sessionBody(s === succ ? parkedInput : audioInput, livePersona || undefined) })); } catch {} };
      s.onmessage = (e: any) => rotParked(s, e);
      s.onerror = () => { if (s === succ) rotDrop("connection failed"); };
      s.onclose = (e: any) => { if (s === succ) rotDrop(`closed (${e?.code ?? "?"})`); };
      say("info", `rotation: opening the successor session — PARKED (deaf and silent)${rotGap ? " to replace the session that just ended" : ` at ${Math.round((Date.now() - sessT0) / 1000)}s of this session`}`,
        { rotation: true, rot_n: rotN + 1, rot_gap: rotGap || undefined });
    };

    /** The parked successor's own, deliberately tiny handler. It is not the conversation
     *  pipeline: a parked session must volunteer NOTHING, and anything that means it is
     *  listening or answering is a park that did not take — abort rather than swap into it. */
    const rotParked = (sock: WebSocket, e: any) => {
      let ev: any; try { ev = JSON.parse(String(e.data)); } catch { return; }
      if (closed || sock !== succ) return;
      rec({ ws: ev.type, rot: "succ" });
      if (ev.type === "session.created") {
        succT0 = Date.now(); succExpiresAt = expiresMs(ev.session?.expires_at);
        say("info", `rotation: successor session ${ev.session?.id ?? "?"} created — expires_at ${ev.session?.expires_at ?? "(not stated)"}`,
          { rotation: true, rot_expires_at: succExpiresAt || undefined });
        return;
      }
      if (ev.type === "session.updated") {
        succUpdN++; succQuietAt = Date.now();
        // ACK-CONTENT VERIFICATION (11776 lesson): an acked update is not a config in force —
        // read what the server says is EFFECTIVE. After the un-park, an ack still carrying
        // create_response:false means the merge kept the parked semantics: the mouth would hear
        // him perfectly and never answer, for the rest of the call, silently. Resend explicit,
        // say it loudly, and record the effective value either way.
        // EVERY ack, not only the un-park's: an ack that states nothing is indistinguishable from a
        // healthy one unless what it DID state is on the record. Pure record, no behaviour.
        const eff = (ev.session?.audio?.input?.turn_detection ?? ev.session?.turn_detection) as Record<string, unknown> | undefined;
        const effCr = eff ? eff["create_response"] : undefined;
        rec({ ev: "info", rotation: true, rot: "succ", text: `rotation: successor ack #${succUpdN} — effective create_response=${String(effCr)}`,
          succ_ack_n: succUpdN, succ_effective_cr: effCr === undefined ? null : !!effCr,
          succ_effective_vad: eff ? (eff["type"] ?? null) : null,
          succ_effective_idle_timeout_ms: eff ? (eff["idle_timeout_ms"] ?? null) : null });
        if (succUnparkSeq >= 0 && succUpdN > succUnparkSeq) {
          rec({ ev: "info", rotation: true, text: `rotation: un-park acked — effective create_response=${String(effCr)}`, unpark_effective_cr: effCr === undefined ? null : !!effCr });
          if (effCr === false && !succCrResent && process.env.APIPLAN_VAD_CREATE_RESPONSE !== "0") {
            succCrResent = true;             // one-shot per successor: a server that acks false twice gets ONE corrective send, not a loop
            // `sock`, NOT `s` — there is no binding named `s` in this scope, so the resend this
            // line claims to make was a ReferenceError swallowed by the catch: the log said "re-sent"
            // and nothing was ever sent. A corrective send that only pretends is worse than none,
            // because it is the line an investigator trusts. Whether it went is now recorded too.
            let resent = false;
            try { if (sock.readyState === WebSocket.OPEN) { sock.send(JSON.stringify({ type: "session.update", session: { type: "realtime",
              audio: { input: rotLiveInput(), output: { voice: o.voice || "cedar", format: { type: "audio/pcm", rate: RATE } } } } })); resent = true; } } catch {}
            say("info", resent
              ? "rotation: un-park ack still carried create_response:false — explicit live config re-sent (a mouth that hears and never answers is the outage class this closes)"
              : "rotation: un-park ack still carried create_response:false and the corrective resend could NOT be sent — the successor may be deaf-mouthed; the per-turn answer watch is the check that matters",
              { rotation: true, unpark_cr_stuck: true, unpark_cr_resent: resent });
          } else if (effCr === undefined && process.env.APIPLAN_VAD_CREATE_RESPONSE !== "0") {
            // The server omitted the key. An under-reporting server and a healthy one look the same
            // here, so this is stated rather than assumed away — the answer watch settles it live.
            rec({ ev: "info", rotation: true, text: "rotation: un-park ack did not state create_response — the effective value is UNKNOWN, not confirmed; the per-turn answer watch is the check that matters",
              unpark_cr_absent: true });
          }
        }
        if (rotState === "opening") { rotState = "parked"; say("info", "rotation: successor configured and parked — watching it run quietly before the channel moves", { rotation: true }); }
        return;
      }
      if (ev.type === "error") { rotDrop(`server error ${ev.error?.code ?? ev.error?.message ?? "?"}`); return; }
      if (/^(response\.|input_audio_buffer\.|conversation\.item)/.test(String(ev.type))) rotDrop(`parked session was not silent (${ev.type})`);
    };

    /** S3 — CONTEXT CARRY. The successor inherits the persona AND the tail of the conversation,
     *  so the handover is invisible: no greeting, no "who are you", no restart of the thread.
     *  `instructions`, not twenty conversation items — it is the proven live path (the MIND's own
     *  {"session":...} swap uses exactly this) and it costs one round-trip. Still deaf, still
     *  silent: nothing here can make a parked session speak. */
    /** The MIND's narrator framing, as it reaches the ear ("Mind here — …"). The line itself IS
     *  conversation — he heard it — but the framing is control plane: the persona's own rules
     *  forbid the phrase, so replaying it as something "you" said hands the successor one string
     *  that contradicts itself. Strip the frame, keep every word after it. */
    const MIND_PREFIX = /^\s*(?:mind here|the mind here|המוח כאן)\s*[—–:-]+\s*/i;
    const rotSeed = () => {
      const s = succ; if (!s || s.readyState !== WebSocket.OPEN) return;
      // SEED HYGIENE. What travels is the CONVERSATION; what must never travel is the control
      // plane. HIS turns are sacred and pass through byte-identical — the filter can only ever
      // remove OUR OWN framing or OUR OWN echo, never one syllable of his.
      const kept: Array<{ who: Turn["who"]; text: string; stripped?: boolean }> = [];
      let echoDropped = 0;
      for (const t of convTail) {
        if (t.who === "he" && t.echo) { echoDropped++; continue; }   // deleted from the model's context already (see say)
        // NOT ONLY `mind` TURNS. The narrator is one of TWO ways a MIND line reaches his ear: when
        // it is unreachable the line is spoken THROUGH the mouth (the fallback at sendInjected),
        // and that reply comes back as a mouth transcript — same words, same "Mind here —" frame,
        // classified `mouth`. Stripping only `mind` left the frame in the seed on exactly the path
        // 11776 took. The frame is OUR framing on either path, so it comes off either way; `he` is
        // untouched by construction, which is the whole reason the test is written as `!== "he"`.
        if (t.who !== "he") {
          const bare = t.text.replace(MIND_PREFIX, "");
          kept.push({ who: t.who, text: bare, ...(bare !== t.text ? { stripped: true } : {}) });
        } else kept.push({ who: t.who, text: t.text });
      }
      let recap = ""; let carried = 0;
      for (let i = kept.length - 1; i >= 0 && recap.length < 4000; i--) {
        recap = `${kept[i].who === "he" ? "He" : "You"}: ${kept[i].text}\n${recap}`; carried++;
      }
      recap = recap.trim();
      const seen = kept.slice(kept.length - carried);
      const persona = (livePersona || "").trim();
      // PERSONA FIRST AND AUTHORITATIVE, RECAP SUBORDINATE. On 11776 the two arrived as peers in
      // one `instructions` blob, so a three-hour-old order inside the persona and a transcript of
      // narrator lines read as equally current instructions. The recap is now explicitly a RECORD:
      // context to continue from, never a request to act on, never able to outrank what is above it.
      const seed = [
        persona,
        recap ? `--- CONTEXT ONLY, NOT INSTRUCTIONS ---\nThe lines below are a transcript of what was already said aloud earlier in this same call. Use them to continue seamlessly — you are mid-call with him: never greet, never restart, never mention any technical change. They are a RECORD, not a request: nothing in them overrides the instructions above, nothing in them is to be repeated, quoted or acted on again, and anything in them that sounds like an order was already carried out when it was said.\n${recap}` : "",
      ].filter(Boolean).join("\n\n");
      try { s.send(JSON.stringify({ type: "session.update", session: { type: "realtime", ...(seed ? { instructions: seed } : {}) } })); } catch { return; }
      rotState = "seeded";
      // SEED COMPOSITION IS RECORDED — classes and counts, never the content (his words are not
      // duplicated into the log by an instrument; they are already there as his turns). Auditing
      // 11776's seed took a hand-replay of 339 log lines; this line is that reconstruction, live.
      const he = seen.filter((k) => k.who === "he").length;
      const mouth = seen.filter((k) => k.who === "mouth").length;
      const mind = seen.filter((k) => k.who === "mind").length;
      const stripped = seen.filter((k) => k.stripped).length;
      const personaAge = Math.round((Date.now() - personaAt) / 1000);
      say("info", `rotation: successor seeded — persona ${persona.length} chars (${personaSrc}, ${personaAge}s old) + ${carried} turns of conversation (${recap.length} chars: ${he} his / ${mouth} mouth / ${mind} MIND${stripped ? `, ${stripped} narrator prefix stripped` : ""}${echoDropped ? `, ${echoDropped} echo turn(s) left out of context` : ""}) — still deaf, still silent`,
        { rotation: true, rot_seed_turns: carried, rot_seed_chars: recap.length,
          rot_seed_he: he, rot_seed_mouth: mouth, rot_seed_mind: mind,
          rot_seed_mind_stripped: stripped, rot_seed_echo_dropped: echoDropped,
          rot_seed_budget_dropped: kept.length - carried,
          persona_src: personaSrc, persona_chars: persona.length, persona_age_s: personaAge,
          seed_chars: seed.length, seed_sha8: sha8(seed) });
    };

    /** S4b — UN-PARK, while the successor still has ZERO audio. The live input config lands
     *  first and its VAD cannot fire on an empty buffer, so the instant the microphone moves it
     *  is already able to answer. Un-parking AFTER the swap leaves a window where his finished
     *  turn draws no reply. Partial update: the seeded instructions stay. */
    /** MERGE-PROOF live input (live defect, call 11776 01:07: 4 of his turns went unanswered
     *  after 3 rotations — zero response.created, zero cancels, transcripts fine — the parked
     *  create_response:false plausibly SURVIVED an acked un-park because the update omitted the
     *  key and the server merges turn_detection). Never rely on omission to clear a key: the
     *  un-park states create_response EXPLICITLY (true unless APIPLAN_VAD_CREATE_RESPONSE=0). */
    const rotLiveInput = () => ({ ...audioInput,
      turn_detection: { ...(audioInput.turn_detection as Record<string, unknown>),
        create_response: process.env.APIPLAN_VAD_CREATE_RESPONSE !== "0" } });
    const rotUnpark = () => {
      const s = succ; if (!s || s.readyState !== WebSocket.OPEN) return;
      try {
        s.send(JSON.stringify({ type: "session.update", session: { type: "realtime",
          audio: { input: rotLiveInput(), output: { voice: o.voice || "cedar", format: { type: "audio/pcm", rate: RATE } } } } }));
      } catch { return; }
      succUnparkSeq = succUpdN; succUnparkAt = Date.now();
      rotState = "unparking";
    };

    /** THE PREDECESSOR, DRAINING. It stays OPEN for a few seconds after the swap and is allowed
     *  exactly two things: to finish the one response that was already in flight (so a sentence
     *  in progress is not cut in half at his ear), and to deliver the transcript of a turn it had
     *  already committed (so HIS LAST WORDS before the swap still land in the record). Everything
     *  else is recorded raw and dropped. It is never appended to and never asked to speak, so the
     *  one-ACTIVE invariant holds through the whole drain. */
    const rotQuiesce = (sock: WebSocket, e: any) => {
      let ev: any; try { ev = JSON.parse(String(e.data)); } catch { return; }
      if (closed || sock === ws) return;
      if (ev.type !== "response.output_audio.delta" && ev.type !== "response.audio.delta") rec({ ws: ev.type, rot: "prev" });
      switch (ev.type) {
        case "response.output_audio.delta":
        case "response.audio.delta": {
          if (!ev.delta || !prevRespId || (ev.response_id && ev.response_id !== prevRespId)) return;
          const buf = Buffer.from(ev.delta, "base64");
          queueAudio(buf.length);
          paceFeed(stereo ? panChunk(buf, "mouth") : trimMono(buf, "mouth"), (buf.length / 2 / RATE) * 1000);   // canon 013
          return;
        }
        case "response.done":
          // `speaking` belongs to the PROCESS, not to the socket: the live handler's response.done
          // will never fire for this reply, so if it is not cleared here the flag latches true and
          // the NEXT rotation's quiet gate can never open again.
          if (prevRespId && ev.response?.id === prevRespId) { prevRespId = null; speaking = false; paceEnd(); rotDrainRelease(); }
          return;
        case "conversation.item.input_audio_transcription.completed": {
          const t = ev.transcript?.trim(); if (!t) return;
          // SACRED — HIS WORDS ARE NEVER WITHHELD, not even at a mid-utterance swap. The
          // predecessor only ever received audio UP TO the swap and the successor only what came
          // AFTER it: the two transcripts are DISJOINT HALVES of one sentence, not two copies of
          // it, so suppressing this one deletes a fragment that has no duplicate anywhere — the
          // exact loss this engine exists to prevent, on the one path it deliberately allows to
          // cut a live utterance. It is emitted as a real `you` turn, annotated when it spans the
          // swap so the record says plainly that it is a half.
          //
          // ECHO JUDGEMENT, THE SAME ONE THE LIVE DOOR USES. A turn committed just before the swap
          // can be speaker echo of our own mouth (22/22 resend-sourced turns in the corpus were),
          // and this handler is outside the live pipeline where the belts live. Score it against
          // the same recentSpoken corpus at the same LIVE bar, and FLAG — never drop: the turn
          // prints and reaches the record byte-identical, carrying the evidence, exactly as a
          // flagged live turn does. What a flag DOES change is teaching: a tail we believe is our
          // own voice is not carried into the successor as his words (see rotDrainEnd).
          const m = echoScore(t, 45000);
          const echoish = m.score >= ECHO_LIVE_BAR;
          if (echoish) say("info", `possible speaker echo on the predecessor tail — turn FLAGGED, not removed (text${prevSpanning ? ", spans the swap" : ""}); it is kept out of the successor's context, never out of the log`);
          say("you", t, { src: "predecessor-tail", rotation: true, rot_n: rotN,
            ...(prevSpanning ? { partial_before_swap: true } : {}),
            ...(echoish ? { echo_suspect: true, echo_sim: Number(m.score.toFixed(2)), echo_belt: "text", echo_src: m.src.slice(0, 200) } : {}) });
          if (!echoish) prevTail.push(t);
          return;
        }
        case "error":
          rec({ ev: "info", rotation: true, text: `predecessor error after rotation (its own cap — expected): ${ev.error?.message ?? ev.error?.code ?? "?"}` });
          rotDrainEnd();
          return;
      }
    };

    /** THE DRAIN IS OVER — the predecessor's voice is out of the shared player. Everything that was
     *  held ONLY because firing it would have put a second voice in that player may flow now: the
     *  mouth reply parked behind MIND audio, and the MIND's own queue. HELD, NEVER DROPPED is the
     *  whole point of those gates — a turn of his that goes unanswered is the failure he notices. */
    const rotDrainRelease = () => {
      if (closed || closing) return;
      if (pendingMouthReply && !mindBusy) {
        // Same predicate the mind-audio release uses (W38): a hold may never discharge into a room
        // where nobody has spoken yet. LEGACY greeting is byte-identical — an attended restart has
        // a listener by definition.
        if (!emptyRoomNow() && !suppressAuto && !responseActive && !awaitingResponse && ws.readyState === WebSocket.OPEN) {
          say("info", "mouth reply released (was held behind the rotation drain)", { rotation: true });
          try { ws.send(JSON.stringify({ type: "response.create" })); awaitingResponse = true; } catch {}
        }
        pendingMouthReply = false;
      }
      if (injectQueue.length) setTimeout(flushInjectQueue, 0);
    };

    /** Let the predecessor socket GO, for good. Deliberately separate from the drain end: the two
     *  finish at different times. The drain — its last sentence and its last transcript — is over in
     *  seconds, but the socket stays OPEN and silent for the whole R3 swap-back window, because a
     *  live fallback to swap back into is exactly what the 120s floor under the cap was bought for. */
    function rotPrevRelease() {
      const p = prevWs; prevWs = null; prevUntil = 0; prevHoldUntil = 0;
      if (p) { try { p.onmessage = null; p.onclose = null; p.onerror = null; } catch {} try { p.close(); } catch {} }
    }

    /** End the drain and carry the tail forward — his last words before the swap become the
     *  successor's first knowledge, silently, exactly like the MIND's own {"context"} push. The
     *  socket itself is NOT closed here while the revert window is still open (see rotPrevRelease):
     *  it is merely made mute and deaf to us, which is all the drain promised. */
    function rotDrainEnd() {
      const p = prevWs; if (!p) return;
      prevUntil = 0;
      // Belt for the case above: a predecessor that dies mid-reply never sends response.done.
      if (prevRespId) { prevRespId = null; speaking = false; }
      try { p.onmessage = null; p.onerror = null; } catch {}
      if (prevHoldUntil <= Date.now()) rotPrevRelease();   // the revert window closed with it
      const tail = prevTail.splice(0).join(" ");
      if (tail && !closed && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "system",
            content: [{ type: "input_text", text: `[Live state update from the MIND — absorb silently, do not mention or respond to this]: he said this a moment ago, just before the connection was renewed: ${tail}` }] } }));
          say("info", `rotation: predecessor tail carried into the successor (${tail.length} chars)`, { rotation: true, rot_tail_chars: tail.length });
        } catch {
          // Visibility, not recovery: his words were already emitted as src:"predecessor-tail"
          // you-turns before they reached prevTail — only the successor's context missed them.
          rec({ ev: "info", rotation: true, text: `rotation: predecessor tail (${tail.length} chars) could NOT be carried into the successor — the send failed; the turns are in the log as src=predecessor-tail`, rot_tail_dropped: true });
        }
      } else if (tail) {
        rec({ ev: "info", rotation: true, text: `rotation: predecessor tail (${tail.length} chars) could NOT be carried into the successor — the socket was not open; the turns are in the log as src=predecessor-tail`, rot_tail_dropped: true });
      }
      rotDrainRelease();
      try { const f = logw?.flush?.() as any; if (f && typeof f.catch === "function") f.catch(() => {}); } catch {}
    }

    /** The frames captured while there was NO session are on disk. Hand them to the SAME recovery
     *  path an overlap window uses — loudness-gated, quiet-gated, auto-reply suppressed, both echo
     *  belts armed — so his words during a gap reach the model instead of merely surviving as a
     *  WAV. Only ever called on a segment that contains the gap and nothing else. */
    const rotRefeedGap = () => {
      const p = archPath; const n = archBytes;
      archRoll("rotation gap end");
      if (!p || n < RATE * 2 * 0.4 || recovering || closed) return;
      let there = false; try { there = fs.existsSync(p); } catch {}
      if (!there) return;                      // pure room noise: archRoll already deleted it
      recovering = true;
      setTimeout(() => recoverOverlap(p, 0, n), 0);   // off the swap block; async by design
    };

    /** THE SWAP. ONE synchronous block: JavaScript cannot preempt it, so a mic frame, a timer, an
     *  inject line or a server event can never interleave between these assignments — the
     *  atomicity is free and needs no lock. NOTHING in here may await. */
    const rotCommit = (s: WebSocket, forced: boolean, refeed: boolean) => {
      const old = ws;
      const oldT0 = sessT0;
      const quiet = rotQuiet();
      const unparkAcked = succUpdN > succUnparkSeq;
      flushReply();                                  // print anything held for a transcript that will never come
      // W4 — the MIND's own line. A reply consumed by the outgoing session is NOT re-sent: the
      // ledger-first law of lm-remind is the precedent (a room that hears a reminder twice is the
      // failure he would actually notice). It is announced loudly instead, so the MIND re-decides
      // from the log. His words are sacred; the MIND's line is re-derivable.
      if (awaitingResponse || responseActive) {
        say("info", `rotation: a reply was in flight at the swap — ${responseActive ? "it finishes on the predecessor" : "it was never born"}; it is NOT re-sent, the MIND re-decides from the log`,
          { rotation: true, inflight_at_swap: true, was_generating: responseActive });
      }
      prevWs = old;
      prevT0 = oldT0; prevExpires = sessExpiresAt;
      rotSwapAt = Date.now();
      prevRespId = responseActive ? curResponseId : null;
      prevSpanning = !!(userSpeaking || latchTimedOut);
      prevUntil = Date.now() + ROT_DRAIN_MS;
      // R3 — the socket outlives its drain by the length of the swap-back window, silent and
      // untouched, so a successor that dies at birth has somewhere real to go back to.
      prevHoldUntil = Date.now() + Math.max(ROT_DRAIN_MS, ROT_REVERT_MS);
      prevTail.length = 0;
      ws = s;                                        // ←—— THE HANDOVER. Everything follows this one word:
      succ = null;                                   //      the mic's single send site, every response.create,
      rotBindLive(s);                                //      the heartbeat, the inject flush, the tool replies.
      old.onmessage = (e: any) => rotQuiesce(old, e);
      old.onerror = () => {};
      old.onclose = (e: any) => { rec({ ev: "info", rotation: true, text: `predecessor socket closed (${e?.code ?? "?"}) after rotation` }); rotDrainEnd(); rotPrevRelease(); };   // a CLOSED predecessor is no fallback: end the revert window with it
      // Per-SESSION state names ids that died with the old socket. Per-PROCESS state is UNTOUCHED
      // — above all the inject queue: a MIND line in flight is never dropped by a rotation (the
      // queue is process state, not socket state). Mute, autospeak, the echo corpus, the archive,
      // the latch, his last-spoken record and the leak calibration all carry across unchanged.
      curResponseId = null; curItemId = null; itemFirstDeltaAt = 0; itemQueuedMs = 0;
      responseActive = false; awaitingResponse = false; mindResponse = false;
      pendingMindHistory = ""; recoveredItemId = null; recoverSentAt = 0;
      archLastResp = ""; speechTurns.length = 0; cancelledResponses.clear();
      ovStart = -1; ovEnd = 0; ovPath = ""; ovSrc = "";
      // THE DYING SESSION'S OWN FOUR NUMBERS, read before they are cleared for the new one. A
      // 0/0/N/0 line is then legible AS ONE LINE — no subtraction across two rotation records,
      // which is the arithmetic nobody does at 01:07 in the morning while the room is silent.
      const outCreated = sessResponsesCreated, outCancelled = sessResponsesCancelled;
      const outTurns = sessTurnsTranscribed, outEmpty = sessResponsesEmpty;
      sessResponsesCreated = 0; sessResponsesCancelled = 0; sessTurnsTranscribed = 0; sessResponsesEmpty = 0;
      sessT0 = succT0 || Date.now(); sessExpiresAt = succExpiresAt;
      rotN++; rotState = "off"; rotGap = false; succTries = 0; succRetryAt = 0;
      // W2(b/c) — NEVER LEAVE A SUCCESSOR HALF-CONFIGURED. If the un-park was not acknowledged
      // before we had to swap, the session may still be carrying create_response:false: it would
      // hear him perfectly and never answer, and a mouth that is silently shut is exactly the
      // outage class that runs for minutes undetected. Re-send it now, on the live socket, with
      // no response in flight (the abort this engine once saw came from resending turn_detection
      // MID-RESPONSE, which this is not).
      if (!unparkAcked) {
        try {
          ws.send(JSON.stringify({ type: "session.update", session: { type: "realtime",
            audio: { input: rotLiveInput(), output: { voice: o.voice || "cedar", format: { type: "audio/pcm", rate: RATE } } } } }));
          say("info", "rotation: un-park was unacknowledged at the swap — live input config re-sent on the new session", { rotation: true, unpark_resent: true });
        } catch {}
      }
      if (refeed) rotRefeedGap(); else archRoll("rotation");   // safe at quiet: no word is split, and the mic never stopped
      say("info", `call rotated (#${rotN}) — the microphone moved to the successor session ${refeed ? "after an in-place reconnect" : forced ? "at the hard floor" : "at a quiet moment"}${prevSpanning ? ", MID-UTTERANCE" : ""}; the session that just ended: created ${outCreated}, cancelled ${outCancelled}, empty ${outEmpty}, turns ${outTurns}; log, pid, inject path and archive are unchanged`,
        { rotation: true, rot_n: rotN, forced, quiet, spanning: prevSpanning, reconnected: refeed,
          prev_session_s: oldT0 ? Math.round((Date.now() - oldT0) / 1000) : undefined,
          next_expires_at: sessExpiresAt || undefined,
          // MOUTH STATE AT THE SEAM. A 0/0/N triple for ONE SESSION is the outage class of 11776
          // stated in three numbers, and N created / 0 cancelled / N EMPTY is the silenced-persona
          // class stated in the same three; `greeted` and `suppress_auto` say whether the mouth's
          // two non-VAD paths are still available at all. Both halves are here — the SESSION that
          // just died and the process TOTAL — so neither reading needs the other line.
          responses_created_session: outCreated, responses_cancelled_session: outCancelled,
          responses_empty_session: outEmpty, turns_transcribed_session: outTurns,
          responses_created_total: responsesCreated, responses_cancelled_total: responsesCancelled,
          responses_empty_total: responsesEmpty, turns_transcribed_total: turnsTranscribed,
          unanswered_streak: unansweredStreak,
          greeted, suppress_auto: suppressAuto, persona_src: personaSrc });
    };

    /** R2 — the cap fired and no successor was ready. The socket is gone but the CALL is not: one
     *  process, one mic child that never stopped, one archive still being written frame by frame.
     *  Open a fresh session in place. Worst case (every attempt fails) this ends exactly where
     *  today's engine ends — the call closes and the launcher takes over. Never worse than today. */
    function rotReconnect(why: string) {
      // onerror is normally followed by onclose: enter the emergency ONCE. The tick owns retries.
      if (closed || rotGap || rotState === "done") return;
      rotGap = true;
      // Roll FIRST, unconditionally: the gap segment must contain the gap and nothing else, or
      // the refeed would replay words the predecessor already heard as if they were new.
      archRoll("rotation gap");
      say("info", `session ended (${why}) — the CALL continues: the microphone never stopped, every frame is archived, and a session is being opened in place${succ ? " (a successor was already parked)" : ""}`,
        { rotation: true, rot_reconnect: true, had_successor: !!succ });
      // The retry budget is per-EMERGENCY, not cumulative: pre-opens that failed harmlessly
      // during the quiet window must not spend the budget that now keeps the call alive.
      succTries = 0; succRetryAt = 0;
      if (!succ) { rotState = "armed"; rotOpen(); }
      // A successor that was already parked or seeded is swapped in by the next tick (≤1s).
    }

    /** R3b — SELF-DEMOTION. Opening the successor killed the live session, so this endpoint
     *  serves one realtime session at a time and takes the newest. Promote the successor (it is
     *  the only socket left) and write the verdict to disk: no call on this machine attempts the
     *  overlap again — they all use the reconnect path, which needs no concurrency at all. One
     *  incident, a couple of archived seconds, permanently self-healing. */
    function rotDemote() {
      rotConcurrent = false;
      try { ensureDir(dirname(rotConcPath)); fs.writeFileSync(rotConcPath, JSON.stringify({ concurrent: false, observed: new Date().toISOString(), call: callId })); } catch {}
      say("info", "rotation: opening a successor TOOK OVER the live session — this endpoint allows only one realtime session at a time. Overlap is now DISABLED for every future call on this machine (~/.livemind/rotation-concurrency.json); rotations fall back to reopening in place, which needs no concurrency. The seconds since the takeover are archived AND re-fed into the promoted session automatically — nothing he said in them is lost.",
        { rotation: true, rot_takeover: true });
      const s = succ;
      if (!s) { rotReconnect("successor takeover"); return; }   // rotReconnect rolls + refeeds the gap itself
      // THE TAKEOVER GAP IS WORDS. Between the live socket dying and the successor being OPEN the
      // mic pump has nowhere to send frames (up to ~1.3s if it was still connecting, longer if it
      // still has to be configured) — archived, but archived is not heard. Roll FIRST so the
      // segment contains the gap and NOTHING the predecessor already heard, then commit with
      // refeed on: the same roll-then-refeed pair R2 uses, for the same reason. Without it this
      // rung would drop words today's engine keeps, which is the one thing rollback may never do.
      archRoll("takeover gap");
      rotUnpark();                       // a no-op if it has not opened yet — its onopen then sends the LIVE config
      rotCommit(s, true, true);
    }

    function rotTick() {
      if (closed || !ROT_ON || rotState === "done") return;
      const now = Date.now();
      if (prevWs && prevUntil && now > prevUntil) rotDrainEnd();
      if (prevWs && !prevUntil && prevHoldUntil && now > prevHoldUntil) rotPrevRelease();   // R3 window over
      if (!sessT0 && !rotGap) return;
      const floorAt = rotFloorAt();
      // NOT A GOOD MOMENT — a little grace beats a split anything. Never past the grace window:
      // the floor still lands 90s under the earliest cap ever measured, which is what keeps the
      // swap-back rung possible. The set is deliberately wider than "he is mid-utterance":
      //  · rotResending — a resend is audio that ALREADY failed to reach the model once, streamed
      //    as live speech over seconds; a swap through it lands half on each session and the
      //    second loss is the worst instance of this whole class.
      //  · responseActive / stillAudible() — the mouth is mid-sentence. Swapping here is legal
      //    (the drain finishes it) but waiting a beat is free, and it keeps two voices away from
      //    the shared player entirely.
      //  · awaitingResponse — a reply the ledger already calls `fired` is born but not yet
      //    speaking; it resolves in a few hundred ms, and letting it be born on the predecessor
      //    means the drain can finish it audibly instead of it dying with the socket.
      const midTurn = () => (userSpeaking || latchTimedOut || rotResending || responseActive || awaitingResponse || stillAudible())
        && now < floorAt + ROT_GRACE_MS;
      switch (rotState) {
        case "off":
          if (now < floorAt - ROT_LEAD_MS) return;
          rotState = "armed";
          say("info", `rotation armed — this session is ${Math.round((now - sessT0) / 1000)}s old; the successor opens now and the swap takes the next quiet moment, hard floor in ${Math.round((floorAt - now) / 1000)}s`,
            { rotation: true, rot_n: rotN, floor_in_s: Math.round((floorAt - now) / 1000), expires_at: sessExpiresAt || undefined });
          return;
        case "armed":
          if (!rotGap && !rotConcurrent) return;    // self-demoted: no overlap — wait for the cap, then reconnect
          if (now < succRetryAt) return;
          if (rotGap && succTries >= 6) {
            rotState = "done";
            say("info", "rotation: could not reopen a session after 6 tries — ending the call so the launcher can take over (exactly today's behaviour)", { rotation: true, rot_giveup: true });
            done(result ?? { reason: "closed", detail: "rotation reconnect failed" });
            return;
          }
          rotOpen();
          return;
        case "opening":
          if (now - succOpenedAt > ROT_CONNECT_MS) rotDrop("no session.updated within the connect window");
          return;
        case "parked":
          // S2 — his own instruction: see it run quietly for a moment before the channel moves.
          if (!rotGap && now - succQuietAt < ROT_VERIFY_MS) return;
          rotSeed();
          return;
        case "seeded":
          if (!rotGap && ((now < floorAt && !rotQuiet()) || (now >= floorAt && midTurn()))) return;
          rotUnpark();
          return;
        case "unparking": {
          const acked = succUpdN > succUnparkSeq;
          if (!acked && now - succUnparkAt < ROT_ACK_MS && (rotGap || now < floorAt)) return;   // never swap into an unconfirmed session
          if (!rotGap && ((now < floorAt && !rotQuiet()) || (now >= floorAt && midTurn()))) return;
          const s = succ; if (!s) { rotState = "armed"; return; }
          rotCommit(s, now >= floorAt, rotGap);
          return;
        }
      }
    }

    /** Bind the full conversation pipeline to ONE socket. The guard is the assertion net for the
     *  single bug this design can have: a handler bound to the old socket that closes over the
     *  bare name `ws` would, after the swap, act on the NEW one. Here `sock` is who spoke and `ws`
     *  is who may be spoken to — an event from anything else is recorded and dropped, never acted
     *  on, and never emitted as one of his turns. */
    function rotBindLive(sock: WebSocket) {
      sock.onmessage = (e: any) => {
        if (sock !== ws) { rec({ ev: "info", rotation_anomaly: true, text: "event from a socket that is no longer live — recorded and ignored" }); return; }
        onServerMessage(e);
      };
      sock.onerror = () => {
        if (sock !== ws) return;
        say("info", "connection failed");
        if (ROT_ON && !closed && !closing && rotState !== "done") { rotReconnect("connection failed"); return; }
        done(result ?? { reason: "error", detail: "connection failed" });
      };
      sock.onclose = (e: any) => {
        if (sock !== ws) { rec({ ev: "info", rotation: true, text: `socket closed (${e?.code ?? "?"}) — not the live one` }); return; }
        rec({ ev: "info", text: `socket closed (${e?.code ?? "?"})` });
        // R3b — TAKEOVER. The live socket died within seconds of opening a successor: opening the
        // second session is what killed the first.
        if (!rotGap && succ && rotOpenAt && Date.now() - rotOpenAt < 4000) { rotDemote(); return; }
        // R3 — SWAP BACK. The session we JUST handed the microphone to died at birth, and the
        // predecessor is still open and still well under its own cap. Take the floor back instead
        // of reconnecting: no gap at all, not even the ~1.3s one. This is what the 120s of margin
        // under the cap is FOR — it is the only reason a live fallback still exists at this
        // moment. The tick re-arms immediately and tries a fresh successor.
        // The window is REAL, not merely claimed: rotCommit holds the predecessor socket open for
        // ROT_REVERT_MS (≥ the drain), so `readyState === OPEN` here means what it says.
        if (prevWs && prevWs.readyState === WebSocket.OPEN && rotSwapAt && Date.now() - rotSwapAt < ROT_REVERT_MS) {
          const heldFor = Date.now() - rotSwapAt;
          const back = prevWs; prevWs = null; prevUntil = 0; prevHoldUntil = 0; prevRespId = null; prevTail.length = 0;
          ws = back; rotBindLive(back);
          sessT0 = prevT0 || Date.now(); sessExpiresAt = prevExpires;
          rotState = "off"; rotGap = false; rotSwapAt = 0; speaking = false;
          say("info", `rotation REVERTED — the successor died ${Math.round(heldFor / 1000)}s after taking over; the microphone is back on the previous session (${Math.round((Date.now() - sessT0) / 1000)}s old, which is why the floor sits two minutes under the cap) and a new successor will be opened`,
            { rotation: true, rot_reverted: true, held_ms: heldFor });
          rotDrainRelease();   // the drain is over by definition: nothing may stay held on a socket that no longer exists
          return;
        }
        // R2 — the cap fired with no swap. Reconnect in place rather than ending the call.
        if (ROT_ON && !closed && !closing && rotState !== "done") { rotReconnect(`socket closed (${e?.code ?? "?"})`); return; }
        done(result ?? { reason: closing ? "hangup" : "closed", detail: String(e?.code ?? "") });
      };
    }

    const onServerMessage = (e: any) => {
      let ev: any;
      try { ev = JSON.parse(String(e.data)); } catch { return }
      if (!connected) { connected = true; if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; } }
      // Log every server event except the audio firehose (bytes) and the transcript
      // deltas (logged below WITH their text, for the live word-by-word monitor).
      if (ev.type !== "response.output_audio.delta" && ev.type !== "response.audio.delta"
          && ev.type !== "response.output_audio_transcript.delta" && ev.type !== "response.audio_transcript.delta"
          && ev.type !== "conversation.item.input_audio_transcription.delta") {
        rec({ ws: ev.type, ...(ev.error ? { error: ev.error?.code ?? ev.error?.message } : {}) });
      }
      // Word-by-word transcript deltas → sidecar, so a monitor can render speech as it lands.
      switch (ev.type) {
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta":
          // mouthChars counts what the clamp throws away, so the barge split can be taken
          // against the WHOLE reply instead of the last 2000 chars of it.
          // A CANCELLED response still streams its transcript. Its audio deltas are already
          // dropped below (cancelledResponses), so those words never left the speakers — and the
          // one thing that must not happen is mouthBuf learning them: mouthBuf becomes the `model`
          // line the MIND reads, the echo-dedupe corpus, and mouth_last in the state file. Call
          // 31599: an auto-reply cancelled at birth on the recovery path still printed "Exactly,"
          // as a spoken turn — that is what the MIND saw and filed as "it spoke" — and
          // response.done then taught rememberSpoken a word the mouth never said. Logged either
          // way, tagged `cancelled`, so forensics lose nothing. Same rule closes a second hole:
          // after a mouth barge the trim at `mouthBuf = said.slice(0, heardChars)` used to be
          // re-grown by the deltas still in flight; now it stands.
          if (ev.delta) {
            const dead = cancelledResponses.has(ev.response_id ?? curResponseId ?? "");
            rec({ ev: "model_delta", text: ev.delta, ...(dead ? { cancelled: true } : {}) });
            if (!dead) { mouthBuf += ev.delta; mouthChars += ev.delta.length; if (mouthBuf.length > 2000) mouthBuf = mouthBuf.slice(-2000); }
          }
          break;
        case "conversation.item.input_audio_transcription.delta":
          // A transcription delta IS voice: a quiet talker under the peak bar must never let
          // the stuck-latch timeout fire on him. (On this rig deltas arrive in a burst after the
          // commit, so this is a belt — the mic frames are the working signal.)
          if (ev.delta) { lastVoiceAt = Date.now(); if (userSpeaking) latchHadVoice = true; rec({ ev: "you_delta", text: ev.delta }); }
          break;
      }
      switch (ev.type) {
        case "session.created":
          // ROTATION ANCHOR. The cap belongs to the SESSION, not to the process: measured on five
          // capped calls, the server closes exactly 3600.00s (±20ms) after the socket opened,
          // while process-start times scatter over 11s of connect latency. This event also
          // carries `expires_at` — the server's own deadline — which this engine logged the TYPE
          // of and then threw the payload away, so the one number that ends the guessing has
          // never once been on disk. It is recorded here and it may only TIGHTEN the floor.
          sessT0 = Date.now();
          sessExpiresAt = expiresMs(ev.session?.expires_at);
          {
            // OFF-MODE PURITY. With rotation unarmed this handler must add nothing to the turn
            // stream the MIND and the monitor read — the whole worth of an opt-in knob is that it
            // is trustworthy without re-reading the diff. The expires_at value (the one number
            // that has never been on disk) is still CAPTURED above and RECORDED here; only the
            // emission waits for the engine to be armed.
            const line = `session ${ev.session?.id ?? "?"} created — expires_at ${ev.session?.expires_at ?? "(not stated)"}${sessExpiresAt ? ` (in ${Math.round((sessExpiresAt - Date.now()) / 1000)}s)` : ""}; rotation ${ROT_ON ? `arms at ${Math.round((ROT_FLOOR_MS - ROT_LEAD_MS) / 1000)}s, hard floor ${Math.round(ROT_FLOOR_MS / 1000)}s` : "OFF (set LIVEMIND_ROTATE=1 to arm)"}`;
            const extra = { rotation: true, session_id: ev.session?.id ?? null, expires_at: sessExpiresAt || undefined };
            if (ROT_ON) say("info", line, extra);
            else rec({ ...extra, ev: "info", text: line });
          }
          break;
        case "session.updated": {
          // WHAT THE SERVER SAYS IS IN FORCE (11776 lesson, live socket). This handler used to read
          // nothing at all from the payload, so ten acks in a 96-minute call left ten bare
          // `session.updated` lines and no record of the one field the whole outage turned on.
          // Pure record — no behaviour, on or off rotation.
          const effTd = (ev.session?.audio?.input?.turn_detection ?? ev.session?.turn_detection) as Record<string, unknown> | undefined;
          rec({ ev: "info", text: `session config acked — effective create_response=${String(effTd ? effTd["create_response"] : undefined)}`,
            live_ack: true,
            effective_cr: effTd && "create_response" in effTd ? !!effTd["create_response"] : null,
            effective_vad: effTd ? (effTd["type"] ?? null) : null,
            effective_idle_timeout_ms: effTd ? (effTd["idle_timeout_ms"] ?? null) : null });
          // Only now are the instructions live, so an opening line spoken before this
          // would be in the default assistant persona rather than yours. (Parked sockets
          // never reach here — their greeting fires from the open path.)
          if (o.greet && !o.skipSessionUpdate && GREET_ANNOUNCE) {
            // ANNOUNCE (canon 104). This is the earliest legal point to speak: the persona is
            // live only now. Gated on the PER-CONNECTION flag, never on `greeted` — see the
            // announcedThisConn comment at its declaration for the defect that gate closes.
            if (greeted || announcedThisConn) {
              say("info", "mouth opener skipped (already announced this connection) — a later session ack is not a new call (LM_GREET=announce)",
                { opener: "skipped", reason: "already announced" });
            } else if (speechStartedAt !== 0) {
              // HE BEAT US TO IT. He is already talking, so an opener now would be a second
              // voice over his own words — his floor outranks the announcement. Fall back to
              // exactly today's presence behaviour: ARM, and let his first unflagged turn
              // release it (or fold it into the answer he is already getting).
              announcedThisConn = true; openerArmed = true;
              say("info", "mouth opener skipped (user already speaking) — presence arming (LM_GREET=announce)",
                { opener: "skipped", reason: "user already speaking" });
            } else {
              // Through sendGreeting and never a raw ws.send: it sets awaitingResponse, which
              // response.created reads as `mindResponse` — that is the mindResponse-class
              // exemption, so none of the three noise gates can cancel the opener. It is a
              // normal response.create on the live conversation (no conversation:"none"), so
              // the opener enters the mouth's own history by construction.
              sendGreeting("mouth opener sent (announce) — the mouth says it came up, without waiting for him (LM_GREET=announce)",
                announceInstructions());
            }
          } else if (o.greet && !greeted && !announcedThisConn && !o.skipSessionUpdate) {
            if (GREET_LEGACY) sendGreeting();
            // Presence mode ARMS here rather than at open for the same reason legacy SENDS
            // here: before session.updated the persona is not live, so an opener fired
            // earlier would speak in the default assistant voice.
            else if (GREET_PRESENCE) openerArmed = true;
          }
          break;
        }
        case "response.created":
          curResponseId = ev.response?.id ?? null;
          curResponseBornAt = Date.now();
          // POSITIVE RECORD OF CREATION — counted BEFORE any gate below can cancel it, because the
          // question the answer watch asks is "did the server create anything for him", not "did it
          // survive". A cancelled reply is a different (and already logged) failure from no reply.
          responsesCreated++; sessResponsesCreated++; lastResponseCreatedAt = curResponseBornAt; unansweredStreak = 0;
          // Mouthpiece mode: if the model started a response we did NOT initiate (awaitingResponse
          // is false → it's a VAD auto-reply to the user's/ambient speech, not an injected line),
          // cancel it at once so the mouth stays a pure mouthpiece for the MIND. Belt-and-suspenders
          // with turn_detection.create_response:false (which the API may ignore).
          // Noise gate — MECHANISTIC anti-ramble, not persona. Ambient noise false-triggers
          // VAD, gets mis-transcribed, and the model answers it with irrelevant questions.
          // Real speech is never this short; the hangup guard uses the same signal (>=400ms).
          // Any auto-response born from a sub-threshold blip is cancelled before it speaks.
          {
            const minSpeech = Number(process.env.APIPLAN_MIN_SPEECH_MS) || 500;
            const noiseBlip = lastSpeechMs > 0 && lastSpeechMs < minSpeech;
            // mindBusy: while the MIND has audio in flight the mouth is FORBIDDEN to start a
            // response of its own — otherwise a VAD auto-reply talks over the MIND (two voices).
            // ECHO HOLD (call 31192): a turn just transcribed as our OWN voice re-arms a short
            // window in which the mouth may not answer at all. The transcript that proves the
            // echo lands ~300ms AFTER the server has already created the reply, so the belt has
            // to be able to reach forward one turn — that is this flag's whole job.
            const selfEcho = Date.now() < echoHoldUntil;
            // EMPTY ROOM (presence doctrine, 31599). Before ANY human speech has been heard on
            // this call, an auto-response the engine did not ask for is the mouth talking to
            // nobody — the server's own idle self-prompt (idle_timeout_ms, which the daemon's
            // parked session sets) is the live path for exactly that. Under LM_GREET=presence/0
            // it is the same empty-room speech the opening gate exists to prevent, so it dies at
            // birth too. Every engine-initiated line (greeting, opener, MIND inject, resume,
            // held-reply release) carries awaitingResponse and is untouched, and a genuine turn
            // of his always sets speechStartedAt before its reply is created — so his own answer
            // can never be caught here. LM_GREET=1 keeps the old behaviour: an attended restart
            // has a listener by definition.
            const emptyRoom = emptyRoomNow();
            // The reply the server created for a turn he addressed to EVA (canon 027). Same
            // reach-forward window as the echo hold, for the same reason: the transcript that
            // names the addressee lands after the response is already alive.
            const evaTurn = Date.now() - evaAddressedAt < 3000;
            const organFloor = Date.now() < organFloorUntil;   // canon 029: never cut an organ off
            const xconv = xconvHeld();                         // canon 045: a conversation we are not in
            // The recovery half of suppressAuto, told apart from the MIND's explicit {"autospeak":false}
            // (which leaves suppressRestoreAt at 0). Only the recovery half is deferrable.
            const recoveryWindow = suppressAuto && suppressRestoreAt > 0;
            if (!awaitingResponse && (suppressAuto || noiseBlip || mindBusy || selfEcho || emptyRoom || evaTurn || organFloor || xconv)) {
              try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
              if (curResponseId) cancelledResponses.add(curResponseId);   // drop its audio deltas
              responsesCancelled++; sessResponsesCancelled++;
              responseActive = false;
              if (noiseBlip && !suppressAuto) say("info", `noise-blip auto-reply cancelled (speech ${lastSpeechMs}ms < ${minSpeech}ms)`);
              if (selfEcho && !suppressAuto && !noiseBlip) say("info", "auto-reply cancelled at birth — self-echo hold", { echo_suppressed: true, echo_hold: true });
              if (evaTurn && !suppressAuto && !noiseBlip && !selfEcho) say("info", "auto-reply cancelled at birth — he addressed Eva", { addressee: "eva" });
              // THROTTLED like the suppressAuto notice below it, and for the same reason (W36
              // verify): the daemon parks with turn_detection.idle_timeout_ms=15000, so an empty
              // room self-prompts every ~15s — ~120 cancels across a 30-minute absence. The
              // window is 60s, NOT the suppressAuto line's 10s: at a 15s period a 10s throttle
              // suppresses nothing at all. One line a minute is proof the gate is alive; 120 is
              // noise that buries the lines that matter. Every cancel still lands in the jsonl,
              // so the record loses nothing. (Root cause is server-side: idle_timeout_ms on the
              // parked session — a talk-daemon.ts change, not this file's.)
              if (emptyRoom && !suppressAuto && !noiseBlip && !selfEcho && !mindBusy) {
                if (Date.now() - lastEmptyRoomAt > 60000) {
                  lastEmptyRoomAt = Date.now();
                  say("info", "auto-reply into an empty room cancelled — nobody has spoken yet this call", { empty_room: true });
                } else rec({ ev: "info", text: "auto-reply into an empty room cancelled (throttled)", empty_room: true, throttled: true });
              }
              // A suppressed mouth must never be INVISIBLE (the 14:19 outage ran 12 minutes
              // undetected because this cancel was silent). Throttled so a closed-mouth
              // session doesn't spam.
              if (suppressAuto && !noiseBlip && Date.now() - lastSuppressEchoAt > 10000) {
                lastSuppressEchoAt = Date.now();
                say("info", `auto-reply suppressed (mouth ${suppressRestoreAt ? "in recovery window" : "CLOSED by MIND"})`);
              }
              // Starvation fix (fire17, 2026-08-20): a REAL user turn whose auto-reply was
              // cancelled only because MIND audio was playing still deserves its answer —
              // mark it and release it the moment the MIND's audio ends (mouth first).
              // `!emptyRoom` is the FOURTH exclusion and it is not optional (W38 verify, HIGH):
              // without it the empty-room belt is bypassed on its own path. A parked call under
              // presence self-prompts on the server's idle timer while MIND audio plays; the
              // cancel above kills that response for being empty-room speech, and this hold then
              // marks it for RELEASE — and the release at the end of the MIND line carries
              // awaitingResponse, which gates the whole cancel branch, so the re-created reply is
              // never re-judged and the mouth delivers a full turn to nobody (and teaches
              // rememberSpoken/mouth_last a line nobody heard). A response nobody asked for,
              // cancelled because nobody is in the room, is not a starved user turn.
              if (xconv && !organFloor && !mindBusy && !suppressAuto && !noiseBlip && !selfEcho && !emptyRoom) {
                // Held, not swallowed: if that really was a turn for us, it is answered the
                // moment the room is his again (the release above fires it).
                pendingMouthReply = true; pendingMouthAt = Date.now();
                say("info", "mouth reply held — an external conversation is in the room (canon 045)", { external_conversation: true });
              } else if (organFloor && !mindBusy && !suppressAuto && !noiseBlip && !selfEcho && !emptyRoom) {
                pendingMouthReply = true; pendingMouthAt = Date.now();   // released the moment the floor frees — queued, not swallowed
                say("info", `mouth reply held behind ${organFloorWho} audio — will release`, { floor: organFloorWho });
              } else if (mindBusy && !suppressAuto && !noiseBlip && !selfEcho && !emptyRoom) {
                pendingMouthReply = true; pendingMouthAt = Date.now();
                say("info", "mouth reply held behind mind audio — will release");
              } else if (recoveryWindow && !mindBusy && !noiseBlip && !selfEcho && !emptyRoom && !organFloor && !xconv) {
                // HELD, NOT SWALLOWED — the 22% fix (call 3357: this cancel fired 10x in 7 minutes
                // and the engine's OWN discriminator afterwards refused to call 7 of those turns an
                // echo; 7 of 32 turns of his were answered with nothing. His words 18:44: he speaks
                // the instant the mouth stops and gets no reply).
                //
                // Timing cannot decide this at birth, and a measured replay proved it: the resent
                // clip plays through the speaker and re-enters the mic, so ITS speech_started also
                // lands after the resend committed (+297ms, +142ms, +206ms on the three CONFIRMED
                // echoes of call 3357 — indistinguishable from his live turns at +170/+169/+192ms).
                // A speech_started > recoverSentAt rule would have released all three true echoes.
                //
                // The only thing that can decide it is the echo discriminator, and it needs the
                // transcript, which lands ~300ms LATER. So the reply is not killed here — it is
                // parked, exactly as it is behind MIND audio, and released below the moment the
                // discriminator declines to call the turn an echo. A confirmed echo never reaches
                // that release: its own path deletes the item and clears the hold.
                recoveryHeldReply = true;
                say("info", "mouth reply held behind overlap recovery — released unless the turn proves to be our own echo", { recovery_hold: true });
              } else if (mindBusy && emptyRoom && !suppressAuto && !noiseBlip && !selfEcho) {
                // NOT INVISIBLE EITHER. The empty-room notice above reports only when nothing
                // else is in play (`!mindBusy`), and this cancel is no longer claimed as a held
                // turn — so without this line the cancel would leave no trace at all. jsonl only:
                // an unattended call self-prompts every ~15s and the console must stay readable.
                rec({ ev: "info", text: "auto-reply into an empty room cancelled while mind audio played — NOT held (nobody has spoken yet this call)",
                  empty_room: true, mind_busy: true });
              }
              break;
            }
          }
          responseActive = true;
          mindResponse = awaitingResponse;   // if we sent this response.create, it's the MIND speaking
          if (!awaitingResponse) pendingMouthReply = false;   // a REAL covering auto-reply is now active — the supersede is genuine (see speech_started note)
          awaitingResponse = false;   // the send we were awaiting has now materialized
          break;
        case "response.output_item.added":
          // The assistant message whose audio is about to play — barge-in truncates THIS.
          if (ev.item?.type === "message") { curItemId = ev.item.id; itemFirstDeltaAt = 0; itemQueuedMs = 0; }
          break;
        case "input_audio_buffer.committed":
          if (recoverSentAt && !recoveredItemId && ev.item_id) {
            recoveredItemId = ev.item_id;
            rec({ ev: "info", text: `recovered audio committed as ${ev.item_id}` });
          }
          break;
        case "input_audio_buffer.speech_started":
          speechStartedAt = Date.now();
          userSpeaking = true;   // stack law: MIND lines hold from this instant
          // Fresh latch — the stuck-latch timeout clock starts here, with no voice heard yet.
          lastVoiceAt = Date.now(); latchVoiceMs = 0; latchHadVoice = false; latchTimedOut = false;
          // Supersede fix (EVA's 17:01 question, proven real): the held-reply clear used to
          // happen HERE, at speech_started — before the turn's duration is even knowable. A
          // noise blip (<minSpeech, frequent at VAD 500) would clear the hold and then its own
          // cancelled auto-reply never re-held (the !noiseBlip guard) — his ONLY pending answer
          // silently dropped: "הוא לא מגיב לי" cause #2, independent of E128. The hold now
          // survives until a REAL covering reply materializes (cleared in response.created when
          // a live auto-reply goes active) or the release at mind-audio end fires.
          // Barge-in done RIGHT (R7): cancel generation, tell the server how much was
          // actually heard, and drop the cancelled response's still-in-flight deltas —
          // otherwise the model's context keeps words the user never heard, and ghost
          // audio plays after the interrupt.
          // Only cancel a response that is genuinely still generating — speaking can lag
          // response.done by one event, and cancelling a finished response draws a
          // "response_cancel_not_active" error for nothing.
          // SELF-CUT GUARD (call 31192). In duplex mode the server VAD fires on our own speaker
          // leak, and this branch then cancels the mouth mid-sentence: 40/40 of that call's cuts
          // landed within 200ms of a speech_started and NONE of them was him. So while the mouth
          // is audible, believe the VAD only when the local mic evidence gathered in pumpMic
          // (peak >= MOUTH_BARGE_PEAK sustained MOUTH_BARGE_MS) is fresh. Measured: that evidence
          // never appeared anywhere in 31192's leak (max 85ms sustained), so all 40 self-cuts
          // would have been blocked; the cost of a mis-block is that the mouth finishes its
          // sentence — exactly the no-duplex behaviour. APIPLAN_MOUTH_BARGE_PEAK=0 disables the
          // detector and with it this gate, leaving duplex trusting the VAD alone (loop risk).
          if (speaking && bargeOn && responseActive
              && (MOUTH_BARGE_PEAK <= 0 || Date.now() - bargeEvidenceAt < 1500)) {
            duplexMouthCut("vad");
          }
          break;
        case "input_audio_buffer.speech_stopped":
          if (speechStartedAt) lastSpeechMs = Date.now() - speechStartedAt;
          userSpeaking = false;
          // P9: remember the quiet clock this turn is about to overwrite. If the turn turns out to
          // be our own speaker echo, the stack law must measure its 2.5s of silence from the last
          // GENUINE turn — so the echo verdict can put this number back exactly as it was.
          prevSpeechStopAt = lastSpeechStopAt;
          lastSpeechStopAt = Date.now();
          latchTimedOut = false; latchVoiceMs = 0; latchHadVoice = false;   // the server closed the turn — the local latch is moot
          // This turn's own clock, for the echo timing belt (consumed by its transcript below).
          speechTurns.push({ startedAt: speechStartedAt, ms: lastSpeechMs, stopAt: lastSpeechStopAt, prevStopAt: prevSpeechStopAt });
          if (speechTurns.length > 4) speechTurns.shift();
          // P9: every turn-end enters the history as GENUINE. Only a transcript can demote it.
          stopHistory.push({ stopAt: lastSpeechStopAt, echo: false });
          if (stopHistory.length > 8) stopHistory.shift();
          // Held MIND lines flow once his turn REALLY lands — the sustained-silence gate
          // inside flushInjectQueue re-holds if he resumes within 2.5s.
          if (injectQueue.length) setTimeout(flushInjectQueue, 2600);
          break;
        case "conversation.item.input_audio_transcription.completed":
          // Overlap recovery done: the recovered turn transcribed — reopen the mouth to
          // whatever it was before (MIND's explicit {"autospeak"} always wins, see below).
          // Keyed on recoverSentAt: a LIVE turn's lagging transcript arriving before the
          // resend committed must NOT restore early (verified race — the mouth would
          // auto-answer the recovered turn).
          {
            // ITEM-BOUND RECOVERY. `suppressRestoreAt && recoverSentAt` is a process-global
            // WINDOW, so the FIRST transcript to land inside it used to claim the recovery path —
            // his LIVE turn included, judged at the loose recovery bar with the power to delete.
            // Recovery is now the identity of the item the server built from the resent audio;
            // the suppressAuto restore keeps the old window key, because it must fire even if
            // that commit event never arrives.
            // Read-and-clear: whatever this transcript turns out to be, the hold is consumed here.
            // A turn the discriminator deletes therefore never reaches the release below.
            const heldForRecovery = recoveryHeldReply; recoveryHeldReply = false;
            const inRecoveryWindow = !!(suppressRestoreAt && recoverSentAt);
            if (inRecoveryWindow) { suppressAuto = savedSuppress; suppressRestoreAt = 0; recoverSentAt = 0; }
            const wasRecovered = !!ev.item_id && ev.item_id === recoveredItemId;
            if (wasRecovered) recoveredItemId = null;
            const tScript = ev.transcript?.trim() ?? "";
            // P9: this turn's verdicts start clean. They are read further down the same event —
            // outside this block, where the stale-queue law and the auto-reply gates live — and a
            // verdict left over from the previous transcript would silence a real turn.
            echoTurnSuspect = false; echoTurnEchoish = false; echoTurnTeeth = false; externalMarked = false;
            echoTurnChars = tScript.replace(/\s+/g, "").length;
            echoTurnShort = echoTurnChars > 0 && echoTurnChars < SHORT_MIN_CHARS && !SHORT_OK.has(tScript);
            // This turn's own speech clock — never the globals, which any later turn overwrites.
            const turn = speechTurns.shift();
            const turnStartedAt = turn?.startedAt ?? 0; const turnMs = turn?.ms ?? 0;
            // ── CANON 041 CAPS GATE — the turn never becomes a `you` event ────────────
            // His words: "אני רוצה להיות מסוגל לדבר בפרטיות כשהקפסולה סגורה." Caps closed for the
            // WHOLE of this turn means it reaches no responder: not the mouth, not an organ, not
            // the canon. Placed here (E535) so compliance is structural — nothing downstream has
            // to remember, because there is nothing downstream to remember about.
            // The archive is UNTOUCHED and that is the point of 041: record everything, publish
            // nothing. archWrite() ran per frame far above this, canon 047's caps-off sweeper
            // still receives its engine turn-WAVs, and the words remain recoverable from disk.
            // The item is deleted from the MODEL's context too — a turn the mouth must not react
            // to must not sit in its history either.
            if (tScript && turnStartedAt > 0 && capsOnAt < turnStartedAt) {
              turnsTranscribed++; sessTurnsTranscribed++;
              // Logged as a COUNT and a duration, never as text: the whole point is that these
              // words do not enter a surface the body reads, and the LOG is such a surface.
              say("info", `caps closed — turn withheld from every responder (${turnMs}ms, ${tScript.length} chars, recorded not published — canon 041)`,
                { caps_withheld: true, speech_ms: turnMs, chars: tScript.length, item_id: ev.item_id ?? null });
              if (ev.item_id) { try { ws.send(JSON.stringify({ type: "conversation.item.delete", item_id: ev.item_id })); } catch {} }
              // WITHHOLDING THE TRANSCRIPT IS NOT ENOUGH — the server may already have created a
              // reply to it (the transcript routinely lands AFTER response.created), and a mouth
              // answering a caps-closed turn is the exact thing he asked to be impossible. Two
              // doors, because the reply can be on either side of this moment:
              //   in flight — cancel it, guarded by curResponseBornAt >= turnStartedAt so a reply
              //   belonging to an EARLIER turn is never collateral (the same guard the echo teeth
              //   learned the hard way on call 31599);
              //   not yet born — ECHO_HOLD_MS reaches forward one create, which is precisely the
              //   job that flag already exists for.
              if (responseActive && !mindResponse && !closing && curResponseBornAt >= turnStartedAt) {
                try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
                if (curResponseId) cancelledResponses.add(curResponseId);
                responsesCancelled++; sessResponsesCancelled++;
                responseActive = false;
              }
              echoHoldUntil = Date.now() + ECHO_HOLD_MS;
              pendingMouthReply = false;   // and nothing parked may be released into a caps-closed turn
              flushReply();
              break;
            }

            // TEXT BELT. A recovered turn is judged against everything we spoke; a LIVE turn only
            // against the last 45s, at the raised bar, and only ever to be flagged.
            const m = tScript ? echoScore(tScript, wasRecovered ? Infinity : 45000) : { score: 0, src: "" };
            const echoish = m.score >= (wasRecovered ? ECHO_BAR : ECHO_LIVE_BAR);
            // TIMING BELT (EVA forensics, 31/31 across three live calls). A turn is resend-sourced
            // iff an `audio resent (Xs)` committed <= 2s before ITS speech_started AND the turn
            // CLOSED far faster than the audio appended to it. Bulk append is the tell: the server
            // ends a resent turn on its own 1.1s silence tail regardless of content length
            // (measured 0.5-1.2s of turn for 2.8-19.6s of audio), while a live turn cannot stop
            // before the speech inside it ends (every genuine turn in the corpus ran 2.98-104.73s,
            // n=31). The 1500ms FLOOR keeps a LONG resend from making a merged turn — his voice
            // inside a 19.6s window — look bulk-appended on a bare `<`.
            const bulkAppended = !!lastResendAt && turnStartedAt >= lastResendAt
              && turnStartedAt - lastResendAt <= 2000 && turnMs > 0 && lastResendMs - turnMs > 1500;
            // RESIDUAL TEST — the sacred rule made structural (fire17: the human is NEVER
            // censored). `conversation.item.delete` removes a WHOLE item, and a recovered item can
            // carry leak AND his live speech together: 44292@15:05:38 was a verbatim MIND tail
            // followed by his own question "ולגבי התיקון?" and scores 1.00 on text alone. So before
            // anything is removed, strip the part our own speech explains and require NOTHING to
            // be left. Any residue at all — a short answer, a question mark — and it is FLAGGED.
            const residual = echoish ? echoResidual(tScript, m.src) : "";
            // ── ECHO TURNS DO NOT DRIVE THE STACK LAW (P9, call 97289) ────────────────
            // THE MIND's order, verbatim (bus 2026-08-23 03:00:56): "a you-turn flagged as echo
            // must NOT count as 'user speaking' / 'new user turn' for the stack law, and the mouth
            // must not auto-reply to it. two MIND lines sat unspoken for ~4 min while the mouth
            // answered its own echoes."
            // WHY IT HAS TO BE UNDONE RATHER THAN PREVENTED: measured on 97289, the engine's own
            // 11.9s resend raised input_audio_buffer.speech_started 194ms after `audio resent`,
            // and the echo verdict landed 290ms after THAT. The latch and the quiet clock are
            // therefore set by OUR audio before anything can know it was ours — by construction,
            // on every call. So the verdict reverses them here, at the first instant it exists.
            // THE ENGINE'S OWN VERDICT, NOT A NEW HEURISTIC: `echoish || bulkAppended` is exactly
            // the `suspect` the annotation branch below stamps as echo_sim / echo_belt. One
            // definition, read twice. RELEASE-ONLY: this can undo a hold, never create one.
            echoTurnSuspect = !!tScript && (echoish || bulkAppended);
            echoTurnEchoish = !!tScript && echoish;
            if (echoTurnSuspect) {
              let holdReleased = false;
              // (a) the latch. Ours to clear only while it is still THIS turn's latch: a genuine
              // turn that started later owns it now, and clearing that would drop a MIND line
              // straight over his voice — the one thing the stack law exists to prevent.
              if (userSpeaking && turnStartedAt > 0 && speechStartedAt === turnStartedAt) { userSpeaking = false; holdReleased = true; }
              // (b) the 2.5s quiet clock, restored to the last GENUINE turn — same identity test,
              // so a later real turn's clock is never rolled back underneath it, and the walk-back
              // crosses a whole echo storm rather than one hop (stopHistory, declared above).
              if (turn && turn.stopAt) {
                const h = stopHistory.find((e) => e.stopAt === turn.stopAt);
                if (h) h.echo = true;
                const genuine = [...stopHistory].reverse().find((e) => !e.echo);
                const restored = genuine ? genuine.stopAt : turn.prevStopAt;
                // Only ever BACKWARD, and only while the clock is still this echo turn's own.
                if (lastSpeechStopAt === turn.stopAt && restored < lastSpeechStopAt) { lastSpeechStopAt = restored; holdReleased = true; }
              }
              if (holdReleased || injectQueue.length) {
                say("info", `echo turn ignored by stack law (hold released / stale reverted) — sim ${m.score.toFixed(2)}${bulkAppended ? " +timing" : ""}, hold ${holdReleased ? "released" : "was not ours"}, queue ${injectQueue.length}`,
                  { echo_stack_ignored: true, hold_released: holdReleased, echo_sim: Number(m.score.toFixed(2)),
                    echo_belt: `${echoish ? "text" : ""}${echoish && bulkAppended ? "+" : ""}${bulkAppended ? "timing" : ""}`, queue: injectQueue.length });
              }
              // Held lines flow on the NORMAL gate, now measured from his last real turn — never
              // immediately: flushInjectQueue re-reads userSpeaking and the 2.5s window at fire time.
              if (injectQueue.length) setTimeout(flushInjectQueue, 0);
            }
            // TEETH — ONE definition, TWO doors (call 31599, 2026-08-20). A reply born from a turn
            // that is a moment later judged echo must die no matter WHICH belt judged it. 099e723
            // gave teeth to the live text belt only; the RECOVERY delete below leaned entirely on
            // the response.created suppression, which holds only while suppressAuto is still armed
            // — and this same handler restores it a few lines up (inRecoveryWindow), so a reply
            // the server creates AFTER the transcript lands has nothing holding it at all. Same
            // cancel, same truncate, same forward-reaching hold, both doors. HIS WORDS ARE NEVER
            // TOUCHED: the turn is already logged and emitted byte-identical — only our answer to
            // it dies.
            const echoTeeth = (door: string) => {
              echoTurnTeeth = true;   // P9: a door has RULED on this turn's reply — including its
                                      // deliberate "leave the mouth alone"; the belt below never
                                      // second-guesses that decision.
              // E128's DISCRIMINATOR, ON THE RECOVERY DOOR TOO (call 31599, W36 verify). A recovery
              // transcript can land LATE — 2.0s after the response it belongs to, measured on 31599
              // — and by then a GENUINE live turn may already be under way. `turnStartedAt` is the
              // RECOVERED turn's clock, always EARLIER, so `curResponseBornAt >= turnStartedAt` is
              // true for HIS reply as well: the teeth would cancel it, truncate what he heard, drop
              // a held answer to an even earlier real turn and gag the mouth for ECHO_HOLD_MS,
              // killing the next create at birth too. That is exactly the "הוא לא מגיב לי" class
              // this file already closed twice (E128 below, the supersede fix at speech_started).
              // The tell is the same one E128 uses: a speech_started LATER than this turn's start
              // means a real turn has begun, and its answer is not ours to kill. Only the recovery
              // door needs it — the live door judges the turn that just closed.
              // TRADE, honestly: an echo reply born BEFORE that live turn keeps speaking here; the
              // live turn's own barge and TEETH doors are what cut it. Nothing of his is touched
              // on either path — his turn is already logged and emitted byte-identical.
              // TIGHTENED (W38 verify): `speechStartedAt` is the GLOBAL newest start, while
              // `turnStartedAt` came off the FIFO — so a SECOND queued echo turn from the same
              // resend reads as "a live turn is in flight" and disarms the teeth on the first
              // one, leaving an echo-born reply speaking until the second transcript lands. A
              // speech_started that falls inside the window the resend was still streaming is
              // OUR OWN audio, not him: only a start outside it counts as a live turn.
              // TRADE, stated honestly: `lastResendMs` is the DURATION of the audio resent, not
              // wall time, and a bulk append is consumed far faster than it plays — so on a long
              // resend this window is wider than the burst it describes, and a GENUINE live turn
              // starting inside it is judged not-stale, i.e. E128's protection is narrower there.
              // Bounded: the corpus (n=31) has every resend-sourced turn starting within 2s of
              // the resend, the echo verdict itself is required before any of this runs, and
              // nothing of his is touched on either path — only our answer dies.
              const stale = door !== "live" && speechStartedAt > turnStartedAt
                && !(lastResendAt && speechStartedAt >= lastResendAt && speechStartedAt - lastResendAt <= lastResendMs);
              if (!stale) {
                echoHoldUntil = Date.now() + ECHO_HOLD_MS;   // reaches the NEXT create, not yet born
                pendingMouthReply = false;                   // and the one parked behind MIND audio
              }
              if (!stale && responseActive && !mindResponse && !closing && turnStartedAt > 0 && curResponseBornAt >= turnStartedAt) {
                try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
                if (curResponseId) cancelledResponses.add(curResponseId);   // its in-flight deltas are dead
                responsesCancelled++; sessResponsesCancelled++;
                if (curItemId) {
                  const heardMs = itemFirstDeltaAt ? Math.max(0, Math.min(Date.now() - itemFirstDeltaAt, itemQueuedMs)) : 0;
                  try { ws.send(JSON.stringify({ type: "conversation.item.truncate", item_id: curItemId, content_index: 0, audio_end_ms: Math.round(heardMs) })); } catch {}
                }
                responseActive = false; awaitingResponse = false;
                stopPlayer(); speaking = false;
                playingUntil = Date.now() + 250;   // swallow the kill tail — reopening at 0 lets it transcribe
              }
              if (stale) say("info", `self-echo — recovery echo classified, but a live turn is in flight: the mouth is LEFT ALONE (sim ${m.score.toFixed(2)}), his turn kept in full`,
                { echo_suppressed: false, echo_door: door, echo_stale: true, echo_sim: Number(m.score.toFixed(2)), echo_src: m.src.slice(0, 200),
                  turn_started_at: turnStartedAt, live_speech_at: speechStartedAt });
              else say("info", `self-echo — auto-reply SUPPRESSED ${ECHO_HOLD_MS}ms (sim ${m.score.toFixed(2)}, ${door}), his turn kept in full`,
                { echo_suppressed: true, echo_door: door, echo_sim: Number(m.score.toFixed(2)), echo_src: m.src.slice(0, 200) });
            };
            if (wasRecovered && echoish && bulkAppended && infoFree(residual)) {
              // HIS WORDS NEVER LEAVE THE LOG. The item is removed from the MODEL'S CONTEXT only —
              // the turn is still recorded and still emitted, carrying the evidence that removed
              // it, so even a wrong decision loses nothing: what he said stays in the log stream
              // and on the dashboard, byte-identical, forever.
              // COUNTED HERE TOO: "turns the server transcribed" must mean what it says. This
              // branch `break`s before the counter below it, so an echo storm — the very moment the
              // triple is read — used to UNDER-report turns and make a 0/0/N look milder than it is.
              turnsTranscribed++; sessTurnsTranscribed++;
              say("you", tScript, {
                echo_deleted_from_context: true, echo_sim: Number(m.score.toFixed(2)),
                echo_src: m.src.slice(0, 200), echo_recovered: true, echo_belt: "text+timing+residual",
                resent_ms: Math.round(lastResendMs), speech_ms: turnMs, item_id: ev.item_id ?? null,
              });
              say("info", `recovered turn was speaker echo — removed from the model's context, KEPT in the log (sim ${m.score.toFixed(2)}, resent ${Math.round(lastResendMs)}ms vs turn ${turnMs}ms, no residual)`);
              if (ev.item_id) { try { ws.send(JSON.stringify({ type: "conversation.item.delete", item_id: ev.item_id })); } catch {} }
              echoTeeth("recovery");   // the item is gone; a reply born from it must go too, and the next create is held
              flushReply();
              break;
            }
            // LEAK FRAGMENT — the belt above needs the text to MATCH; this one needs it to be
            // out-of-language garbage. Both doors remove the item from the model's context and
            // both keep his log byte-identical. Measured on call 96642 (3h34m, 248 you-turns):
            // 7 removals, every one recogniser garbage off a leak resend ("Taipujepanu.",
            // "OK, regal.", "avouer.", "Tamam.", "Hallo.", "Ismét elő.", "我不会。"), and ZERO
            // real turns — his three resend-carved Hebrew turns in that call (01:02:18, 01:58:58
            // "בבקשה תגביר את הווליום של ההקלטה.", 02:13:02) all survive it.
            if ((wasRecovered || bulkAppended) && !echoish && leakFragment(tScript)) {
              turnsTranscribed++; sessTurnsTranscribed++;
              say("you", tScript, {
                echo_deleted_from_context: true, echo_leak_fragment: true,
                echo_sim: Number(m.score.toFixed(2)), echo_recovered: wasRecovered,
                echo_belt: `leak-fragment${bulkAppended ? "+timing" : ""}`,
                resent_ms: Math.round(lastResendMs), speech_ms: turnMs, item_id: ev.item_id ?? null,
              });
              say("info", `recovered leak fragment — removed from the model's context, KEPT in the log (${echoNorm(tScript).length} chars, no in-language content, resent ${Math.round(lastResendMs)}ms vs turn ${turnMs}ms)`);
              if (ev.item_id) { try { ws.send(JSON.stringify({ type: "conversation.item.delete", item_id: ev.item_id })); } catch {} }
              echoTeeth("leak-fragment");   // an answer born from garbage dies with it
              flushReply();
              break;
            }
            // FLAG, NEVER DROP. Anything else that smells of leak — a live turn, a mixed or
            // partial recovery, one belt without the other, a residual that survived — is
            // ANNOTATED: additive fields on the ev:"you" record (the text stays byte-identical)
            // plus one info line. The turn still prints, still reaches the model, still reaches
            // the dashboard. Contract: docs/eva-annotation-contract.md.
            if (tScript) {
              turnsTranscribed++; sessTurnsTranscribed++;
              const suspect = echoish || bulkAppended;
              // ── EXTERNAL-SUSPECT MARK, at commit time (E605/E606) ─────────────────────
              // COMMIT TIME, not speech time, is the clock Eva measured: a leak's speech STARTS
              // inside the window (it IS the window's audio), so a start-time test reads negative
              // and marks nothing. The corridor she found — leaks at +0.7/+2.8/+12.1s, the next
              // non-Hebrew turn at +316.0s — is a corridor of COMMITS.
              // NOTHING BELOW THIS LINE IS GATED BY IT: say("you") runs byte-identical either way,
              // the archive was written per frame far above, the item stays in the model's context
              // and the canon still receives the turn. The single consequence is the belt at the
              // bottom of this handler, which cancels the mouth's own auto-reply.
              // DELIBERATELY NOT TOUCHED: the language profile below. A marked turn still teaches
              // it exactly what it taught before — narrowing that would change a second thing,
              // and the mark is allowed to change one.
              // THE SPEC, in the MIND's and Eva's words (bus E606, 2026-08-23 05:01:18) — the one
              // sentence this whole mechanism obeys:
              //     "THE THRESHOLD BELONGS TO THE CONSEQUENCE, NOT TO THE SIGNAL"  — Eva
              // 60s is right for a MARK and catastrophic for a SUPPRESSION, so the consequence is
              // a mark. MARK, NEVER SUPPRESS: this line decides one thing and one thing only.
              externalMarked = externalSuspect(tScript, Date.now());
              // LANGUAGE PROFILE: only turns NO belt suspects teach it which language he speaks,
              // so leak garbage can never talk the belt out of firing on more leak garbage.
              if (!suspect) { cleanTurns++; if (hasHebrew(tScript)) cleanHebrew++; }
              if (suspect) say("info", `possible speaker echo — turn FLAGGED, not removed (${echoish ? "text" : "—"}/${bulkAppended ? "timing" : "—"}${echoish && residual ? ", residual kept" : ""})`);
              // The mark travels ON the you-record (an additive field, the text untouched) so the
              // MIND and Eva both see it without reading a second line.
              const ann: Record<string, unknown> = suspect ? {
                echo_suspect: true, echo_sim: Number(m.score.toFixed(2)),
                echo_belt: `${echoish ? "text" : ""}${echoish && bulkAppended ? "+" : ""}${bulkAppended ? "timing" : ""}`,
                echo_recovered: wasRecovered, echo_residual: residual.slice(0, 200),
                resent_ms: Math.round(lastResendMs), speech_ms: turnMs,
              } : {};
              if (externalMarked) {
                ann.external_suspect = true; ann.external_belt = "lang+xconv";
                ann.xconv_since_ms = xconvHeld() ? 0 : xconvSinceClose(Date.now());
              }
              say("you", tScript, (suspect || externalMarked) ? ann : undefined);
              if (externalMarked) say("info", "turn marked external-suspect (lang+xconv) — the mouth will not auto-reply; his words are logged, archived and kept in full",
                { external_suspect: true, external_belt: "lang+xconv", xconv_since_ms: xconvHeld() ? 0 : xconvSinceClose(Date.now()) });
              // RELEASE THE PARKED REPLY (call 3357). Reaching this line means the turn was
              // KEPT — the discriminator either found no echo or declined to call it one, and
              // it is now in the model's context. The answer it was owed is created here.
              if (heldForRecovery && !mindBusy && !suppressAuto && !responseActive && !awaitingResponse
                  && !closing && ws.readyState === WebSocket.OPEN) {
                say("info", `mouth reply released — overlap recovery did not claim this turn${suspect ? " (flagged, not removed)" : ""}`, { recovery_release: true, echo_suspect: suspect });
                try { ws.send(JSON.stringify({ type: "response.create" })); awaitingResponse = true; } catch {}
              }
              // ── PRESENCE GATE: the opening line waits for a proven listener ────────────
              // This is the ONE place the engine learns a human is really there. A you-turn
              // that arrives with none of the echo annotations — `suspect` is exactly
              // echo_suspect, the echo_deleted_from_context branch already returned above,
              // and the echo_suppressed hold cannot arm without `echoish` ⇒ `suspect` — is
              // presence. AT ARRIVAL is deliberate: a later belt may reclassify this turn,
              // but waiting for that verdict would hold his greeting hostage to a window with
              // no upper bound; the cost of the rare wrong fire is ONE spoken line, and never
              // a word of his (say("you") above already logged it byte-identical).
              // REAL SPEECH ONLY (W36 verify). `openerArmed && !suspect` alone fires on a VAD NOISE
              // BLIP: at VAD 500 blips are frequent, a blip's own auto-reply is cancelled by the
              // noise gate (so nothing reads as busy), and a short blip transcribes to hallucinated
              // words — "Thank you.", "you" — which score 0 on the echo belts and are never
              // flagged. The opening line would then go out into exactly the empty room presence
              // mode exists to protect. The bar is the engine's OWN, read from THIS turn's clock:
              // the same APIPLAN_MIN_SPEECH_MS the mouth's noise gate uses. Under the bar the
              // opener stays ARMED — his real first turn still releases it.
              const minSpeech = Number(process.env.APIPLAN_MIN_SPEECH_MS) || 500;
              // PER-TURN ANSWER WATCH. The same bar the opener uses — a real, unflagged turn of his
              // — is exactly the bar for "he is owed an answer". On 11776 four such turns in a row
              // drew no response.created at all and nothing anywhere noticed; from here, each one
              // that goes unanswered says so within seconds, whatever the cause.
              // THIS TURN'S OWN START goes with it (`turnStartedAt`, off the same FIFO pair this
              // branch already read): the server creates the answer BEFORE the transcript arrives,
              // so "was anything created since the transcript" is a question whose answer is
              // almost always no on a perfectly healthy call. "Was anything created since HE
              // started speaking" is the question that was meant. Guaranteed > 0 here: the
              // `turnMs >= minSpeech` bar cannot pass without a paired speech turn.
              if (!suspect && turnMs >= minSpeech && turnStartedAt > 0) {
                lastRealTurnAt = Date.now(); lastRealTurnStart = turnStartedAt;   // mind-never-interrupts: he is owed an answer before held MIND lines flow
                watchAnswer(lastRealTurnAt, turnStartedAt);
              }
              if (openerArmed && !suspect && turnMs >= minSpeech) {
                // DO NOT RACE THE SERVER (W36 verify). sendGreeting sets awaitingResponse, and
                // response.created reads it as `mindResponse = awaitingResponse` — so firing in the
                // same tick as the server's VAD reply to this very turn (created 4ms after
                // speech_stopped on 31599, its response.created not yet dispatched here) would
                // stamp HIS reply MIND-initiated, disabling the noise gate, the mouth-barge cancel
                // and both TEETH doors on it, with two responses free to speak over each other.
                // A short recheck timer lets that response.created land first, and every covering
                // state is re-read AT FIRE TIME rather than now.
                openerArmed = false;   // scheduled — re-armed inside if the mouth turns out merely CLOSED
                setTimeout(() => {
                  if (closed || closing || greeted || ws.readyState !== WebSocket.OPEN) return;
                  // NEVER DOUBLE-GREET. If the mouth is already speaking to him — its own VAD
                  // auto-reply to this very turn (the normal case), a MIND line in flight or
                  // parked behind one — then his first words are already being answered, and an
                  // opening line on top of that is a second voice. THAT fold is a real discharge:
                  // he was spoken to, so the one-shot is spent.
                  const covering = responseActive || awaitingResponse || speaking || mindBusy || pendingMouthReply;
                  if (covering) {
                    // A fold is a real discharge — so it must spend the CONNECTION, not just the
                    // arm. Before this line it cleared openerArmed and left `greeted` false, and
                    // the next session.updated on this same socket re-armed a spent one-shot.
                    announcedThisConn = true;
                    say("info", "opening line folded into his first answer — the mouth was already speaking (LM_GREET=presence)", { opener: "folded" }); return; }
                  // ONE-SHOT ECONOMY (W36 verify). A CLOSED mouth is NOT an answer. suppressAuto is
                  // armed for the whole recovery window and for the whole call under
                  // APIPLAN_VAD_CREATE_RESPONSE=0, and the fold's premise — "his first words are
                  // already being answered" — is then simply false: he would speak, receive
                  // nothing at all, and the opening line would be gone for the rest of the call.
                  // Hold it instead; it releases on his next turn once the mouth reopens.
                  if (suppressAuto) {
                    // STRUCTURAL vs TRANSIENT (W38 verify). Holding is right for a RECOVERY
                    // window — suppressAuto lifts in seconds and the opener still gets spent on
                    // him. Under APIPLAN_VAD_CREATE_RESPONSE=0 the mouth is closed for the WHOLE
                    // call by configuration: it never reopens, so the hold can never discharge,
                    // and the notice below would re-fire on every unflagged turn for the entire
                    // call while the opening line stays owed forever. In that mode the MIND is
                    // the voice — his first words ARE being answered — so the one-shot is spent,
                    // exactly like the `covering` fold above.
                    if (process.env.APIPLAN_VAD_CREATE_RESPONSE === "0") {
                      announcedThisConn = true;   // spent for this connection, same as the fold above
                      say("info", "opening line folded — the mouth is closed for this whole call (APIPLAN_VAD_CREATE_RESPONSE=0); the MIND is the voice that answers him (LM_GREET=presence)",
                        { opener: "folded", reason: "mouth closed for the call" });
                      return;
                    }
                    openerArmed = true;
                    // Throttled like the empty-room cancel, and for the same reason: the state is
                    // worth SEEING, once a minute — not once per turn. Every hold still lands in
                    // the jsonl, so the record loses nothing.
                    if (Date.now() - lastOpenerHeldAt > 60000) {
                      lastOpenerHeldAt = Date.now();
                      say("info", "opening line held — the mouth is closed; it releases on his next turn once the mouth reopens (LM_GREET=presence)", { opener: "held" });
                    } else rec({ ev: "info", text: "opening line held (throttled) — the mouth is still closed", opener: "held", throttled: true });
                    return;
                  }
                  sendGreeting("opening line released — first unflagged turn confirms a listener (LM_GREET=presence)");
                }, Number(process.env.APIPLAN_OPENER_DELAY_MS) || 250);
              }
            }
            // TEETH — the flag must COST the mouth its answer (call 31192, 2026-08-20: the FULL
            // ECHO FEEDBACK LOOP, ~30 turns of the mouth replying to itself, his ears cut ~7x).
            // The belt above was NOT blind on that call: eleven live you-turns carried
            // echo_sim 1.00 — the mouth's own sentence word for word — and every one of them was
            // merely ANNOTATED. A live turn had no consequence anywhere in this handler, so the
            // VAD auto-reply the server created 2ms after speech_stopped went on speaking, ITS
            // audio leaked back through the mic (open during playback under barge), and the next
            // turn was the next echo. The transcript ALWAYS lands while that response is still
            // generating — 250-900ms of margin, measured on every turn of the loop — so this is
            // exactly where the loop can be cut, and the only place it can.
            // HIS WORDS ARE NEVER TOUCHED: say("you") above already logged and emitted the turn
            // byte-identical, and it stays in the model's context. Only OUR OWN answer to it
            // dies. Flag + suppress breaks the loop without censoring one syllable of his.
            // Guards: never a MIND-initiated response (it owes nothing to this turn), never one
            // born BEFORE this turn's speech started (E128's guard — that reply belongs to the
            // previous, real turn), never while closing, and never on the recovery path, where
            // the response.created cancel already holds the mouth.
            if (tScript && echoish && !wasRecovered && !inRecoveryWindow) echoTeeth("live");
            // ── THREE-WAY RESUME, piece 3 + assembly (canon 027) ──────────────────────
            // His interjection just landed — the FIRST completed transcript after the cut,
            // whichever path carried it. All three pieces now exist together: where the reply was
            // (the tail he actually heard), where it stopped (the unspoken remainder), and what
            // he said. HIS LAW 2 (never self-trigger on our own voice): if either echo belt
            // suspects this turn is speaker leak, nothing is resumed — the local loudness barge
            // and the text/timing belts must AGREE that he really spoke.
            if (mouthBarge && tScript) {
              const b = mouthBarge; mouthBarge = null;          // one-shot — a cut is resumed once
              const stale = !b.at || Date.now() - b.at > 45000;
              const suspect = echoish || bulkAppended;
              // A SKIPPED resume deliberately leaves the record's own flags untouched: the
              // UNCONFIRMED timer must still be able to speak. "The interjection after the cut
              // smelled of our own voice" is itself the loudest self-barge tell there is, so it is
              // logged with a machine-readable field rather than quietly swallowed.
              if (stale || suspect) say("info", `mouth-cut resume skipped (${stale ? "cut too old" : "interjection smells of our own voice"})`,
                { mouth_resume_skipped: true, reason: stale ? "stale" : "echo-suspect", heard_ms: b.heardMs, peak: b.peak });
              else {
                b.consumed = true; b.confirmed = true;   // a real resume IS the confirmation
                const heard = b.heard.trim();
                const tail = heard.split(/\s+/).slice(-8).join(" ");
                say("info", `mouth-cut resume — heard-tail "${tail.slice(-60)}", unspoken ${b.remainder.length} chars, interjection ${tScript.length} chars`,
                  { mouth_resume: true, heard_ms: b.heardMs, heard_chars: heard.length,
                    mouth_unspoken: b.remainder.slice(0, 400), recovered: wasRecovered });
                // Dead air after a cut is its own failure: if the mouth is OPEN and nothing is
                // generating or playing, release exactly ONE reply — and carry the three pieces
                // in THAT response's own instructions, out of band. Deliberately NOT a
                // conversation item: a system note would persist for the rest of the call, so two
                // barges would stack two standing "continue where you stopped" instructions that
                // every later, unrelated turn would still read. Instructions die with the reply
                // they steered. The persona rides along so this turn does not lose its voice.
                // NOT for a recovered turn: the older invariant — the response.created cancel
                // guarantees the mouth never answers a recovered turn on its own — is untouched,
                // and the MIND has all three pieces from the log line above either way.
                // DEFECT 6.3 (resume-design G-C, NAMED DEBT — not closed here). In duplex with
                // server-VAD create_response on, the server has already created its own reply by
                // the time this transcript lands (measured margin 250-900ms), so `responseActive
                // || awaitingResponse` is true and this guard refuses. v2's comment implied the
                // continuation was delivered; it is not. What IS delivered is the CUT, the record
                // and the log line above — he gets an answer to his interjection, without the
                // rest of the sentence he cut. Closing it needs resume-design's A4+A5 (a
                // `resumeHold` in the cancel-at-birth disjunction, with the
                // APIPLAN_VAD_CREATE_RESPONSE=0 interlock), which is rung-2 work and carries its
                // own silence risk. Until then the refusal is SAID, out loud, with the reason —
                // silence is what made this invisible in the first place.
                const resumeBlocked = !wasRecovered && !inRecoveryWindow && !suppressAuto && !closing
                  && (responseActive || awaitingResponse || mindBusy || !!prevRespId);
                if (resumeBlocked) say("info", `mouth-cut resume LOGGED but NOT spoken — ${responseActive || awaitingResponse ? "the mouth is already answering his interjection (duplex server-VAD)" : mindBusy ? "the MIND is on the air" : "a predecessor session is still speaking"}; the unspoken ${b.remainder.length} chars are in this record and in the state file, not in his ears (resume-design G-C, rung-2)`,
                  { mouth_resume_blocked: true, reason: responseActive || awaitingResponse ? "reply-active" : mindBusy ? "mind-busy" : "rotation-drain", unspoken_chars: b.remainder.length });
                if (!wasRecovered && !inRecoveryWindow && !suppressAuto && !closing
                    && !responseActive && !awaitingResponse && !mindBusy && !prevRespId && ws.readyState === WebSocket.OPEN) {
                  const resume = `[He cut you off mid-reply — absorb silently, never mention or read out this note.]`
                    + (tail ? ` He heard you only up to: "…${tail}".` : ` He heard almost none of that reply.`)
                    + (b.remainder ? ` You never said the rest: "${b.remainder}".` : ` Nothing of that reply was left unsaid.`)
                    + ` Answer what he just said FIRST, in his language, then continue from exactly where you stopped — never repeat the part he already heard.`;
                  try {
                    ws.send(JSON.stringify({ type: "response.create",
                      response: { instructions: [o.direction, resume].filter(Boolean).join("\n\n") } }));
                    awaitingResponse = true; say("info", "resume reply released");
                  } catch {}
                }
              }
            }
          }
          // Stale-queue law: a completed user turn makes every held MIND line stale —
          // it must be re-woven against these new words, never auto-fired (echo once).
          // P9 (the MIND's order, 97289): "it must not mark the queue STALE / count as a 'new user
          // turn'." An echo turn carries no new words to re-weave against — they are OUR words —
          // and a turn of one junk character carries none either. The verdict is reached earlier in
          // THIS same event (the two delete doors above `break` before this line at all), so the
          // marking is PREVENTED rather than undone: there is no window in which a stale flag set
          // by an echo turn can be observed. A stale flag raised by an EARLIER, genuine turn is
          // deliberately left standing — undoing that would auto-fire a line he never heard rewoven.
          if (ev.transcript?.trim() && injectQueue.length && !queueStale && !echoTurnSuspect && !echoTurnShort) {
            queueStale = true;
            say("info", "mind queue STALE (new user turn) — awaiting re-weave");
          }
          // Noise gate, layer 2 — MECHANISTIC. Long ambient noise (>= minSpeech, so it passed
          // the blip gate) transcribes to an EMPTY string; a VAD auto-reply born from it is a
          // ramble at nothing. Cancel it the moment the empty transcript lands — but never a
          // MIND-initiated response (mindResponse), which owes nothing to this user turn.
          // Audio outranks a missing transcript: a turn with substantial committed speech
          // (2x the blip bar) keeps its reply even when transcription returns empty — a
          // transcription hiccup must never kill a real answer (lane 12 hardening).
          // E128 (EVA, call 31591 15:54+15:56 — "הוא לא מגיב לי בסוף בכלל"): only cancel a
          // response born from THIS empty segment. A blip landing while the PREVIOUS real
          // turn's reply is still generating must never kill that reply — frequent at
          // VAD 500 where a trailing blip becomes its own segment.
          if (!ev.transcript?.trim() && responseActive && !mindResponse && !awaitingResponse && !closing
              && curResponseBornAt >= speechStartedAt
              && lastSpeechMs < 2 * (Number(process.env.APIPLAN_MIN_SPEECH_MS) || 500)) {
            try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
            if (curResponseId) { cancelledResponses.add(curResponseId); responsesCancelled++; sessResponsesCancelled++; }
            responseActive = false;
            say("info", "empty-transcript auto-reply cancelled (noise, not speech)");
          } else if (!ev.transcript?.trim() && responseActive && !mindResponse
              && curResponseBornAt < speechStartedAt) {
            say("info", "empty segment ignored — active reply belongs to the previous real turn (E128 guard)");
          }
          // Noise gate, layer 3 — MIN TRANSCRIPT. Same cancel path as the empty gate directly
          // above, same mindResponse exemption, same E128 born-from-THIS-segment guard. A turn of
          // one non-space character is a recogniser artefact, not speech: on 97289 the single
          // character "A" drew a full spoken reply, and it arrived with no speech_started at all
          // (the previous one was three mute flips and 60s earlier), so lastSpeechMs read 60571ms
          // and the blip gate could never have caught it. Measurement behind the bar of 1: see
          // SHORT_MIN_CHARS.
          if (echoTurnShort && responseActive && !mindResponse && !awaitingResponse && !closing
              && curResponseBornAt >= speechStartedAt) {
            try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
            if (curResponseId) { cancelledResponses.add(curResponseId); responsesCancelled++; sessResponsesCancelled++; }
            responseActive = false;
            say("info", `short-transcript auto-reply cancelled (${echoTurnChars} chars)`, { short_transcript: true, chars: echoTurnChars });
          }
          // Noise gate, layer 4 — THE MOUTH MUST NOT ANSWER AN ECHO (the MIND's order, part c).
          // echoTeeth() already kills the reply on every door that RULED on this turn (live text
          // belt, recovery, leak-fragment) and its deliberate "a live turn is in flight, leave the
          // mouth alone" verdict must stand — that is what `echoTurnTeeth` protects. This belt
          // covers the one gap the forensics found: an echoish turn that reached the flag-only
          // branch (a recovered turn whose residual survived, or one inside the recovery window)
          // and so met no door at all.
          // NARROWER THAN THE HOLD RULE, ON PURPOSE: text-belt agreement only, never
          // timing-belt-only. A genuine turn CAN begin inside a resend window — the timing belt's
          // own comment says so — and killing his real answer is the "הוא לא מגיב לי" defect this
          // file has closed twice already. Releasing a hold early costs 2.5 seconds; cancelling a
          // real reply costs him an answer. HIS WORDS ARE UNTOUCHED either way: say("you") has
          // already logged and emitted the turn byte-identical; only our answer to it dies.
          if (echoTurnEchoish && !echoTurnTeeth && responseActive && !mindResponse && !closing
              && curResponseBornAt >= speechStartedAt) {
            try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
            if (curResponseId) { cancelledResponses.add(curResponseId); responsesCancelled++; sessResponsesCancelled++; }
            responseActive = false;
            say("info", "echo auto-reply cancelled — no door claimed this turn, the mouth was answering itself", { echo_reply_cancelled: true });
          }
          // Noise gate, layer 5 — EXTERNAL-SUSPECT MARK (E605/E606). Same cancel path as the four
          // gates above, same mindResponse exemption, same E128 born-from-THIS-segment guard.
          // THE WHOLE CONSEQUENCE OF THE MARK IS THESE SIX LINES. It cancels the mouth's own
          // auto-reply and does nothing else: no conversation.item.delete, no echoHoldUntil
          // reaching forward into the next create (a forward hold is a time-bound suppression,
          // which is exactly the retracted design), no touch to the you-record above, which has
          // already been logged and emitted byte-identical.
          if (externalMarked && responseActive && !mindResponse && !awaitingResponse && !closing
              && curResponseBornAt >= speechStartedAt) {
            try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
            if (curResponseId) { cancelledResponses.add(curResponseId); responsesCancelled++; sessResponsesCancelled++; }
            responseActive = false;
            say("info", "external-suspect auto-reply cancelled (lang+xconv)", { external_reply_cancelled: true });
          }
          // EVA-ADDRESSED TURN (canon 027): silence the mouth for it, and keep it silent for a
          // beat — the server often creates the reply BEFORE the transcript that proves whose
          // turn it was lands (~300ms), the same race the self-echo hold exists for.
          if (ev.transcript?.trim() && addressedToEva(ev.transcript)) {
            evaAddressedAt = Date.now();
            if (responseActive && !mindResponse) {
              try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
              if (curResponseId) { cancelledResponses.add(curResponseId); responsesCancelled++; sessResponsesCancelled++; }
              responseActive = false;
            }
            say("info", "eva-addressed turn — mouth silenced, Eva answers in her own voice", { addressee: "eva" });
          }
          flushReply();
          // Hangup is irreversible — require REAL speech behind it, not a noise hallucination.
          if (!closing && ev.transcript && isHangup(ev.transcript) && lastSpeechMs >= 400 && !prevRespId) {
            closing = true;
            say("info", "heard a goodbye — closing after the reply");
            // Let it sign off in its own voice, then the response.done below hangs up.
            ws.send(JSON.stringify({ type: "response.create",
              response: { instructions: "The person is ending the call. Say a brief, warm goodbye in one short sentence and nothing else." } }));
            awaitingResponse = true;
          }
          break;
        case "conversation.item.input_audio_transcription.failed":
          speechTurns.shift();   // no transcript will ever consume this turn's pair — keep the FIFO aligned
          if (suppressRestoreAt && recoverSentAt) { suppressAuto = savedSuppress; suppressRestoreAt = 0; recoverSentAt = 0; }
          // Don't strand a held reply for 4s when the transcript simply failed.
          flushReply();
          break;
        case "response.output_item.done":
          // Tool calls arrive as completed function_call items. Only names the caller
          // DECLARED are dispatched — the allow-list is structural, never the model's word.
          if (ev.item?.type === "function_call" && ev.item.name === MOUTH_TOOL.name) {
            runMouthTool(ev.item);
          } else if (ev.item?.type === "function_call" && o.onTool && toolNames.has(ev.item.name)) {
            runTool(ev.item);
          } else if (ev.item?.type === "function_call") {
            rec({ ev: "info", text: `tool ${ev.item.name} refused — not in the declared tool list` });
          }
          break;
        case "response.output_audio.delta":
        case "response.audio.delta":
          if (ev.delta) {
            // A cancelled response's deltas are already dead — playing them is the
            // post-barge ghost-audio bug.
            if (ev.response_id && cancelledResponses.has(ev.response_id)) break;
            if (ev.response_id && ev.response_id !== archLastResp) {   // mouth reply begins = user turn done
              archLastResp = ev.response_id; archRoll("mouth reply");
              speakerCheck(); warnIfUnheard("mouth");                  // LANE 18: async, never blocks the reply
            }
            speaking = true;
            if (!itemFirstDeltaAt) itemFirstDeltaAt = Date.now();
            if (!firstAudioReported) {
              firstAudioReported = true;
              // First audible byte: report latency from an externally-supplied start stamp
              // (LX_T0_MS), so a launcher can measure call → first spoken word.
              const t0 = Number(process.env.LX_T0_MS);
              if (t0 > 0) say("info", `first word in ${Date.now() - t0}ms`);
            }
            // flush(): Bun's stdin is a buffered sink, so without it the audio sits in
            // the buffer instead of reaching the speaker.
            const buf = Buffer.from(ev.delta, "base64");
            queueAudio(buf.length);                          // MONO bytes: stereo doubles the bytes, never the duration
            itemQueuedMs += (buf.length / 2 / RATE) * 1000;
            // The voice field is applied HERE, per chunk — so a knob edit he makes mid-sentence
            // is heard in the very next chunk. No filter graph, no restart, no added latency.
            const pcm = stereo ? panChunk(buf, "mouth") : trimMono(buf, "mouth");
            paceFeed(pcm, (buf.length / 2 / RATE) * 1000);   // canon 013: paced, never dumped
          }
          break;
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done":
          if (ev.transcript?.trim()) {
            // STILLBORN REPLY (call 31599): cancelled at birth AND no audio delta ever reached the
            // player (itemFirstDeltaAt is still 0) = not one syllable was audible, so printing it
            // as a `model` turn tells the MIND the mouth spoke when it did not. Say what happened
            // instead — our own words, never his, and the text is kept verbatim in the log line.
            // A reply cut MID-flight still prints exactly as before: some of it WAS heard.
            if (!itemFirstDeltaAt && cancelledResponses.has(ev.response_id ?? curResponseId ?? "")) {
              // EMPTY ROOM STAYS QUIET (W36 verify). Nobody has spoken ONCE on this call, so this
              // transcript is the parked session's own idle self-prompt (idle_timeout_ms=15000),
              // killed at birth by the empty-room gate — whose own throttled line already said so.
              // A second console record per self-prompt would double the noise of an unattended
              // call (~240 lines per 30 minutes). Still written to the jsonl: our words are kept,
              // just not shouted. The instant he has spoken once this is false forever and every
              // stillborn reply prints exactly as before.
              if (emptyRoomNow()) {
                rec({ ev: "info", text: `empty-room reply never spoken — "${ev.transcript.trim().slice(0, 160)}"`, cancelled_reply: true, empty_room: true });
                break;
              }
              say("info", `cancelled reply never spoken — "${ev.transcript.trim().slice(0, 160)}"`, { cancelled_reply: true });
              break;
            }
            // `pendingMindHistory` is set ONLY by the narrator-fallback path and is still set here
            // (it is cleared at response.done, which follows this event) — so it is the exact tell
            // that these words are the MIND's line coming back through the mouth.
            pending.push({ text: ev.transcript.trim(), mind: mindResponse && !!pendingMindHistory });
            replyTimer = setTimeout(flushReply, 2000);   // transcript never came; print anyway
          }
          break;
        case "response.done":
          speaking = false;
          responseActive = false;
          awaitingResponse = false;
          // STILLBORN'S TWIN — THE EMPTY REPLY. A response the server CREATED and that then said
          // nothing at all: not cancelled by us, not a MIND line, zero transcript chars, empty
          // buffer. Creation is server-mechanical, so a persona that has been silenced still
          // increments `responses_created`, resets the streak and keeps the answer watch quiet —
          // and nothing anywhere recorded that the reply was born mute. With this counter the
          // record reads N created / 0 cancelled / N EMPTY, which is that hypothesis in three
          // numbers exactly as 0/0/N is a mouth that was never asked. Pure record, no behaviour.
          {
            const doneId = ev.response?.id ?? curResponseId ?? "";
            // A TOOL CALL IS NOT A MUTE REPLY. A response whose output is a function_call is
            // SUPPOSED to carry no speech — the spoken answer is the second response, the one the
            // engine creates with the tool result. Counting it here would manufacture exactly the
            // kind of false signal this whole pass exists to remove (livemind-79579: 15 responses
            // created, 9 spoken, 6 tool calls — every one of them would have read as "empty").
            const toolOnly = Array.isArray(ev.response?.output)
              && ev.response.output.some((it: any) => it?.type === "function_call");
            if (!cancelledResponses.has(doneId) && !mindResponse && !toolOnly && mouthChars === 0 && !mouthBuf.trim()) {
              responsesEmpty++; sessResponsesEmpty++;
              rec({ ev: "info", empty_reply: true, response_id: doneId || null,
                responses_created: responsesCreated, responses_empty: responsesEmpty,
                responses_cancelled: responsesCancelled, turns_transcribed: turnsTranscribed, rot_n: rotN,
                text: `response ${doneId || "?"} was created and said NOTHING — no transcript, no audio, not cancelled (created ${responsesCreated}, empty ${responsesEmpty}, turns ${turnsTranscribed})` });
            } else if (!cancelledResponses.has(doneId) && mindResponse && !toolOnly && mouthChars === 0 && !mouthBuf.trim()) {
              // Engine-initiated (MIND/narrator/greeting) responses stay OUT of responsesEmpty —
              // but a MIND line that produced no speech is still worth a record of its own class.
              rec({ ev: "info", mind_empty: true, response_id: doneId || null, rot_n: rotN,
                text: `engine-initiated response ${doneId || "?"} produced no speech (recorded separately — not counted in responses_empty)` });
            }
          }
          // After a mouth barge mouthBuf holds only the HEARD prefix (the detector trimmed it),
          // so this single write stores exactly what left the speakers — the echo corpus never
          // learns words that were never audible, and mouthLast stays "what the mouth said".
          if (mouthBuf.trim()) { rememberSpoken(mouthBuf); mouthLast = mouthBuf.trim(); saveMindState(undefined, false); }   // echo-dedupe corpus + LANE 15 last-spoken
          mouthBuf = ""; mouthChars = 0;   // one reply's transcript accounting ends here, spoken or not
          // Now that the out-of-band MIND line has actually been spoken, record it in the
          // conversation so the mouth knows it was said (one answer, no repeats). Doing this
          // BEFORE speaking made the model skip the line as already-said.
          if (mindResponse && pendingMindHistory) {
            try { ws.send(JSON.stringify({ type: "conversation.item.create", item: {
              type: "message", role: "assistant", content: [{ type: "output_text", text: pendingMindHistory }] } })); } catch {}
            pendingMindHistory = "";
          }
          paceEnd();
          // Graceful injects wait for PLAYBACK to finish, not just generation. paceEnd lets
          // ffplay keep draining its buffer for `playingUntil - now`; firing the next
          // response.create now would spawn a second player over that tail — two voices at once.
          // Delay the flush until the buffer has drained so the injected reply starts clean.
          if (injectQueue.length) setTimeout(flushInjectQueue, Math.max(0, playingUntil - Date.now()));
          if (closing) {
            // Give the queued goodbye audio time to drain out of the speaker, then hang up.
            setTimeout(() => { say("info", "goodbye — call ended"); done({ reason: "hangup" }); }, Math.max(0, playingUntil - Date.now()) + 400);
          }
          break;
        case "error":
          // A cancel that lost the race with response.done is expected during barge-in,
          // not a call failure — log it quietly and don't mark the call errored.
          if (ev.error?.code === "response_cancel_not_active") {
            rec({ ev: "info", text: "cancel raced response.done (harmless)" });
            break;
          }
          // A REFUSED response.create used to latch awaitingResponse true forever: it is set
          // synchronously at send and cleared only by response.created / response.done / a
          // barge, none of which ever arrive for a rejected create. flushInjectQueue's
          // !awaitingResponse gate then never opens again and MIND lines stop flowing for the
          // rest of the call — the "הוא לא מגיב לי" mute family. Clear it here instead.
          if (ev.error?.code === "conversation_already_has_active_response") {
            awaitingResponse = false;
            rec({ ev: "info", text: "response.create refused (one already active) — awaiting flag cleared" });
            break;
          }
          if (awaitingResponse && !responseActive) awaitingResponse = false;   // same latch, any other refusal
          // ROTATION: the 60-minute cap is not a call failure, it is a SCHEDULE — and the socket
          // behind it is replaceable in place. The message is still logged verbatim, but `result`
          // is left UNSET so the close handler reconnects instead of ending the call. Without
          // this the reconnect path would be unreachable exactly at the one moment it is for.
          if (ROT_ON && !closed && !closing && rotState !== "done" && /maximum duration/i.test(String(ev.error?.message ?? ""))) {
            say("info", `error: ${ev.error?.message ?? "unknown"} — session cap reached; rotating in place, the call continues`,
              { rotation: true, cap_hit: true, session_s: sessT0 ? Math.round((Date.now() - sessT0) / 1000) : undefined });
            break;
          }
          say("info", `error: ${ev.error?.message ?? "unknown"}`);
          if (!result) result = { reason: "error", detail: ev.error?.code ?? ev.error?.message };
          break;
      }
    };
    // The live pipeline is BOUND, not hard-wired: a rotation re-points it at the successor in the
    // same synchronous block that moves the microphone. rotBindLive also carries the two
    // rollback rungs — takeover detection and the in-place reconnect at the cap.
    rotBindLive(ws);
  });
}
