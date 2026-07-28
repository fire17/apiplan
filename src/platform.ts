// platform.ts — everything that differs between macOS, Linux, WSL and Windows.
// Every OS-specific decision lives here and nowhere else, so the engine, the
// providers and the TUI are written once and run everywhere.
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";

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
    const cmd = join(binDir, `${name}.cmd`);
    writeFileSync(cmd, `@echo off\r\n"${runner}" "${entry}" ${args.map(winQuote).join(" ")} %*\r\n`);
    written.push(cmd);
    const ps1 = join(binDir, `${name}.ps1`);
    writeFileSync(ps1, `#!/usr/bin/env pwsh\n& "${runner}" "${entry}" ${args.map(psQuote).join(" ")} @args\nexit $LASTEXITCODE\n`);
    written.push(ps1);
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
  const cands = IS_WIN ? [`${name}.cmd`, `${name}.ps1`] : [name];
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

/** Human-readable OS label for `apiplan doctor`. */
export function osLabel(): string {
  return IS_WIN ? "Windows" : IS_MAC ? "macOS" : IS_WSL ? "WSL" : "Linux";
}
