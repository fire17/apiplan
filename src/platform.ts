// platform.ts — everything that differs between macOS, Linux, WSL and Windows.
// Every OS-specific decision lives here and nowhere else, so the engine, the
// providers and the TUI are written once and run everywhere.
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, statSync } from "node:fs";

export const IS_WIN = platform() === "win32";
export const IS_MAC = platform() === "darwin";
/**
 * WSL is Linux, but with a Windows host reachable through interop. Kept as a pure
 * function of /proc/version so the branch can be tested on a machine that isn't WSL
 * (real strings from WSL1, WSL2 and plain Linux live in test/platform.test.ts).
 */
export function detectWsl(procVersion: string, env: Record<string, string | undefined> = {}): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;   // set by WSL itself
  return /microsoft|wsl/i.test(procVersion);
}
export const IS_WSL = !IS_WIN && !IS_MAC && (() => {
  try { return detectWsl(readFileSync("/proc/version", "utf8"), process.env); } catch { return false; }
})();

export const HOME = homedir();
export const STATE_DIR = process.env.APIPLAN_HOME || join(HOME, ".apiplan");
export const TMP = process.env.TMPDIR || process.env.TEMP || tmpdir();

export function ensureDir(d: string) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

/** Read a JSON file, or `fallback` if it is missing/corrupt. Never throws. */
export function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}
/** Atomic write (temp + rename) so a crash mid-write can't corrupt shared state. */
export function writeJson(path: string, value: unknown) {
  ensureDir(join(path, ".."));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  try { require("node:fs").renameSync(tmp, path); }
  catch { writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); try { unlinkSync(tmp); } catch {} }
}

// ---- where user-facing commands get installed ----
/** First writable dir on PATH we'd be happy to own, else a sensible per-OS default. */
export function defaultBinDir(): string {
  if (process.env.APIPLAN_BIN) return process.env.APIPLAN_BIN;
  const path = (process.env.PATH || "").split(IS_WIN ? ";" : ":").filter(Boolean);
  const prefer = IS_WIN
    ? [join(HOME, ".bun", "bin"), join(HOME, "AppData", "Local", "Microsoft", "WindowsApps"), join(HOME, "bin")]
    : [join(HOME, ".bun", "bin"), join(HOME, ".local", "bin"), "/usr/local/bin"];
  for (const p of prefer) if (path.includes(p) && canWrite(p)) return p;
  for (const p of prefer) if (canWrite(p)) return p;
  return IS_WIN ? join(HOME, "AppData", "Local", "apiplan", "bin") : join(HOME, ".local", "bin");
}
function canWrite(d: string): boolean {
  try { ensureDir(d); const t = join(d, `.apiplan-w-${process.pid}`); writeFileSync(t, ""); unlinkSync(t); return true; }
  catch { return false; }
}
export function onPath(dir: string): boolean {
  return (process.env.PATH || "").split(IS_WIN ? ";" : ":").includes(dir);
}

// ---- command shims (the globally available CLIs) ----
/**
 * Materialise one command. On POSIX that's a tiny exec'ing sh script; on Windows
 * BOTH a .cmd (for cmd.exe/PowerShell) and a .ps1 (for pwsh piping), because a
 * bare `.cmd` mangles some quoting that PowerShell users depend on.
 */
