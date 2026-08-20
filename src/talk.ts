// talk.ts — a spoken conversation with the model: microphone in, voice out, on the
// subscription. The realtime socket already carries audio both ways (see providers.ts);
// this adds the two ends ffmpeg gives us and the turn-taking in between.
//
// Turn-taking is the server's job: `server_vad` means OpenAI decides when you stopped
// talking, so there is no push-to-talk and no silence heuristic of our own to get wrong.
import { openai, openRealtime, speakRealtime } from "./providers.ts";
import { micCommand, speakerCommand, ensureDir } from "./platform.ts";
import { dirname, basename } from "node:path";
import { unlinkSync } from "node:fs";
import * as fs from "node:fs";

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
  const spk = speakerCommand(RATE);
  if (!mic) throw new Error("no microphone capture available — install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`).");
  if (!spk) throw new Error("no audio playback available — ffplay ships with ffmpeg; install it.");

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
    try { logw.write(JSON.stringify({ t: Date.now(), ...obj }) + "\n"); logw.flush?.(); } catch {}
  };
  const emit = o.onEvent ?? (() => {});
  const say = (kind: "you" | "model" | "info", text: string) => { emit(kind, text); rec({ ev: kind, text }); };

  // Inbound control channel — where injected context (monitor reports, mid-call context)
  // is read from. Exported in the env so an in-process tool (set_monitor) knows where a
  // background watcher should append its triggers.
  const injectPath = o.injectFile || process.env.APIPLAN_TALK_INJECT || (logPath ? logPath + ".inject" : "");
  if (injectPath) process.env.APIPLAN_TALK_INJECT = injectPath;

  const ws = o.socket ?? openRealtime(c.token, model);
  rec({ ev: "info", text: `talk start model=${model} voice=${o.voice || "cedar"}${o.socket ? " (parked socket)" : ""}${o.tools?.length ? ` tools=${o.tools.length}` : ""}` });
  // Forensics anchor: log the engine's git sha so log analysis never infers the running
  // code version from process start times (verified pain: 61139 judged on unshipped code).
  try {
    const sha = new TextDecoder().decode(Bun.spawnSync(["git", "-C", dirname(new URL(import.meta.url).pathname), "rev-parse", "--short", "HEAD"]).stdout).trim();
    if (sha) rec({ ev: "info", text: `engine ${sha}` });
  } catch { /* never block a call on git */ }

  // Structural allow-list: a tool name the caller never declared is never dispatched,
  // no matter what the model asks for.
  const toolNames = new Set((o.tools ?? []).map((t: any) => t?.name).filter(Boolean));

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
    noise_reduction: { type: o.barge ? "near_field" : "far_field" },
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

  // Whisper finishes transcribing your turn AFTER the model has already answered, so
  // printing each line as it arrives shows the reply above the question. Hold the reply
  // until your line is printed — with a timeout, so a missing transcript can't eat it.
  // A queue, not a single slot: fast consecutive turns must not overwrite an unflushed one.
  const pending: string[] = [];
  let replyTimer: ReturnType<typeof setTimeout> | null = null;
  const flushReply = () => {
    if (replyTimer) { clearTimeout(replyTimer); replyTimer = null; }
    while (pending.length) say("model", pending.shift()!);
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
  let userSpeaking = false;   // VAD says the human is mid-turn — MIND lines HOLD (stack law)
  let lastSpeechStopAt = 0;   // sustained-silence gate: MIND may speak only after ~2.5s of real quiet

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

  // Barge-in bookkeeping (R7): to interrupt CORRECTLY we must tell the server how much
  // was actually heard (conversation.item.truncate) and drop the cancelled response's
  // in-flight deltas — otherwise the model's context contains words the user never heard,
  // and ghost audio plays after the interrupt.
  let curResponseId: string | null = null;   // response currently generating
  let responseActive = false;                 // a response is mid-generation (safe to cancel)
  let mindResponse = false;                   // current response was MIND/tool-initiated (never noise-cancel it)
  let pendingMindHistory = "";                // MIND line to record in conversation AFTER it is spoken
  let mindBusy = false;                       // a MIND narrator line is generating or playing (serializes the queue)
  let mindPlayer: any = null;                 // the MIND voice's own ffplay child (killed on barge/exit)
  // USER-BARGES-MIND bookkeeping (fire17's law, voice, 2026-08-20: "אם אני אומר הודעה,
  // אתה חייב לתת לפה להתפרץ ולעצור את מה שהמיינד מדבר... המוח חייב לקטוע את עצמו ולהבין
  // איפה הוא נקטע"): the line now playing, so an interrupt can estimate how much was
  // actually heard (cut) and re-queue the unspoken remainder for re-weave.
  let mindLine: { text: string; ms: number; startAt: number; cut: number } | null = null;
  let pendingMouthReply = false;              // a VAD auto-reply cancelled only because MIND audio was playing — release it after
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
  const archOn = process.env.APIPLAN_ARCHIVE !== "0";
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
    return archMode !== "caps-only" || !micMuted;
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
    try { player?.kill(9); } catch {}
    player = null;
    const n = draining.size;
    for (const p of draining) { try { p.kill(9); } catch {} }
    draining.clear();
    // Evidence in the log that the mouth was actually silenced — `n` is the tail that used to
    // keep playing under the MIND's voice (unreachable before the draining set existed).
    if (hadLive || n) say("info", `mouth silenced (live=${hadLive ? 1 : 0} draining-tail=${n})`);
  };
  // Note: the player is spawned lazily on the first audio byte (below), NOT pre-spawned —
  // ffplay with -autoexit on a still-empty stdin exits immediately (code 123). The
  // low-latency flags on speakerCommand() still cut real audible latency once it starts.

  let micProc: ReturnType<typeof Bun.spawn> | null = null;
  let closed = false;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    if (closed) return; closed = true;
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    try { ws.close(); } catch {}
    const m = micProc;
    try { m?.kill(); } catch {}
    if (m) setTimeout(() => { try { m.kill(9); } catch {} }, 500);   // escalate if ffmpeg ignores TERM
    stopPlayer();
    if (mindPlayer) { try { mindPlayer.kill("SIGKILL"); } catch {} mindPlayer = null; }
    archRoll("call end");
    try { logw?.flush?.(); } catch {}
  };
  // Clean up the child ffmpeg/ffplay on EVERY exit path, not just Ctrl-C: a leftover
  // ffmpeg keeps the mic device open and the next run fails with "device busy".
  // A daemon that calls talk() repeatedly passes manageSignals:false — per-call process
  // handlers would accumulate, and the uncaughtException rethrow would kill the daemon.
  if (o.manageSignals !== false) {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { close(); process.exit(0); });
    process.on("exit", () => { try { close(); } catch {} });
    process.on("uncaughtException", (e) => { rec({ ev: "info", text: `uncaught ${String((e as any)?.message ?? e).slice(0, 200)}` }); close(); throw e; });
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

    const onOpen = () => {
      if (o.skipSessionUpdate) {
        // Parked socket: session.updated will never arrive, so nothing may be gated on it.
        // Tools are per-call: merge them in with a minimal update that touches NOTHING
        // else (partial session.update merges; the observed abort was from resending
        // turn_detection MID-RESPONSE, which this is not — no response is in flight yet).
        if (o.tools?.length) {
          ws.send(JSON.stringify({ type: "session.update", session: { type: "realtime", tools: o.tools, tool_choice: "auto" } }));
        }
        if (o.greet && !greeted) {
          greeted = true;
          const gi = greetInstructions();
          ws.send(JSON.stringify({ type: "response.create", ...(gi ? { response: { instructions: gi } } : {}) }));
          awaitingResponse = true;
        }
      } else {
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["audio"],
            ...(o.direction ? { instructions: o.direction } : {}),
            ...(o.tools?.length ? { tools: o.tools, tool_choice: "auto" } : {}),
            audio: { input: audioInput, output: { voice: o.voice || "cedar", format: { type: "audio/pcm", rate: RATE } } },
          },
        }));
      }
      say("info", o.greet ? "connecting — it will speak first. Ctrl-C to stop." : "listening — speak, and it answers. Ctrl-C to stop.");
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
        micProc = Bun.spawn(mic, { stdout: "pipe", stderr: "ignore" });
        const startedAt = Date.now();
        await pumpMic(micProc);
        if (closed || ws.readyState !== WebSocket.OPEN) return;
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
    let ovStart = -1; let ovEnd = 0; let ovPath = ""; let ovAt = 0;
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
    const BARGE_PEAK = envBar("APIPLAN_MIND_BARGE_PEAK", 1800);
    const BARGE_SUSTAIN = Number(process.env.APIPLAN_MIND_BARGE_MS) || 250;
    const MUTEDWARN_PEAK = envBar("APIPLAN_MUTEDWARN_PEAK", 1800);   // no leak risk while muted — can be aggressive
    let bargeMs = 0; let lastBargeAt = 0;
    let mutedSpeechMs = 0; let mutedWarnAt = 0;
    // Auditability: a live log must always record which thresholds were in force.
    say("info", `bars: barge=${BARGE_PEAK}/${BARGE_SUSTAIN}ms recover=${envBar("APIPLAN_RECOVER_PEAK", 2000)} mutedwarn=${MUTEDWARN_PEAK}`);
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
        const RECOVER_PEAK = envBar("APIPLAN_RECOVER_PEAK", 2000);
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
        let firstLoud = -1; let lastLoud = -1; let loudMs = 0;
        for (let b = 0; b * BLK < got; b++) {
          if (framePeak(buf.subarray(b * BLK, Math.min(got, (b + 1) * BLK))) >= RECOVER_PEAK) {
            if (firstLoud < 0) firstLoud = b;
            lastLoud = b; loudMs += 50;
          }
        }
        if (loudMs < 200) { say("info", `overlap recovery skipped — nothing above the leak bar (${loudMs}ms loud)`); return; }
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
    async function pumpMic(proc: ReturnType<typeof Bun.spawn>) {
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done: rdone, value } = await reader.read();
          if (rdone) break;
          if (value?.length) archWrite(value);                 // never-lose: archive BEFORE any drop below
          if (micMuted) {                                      // muted: drop mic frames so the model never hears them
            // A mute flip rolls the archive segment — a pending overlap window into the old
            // segment is no longer a live turn (verified defect: a window resent 4.5 min
            // later as fresh speech). Discard it; the audio itself stays archived.
            if (ovStart >= 0) { ovStart = -1; ovEnd = 0; ovPath = ""; }
            // Talking into a stuck/forgotten mute is silent deafness (root cause of the
            // 13:37 "הפה לא עונה לי" — mic muted, never unmuted, zero feedback). Say so.
            if (value?.length) {
              if (framePeak(value) >= MUTEDWARN_PEAK) mutedSpeechMs += (value.length / 2 / RATE) * 1000; else mutedSpeechMs = Math.max(0, mutedSpeechMs - 200);
              if (mutedSpeechMs > 1000 && Date.now() - mutedWarnAt > 10000) {
                mutedWarnAt = Date.now(); mutedSpeechMs = 0;
                say("info", "speaking while muted — the mouth cannot hear you");
              }
            }
            continue;
          }
          // MIND narrator playing: frames NEVER flow in ANY mode (o.barge only trades off
          // the MOUTH's playback — the narrator's audio must not reach the model even with
          // headphones-mode on; verified gap). Detect the human barging locally.
          if (mindPlayer && mindLine) {
            if (value?.length && archFd >= 0) {
              if (ovStart < 0) { ovStart = archBytes - value.length; ovPath = archPath; ovAt = Date.now(); }
              if (ovPath === archPath) ovEnd = archBytes;
            }
            if (value?.length && BARGE_PEAK > 0) {
              const fMs = (value.length / 2 / RATE) * 1000;
              // Leaky accumulator — real speech dips below any bar mid-word; a strict
              // consecutive rule never accumulates 250ms (measured).
              bargeMs = framePeak(value) >= BARGE_PEAK ? bargeMs + fMs : Math.max(0, bargeMs - fMs);
              if (bargeMs >= BARGE_SUSTAIN && Date.now() - lastBargeAt > 1000) {
                bargeMs = 0; lastBargeAt = Date.now();
                const L = mindLine;
                // startAt is biased by ffplay spin-up (~250ms measured) and the cut rounds
                // DOWN to a word boundary — never record words he did not hear as spoken.
                const raw = Math.min(L.text.length, Math.round(((Date.now() - L.startAt) / L.ms) * L.text.length));
                const wb = L.text.lastIndexOf(" ", raw);
                L.cut = wb > 0 ? wb : Math.max(0, raw);
                try { mindPlayer.kill("SIGKILL"); } catch {}   // exited handler records the spoken prefix only
                playingUntil = Date.now() + 250;               // swallow the kill tail — reopening at 0 lets the tail transcribe
                say("info", `mind interrupted by user — spoke ${L.cut}/${L.text.length} chars`);
                const rest = L.text.slice(L.cut).trim();
                if (rest) { injectQueue.push(rest); queueStale = true; }   // remainder is STALE — re-weave against his words
                ovStart = -1; ovEnd = 0; ovPath = "";          // his live speech supersedes overlap recovery here
              }
            }
            continue;
          }
          if (stillAudible() && !o.barge) {
            if (value?.length && archFd >= 0) {                // overlap capture: his words during mouth playback
              if (ovStart < 0) { ovStart = archBytes - value.length; ovPath = archPath; ovAt = Date.now(); }
              if (ovPath === archPath) ovEnd = archBytes;      // segment rolled mid-window → keep what we had
            }
            bargeMs = 0;
            continue;
          }
          bargeMs = 0;
          if (ovStart >= 0 && !recovering) {                   // playback just ended → recover the dropped window
            // Max age: a stale window is not a live turn (mute gaps, long stalls).
            if (Date.now() - ovAt < 30000) {
              recovering = true;
              recoverOverlap(ovPath, ovStart, ovEnd);          // async; never blocks the mic pump
            }
            ovStart = -1; ovEnd = 0; ovPath = "";
          }
          if (ws.readyState !== WebSocket.OPEN) break;
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
        say("info", `audio resent (${(sent / (RATE * 2)).toFixed(1)}s): ${basename(path)}`);
      } catch (e) { say("info", `audio resend failed: ${String(e).slice(0, 120)}`); }
    }

    /** Dispatch ONE declared tool call, reply with its output, and let the model speak
     *  the result. Failures become a sentence the model can just say — a tool error must
     *  never take the call down. */
    const runTool = async (item: any) => {
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
      ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output } }));
      if (!closing) { ws.send(JSON.stringify({ type: "response.create" })); awaitingResponse = true; }
    };

    // ── Inbound context injection ────────────────────────────────────────────────
    // Other processes (a set_monitor watcher, a mid-call context push) append {text,mode}
    // lines to injectPath. Each is spoken INTO the live call: mode "graceful" waits for the
    // current sentence to finish; "interrupt" barges in so the model answers on it at once.
    const injectQueue: string[] = [];
    let injectOff = 0;
    const sendInjected = (text: string) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      // THE MIND'S OWN VOICE — mechanistic verbatim by construction. Driving the mouth's
      // conversational model with "say this word for word" instructions proved FLAKY: it
      // paraphrased, translated (English→Spanish live), summarized long lines, and with a
      // pending user question freelanced replies instead. So MIND lines no longer go through
      // the mouth's model at all: a dedicated narrator connection (speakRealtime — the same
      // engine as `apiplan speak`) renders the exact words as audio in a DISTINCT voice
      // (APIPLAN_MIND_VOICE, default "ash"), and we play it directly. The mouth cannot
      // reword what it never speaks — and the human hears by ear which tier is talking.
      say("info", "injected context");
      mindBusy = true;
      const mindVoice = process.env.APIPLAN_MIND_VOICE || "ash";
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
        mindPlayer = Bun.spawn(["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet",
          "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0", f],
          { stdout: "ignore", stderr: "ignore" });
        // startAt is biased by ffplay spin-up (measured 200-300ms before first audible
        // sample) so the barge cut never over-counts words as spoken.
        mindLine = { text, ms, startAt: Date.now() + (Number(process.env.APIPLAN_MIND_START_MS) || 250), cut: -1 };
        say("model", text);   // the exact words now audible — the monitor/GUI see the true line
        mindPlayer.exited.then(() => {
          // If the user barged (pumpMic set cut), only the SPOKEN PREFIX goes into the
          // mouth's history — recording words that were never heard corrupts its context.
          const cut = mindLine?.cut ?? -1;
          const spoken = cut >= 0 ? text.slice(0, cut) : text;
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
          if (pendingMouthReply && !suppressAuto && !closing && !responseActive && !awaitingResponse && ws.readyState === WebSocket.OPEN) {
            say("info", "mouth reply released (was held behind mind audio)");
            try { ws.send(JSON.stringify({ type: "response.create" })); awaitingResponse = true; } catch {}
          }
          pendingMouthReply = false;
          flushInjectQueue();
        });
      }).catch(() => {
        // Narrator unreachable → legacy best-effort path: out-of-band verbatim instruction
        // on the mouth's own socket (may paraphrase — better than silence).
        mindBusy = false;
        if (closing || ws.readyState !== WebSocket.OPEN) return;
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
      if (curResponseId) cancelledResponses.add(curResponseId);
      if (curItemId) {
        const heardMs = itemFirstDeltaAt ? Math.max(0, Math.min(Date.now() - itemFirstDeltaAt, itemQueuedMs)) : 0;
        try { ws.send(JSON.stringify({ type: "conversation.item.truncate", item_id: curItemId, content_index: 0, audio_end_ms: Math.round(heardMs) })); } catch {}
      }
      stopPlayer(); speaking = false; playingUntil = 0;
      // A voice barge also silences the MIND's narrator audio (it has its own player).
      if (mindPlayer) { try { mindPlayer.kill("SIGKILL"); } catch {} mindPlayer = null; mindBusy = false; }
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
      if (responseActive && !mindResponse) bargeNow();       // still generating: cancel + truncate + stop
      else { stopPlayer(); speaking = false; playingUntil = 0; }   // done generating, still AUDIBLE: kill the tail
    };
    const injectContext = (text: string, mode: string) => {
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
      }
      queueStale = false;   // a new inject IS the re-weave — it releases the stale hold
      if (userSpeaking && Date.now() - speechStartedAt < 120000) {
        injectQueue.push(text);
        say("info", `mind line HELD (user speaking) — queue ${injectQueue.length}`);
        // QUEUE MERGE LAW (fire17, voice, 2026-08-20: "כמה הודעות במקביל נכנסות למחסנית
        // במקום להתעדכן... זה צריך להיות הודעה אחת"): the queue must never grow past one —
        // this echo (once per growth) tells the watching MIND to {"drop_queue"} + weave
        // everything held into ONE fresh line.
        if (injectQueue.length > 1) say("info", `mind queue MERGE (${injectQueue.length} held) — weave into one`);
        return;
      }
      if (mode === "interrupt" && (responseActive || awaitingResponse)) bargeNow();
      if (!responseActive && !awaitingResponse && !mindBusy) { sendInjected(text); return; }
      injectQueue.push(text);
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
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushInjectQueue = () => {
      flushTimer = null;
      if (queueStale) return;
      if (userSpeaking || Date.now() - lastSpeechStopAt < 2500) {
        if (injectQueue.length && !flushTimer) flushTimer = setTimeout(flushInjectQueue, 1000);
        return;
      }
      while (injectQueue.length && !responseActive && !awaitingResponse && !mindBusy) sendInjected(injectQueue.shift()!);
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
                          lastSpeechStopAt = Date.now();
                          if (speechStartedAt) lastSpeechMs = Date.now() - speechStartedAt;
                          if (injectQueue.length) setTimeout(flushInjectQueue, 2600);
                        }
                      }
                    } else if (typeof j.autospeak === "boolean") {   // MIND's mouth switch — may the model answer on its own?
                      suppressRestoreAt = 0;                          // MIND's explicit choice outranks a pending overlap-recovery restore
                      suppressAuto = !j.autospeak;
                      say("info", j.autospeak ? "mouth OPEN (auto-speak on)" : "mouth CLOSED (MIND-only)");
                    } else if (j.ping) {   // no-op probe: proves the inject channel is being read, with zero side effects
                      say("info", "pong");
                    } else if (j.context) {
                      // SILENT context preload (fire17's design, 2026-08-18): push state into the
                      // conversation as a system note WITHOUT triggering any speech — the model's
                      // very next answer already knows it, before the human even asks. This is how
                      // the MIND keeps the mouth in sync continuously, not just at launch.
                      ws.send(JSON.stringify({ type: "conversation.item.create", item: {
                        type: "message", role: "system",
                        content: [{ type: "input_text", text: `[Live state update from the MIND — absorb silently, do not mention or respond to this]: ${String(j.context)}` }] } }));
                      say("info", "context preloaded (silent)");
                    } else if (j.drop_queue) {   // MIND re-weave: discard held/unspoken lines before sending a fresh one
                      say("info", `queue dropped (${injectQueue.length} lines)`);
                      injectQueue.length = 0;
                      queueStale = false;
                    } else if (typeof j.audio === "string") {   // resend a recording as live speech
                      resendAudio(j.audio);
                    } else if (j.text) injectContext(String(j.text), String(j.mode || "graceful"));
                  } catch {}
                }
              }
            }
          }
        } catch {}
        if (!closed) setTimeout(tick, 150);
      };
      setTimeout(tick, 150);
    }

    ws.onmessage = (e: any) => {
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
          if (ev.delta) rec({ ev: "model_delta", text: ev.delta });
          break;
        case "conversation.item.input_audio_transcription.delta":
          if (ev.delta) rec({ ev: "you_delta", text: ev.delta });
          break;
      }
      switch (ev.type) {
        case "session.updated":
          // Only now are the instructions live, so an opening line spoken before this
          // would be in the default assistant persona rather than yours. (Parked sockets
          // never reach here — their greeting fires from the open path.)
          if (o.greet && !greeted && !o.skipSessionUpdate) {
            greeted = true;
            ws.send(JSON.stringify({ type: "response.create",
              ...(typeof o.greet === "string" ? { response: { instructions: o.greet } } : {}) }));
            awaitingResponse = true;
          }
          break;
        case "response.created":
          curResponseId = ev.response?.id ?? null;
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
            if (!awaitingResponse && (suppressAuto || noiseBlip || mindBusy)) {
              try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
              if (curResponseId) cancelledResponses.add(curResponseId);   // drop its audio deltas
              responseActive = false;
              if (noiseBlip && !suppressAuto) say("info", `noise-blip auto-reply cancelled (speech ${lastSpeechMs}ms < ${minSpeech}ms)`);
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
              if (mindBusy && !suppressAuto && !noiseBlip) {
                pendingMouthReply = true;
                say("info", "mouth reply held behind mind audio — will release");
              }
              break;
            }
          }
          responseActive = true;
          mindResponse = awaitingResponse;   // if we sent this response.create, it's the MIND speaking
          awaitingResponse = false;   // the send we were awaiting has now materialized
          break;
        case "response.output_item.added":
          // The assistant message whose audio is about to play — barge-in truncates THIS.
          if (ev.item?.type === "message") { curItemId = ev.item.id; itemFirstDeltaAt = 0; itemQueuedMs = 0; }
          break;
        case "input_audio_buffer.speech_started":
          speechStartedAt = Date.now();
          userSpeaking = true;   // stack law: MIND lines hold from this instant
          pendingMouthReply = false;   // a NEW turn supersedes a held reply — its own VAD auto-reply covers him
          // Barge-in done RIGHT (R7): cancel generation, tell the server how much was
          // actually heard, and drop the cancelled response's still-in-flight deltas —
          // otherwise the model's context keeps words the user never heard, and ghost
          // audio plays after the interrupt.
          // Only cancel a response that is genuinely still generating — speaking can lag
          // response.done by one event, and cancelling a finished response draws a
          // "response_cancel_not_active" error for nothing.
          if (speaking && o.barge && responseActive) {
            ws.send(JSON.stringify({ type: "response.cancel" }));
            responseActive = false; awaitingResponse = false;
            if (curResponseId) cancelledResponses.add(curResponseId);
            if (curItemId) {
              const heardMs = itemFirstDeltaAt
                ? Math.max(0, Math.min(Date.now() - itemFirstDeltaAt, itemQueuedMs))
                : 0;
              ws.send(JSON.stringify({ type: "conversation.item.truncate", item_id: curItemId, content_index: 0, audio_end_ms: Math.round(heardMs) }));
            }
            stopPlayer();                 // no eager restart — the next reply's delta spawns fresh
            speaking = false;
            playingUntil = 0;
          }
          break;
        case "input_audio_buffer.speech_stopped":
          if (speechStartedAt) lastSpeechMs = Date.now() - speechStartedAt;
          userSpeaking = false;
          lastSpeechStopAt = Date.now();
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
          if (suppressRestoreAt && recoverSentAt) { suppressAuto = savedSuppress; suppressRestoreAt = 0; recoverSentAt = 0; }
          if (ev.transcript?.trim()) say("you", ev.transcript.trim());
          // Stale-queue law: a completed user turn makes every held MIND line stale —
          // it must be re-woven against these new words, never auto-fired (echo once).
          if (ev.transcript?.trim() && injectQueue.length && !queueStale) {
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
          if (!ev.transcript?.trim() && responseActive && !mindResponse && !awaitingResponse && !closing
              && lastSpeechMs < 2 * (Number(process.env.APIPLAN_MIN_SPEECH_MS) || 500)) {
            try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
            if (curResponseId) cancelledResponses.add(curResponseId);
            responseActive = false;
            say("info", "empty-transcript auto-reply cancelled (noise, not speech)");
          }
          flushReply();
          // Hangup is irreversible — require REAL speech behind it, not a noise hallucination.
          if (!closing && ev.transcript && isHangup(ev.transcript) && lastSpeechMs >= 400) {
            closing = true;
            say("info", "heard a goodbye — closing after the reply");
            // Let it sign off in its own voice, then the response.done below hangs up.
            ws.send(JSON.stringify({ type: "response.create",
              response: { instructions: "The person is ending the call. Say a brief, warm goodbye in one short sentence and nothing else." } }));
            awaitingResponse = true;
          }
          break;
        case "conversation.item.input_audio_transcription.failed":
          if (suppressRestoreAt && recoverSentAt) { suppressAuto = savedSuppress; suppressRestoreAt = 0; recoverSentAt = 0; }
          // Don't strand a held reply for 4s when the transcript simply failed.
          flushReply();
          break;
        case "response.output_item.done":
          // Tool calls arrive as completed function_call items. Only names the caller
          // DECLARED are dispatched — the allow-list is structural, never the model's word.
          if (ev.item?.type === "function_call" && o.onTool && toolNames.has(ev.item.name)) {
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
            }
            speaking = true;
            if (!player || player.exitCode !== null) startPlayer();   // dead/absent → fresh player
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
            queueAudio(buf.length);
            itemQueuedMs += (buf.length / 2 / RATE) * 1000;
            try { player!.stdin!.write(buf); player!.stdin!.flush?.(); } catch { playingUntil = 0; }
          }
          break;
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done":
          if (ev.transcript?.trim()) {
            pending.push(ev.transcript.trim());
            replyTimer = setTimeout(flushReply, 2000);   // transcript never came; print anyway
          }
          break;
        case "response.done":
          speaking = false;
          responseActive = false;
          awaitingResponse = false;
          // Now that the out-of-band MIND line has actually been spoken, record it in the
          // conversation so the mouth knows it was said (one answer, no repeats). Doing this
          // BEFORE speaking made the model skip the line as already-said.
          if (mindResponse && pendingMindHistory) {
            try { ws.send(JSON.stringify({ type: "conversation.item.create", item: {
              type: "message", role: "assistant", content: [{ type: "output_text", text: pendingMindHistory }] } })); } catch {}
            pendingMindHistory = "";
          }
          endPlayer();
          // Graceful injects wait for PLAYBACK to finish, not just generation. endPlayer lets
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
          say("info", `error: ${ev.error?.message ?? "unknown"}`);
          if (!result) result = { reason: "error", detail: ev.error?.code ?? ev.error?.message };
          break;
      }
    };
    ws.onerror = () => { say("info", "connection failed"); done(result ?? { reason: "error", detail: "connection failed" }); };
    ws.onclose = (e: any) => {
      rec({ ev: "info", text: `socket closed (${e?.code ?? "?"})` });
      done(result ?? { reason: closing ? "hangup" : "closed", detail: String(e?.code ?? "") });
    };
  });
}
