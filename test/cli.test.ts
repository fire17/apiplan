// The CLI surface: help quality, the quote-free prompt promise, and the fact that
// every management verb is scriptable (the TUI is a view over these, never the only door).
import { expect, test, describe } from "bun:test";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const ASK = join(ROOT, "bin", "ask.ts");
const AP = join(ROOT, "bin", "apiplan.ts");
const SB = join(tmpdir(), `apiplan-cli-${process.pid}`);
mkdirSync(SB, { recursive: true });

/** Run one of our entry points with a clean, isolated config + bin dir. */
function run(entry: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync([process.execPath, entry, ...args], {
    env: { ...process.env, APIPLAN_HOME: SB, APIPLAN_BIN: join(SB, "bin"), NO_COLOR: "1", APIPLAN_DAEMON: "off", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}

describe("help is real documentation (B9)", () => {
  const { out, code } = run(ASK, ["--model", "opus", "--help"]);
  test("exits clean and names the resolved model", () => {
    expect(code).toBe(0);
    expect(out).toContain("claude-opus-5");
  });
  test("documents every flag a user can pass", () => {
    for (const flag of ["--model", "--effort", "--thinking", "--loop", "--max-tokens", "--image",
      "--system", "--system-file", "--chat", "--stream", "--show-thinking", "--json", "--dry-run",
      "--no-daemon", "--verbose", "--help", "--version", "--fast", "--1m", "--"]) {
      expect(out).toContain(flag);
    }
  });
  test("fits on one screen and shows a quote-free example", () => {
    expect(out.split("\n").length).toBeLessThanOrEqual(48);
    expect(out).toMatch(/<your question, no quotes needed>/);
  });
  test("apiplan's own help lists every management verb", () => {
    const r = run(AP, ["help"]);
    for (const verb of ["status", "models", "commands", "install", "add", "rename", "rm", "sync", "doctor", "daemon", "path", "shell-init"]) {
      expect(r.out).toContain(verb);
    }
    expect(r.code).toBe(0);
  });
  test("--version prints a version on both entry points", () => {
    expect(run(ASK, ["--version"]).out).toMatch(/apiplan \d+\.\d+\.\d+/);
    expect(run(AP, ["--version"]).out).toMatch(/apiplan \d+\.\d+\.\d+/);
  });
});

describe("a sentence needs no quotes (B8)", () => {
  test("bare words reach the request as one prompt", () => {
    const { out } = run(ASK, ["-m", "opus", "--dry-run", "explain", "monads", "in", "one", "sentence"]);
    const body = JSON.parse(out).body;
    expect(body.messages[0].content).toBe("explain monads in one sentence");
  });
  test("punctuation the shell would normally eat survives when it reaches us", () => {
    const { out } = run(ASK, ["-m", "opus", "--dry-run", "is", "this", "right?", "100%", "sure*"]);
    expect(JSON.parse(out).body.messages[0].content).toBe("is this right? 100% sure*");
  });
  test("zsh users get noglob aliases so the shell stops eating ? and *", () => {
    const { out } = run(AP, ["shell-init", "zsh"]);
    expect(out).toContain("alias apiplan='noglob apiplan'");
    expect(out).toMatch(/alias \w+='noglob \w+'/);
  });
  test("shells that need nothing are told so, not given useless aliases", () => {
    const { out } = run(AP, ["shell-init", "bash"]);
    expect(out).not.toMatch(/^alias \S+=/m);   // no alias definitions, only an explanation
    expect(out.toLowerCase()).toContain("no aliases are needed");
  });
});

describe("errors help instead of just failing", () => {
  test("an unknown model suggests real alternatives", () => {
    const r = run(ASK, ["-m", "gpt9", "hi"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown model");
    expect(r.err).toContain("apiplan models");
  });
  test("an effort the model does not support lists the ones it does", () => {
    const r = run(ASK, ["-m", "sol", "-e", "minimal", "hi"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/valid: .*high/);
  });
  test("no prompt prints help rather than a bare error", () => {
    const r = run(ASK, ["-m", "opus"]);
    expect(r.out).toContain("USAGE");
    expect(r.err).toContain("no prompt");
  });
  test("a missing image file is named exactly", () => {
    const r = run(ASK, ["-m", "opus", "-i", "/no/such/pic.png", "hi"]);
    expect(r.err).toContain("/no/such/pic.png");
  });
});

describe("command management is fully scriptable (I2)", () => {
  test("add → rename → rm round-trips, and names are validated", () => {
    expect(run(AP, ["add", "myopus", "--model", "opus48", "--flags", "-e low --stream"]).code).toBe(0);
    let ls = run(AP, ["commands"]).out;
    expect(ls).toContain("myopus");
    expect(ls).toContain("claude-opus-4-8");

    expect(run(AP, ["rename", "myopus", "quickopus"]).code).toBe(0);
    ls = run(AP, ["commands"]).out;
    expect(ls).toContain("quickopus");
    expect(ls).not.toContain("myopus");

    expect(run(AP, ["rm", "quickopus"]).code).toBe(0);
    expect(run(AP, ["commands"]).out).not.toContain("quickopus");
  });
  test("adding an unknown model is refused with a pointer to the model list", () => {
    const r = run(AP, ["add", "bogus", "--model", "not-a-model"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("apiplan models");
  });
  test("a created command actually carries its baked-in flags", () => {
    run(AP, ["add", "terse", "--model", "opus", "--flags", "-e low --stream"]);
    expect(run(AP, ["commands"]).out).toContain("-e low --stream");
    run(AP, ["rm", "terse"]);
  });
  test("config is plain JSON a human can edit, then sync", () => {
    const cfg = join(SB, "commands.json");
    writeFileSync(cfg, JSON.stringify({ version: 1, binDir: join(SB, "bin"), commands: [{ name: "handmade", model: "sonnet" }] }));
    const r = run(AP, ["sync"]);
    expect(r.out).toContain("handmade");
  });
  test("an upgrade's leftover command is detected and prunable, foreign files are not", () => {
    const bin = join(SB, "bin");
    mkdirSync(bin, { recursive: true });
    // a shim we wrote for a command that no longer exists in the config
    writeFileSync(join(bin, "gonecmd"), `#!/bin/sh\nexec "/bin/bun" "/x/ask.ts" --model opus "$@"\n`);
    // something that just happens to live in the same directory
    writeFileSync(join(bin, "notours"), "#!/bin/sh\necho unrelated tool\n");
    const sync = run(AP, ["sync"]);
    expect(sync.out).toContain("gonecmd");
    const pruned = run(AP, ["prune"]);
    expect(pruned.out).toContain("gonecmd");
    expect(pruned.out).not.toContain("notours");
    expect(run(AP, ["prune"]).out).toContain("nothing to prune");
  });
  test("doctor reports rather than throws, even in a fresh sandbox", () => {
    const r = run(AP, ["doctor"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DOCTOR");
    expect(r.out).toContain("bin dir");
  });
});
