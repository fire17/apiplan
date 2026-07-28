// The cross-platform layer, exercised for all four targets from any one of them.
// Windows shim generation takes an explicit flag so it is testable on macOS/Linux.
import { expect, test, describe, afterAll } from "bun:test";
import { join } from "node:path";
import { readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeShim, removeShim, RESERVED, shadowsExisting, isOurShim, ipc, readJson, writeJson, osLabel, detectWsl, IS_WIN } from "../src/platform.ts";

const SB = join(tmpdir(), `apiplan-test-${process.pid}`);
mkdirSync(SB, { recursive: true });
afterAll(() => { try { rmSync(SB, { recursive: true, force: true }); } catch {} });

describe("shims", () => {
  test("posix shim execs the runner and passes user args through", () => {
    const files = writeShim(SB, "unittest-posix", "/bin/bun", "/x/ask.ts", ["--model", "opus"], false);
    expect(files.length).toBe(1);
    const s = readFileSync(files[0], "utf8");
    expect(s).toStartWith("#!/bin/sh");
    expect(s).toContain(`exec "/bin/bun" "/x/ask.ts" --model opus "$@"`);
  });
  test("windows gets .cmd, .ps1 AND a bare sh shim (cmd.exe, pwsh, Git Bash)", () => {
    const files = writeShim(SB, "unittest-win", "C:\\bun.exe", "C:\\ask.ts", ["--model", "opus"], true);
    expect(files.map((f) => f.split(/[\\/]/).pop())).toEqual(["unittest-win.cmd", "unittest-win.ps1", "unittest-win"]);
    // Git Bash appends only .exe, so without the extensionless copy `opus` finds nothing
    expect(readFileSync(files[2], "utf8")).toStartWith("#!/bin/sh");
    const cmd = readFileSync(files[0], "utf8");
    expect(cmd).toContain("@echo off");
    expect(cmd).toContain("%*");                 // forwards the user's words
    expect(cmd).toContain("\r\n");               // CRLF, or cmd.exe misparses
    const ps1 = readFileSync(files[1], "utf8");
    expect(ps1).toContain("@args");
    expect(ps1).toContain("exit $LASTEXITCODE"); // exit code survives the wrapper
  });
  test("flags containing spaces stay one argument", () => {
    const f = writeShim(SB, "unittest-quote", "/bin/bun", "/x/ask.ts", ["-s", "be very terse"], false)[0];
    expect(readFileSync(f, "utf8")).toContain(`-s 'be very terse'`);
  });
  test("removeShim cleans up every variant it wrote", () => {
    writeShim(SB, "unittest-rm", "/bin/bun", "/x/ask.ts", [], false);
    expect(existsSync(join(SB, "unittest-rm"))).toBe(true);
    const gone = removeShim(SB, "unittest-rm");
    expect(gone.length).toBeGreaterThan(0);
    expect(existsSync(join(SB, "unittest-rm"))).toBe(false);
  });
});

describe("name safety", () => {
  test("real system tools are reserved — gpt is a partition editor", () => {
    expect(RESERVED.has("gpt")).toBe(true);
    expect(RESERVED.has("rm")).toBe(true);
    expect(shadowsExisting("gpt", SB)).not.toBeNull();
  });
  test("a name nothing else owns is free", () => {
    expect(shadowsExisting("apiplan-nonexistent-xyz", SB)).toBeNull();
  });
  test("our own shim is recognised as safe to upgrade", () => {
    const f = join(SB, "unittest-ours");
    writeFileSync(f, `#!/bin/sh\nexec "/bin/bun" "/x/ask.ts" --model opus "$@"\n`);
    expect(isOurShim(f)).toBe(true);
  });
  test("a foreign script is NOT ours", () => {
    const f = join(SB, "unittest-foreign");
    writeFileSync(f, "#!/bin/sh\necho hello from some other tool\n");
    expect(isOurShim(f)).toBe(false);
  });
});

describe("WSL detection (real /proc/version strings)", () => {
  test("WSL2 kernel is recognised", () => {
    expect(detectWsl("Linux version 5.15.167.4-microsoft-standard-WSL2 (root@941d701f84f1) #1 SMP")).toBe(true);
  });
  test("WSL1 kernel is recognised", () => {
    expect(detectWsl("Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) #488-Microsoft")).toBe(true);
  });
  test("plain Linux is NOT WSL", () => {
    expect(detectWsl("Linux version 6.1.0-18-arm64 (debian-kernel@lists.debian.org) #1 SMP Debian")).toBe(false);
    expect(detectWsl("Linux version 5.10.0-21-amd64 (gcc-10) #1 SMP Debian 5.10.162-1")).toBe(false);
  });
  test("WSL's own environment variables are trusted even if /proc/version is odd", () => {
    expect(detectWsl("Linux version 6.6.0-generic", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
    expect(detectWsl("Linux version 6.6.0-generic", { WSL_INTEROP: "/run/WSL/8_interop" })).toBe(true);
    expect(detectWsl("Linux version 6.6.0-generic", {})).toBe(false);
  });
});

describe("ipc transport", () => {
  test("unix socket off Windows, loopback TCP on it", () => {
    const i = ipc();
    expect(i.kind).toBe(IS_WIN ? "tcp" : "unix");
  });
});

describe("state files", () => {
  test("write then read round-trips, and corrupt files fall back instead of throwing", () => {
    const p = join(SB, "state.json");
    writeJson(p, { a: 1, nested: { b: [1, 2] } });
    expect(readJson(p, null)).toEqual({ a: 1, nested: { b: [1, 2] } });
    writeFileSync(p, "{ this is not json");
    expect(readJson(p, { fallback: true })).toEqual({ fallback: true });
    expect(readJson(join(SB, "does-not-exist.json"), "d")).toBe("d");
  });
});

test("os label names one of the four supported targets", () => {
  expect(["macOS", "Linux", "WSL", "Windows"]).toContain(osLabel());
});

// A tracked path that Windows cannot create makes `git checkout` fail outright — the
// repo becomes uncloneable there, which is worse than any test failure. This happened:
// a mangled shell command created a file whose NAME was a multi-line script, `git add
// -A` committed it, and Windows CI died at checkout.
test("no tracked file has a name Windows cannot check out", () => {
  const p = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return;                      // not a git checkout (e.g. tarball) — nothing to assert
  const paths = p.stdout.toString().split("\0").filter(Boolean);
  expect(paths.length).toBeGreaterThan(0);
  const illegal = paths.filter((f) => /[<>:"|?*\n\r]/.test(f) || /[ .]$/.test(f.split("/").pop() ?? ""));
  expect(illegal).toEqual([]);
});
