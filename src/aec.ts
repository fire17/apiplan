// aec.ts — ARCHITECTURE A capture: the microphone comes from macOS VoiceProcessingIO
// (AUVoiceIO), which cancels our own loudspeaker INSIDE CoreAudio, before the sample is
// ever captured — plus the barge gate that rides that cleaned signal. ONE child, ONE env
// switch (LM_BARGE_VP). Unset/0 = OFF, and the engine's mic path is byte-identical.
//
// WHY THE CHILD REPLACES THE MIC INSTEAD OF SITTING BEHIND IT (measured, 2026-08-21,
// prestage/pipeA/STATUS.md + runs/20260821T040746-feelA2): with arch A the canceller IS the
// capture device. There is no signal to hand it and nothing to run in Bun — the OS can only
// cancel audio it captured itself. So this child BECOMES the microphone: talk.ts stops
// spawning `ffmpeg -f avfoundation` and reads the VPIO stream instead. Live evidence: three
// rounds out of three, his voice cut the narration through the speakers (peaks 21101 /
// 27223 / 21926 on the CLEANED signal, prob 0.95-0.998), and this Mac's own speaker DSP was
// cancelled at capture — the thing arch B could not do at 4.6 dB on the real path.
//
// THE CONTRACT (the child is swappable — point LM_BARGE_VP_CMD at any binary that speaks it):
//   <cmd> --rate <hz>
//   fd1  CLEANED mic PCM s16le mono @rate — THIS IS THE ENGINE'S MICROPHONE
//   fd3  one JSON per line: {"ev":"barge","ms":n,"prob":p,"voiced_ms":n,"peak":n}
//        (stderr, prefixed "EV ", when fd3 is not open)
//   stderr  human log lines
// No reference FIFO in v2, deliberately: VPIO takes its reference from the device's own
// render side and estimates the delay itself, so a reference stream would be plumbing that
// cancels nothing (pipeA drained one purely to stamp `ref_active`). The engine already knows
// whether it is rendering — `stillAudible()` / `mindPlayer` — so that cross-check is free and
// exact in talk.ts, and the whole FIFO/pacing/downmix layer of v1 is deleted rather than kept.
//
// V3 (fix cycle, verdict wave3/verify-verdict.md) adds three things and nothing else:
//   * CONVERGENCE ARMING (defect 3.4 + the soak lane's ONE true false-positive class). AUVoiceIO
//     needs time to converge: measured on this rig the helper reaches READY at +3.4-3.5s and its
//     FIRST audio buffer at +3.6s, and the soak's only genuine echo-driven event sat inside the
//     first ~2s of capture (cleaned peak 1.4-2.6k, clearing the child's 1200 bar) — i.e. leak that
//     the canceller had not yet learned to cancel. So the gate stays SHUT until the child says it
//     is converged (`conv=1` / "converter (re)built" on its own stderr) AND a warmup has elapsed
//     past the first byte (LM_BARGE_VP_ARM_MS, default 2500ms). Unarmed events are counted and
//     dropped, never delivered. Arming is ONE-TIME per capture: once armed, a real barge is never
//     delayed by a millisecond.
//   * FIRST-BYTE HANDOVER SUPPORT (defect 3.4, never-lose). The child is slow to start, so talk.ts
//     keeps the ordinary ffmpeg mic running until this class reports the FIRST cleaned byte. This
//     file reads that byte itself (`whenFirstByte`) and hands it to the caller, so no audio is
//     dropped at the switch and the activation window is never deaf.
//   * aecmic2 AS THE DEFAULT HELPER (defect 4.3): v1's aecmic aborts on EPIPE and cannot recover
//     from a device/format change.
//
// This file owns ONLY the plumbing: the child, the watchdog, the fail-safe, the event lines.
// Every decision about what a barge MEANS stays in talk.ts, on the machinery that exists.
import * as fs from "node:fs";
import { homedir } from "node:os";

export type VpLog = (kind: "info", msg: string, extra?: Record<string, unknown>) => void;
export type VpEvent = { ev?: string; ms?: number; prob?: number; voiced_ms?: number; peak?: number };