export function writeShim(binDir: string, name: string, runner: string, entry: string, args: string[], forWindows = IS_WIN): string[] {
  ensureDir(binDir);
  const argline = args.map(shellQuote).join(" ");
  const written: string[] = [];
  if (forWindows) {
    // Three files, because Windows has three shells that resolve commands differently:
    //   .cmd  — cmd.exe and PowerShell (via PATHEXT)
    //   .ps1  — pwsh, where quoting and piping behave like a native cmdlet
    //   bare  — Git Bash / MSYS, which append .exe only and would otherwise find nothing
    const cmd = join(binDir, `${name}.cmd`);
    writeFileSync(cmd, `@echo off\r\n"${runner}" "${entry}" ${args.map(winQuote).join(" ")} %*\r\n`);
    written.push(cmd);
    const ps1 = join(binDir, `${name}.ps1`);
    writeFileSync(ps1, `#!/usr/bin/env pwsh\n& "${runner}" "${entry}" ${args.map(psQuote).join(" ")} @args\nexit $LASTEXITCODE\n`);
    written.push(ps1);
    const sh = join(binDir, name);
    writeFileSync(sh, `#!/bin/sh\nexec "${runner}" "${entry}" ${argline} "$@"\n`);
    try { chmodSync(sh, 0o755); } catch {}
    written.push(sh);
  } else {
    const sh = join(binDir, name);
    writeFileSync(sh, `#!/bin/sh\nexec "${runner}" "${entry}" ${argline} "$@"\n`);
    chmodSync(sh, 0o755);
    written.push(sh);
  }
  return written;
}
export function removeShim(binDir: string, name: string): string[] {
  const gone: string[] = [];
  const cands = IS_WIN ? [`${name}.cmd`, `${name}.ps1`, name] : [name];
  for (const c of cands) {
    const p = join(binDir, c);
    if (existsSync(p)) { try { unlinkSync(p); gone.push(p); } catch {} }
  }
  return gone;
}
const shellQuote = (s: string) => (/^[A-Za-z0-9_.:/=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const winQuote = (s: string) => (/^[A-Za-z0-9_.:/=\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Names we must never install over: real system tools. `gpt` is /usr/sbin/gpt
 * (the GUID partition table editor) on macOS — installing over it silently
 * shadows a disk tool, and PATH order decides who wins. Learned the hard way.
 */
export const RESERVED = new Set(["gpt", "test", "ls", "cd", "rm", "cp", "mv", "kill", "sh", "bash", "zsh", "python", "node", "git", "claude", "codex", "npm", "bun", "curl", "sudo", "open", "which", "env", "clear", "top", "df", "du", "ps"]);
/**
 * Anything already resolvable on PATH that we didn't install ourselves.
 * A shim we wrote (this version or an earlier one) is ours to replace — we detect
 * that by content, so upgrading never needs --force, while a real system tool of
 * the same name is still protected.
 */
export function shadowsExisting(name: string, binDir: string): string | null {
  if (RESERVED.has(name)) return whichSync(name) || "(reserved name)";
  const found = whichSync(name);
  if (!found) return null;
  const ours = [join(binDir, name), join(binDir, `${name}.cmd`), join(binDir, `${name}.ps1`)];
  if (ours.some((o) => found === o)) return null;
  return isOurShim(found) ? null : found;
}
/** True when this file is a shim written by any version of apiplan. */
export function isOurShim(file: string): boolean {
  try {
    const s = readFileSync(file, "utf8");
    if (s.length > 4096) return false; // shims are tiny; a real binary is not
    return /apiplan|APIPlan|\bask\.ts\b|\bapi\.ts\b|\bcodex\.ts\b/.test(s);
  } catch { return false; }
}
export function whichSync(name: string): string | null {
  const exts = IS_WIN ? ["", ".cmd", ".exe", ".ps1", ".bat"] : [""];
  for (const dir of (process.env.PATH || "").split(IS_WIN ? ";" : ":")) {
    if (!dir) continue;
    for (const e of exts) { const p = join(dir, name + e); if (existsSync(p)) return p; }
  }
  return null;
}

// ---- daemon IPC: unix socket where we have one, loopback TCP on Windows ----
export type Ipc =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; portFile: string };
export function ipc(): Ipc {
  if (process.env.APIPLAN_SOCK) return { kind: "unix", path: process.env.APIPLAN_SOCK };
  // APIPLAN_IPC lets the Windows transport be exercised on any OS, so the loopback
  // path is tested rather than assumed.
  const forced = process.env.APIPLAN_IPC;
  const useTcp = forced ? forced === "tcp" : IS_WIN;
  return useTcp
    ? { kind: "tcp", portFile: join(STATE_DIR, "daemon.json") }
    : { kind: "unix", path: join(STATE_DIR, "daemon.sock") };
}
/** Build the fetch() target + options for talking to the daemon, per transport. */
export function ipcTarget(i: Ipc, path: string): { url: string; opts: any } | null {
  if (i.kind === "unix") return { url: `http://apiplan${path}`, opts: { unix: i.path } };
  const st = readJson<{ port?: number; token?: string }>(i.portFile, {});
  if (!st.port) return null;
  return { url: `http://127.0.0.1:${st.port}${path}`, opts: { headers: { "x-apiplan-token": st.token || "" } } };
}

// ---- clipboard images, per OS ----
/** Raw bytes of the clipboard image, or null. Tries every mechanism the OS offers. */
export function clipboardImageBytes(): Uint8Array | null {
  const out = join(TMP, `apiplan-clip-${process.pid}.png`);
  const tries: string[][] = IS_MAC
    ? [["pngpaste", out]]
    : IS_WIN || IS_WSL
      ? [["powershell.exe", "-NoProfile", "-Command",
          `Add-Type -Assembly System.Windows.Forms; $i=[Windows.Forms.Clipboard]::GetImage(); if($i){$i.Save('${out.replace(/\\/g, "\\\\")}',[System.Drawing.Imaging.ImageFormat]::Png)}`]]
      : [["wl-paste", "-t", "image/png", "-o"], ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]];
  for (const cmd of tries) {
    // stdout-producing tools (wl-paste/xclip/pngpaste -) vs file-writing tools
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0 && r.stdout?.length > 8) return new Uint8Array(r.stdout);
    if (existsSync(out)) {
      try { const b = new Uint8Array(readFileSync(out)); unlinkSync(out); if (b.length > 8) return b; } catch {}
    }
  }
  if (IS_MAC) { // AppleScript fallback when pngpaste isn't installed
    Bun.spawnSync(["osascript", "-e", `try
set png to (the clipboard as «class PNGf»)
set f to open for access POSIX file "${out}" with write permission
write png to f
close access f
end try`], { stderr: "ignore" });
    if (existsSync(out)) { try { const b = new Uint8Array(readFileSync(out)); unlinkSync(out); if (b.length > 8) return b; } catch {} }
  }
  return null;
}

/**
 * Speak text with whatever voice the operating system already has — the offline
 * fallback for `--local`, so a machine with no API key can still talk.
 * Returns the tool used, or null when the OS offers nothing.
 */
/**
 * The OS voice that can actually pronounce this text. `say` reads Hebrew with an
 * English voice as gibberish, so the script the text is written in picks the voice —
 * which is the difference between working multilingual speech and noise.
 */
export function localVoiceFor(text: string): string | null {
  if (!IS_MAC) return null;               // only macOS exposes a stable named-voice list
  const script: [RegExp, string[]][] = [
    [/[\u0590-\u05FF]/, ["Carmit"]],                        // Hebrew
    [/[\u0600-\u06FF]/, ["Majed", "Amira"]],                 // Arabic
    [/[\u3040-\u30FF]/, ["Kyoko", "Otoya"]],                 // Japanese
    [/[\uAC00-\uD7AF]/, ["Yuna"]],                          // Korean
    [/[\u4E00-\u9FFF]/, ["Tingting", "Meijia"]],             // Chinese
    [/[\u0400-\u04FF]/, ["Milena", "Katya"]],                // Cyrillic
    [/[\u0900-\u097F]/, ["Lekha"]],                         // Devanagari
    [/[\u0E00-\u0E7F]/, ["Kanya"]],                         // Thai
  ];
  let want: string[] | null = null;
  for (const [re, names] of script) if (re.test(text)) { want = names; break; }
  const have = new Set<string>();
  try {
    const r = Bun.spawnSync(["say", "-v", "?"], { stderr: "ignore" });
    for (const line of (r.stdout?.toString() ?? "").split("\n")) {
      const m = line.match(/^([^\s]+(?: [^\s]+)?)\s{2,}/);
      if (m) have.add(m[1].trim());
    }
  } catch { return null; }
  if (want) return want.find((n) => have.has(n)) ?? null;
  return null;                            // Latin text: the system default is right
}

export function speakLocally(text: string): string | null {
  const mac = localVoiceFor(text);
  const attempts: string[][] = IS_MAC
    ? [mac ? ["say", "-v", mac, text] : ["say", text]]
    : IS_WIN
      ? [["powershell.exe", "-NoProfile", "-Command", `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(${JSON.stringify(text)})`]]
      : IS_WSL
        ? [["powershell.exe", "-NoProfile", "-Command", `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(${JSON.stringify(text)})`],
           ["spd-say", "-w", text], ["espeak", text]]
        : [["spd-say", "-w", text], ["espeak", text], ["festival", "--tts"]];
  for (const cmd of attempts) {
    if (!whichSync(cmd[0])) continue;
    const r = Bun.spawnSync(cmd, { stdin: cmd[0] === "festival" ? new TextEncoder().encode(text) : undefined, stderr: "ignore", stdout: "ignore" });
    if (r.exitCode === 0) return cmd[0];
  }
  return null;
}

/**
 * Live microphone capture as raw PCM16 on stdout, and raw PCM16 playback on stdin.
 * ffmpeg is the one dependency that already exists on machines doing audio work, and
 * it is the only cross-platform way to reach a microphone without a native module —
 * so both are ffmpeg/ffplay argv, and the OS difference is only the input driver.
 */
export function micCommand(rate = 24000): string[] | null {
  if (!whichSync("ffmpeg")) return null;
  const src = IS_MAC ? ["-f", "avfoundation", "-i", ":default"]
    : IS_WIN ? ["-f", "dshow", "-i", "audio=default"]
    : ["-f", "pulse", "-i", "default"];            // Linux/WSL: PulseAudio or PipeWire's shim
  return ["ffmpeg", "-hide_banner", "-loglevel", "error", ...src,
    "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"];
}
export function speakerCommand(rate = 24000, channels: "mono" | "stereo" = "mono"): string[] | null {
  if (!whichSync("ffplay")) return null;
  // -ch_layout, NOT -ac: `-ac` is an ffmpeg option and ffplay rejects it outright
  // ("Option not found"), exiting instantly — which sounds exactly like silence.
  // -autoexit: one player per reply, so it drains and exits when that reply's stdin
  // closes. A single long-lived player is alive but silent after the first turn — raw
  // PCM has no timestamps, so the gaps between turns drift its clock.
  // Low-latency flags: start playing the moment PCM arrives instead of probing/buffering
  // a header-less stream. Cuts ~75-170ms of real (previously unmeasured) audible latency.
  // channels="stereo" is the LiveMind voice field (canon 023): the PCM is already interleaved
  // in-process by panChunk() before it reaches this stdin, so the layout must match (the byte
  // rate doubles, the duration does not). NEVER add `-af pan=` here — ffplay fixes its filter
  // graph at spawn, so his live knob would only be heard on the NEXT player, and a filter in
  // this path spends the very latency the flags above bought back.
  return ["ffplay", "-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit",
    "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0",
    "-f", "s16le", "-ar", String(rate), "-ch_layout", channels, "-i", "-"];
}

// ── LiveMind STEREO VOICE FIELD (canon 023, fire17's spec) ───────────────────
// His words: MOUTH = 100% right + 50% left, MIND = 100% left + 50% right — "חלק חלק,
// ומעבר חלק ביניהם". A crossover, not a hard pan: the 50% bleed keeps the ~3-6 dB that a
// hard pan costs, and he tuned it by ear before anyone measured it.
//
// This is the ONE loader for BOTH voices. The mouth interleaves per PCM chunk (below); the
// mind builds an ffplay `-af pan=` string from panGains("mind") at every utterance spawn.
// One file, one kill switch, one mono decision — so the field can never end up half-on.
//
// Three laws shape this code:
//  1. LIVE KNOB, NO RESTART — he tunes WHILE a call runs. So the mouth is panned here, in
//     process, per PCM chunk. An ffplay `-af pan=` graph is fixed at spawn: a knob change
//     would only be heard on the NEXT player, i.e. a reply late. (The MIND path is
//     per-utterance, so `-af pan` IS fine there — it re-reads these gains at every spawn.)
//  2. A MISSING OR HALF-WRITTEN KNOB FILE MUST NEVER BREAK HIS AUDIO. He hand-edits
//     ~/.livemind/stereo.json mid-call (the hub slider and `lm-pan` write the same file),
//     so catching a half-flushed save is the NORMAL case, not an edge case: the last good
//     gains stand, everything is clamped 0..1, and the call keeps talking.
//  3. MONO DEGRADE IS HONEST — both ears get identical samples at FULL volume, never one
//     ear at half. panGains() returns unity for BOTH voices, so the mind's filter string
//     collapses to a flat duplicate and the two voices stay equally loud.
export const STEREO_FILE = process.env.LIVEMIND_STEREO_FILE || join(HOME, ".livemind", "stereo.json");
export type PanGains = { l: number; r: number };
const PAN_DEFAULTS: Record<"mouth" | "mind", PanGains> = { mouth: { l: 0.5, r: 1.0 }, mind: { l: 1.0, r: 0.5 } };
const PAN_UNITY: PanGains = { l: 1, r: 1 };
let panCache: Record<"mouth" | "mind", PanGains> = PAN_DEFAULTS;
let panMtime = -1, panStatAt = 0;
// Two independent reasons the field can collapse; either one means honest mono-sum.
let monoAccess = false, monoDevice = false, monoCheckAt = 0;
const monoSum = () => monoAccess || monoDevice;

/** Kill switch for the field, both voices at once: LIVEMIND_STEREO=0 (APIPLAN_STEREO=off works too). */
export function stereoEnabled(): boolean {
  const v = (process.env.LIVEMIND_STEREO ?? process.env.APIPLAN_STEREO ?? "").trim().toLowerCase();
  return v !== "0" && v !== "off" && v !== "false" && v !== "no";
}

// ── VOICE TRIM (path-gain parity) ─────────────────────────────────────────────
// The field decides WHERE a voice sits; the trim decides HOW LOUD it is — per voice, in the SAME
// live file: {"mouth":{"l":0.5,"r":1,"g":1},"mind":{"l":1,"r":0.5,"g":0.8}}. One loader, one
// kill switch, one mono decision, still.
//
// WHY IT EXISTS, measured 2026-08-20 (his ear: "the mouth is quieter than the mind"):
//  • ffplay does NOT normalize the MIND path down. `pan=stereo|c0=1.0*c0|c1=0.5*c0` was measured
//    end-to-end (mono 4095 in → L max 4095, R max 2048): c0 passes at unity. af_pan renormalizes
//    only terms written WITHOUT an explicit `k*` coefficient, and only when one output's |gain|
//    sum exceeds 1 — the shipped expression fails both tests, so it cannot attenuate.
//  • The two pan paths are arithmetically MIRROR-EQUAL (mouth 0.5/1.0 in-process, mind 1.0/0.5
//    in the filter) — identical energy. The mismatch is not in the panning.
//  • The SOURCES differ: four MIND narrator renders measure peak -0.43..0.00 dBFS, RMS -19..-21
//    dBFS — hot, effectively at full scale. The mouth's realtime deltas are not on disk to
//    measure, but a hotter narrator is exactly what his ear reports.
// ATTENUATION ONLY, clamped 0..1: the mind already sits at 0 dBFS, so the clip-free way to match
// two voices is to lower the LOUDER one — never to boost the quieter one into the ceiling.
// Default 1.0 for both = byte-identical audio: this knob costs nothing until he turns it.
// (g:0 mutes that voice — honest, and reversible in the same breath, since the file is live.)
const TRIM_DEFAULTS: Record<"mouth" | "mind", number> = { mouth: 1, mind: 1 };
let trimCache: Record<"mouth" | "mind", number> = { ...TRIM_DEFAULTS };

/** The one throttled read of the live knob file: ≤5 stats/sec, one parse per mtime change. */
function refreshPan() {
  const now = Date.now();
  if (now - panStatAt <= 200) return;       // ≤5 stats/sec — never a read or a parse per chunk
  panStatAt = now;
  try {
    const m = statSync(STEREO_FILE).mtimeMs;
    if (m === panMtime) return;
    const j: any = JSON.parse(readFileSync(STEREO_FILE, "utf8"));
    const g = (v: unknown, d: number) => (typeof v === "number" && v >= 0 && v <= 1 ? v : d);
    panCache = {
      mouth: { l: g(j?.mouth?.l, PAN_DEFAULTS.mouth.l), r: g(j?.mouth?.r, PAN_DEFAULTS.mouth.r) },
      mind:  { l: g(j?.mind?.l,  PAN_DEFAULTS.mind.l),  r: g(j?.mind?.r,  PAN_DEFAULTS.mind.r)  },
    };
    trimCache = { mouth: g(j?.mouth?.g, TRIM_DEFAULTS.mouth), mind: g(j?.mind?.g, TRIM_DEFAULTS.mind) };
    panMtime = m;
  } catch { /* missing, half-written, or garbage: keep the last good gains and keep talking */ }
}

/** Current gains for one voice. Hot path: stats the knob ≤5x/sec, parses only on mtime change. */
export function panGains(who: "mouth" | "mind"): PanGains {
  refreshPan();                             // BEFORE the mono check — the trim stays live in mono-sum too
  if (monoSum()) return PAN_UNITY;
  return panCache[who] ?? PAN_DEFAULTS[who];
}

/** Live output trim for one voice, 0..1 (1 = untouched). LIVEMIND_MOUTH_GAIN / LIVEMIND_MIND_GAIN
 *  win over the file, so a call can be STARTED at a fixed balance without moving his live slider;
 *  an out-of-range or typo'd env is ignored rather than obeyed, and the file (or 1.0) stands. */
export function voiceGain(who: "mouth" | "mind"): number {
  const raw = process.env[who === "mouth" ? "LIVEMIND_MOUTH_GAIN" : "LIVEMIND_MIND_GAIN"];
  if (raw !== undefined && raw !== "") {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
  }
  refreshPan();
  return trimCache[who] ?? 1;
}

// A chunk of raw PCM can in principle split a sample across two deltas. Dropping that odd
// byte would shift the byte-parity of EVERY later sample — the stream turns to noise and
// never recovers — so it is carried into the next chunk instead. Per voice, reset with the player.
const panCarry: Record<"mouth" | "mind", number> = { mouth: -1, mind: -1 };
export function panReset(who: "mouth" | "mind") { panCarry[who] = -1; }

/** mono s16le → interleaved stereo s16le at the live gains. Clamped, so a bad knob cannot distort him. */
export function panChunk(chunk: Buffer, who: "mouth" | "mind" = "mouth"): Buffer {
  const { l, r } = panGains(who);           // read ONCE per chunk, not per sample
  const t = voiceGain(who);                 // …and the trim with it — both ≤1, so gl/gr can add no clipping
  const gl = l * t, gr = r * t;
  let buf = chunk;
  const carried = panCarry[who];
  if (carried >= 0) {                        // rare: re-join the sample that straddled two chunks
    const joined = Buffer.allocUnsafe(chunk.length + 1);
    joined[0] = carried;
    chunk.copy(joined, 1);
    buf = joined;
  }
  const n = buf.length >> 1;
  panCarry[who] = (buf.length & 1) ? buf[buf.length - 1]! : -1;
  const out = Buffer.allocUnsafe(n * 4);
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    let L = Math.round(s * gl), R = Math.round(s * gr);
    if (L > 32767) L = 32767; else if (L < -32768) L = -32768;
    if (R > 32767) R = 32767; else if (R < -32768) R = -32768;
    out.writeInt16LE(L, i * 4);
    out.writeInt16LE(R, i * 4 + 2);
  }
  return out;
}

