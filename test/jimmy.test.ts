// jimmy's contract, tested against a local stand-in for chatjimmy.ai. Pointing
// JIMMY_API at a fake keeps these hermetic — no network, no third-party uptime — while
// still exercising the real CLI end to end, including the stats sentinel and streaming.
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "jimmy.ts");
const STATS = { decode_rate: 14926.3, prefill_rate: 15224.3, ttft: 0.00118, total_tokens: 48 };

let base = "";
let stop = () => {};
let lastBody: any = null;

beforeAll(() => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") return new Response(JSON.stringify({ status: "ok" }));
      lastBody = await req.json();
      if (!lastBody?.chatOptions?.selectedModel) {
        return new Response(JSON.stringify({ success: false, error: "Selected model is required" }), { status: 400 });
      }
      // The real server streams plain text and appends its telemetry at the very end.
      return new Response(`Hello, how are you?<|stats|>${JSON.stringify(STATS)}<|/stats|>`);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  stop = () => server.stop(true);
});
afterAll(() => stop());

/**
 * Run the CLI with the daemon disabled, so each test measures the direct path.
 * Async on purpose: spawnSync blocks this process's event loop, and the fake server
 * lives in that same loop — so a synchronous spawn deadlocks against its own server.
 */
const stdinFile = (text: string) => {
  const f = join(require("node:os").tmpdir(), `jimmy-stdin-${Bun.hash(text).toString(36)}.txt`);
  require("node:fs").writeFileSync(f, text);
  return f;
};

const run = async (args: string[], stdin: "ignore" | string = "ignore", env: Record<string, string> = {}) => {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, JIMMY_API: base, JIMMY_DAEMON: "off", JIMMY_MODEL: "llama3.1-8B", ...env },
    // A real file rather than a programmatic pipe: Bun's spawn-pipe writes did not
    // reach the child reliably, and the CLI treats a file and a FIFO the same way.
    stdin: stdin === "ignore" ? "ignore" : Bun.file(stdinFile(stdin)),
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { out, err, code: await p.exited };
};

describe("jimmy speaks chatjimmy.ai's actual dialect", () => {
  test("the model goes in chatOptions.selectedModel, which is the only spelling it accepts", async () => {
    await run(["say", "hi"]);
    expect(lastBody.chatOptions.selectedModel).toBe("llama3.1-8B");
    expect(lastBody.messages).toEqual([{ role: "user", content: "say hi" }]);
  });
  test("a bare sentence is the prompt — no quotes needed", async () => {
    const r = await run(["is", "91", "prime?"]);
    expect(lastBody.messages[0].content).toBe("is 91 prime?");
    expect(r.code).toBe(0);
  });
  test("--system becomes a system message and never leaks into the prompt", async () => {
    await run(["-s", "answer in one word", "what", "animal"]);
    expect(lastBody.messages[0]).toEqual({ role: "system", content: "answer in one word" });
    expect(lastBody.messages[1].content).toBe("what animal");
  });
  test("piped stdin is appended to the prompt", async () => {
    await run(["summarise"], "the cat sat on the mat");
    expect(lastBody.messages[0].content).toBe("summarise\n\nthe cat sat on the mat");
  });
});

describe("the telemetry sentinel never reaches the answer", () => {
  test("streamed output carries the text and not the stats block", async () => {
    const r = await run(["say", "hi"]);
    expect(r.out).toContain("Hello, how are you?");
    expect(r.out).not.toContain("<|stats|>");
    expect(r.out).not.toContain("decode_rate");
  });
  test("--no-stream produces the same clean text", async () => {
    const r = await run(["--no-stream", "say", "hi"]);
    expect(r.out.trim()).toBe("Hello, how are you?");
    expect(r.out).not.toContain("stats");
  });
  test("--stats reports the speed on stderr, keeping stdout pipeable", async () => {
    const r = await run(["--stats", "say", "hi"]);
    expect(r.err).toContain("tok/s decode");
    expect(r.out).not.toContain("tok/s");
  });
  test("--json exposes text and stats separately", async () => {
    const r = await run(["--json", "say", "hi"]);
    const j = JSON.parse(r.out);
    expect(j.text).toBe("Hello, how are you?");
    expect(j.stats.decode_rate).toBeCloseTo(14926.3, 1);
    expect(j.model).toBe("llama3.1-8B");
  });
});

describe("it fails usefully instead of hanging", () => {
  test("no prompt and no pipe is an error, not a wait", async () => {
    // The bug this guards: stdin that is neither a TTY nor a pipe (a scheduler handing
    // the process /dev/null) made the CLI await input that was never coming.
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no prompt");
  });
  test("a server error is reported with its message", async () => {
    const r = await run(["hi"], "ignore", { JIMMY_MODEL: "" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Selected model is required");
  });
  test("an unreachable endpoint says so rather than throwing a stack trace", async () => {
    const r = await run(["hi"], "ignore", { JIMMY_API: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not reach");
    expect(r.err).not.toContain("at <anonymous>");
  });
});

describe("help", () => {
  test("names the service, the speed story, and that no key is needed", async () => {
    const r = await run(["--help"]);
    expect(r.out).toContain("chatjimmy.ai");
    expect(r.out).toContain("no API key");
    expect(r.out.split("\n").length).toBeLessThanOrEqual(24);
  });
});