/** The proven arch-A pipeline (aecmic + Silero gate). Overridable — see LM_BARGE_VP_CMD.
 *  NAMED DEBT (verdict 4.4): this is a `.deify` STAGING path, so committing it makes a hands
 *  working directory part of the engine's supported surface. It fails SAFELY (the existsSync
 *  check below returns null and the ffmpeg mic is used), and the line logged at start() says so
 *  out loud — but before this ships for real, either move the pipeline under ~/Creations/APIPlan
 *  or set LM_BARGE_VP_CMD explicitly. */
const DEFAULT_CMD = `${homedir()}/Creations/LiveMind/hands/.deify/new-hands-barge/prestage/pipeA/pipeA`;
/** The PRODUCTIONIZED capture helper (wave3/aecmic2), used unless the caller names its own.
 *  v1's `aecmic` is pipeA's built-in default and it writes with FileHandle.write, which raises
 *  NSFileHandleOperationException on EPIPE and ABORTS — observed, not theoretical, in
 *  runs/20260821T040746-feelA2/round1/pipeA.err ("libc++abi: terminating due to uncaught
 *  exception"). aecmic2 uses raw write(2), watches for the parent's death, recovers from an
 *  AirPods/BT/format switch by itself (measured: retap + converter rebuild in 1.5-2.3s), and
 *  prints the `conv=` heartbeat that the convergence gate below reads. */
const DEFAULT_HELPER = `${homedir()}/Creations/LiveMind/hands/.deify/new-hands-barge/wave3/aecmic2/aecmic2`;
const envMs = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };

export class VpCapture {
  /** null = OFF (unset/0/off), or the command is missing — in both cases the caller spawns
   *  the ordinary ffmpeg mic and NOTHING about this call changes. */
  static start(rate: number, o: { onBarge: (e: VpEvent) => void; onDown: (why: string) => void; log: VpLog }): VpCapture | null {
    const on = (process.env.LM_BARGE_VP || "").trim().toLowerCase();
    if (!on || on === "0" || on === "off" || on === "false") return null;
    const argv = (process.env.LM_BARGE_VP_CMD || DEFAULT_CMD).trim().split(/\s+/).filter(Boolean);
    const extra = (process.env.LM_BARGE_VP_ARGS || "").trim().split(/\s+/).filter(Boolean);
    if (!argv.length) return null;
    // FAIL BEFORE SPAWNING, not after: a missing binary must cost the call nothing.
    if (argv[0].includes("/") && !fs.existsSync(argv[0])) {
      o.log("info", `vp capture unavailable — ${argv[0]} not found; staying on the ffmpeg mic`, { vp_missing: true, cmd: argv[0] });
      return null;
    }
    // DEFECT 4.3 — the wrong helper was wired in. pipeA's `--aecmic` default is the v1 binary;
    // point it at aecmic2 unless the caller already chose one. SPAWN-ONCE is the other half of
    // that mitigation and lives in talk.ts's micLoop: aecmic2 recovers from device/format churn
    // by ITSELF, so the child is started once per call and kept across mic respawns rather than
    // paying the ~3.5s activation cost again and fighting the device for it.
    if (!process.env.LM_BARGE_VP_CMD && !extra.includes("--aecmic") && fs.existsSync(DEFAULT_HELPER)) extra.push("--aecmic", DEFAULT_HELPER);
    if (!process.env.LM_BARGE_VP_CMD) o.log("info", `vp capture: using the STAGING pipeline at ${DEFAULT_CMD} (a hands working tree, not an engine-owned path) — set LM_BARGE_VP_CMD to pin a supported one`, { vp_staging_cmd: true, cmd: DEFAULT_CMD });
    try { return new VpCapture(argv.concat(["--rate", String(rate)], extra), rate, o); }
    catch (e) { o.log("info", `vp capture spawn failed (${e}) — staying on the ffmpeg mic`, { vp_spawn_failed: true }); return null; }
  }