/** Mono s16le at the voice trim — the LIVEMIND_STEREO=0 path, where panChunk never runs and the
 *  trim would otherwise be a silently dead knob. At the default (1) it returns the SAME buffer:
 *  no copy, no loop, no cost. A trailing odd byte (a sample straddling two chunks) is passed
 *  through untouched rather than dropped — dropping it would shift the byte-parity of every later
 *  sample and turn the stream to noise, and one slightly-untrimmed sample is inaudible. */
export function trimMono(chunk: Buffer, who: "mouth" | "mind" = "mouth"): Buffer {
  const t = voiceGain(who);
  if (!(t < 1)) return chunk;               // 1, NaN-proof: the default path stays byte-identical
  const out = Buffer.allocUnsafe(chunk.length);
  const n = chunk.length >> 1;
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(chunk.readInt16LE(i * 2) * t), i * 2);
  if (chunk.length & 1) out[chunk.length - 1] = chunk[chunk.length - 1]!;
  return out;
}

/** macOS "Play stereo audio as mono" silently destroys the field. ~20ms, so read it sync. */
function readAccessibilityMono(): boolean {
  if (!IS_MAC) return false;
  try {
    const r = Bun.spawnSync(["defaults", "read", "com.apple.universalaccess", "monoAudio"], { stderr: "ignore" });
    return new TextDecoder().decode(r.stdout).trim() === "1";
  } catch { return false; }   // absent key = feature off; never block a call on a probe
}
/** The device itself: a BT headset with its mic open switches to mono HFP. ~200ms, so async. */
function probeOutputDevice(log?: (msg: string) => void) {
  if (!IS_MAC) return;
  (async () => {
    try {
      const p = Bun.spawn(["system_profiler", "SPAudioDataType"], { stdout: "pipe", stderr: "ignore" });
      const txt = await new Response(p.stdout as ReadableStream).text();
      const dev = txt.split(/\n\s*\n/).find((b) => /Default Output Device:\s*Yes/i.test(b)) || "";
      const ch = Number(dev.match(/Output Channels:\s*(\d+)/i)?.[1] ?? 2);
      const was = monoDevice;
      monoDevice = ch < 2;
      if (monoDevice !== was)
        log?.(monoDevice
          ? `stereo field degraded to MONO-SUM — default output device has ${ch} channel (Bluetooth HFP?)`
          : "stereo field: the default output device is stereo again — the field is back");
    } catch { /* a probe must never touch his audio */ }
  })();
}
/**
 * Re-decide the mode. His calls run for HOURS: AirPods can arrive mid-call (HFP collapses both
 * channels) and the accessibility switch can flip at any time, so a start-of-call decision goes
 * stale and the log line then lies. Throttled to once per 30s and called only where a player is
 * being spawned anyway, so it costs one cached spawn on a path that already spawns ffplay.
 */
