import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CodexLiveConnection, loadLiveNatives } from "./codex-live.ts";
import type { TalkOpts, TalkResult } from "./talk.ts";

/** Codex v3 conversations use native media and delegation events rather than Realtime function tools. */
export async function talkCodexLive(o: TalkOpts): Promise<TalkResult> {
  if (o.tools?.length || o.onTool) throw new Error("Codex live does not support Realtime --tools modules. Use gpt-realtime for function tools.");
  if (o.socket || o.skipSessionUpdate) throw new Error("Codex live cannot reuse a parked Realtime socket.");
  if (o.injectFile || process.env.APIPLAN_TALK_INJECT) throw new Error("Codex live does not yet support an injection file.");
  const natives = await loadLiveNatives();
  const abort = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, abort.signal]) : abort.signal;
  let connection: CodexLiveConnection | undefined;
  let capture: InstanceType<typeof natives.AudioCapture> | undefined;
  let input: ReturnType<typeof Bun.spawn> | undefined;
  let inputTask: Promise<void> | undefined;
  let lastAudio = 0, hangingUp = false, result: TalkResult | undefined;
  const logFile = o.logFile || process.env.APIPLAN_TALK_LOG;
  if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  const say = (kind: "you" | "model" | "info", text: string) => {
    o.onEvent?.(kind, text);
    if (logFile) appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), kind, text, model: "gpt-live-1-codex" }) + "\n");
  };
  const stop = (reason: TalkResult["reason"] = "hangup", detail?: string) => {
    result ??= { reason, ...(detail ? { detail } : {}) };
    abort.abort();
  };
  const onSignal = () => stop();
  const onKey = (bytes: Buffer) => { if ([3, 10, 13, 27, 113].includes(bytes[0])) stop(); };
  const wasRaw = process.stdin.isRaw;
  const keyControl = o.manageSignals !== false && process.stdin.isTTY;
  if (o.manageSignals !== false) { process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal); }
  if (keyControl) { process.stdin.setRawMode(true); process.stdin.on("data", onKey); process.stdin.resume(); }
  const timeout = o.duration ? setTimeout(() => stop("timeout", connection ? undefined : "Call duration elapsed before connection."), o.duration * 1000) : undefined;
  const startup = setTimeout(() => stop("timeout", "Codex live startup timed out."), 45000);
  const barge = !!o.barge && process.env.APIPLAN_BARGE_OK === "1";
  const push = (samples: Float32Array) => {
    // The native peer renders on speakers; gate input during playback unless headphones were explicitly selected.
    if (barge || Date.now() - lastAudio > 600) connection?.pushAudio(samples);
  };
  try {
    connection = await CodexLiveConnection.connect({ natives, signal, voice: o.voice || process.env.APIPLAN_VOICE || "cedar",
      instructions: [o.direction || "You are a helpful voice assistant. Respond briefly and naturally.",
        "This host has no delegated tools. Answer directly; do not delegate actions to the host."].join("\n"),
      onOutputLevel: level => { if (level > 0.0001) lastAudio = Date.now(); },
      onEvent: event => {
        if (event.type === "turn.done") {
          const text = event.turn?.transcript;
          const role = event.turn?.role;
          if (typeof text !== "string" || !["user", "assistant"].includes(role)) return;
          say(role === "user" ? "you" : "model", text);
          const normalized = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
          if (role === "user" && o.hangup?.some(word => normalized.includes(` ${word.toLowerCase().trim()} `))) hangingUp = true;
          if (role === "assistant" && hangingUp) result = { reason: "hangup" };
        } else if (event.type === "delegation.created" && connection) {
          connection.send({ type: "delegation.context.append", delegation_item_id: event.item?.id,
            content: [{ type: "input_text", text: "This host has no tools. Tell the user you cannot perform that action here." }] });
        } else if (event.type === "error") stop("error", event.message ?? event.error?.message ?? "Codex live failed.");
      },
    });
    clearTimeout(startup);
    say("info", `connected: gpt-live-1-codex / Codex WebRTC / ${connection.metrics.authSource}; Enter or Ctrl-C ends the call`);
    if (o.greet) connection.send({ type: "response.create", response: { conversation: "none",
      instructions: typeof o.greet === "string" ? o.greet : "Greet the user briefly, then listen." } });
    if (o.inputFile) {
      input = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-i", o.inputFile, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      inputTask = (async () => {
        let pending = Buffer.alloc(0);
        for await (const bytes of input!.stdout as ReadableStream<Uint8Array>) {
          pending = Buffer.concat([pending, bytes]);
          const count = Math.floor(pending.length / 4);
          if (count) {
            const samples = new Float32Array(count);
            for (let i = 0; i < count; i++) samples[i] = pending.readFloatLE(i * 4);
            push(samples); pending = pending.subarray(count * 4);
          }
        }
        const code = await input!.exited;
        if (code && !signal.aborted) stop("mic-lost", "Input audio could not be decoded by ffmpeg.");
      })().catch(() => { if (!signal.aborted) stop("mic-lost", "Input audio stream failed."); });
    } else capture = new natives.AudioCapture(16000, (error, samples) => error ? stop("mic-lost", error.message) : push(samples));
    while (!signal.aborted) {
      if (result && Date.now() - lastAudio > 900) break;
      await Bun.sleep(50);
    }
    return result ?? { reason: "closed" };
  } catch (error) {
    if (result) return result;
    if (o.signal?.aborted) return { reason: "closed" };
    throw error;
  } finally {
    clearTimeout(startup); clearTimeout(timeout);
    capture?.stop(); input?.kill();
    await inputTask;
    await connection?.close();
    if (o.manageSignals !== false) { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
    if (keyControl) { process.stdin.off("data", onKey); process.stdin.setRawMode(!!wasRaw); process.stdin.pause(); }
    say("info", `call ended: ${result?.reason ?? "closed"}${result?.detail ? ` (${result.detail})` : ""}`);
  }
}