  down = false;
  proc: any;
  /** The FIRST cleaned byte, read by this class so talk.ts can keep the ffmpeg mic alive until
   *  the switch (never-lose: the activation window must not be deaf). Resolves null if the child
   *  ends without ever producing audio. The chunk is handed BACK to the caller, never swallowed. */
  whenFirstByte!: Promise<Uint8Array | null>;
  /** True once the engine's own mic pump has taken this child's stream over. */
  handedOver = false;
  private spawnAt = Date.now();
  private firstByteAt = 0;
  private lastByteAt = 0;
  private lastNonZeroAt = 0;
  private timer: any = null;
  private stderrLines = 0;
  private conv = false;              // the child says its canceller/converter is up (`conv=1`)
  private armedAt = 0;               // when the gate opened (0 = still shut)
  private unarmed = 0;               // events dropped before arming — the soak's one FP class
  private readonly deadMs = envMs("LM_BARGE_VP_DEAD_MS", 200);      // P0-5 / brief: 200ms of no bytes = down
  // DEFECT 3.4. The old default was 5000ms and the MEASURED floor is already 3 656ms of pure
  // helper startup (setVoiceProcessingEnabled 0.6-1.4s + engine.start 0.1-2.0s + first_buffer)
  // BEFORE pipeA's python + numpy + onnxruntime + Silero import — so a cold start on a busy
  // device tripped the watchdog and disarmed the call permanently. 3x the measured floor.
  private readonly startMs = envMs("LM_BARGE_VP_START_MS", 12000);
  private readonly zeroMs = envMs("LM_BARGE_VP_ZERO_MS", 3000);     // TCC silent-denial: frames of pure zeros
  /** CONVERGENCE ARMING (defect 3.4 + the soak lane's one true FP class): warmup past the FIRST
   *  byte before any event is believed. AUVoiceIO's canceller has not converged yet at t=0 and
   *  the leak it lets through in that window measured 1.4-2.6k peak — over the child's own bar. */
  private readonly armMs = envMs("LM_BARGE_VP_ARM_MS", 2500);
  /** If a child never prints a convergence token (a custom LM_BARGE_VP_CMD, or --no-status), arm
   *  on the warmup ALONE after this long rather than staying deaf forever — and say so. Far past
   *  the ~2s FP window either way, so the gate is never armed early by this fallback. */
  private readonly convWaitMs = envMs("LM_BARGE_VP_CONV_MS", 8000);
  /** How long the child may sit between its first byte and the engine's pump taking over. */
  private readonly handoverMs = envMs("LM_BARGE_VP_HANDOVER_MS", 5000);

  private constructor(private argv: string[], private rate: number,
                      private o: { onBarge: (e: VpEvent) => void; onDown: (why: string) => void; log: VpLog }) {
    // stdin is IGNORED on purpose: the child owns the device, so there is no raw mic to feed it.
    // fd3 when this runtime gives it to us; the stderr "EV " channel is the fallback.
    try { this.proc = Bun.spawn(this.argv, { stdio: ["ignore", "pipe", "pipe", "pipe"] as any }); }
    catch { this.proc = Bun.spawn(this.argv, { stdout: "pipe", stderr: "pipe" }); }
    this.o.log("info", `vp capture up: ${this.argv.join(" ")}`, { vp_start: true, cmd: this.argv.join(" ") });
    this.proc.exited.then((code: number) => this.fail(`capture child exited (rc=${code})`));
    this.whenFirstByte = this.readFirstChunk();
    this.pumpEvents();
    this.pumpStderr();
    // 50ms: the deafness bar is 200ms, and a 100ms tick would let it slip to ~300.
    this.timer = setInterval(() => this.tick(), 50);
  }