export function stereoRecheck(log?: (msg: string) => void) {
  if (!stereoEnabled()) return;
  const now = Date.now();
  if (now - monoCheckAt < 30000) return;
  monoCheckAt = now;
  const was = monoAccess;
  monoAccess = readAccessibilityMono();
  if (monoAccess !== was)
    log?.(monoAccess
      ? "stereo field: MONO-SUM — 'play stereo audio as mono' came on mid-call; both ears identical, full volume"
      : "stereo field: 'play stereo audio as mono' went off — the field is back");
  probeOutputDevice(log);
}

/**
 * Startup: decide whether this machine can actually carry a stereo field, and SAY which mode
 * engaged (a silently-collapsed field is indistinguishable from a working one by ear).
 * Mono degrade is honest — both ears get the same samples at full volume, never one ear halved.
 */
export function initStereo(log: (msg: string) => void) {
  if (!stereoEnabled()) { log("stereo field OFF (LIVEMIND_STEREO=0) — mouth stays mono"); return; }
  monoCheckAt = Date.now();
  monoAccess = readAccessibilityMono();
  const g = panGains("mouth");
  log(monoSum()
    ? "stereo field: MONO-SUM — accessibility 'play stereo audio as mono' is on; both ears identical, full volume"
    : `stereo field: mouth L=${g.l.toFixed(2)} R=${g.r.toFixed(2)} · live knob ${STEREO_FILE} (edit mid-call, no restart)`);
  // The device probe costs ~200ms, so it runs ASYNC — the player is spawned lazily on the first
  // audio byte, seconds later, and stereo is the safe default meanwhile.
  probeOutputDevice(log);
}