  /** Called by the mic pump for every frame it reads out of this child — the watchdog's only
   *  input. Cheap: one sparse scan, the same stride profile the archive's peak scan uses. */
  note(v: Uint8Array) {
    if (this.down) return;              // a reverted child's last frames are the ffmpeg mic's business now
    const now = Date.now();
    if (!this.firstByteAt) this.markFirstByte();
    // The engine's pump is reading this child now, so the ordinary liveness watchdog applies.
    if (!this.handedOver) { this.handedOver = true; this.lastNonZeroAt = now; }
    this.lastByteAt = now;
    for (let i = 0; i + 1 < v.length; i += 64) {
      if (((v[i] | (v[i + 1] << 8)) << 16 >> 16) !== 0) { this.lastNonZeroAt = now; break; }
    }
  }

  /** THE GATE. Shut until the child is converged AND the warmup has passed the first byte.
   *  One-time per capture: `armedAt` latches, so an armed call never pays this again. */
  get armed(): boolean {
    if (this.armedAt) return true;
    if (this.down || !this.firstByteAt) return false;
    const age = Date.now() - this.firstByteAt;
    if (age < this.armMs) return false;
    if (!this.conv && age < this.convWaitMs) return false;
    this.armedAt = Date.now();
    this.o.log("info", `vp barge gate ARMED — ${age}ms past the first cleaned byte${this.conv ? ", canceller converged (conv=1)" : `, NO convergence token from this child in ${this.convWaitMs}ms (armed on the warmup alone)`}${this.unarmed ? `; ${this.unarmed} pre-convergence event(s) dropped` : ""}`,
      { vp_armed: true, warmup_ms: age, conv: this.conv, dropped_unarmed: this.unarmed || undefined });
    return true;
  }

  close() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.proc?.kill(9); } catch {}
  }

  // ── internals ──────────────────────────────────────────────────────────────────
  private markFirstByte() {
    const now = Date.now();
    this.firstByteAt = this.lastByteAt = this.lastNonZeroAt = now;
    this.o.log("info", `vp capture live — VPIO cleaned mic @${this.rate}Hz after ${now - this.spawnAt}ms (the OS cancels our speaker before capture); the barge gate stays SHUT for another ${this.armMs}ms while the canceller converges`,
      { vp_live: true, ms: now - this.spawnAt, arm_ms: this.armMs });
  }

  /** Read exactly ONE chunk off the child's stdout and give the lock straight back, so the
   *  engine's own pump can take the stream over from the very next byte. Never swallows audio:
   *  the chunk is returned and talk.ts feeds it into pumpMic ahead of everything else. */
  private async readFirstChunk(): Promise<Uint8Array | null> {
    const stream = this.proc?.stdout;
    if (!stream || typeof stream.getReader !== "function") return null;
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return null;
        if (value?.length) { this.markFirstByte(); return value as Uint8Array; }
      }
    } catch { return null; }
    finally { try { reader.releaseLock(); } catch {} }
  }

  /** ONE way down, whatever the cause: say it loud, tell the caller (which reverts to the
   *  ffmpeg mic live), kill the child so its stdout ends and the mic supervisor respawns. */
  private fail(why: string) {
    if (this.down) return;
    this.down = true;
    this.o.log("info", `vp capture down — reverting to the ffmpeg mic (${why})`, { vp_down: true, why });
    this.close();
    try { this.o.onDown(why); } catch {}
  }

  private tick() {
    if (this.down) return;
    const now = Date.now();
    if (!this.firstByteAt) {
      if (now - this.spawnAt > this.startMs) this.fail(`no audio in ${this.startMs}ms (device contention, or the capture never started)`);
      return;
    }
    // HANDOVER WINDOW: between the first byte (read here) and the engine's pump taking over,
    // nothing calls note(), so the 200ms liveness bar would fire on a perfectly healthy child.
    if (!this.handedOver) {
      if (now - this.firstByteAt > this.handoverMs) this.fail(`the engine never took the capture over (${now - this.firstByteAt}ms after the first byte)`);
      return;
    }
    // Poll the gate so the ARMED line lands at the moment it really opens, not at the first
    // barge that happens to query it — an operator must be able to SEE the call go live.
    if (!this.armedAt) void this.armed;
    if (now - this.lastByteAt > this.deadMs) { this.fail(`no cleaned frames for ${now - this.lastByteAt}ms`); return; }
    // TCC SILENT DENIAL (P0-5): a denied mic yields an endless stream of ZEROS — frames keep
    // arriving, every peak is 0, and the call looks alive while hearing nothing. A real room
    // has a noise floor (measured: peak 602 in a quiet room on this rig), so digital silence
    // this long is a permission problem, not a quiet one. Reverting is the safe direction.
    if (now - this.lastNonZeroAt > this.zeroMs) this.fail(`all-zero frames for ${now - this.lastNonZeroAt}ms — MICROPHONE PERMISSION (TCC) or a dead capture device`);
  }

  private async pumpEvents() {
    const fd3 = this.proc.stdio?.[3];
    if (typeof fd3 !== "number") return;                 // no fd3 → the stderr "EV " channel carries them
    try {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of Bun.file(fd3).stream() as any) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); this.line(line.trim()); }
      }
    } catch { /* the child went away; the watchdog and `exited` both cover it */ }
  }

  private async pumpStderr() {
    if (!this.proc.stderr) return;
    try {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of this.proc.stderr as any) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          if (line.startsWith("EV ")) { this.line(line.slice(3).trim()); continue; }
          // TCC, read straight off aecmic's own diagnostic (P0-5): 3 = authorized. Anything
          // else is a call that will hear nothing, so say it LOUD and take the ffmpeg mic back
          // now rather than after 3s of zeros.
          // CONVERGENCE, straight off the child's own diagnostics. aecmic2 prints
          // `converter (re)built: ...` the instant its first buffer converts, and carries
          // `conv=1` in every status heartbeat and in its shutdown line. Either is the same
          // fact: the capture chain is up and the canceller is running on real audio.
          if (!this.conv && (/\bconv=([1-9]\d*)/.test(line) || /converter \(re\)built/.test(line))) this.conv = true;
          const tcc = /TCC status:\s*(\d)/.exec(line);
          if (tcc && tcc[1] !== "3") { this.o.log("info", `vp capture: MICROPHONE PERMISSION DENIED (TCC status ${tcc[1]}) — grant Microphone access to the terminal/app that starts the call`, { vp_tcc: Number(tcc[1]) }); this.fail(`microphone permission denied (TCC status ${tcc[1]})`); continue; }
          // Startup diagnostics are worth having in the log; a crash dump is not. Cap the
          // chatter and keep only the lines that name a failure after that.
          if (this.stderrLines < 15 || /error|denied|fail|exit|TCC/i.test(line)) { this.stderrLines++; this.o.log("info", `vp: ${line.slice(0, 200)}`, { vp_log: true }); }
        }
      }
    } catch {}
  }

  private line(s: string) {
    if (!s.startsWith("{")) return;
    try {
      const ev = JSON.parse(s) as VpEvent;
      if (ev?.ev !== "barge" || this.down) return;
      // THE ONE TRUE FALSE-POSITIVE CLASS (soak lane): every echo-driven event it could not
      // explain away sat in the first ~2s of capture, at cleaned peak 1.4-2.6k — leak the
      // canceller had not converged on yet, comfortably over the child's own 1200 bar. Level
      // cannot separate it from him (his real barges measured 2 574 at the quiet end), so it is
      // separated by TIME instead. Dropped events are counted and reported when the gate opens.
      if (!this.armed) {
        this.unarmed++;
        if (this.unarmed <= 3) this.o.log("info", `vp barge IGNORED — the gate is not armed yet (peak ${Math.round(ev.peak ?? 0)}, ${Math.round(ev.voiced_ms ?? 0)}ms voiced): the canceller is still converging, and that is exactly where the soak's false positives lived`,
          { vp_unarmed_drop: true, peak: Math.round(ev.peak ?? 0), voiced_ms: Math.round(ev.voiced_ms ?? 0), n: this.unarmed });
        return;
      }
      this.o.onBarge(ev);
    } catch { /* a malformed line is never a barge */ }
  }
}