/** Hand a file to the desktop to open however it likes. Returns the tool, or null. */
export function openFile(path: string): string | null {
  const cmd = IS_MAC ? ["open", path]
    : IS_WIN ? ["cmd.exe", "/c", "start", "", path]
    : IS_WSL ? ["wslview", path]
    : ["xdg-open", path];
  if (!whichSync(cmd[0])) return null;
  const r = Bun.spawnSync(cmd, { stderr: "ignore", stdout: "ignore" });
  return r.exitCode === 0 ? cmd[0] : null;
}

/** Play an audio file with the OS's default player. Returns the tool used, or null. */
export function playAudio(path: string): string | null {
  const attempts: string[][] = IS_MAC
    ? [["afplay", path]]
    : IS_WIN
      ? [["powershell.exe", "-NoProfile", "-Command", `(New-Object Media.SoundPlayer ${JSON.stringify(path)}).PlaySync()`]]
      : [["paplay", path], ["aplay", path], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path], ["mpv", "--no-video", path]];
  for (const cmd of attempts) {
    if (!whichSync(cmd[0])) continue;
    const r = Bun.spawnSync(cmd, { stderr: "ignore", stdout: "ignore" });
    if (r.exitCode === 0) return cmd[0];
  }
  return null;
}

/** Human-readable OS label for `apiplan doctor`. */
export function osLabel(): string {
  return IS_WIN ? "Windows" : IS_MAC ? "macOS" : IS_WSL ? "WSL" : "Linux";
}
