#!/usr/bin/env bun
// jimmy.ts — a CLI for chatjimmy.ai (Taalas), whose model runs in silicon rather than
// on a GPU: measured 14,926 tok/s decode and 1.18 ms to first token server-side.
//
// At those numbers the model is never the slow part — the wall clock is process start,
// TLS, and network. So this file stays deliberately dependency-free and does exactly
// one thing: open the connection as early as possible and stream bytes straight out.
const API = process.env.JIMMY_API ?? "https://chatjimmy.ai";
const MODEL = process.env.JIMMY_MODEL ?? "llama3.1-8B";
const START = performance.now();

// The server appends its own telemetry to the end of the stream. It is genuinely
// interesting here (it is the whole point of the hardware) but it is not the answer,
// so it is stripped unless asked for.
const STATS = /<\|stats\|>([\s\S]*?)<\|\/stats\|>/;

import { join } from "node:path";
import { STATE_DIR, ensureDir, ipc, ipcTarget, IS_WIN } from "../src/platform.ts";

const SOCK = process.env.JIMMY_SOCK ?? join(STATE_DIR, IS_WIN ? "jimmy.json" : "jimmy.sock");
const IDLE_MS = 15 * 60_000;      // a holder nobody uses is just a process; let it go

/**
 * The warm holder. It exists for one reason: keep a TLS session to chatjimmy.ai alive so
 * a call costs a round trip instead of a handshake. It carries no state and no secrets —
 * there is no account here — so it is safe to start on demand and let it expire.
 */
async function runDaemon(): Promise<never> {
  ensureDir(STATE_DIR);
  try { require("node:fs").unlinkSync(SOCK); } catch {}
  let last = Date.now();
  const keepWarm = async () => {
    // An idle TLS connection gets closed by the far end; a cheap periodic GET keeps the
    // session (and DNS) hot so the first real call after a pause is still fast.
    try { await fetch(`${API}/api/health`); } catch {}
  };
  await keepWarm();
  const timer = setInterval(() => {
    if (Date.now() - last > IDLE_MS) { try { require("node:fs").unlinkSync(SOCK); } catch {}; process.exit(0); }
    keepWarm();
  }, 30_000);
  const server = Bun.serve({
    unix: IS_WIN ? undefined : SOCK,
    ...(IS_WIN ? { port: 0, hostname: "127.0.0.1" } : {}),
    idleTimeout: 120,
    async fetch(req) {
      last = Date.now();
      if (new URL(req.url).pathname === "/health") return new Response("ok");
      const body = await req.text();
      // Stream straight through: the client is waiting on these bytes.
      const up = await fetch(`${API}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body });
      return new Response(up.body, { status: up.status, headers: { "content-type": "text/plain" } });
    },
  } as any);
  if (IS_WIN) require("node:fs").writeFileSync(SOCK, JSON.stringify({ port: (server as any).port }));
  const bye = () => { try { require("node:fs").unlinkSync(SOCK); } catch {}; process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
  await new Promise(() => {});
  clearInterval(timer);
  throw new Error("unreachable");
}

const target = (path: string) => {
  if (IS_WIN) {
    try { const { port } = JSON.parse(require("node:fs").readFileSync(SOCK, "utf8")); return { url: `http://127.0.0.1:${port}${path}`, opts: {} }; }
    catch { return null; }
  }
  return { url: `http://jimmy${path}`, opts: { unix: SOCK } };
};

/** Ask the warm holder. Null means "no holder" — the caller then goes direct. */
async function viaDaemon(body: string): Promise<Response | null> {
  if ((process.env.JIMMY_DAEMON ?? "auto") === "off") return null;
  const t = target("/api/chat");
  if (!t) { spawnDaemon(); return null; }
  try {
    const r = await fetch(t.url, { ...(t.opts as any), method: "POST", headers: { "content-type": "application/json" }, body });
    if (r.ok) return r;
  } catch {
    // Not running. Start one for NEXT time and serve this call directly, so the first
    // call is never slower for having asked.
    spawnDaemon();
  }
  return null;
}

function spawnDaemon() {
  try {
    Bun.spawn([process.execPath, import.meta.path, "--daemon"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {}
}

const argv = process.argv.slice(2);
const flag = (...names: string[]) => names.some((n) => argv.includes(n));
const valOf = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes("--daemon")) await runDaemon();
if (argv.includes("--daemon-stop")) {
  const t = target("/health");
  let stopped = false;
  try { if (t) { await fetch(t.url, { ...(t.opts as any) }); } } catch {}
  try { require("node:fs").unlinkSync(SOCK); stopped = true; } catch {}
  // The holder notices its socket is gone at the next tick and exits on its own.
  process.stdout.write(stopped ? "jimmy: warm connection released\n" : "jimmy: nothing running\n");
  process.exit(0);
}

if (flag("-h", "--help")) {
  process.stdout.write(`jimmy — chat with ${MODEL} on chatjimmy.ai (Taalas silicon)

USAGE
  jimmy <your question, no quotes needed>
  cat file.txt | jimmy summarise this
  jimmy -s "answer in one word" is 91 prime

  -s, --system <text>   system prompt
      --stats           show the server's own speed numbers (tok/s, TTFT)
      --json            print the raw JSON response instead of text
      --no-stream       wait for the whole answer, then print it
      --daemon          run the warm connection holder in the foreground
      --daemon-stop     stop it   (JIMMY_DAEMON=off disables it entirely)
  -v, --verbose         report round-trip latency
  -h, --help            this help

No account, no API key — chatjimmy.ai is open. JIMMY_API / JIMMY_MODEL override the
endpoint and model.
`);
  process.exit(0);
}

const system = valOf("-s") ?? valOf("--system");
const VALUED = new Set(["-s", "--system"]);
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUED.has(a)) { i++; continue; }
  if (a.startsWith("-")) continue;
  words.push(a);
}

/**
 * Read stdin only when it is actually a pipe or a file. `!isTTY` is not enough: under a
 * scheduler, CI, or any launcher that hands the process /dev/null, stdin is a non-TTY
 * character device with nothing coming, and awaiting it hangs forever.
 */
function readStdin(): Promise<string> {
  try {
    const st = require("node:fs").fstatSync(0);
    if (st.isFIFO() || st.isFile()) return Bun.stdin.text();
  } catch {}
  return Promise.resolve("");
}
const piped = await readStdin();
const prompt = [words.join(" "), piped.trim()].filter(Boolean).join("\n\n");
if (!prompt) {
  process.stderr.write("jimmy: no prompt — type it after the command, or pipe it in.\n");
  process.exit(1);
}

const messages = [
  ...(system ? [{ role: "system", content: system }] : []),
  { role: "user", content: prompt },
];

// chatOptions.selectedModel, not `model` — the server answers
// {"error":"Selected model is required"} for every other spelling.
const payload = JSON.stringify({ messages, chatOptions: { selectedModel: MODEL } });
const direct = () => fetch(`${API}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });

let res: Response;
try {
  // Measured: 528ms cold, 171ms once the TLS session is reused. The model itself takes
  // ~1ms, so the handshake IS the latency — a process that keeps the connection open is
  // worth more here than any other optimisation available to us.
  res = (await viaDaemon(payload)) ?? (await direct());
} catch (e: any) {
  process.stderr.write(`jimmy: could not reach ${API} — ${e?.message ?? e}\n`);
  process.exit(1);
}

if (!res.ok || !res.body) {
  const detail = (await res.text()).slice(0, 300);
  process.stderr.write(`jimmy: ${API} answered ${res.status}: ${detail}\n`);
  process.exit(1);
}

const stream = !flag("--no-stream", "--json");
const reader = res.body.getReader();
const dec = new TextDecoder();
let all = "", ttft = 0;

// The stats sentinel arrives at the very end, but it could be split across chunks — so
// hold back a tail long enough to contain its opening marker rather than printing it.
const HOLD = 16;
let pending = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (!ttft) ttft = performance.now() - START;
  const chunk = dec.decode(value, { stream: true });
  all += chunk;
  if (!stream) continue;
  pending += chunk;
  const cut = pending.indexOf("<|stats|>");
  if (cut >= 0) { process.stdout.write(pending.slice(0, cut)); pending = ""; break; }
  if (pending.length > HOLD) { process.stdout.write(pending.slice(0, -HOLD)); pending = pending.slice(-HOLD); }
}
if (stream && pending) process.stdout.write(pending.replace(STATS, ""));

const m = all.match(STATS);
const text = all.replace(STATS, "").trim();
let stats: any = null;
try { stats = m ? JSON.parse(m[1]) : null; } catch {}

if (flag("--json")) {
  process.stdout.write(JSON.stringify({ model: MODEL, text, stats }, null, 2) + "\n");
} else if (stream) {
  if (!text.endsWith("\n")) process.stdout.write("\n");
} else {
  process.stdout.write(text + "\n");
}

if (flag("--stats") && stats) {
  const n = (v: number, d = 0) => (typeof v === "number" ? v.toFixed(d) : "?");
  process.stderr.write(
    `\x1b[2m${n(stats.decode_rate)} tok/s decode · ${n(stats.prefill_rate)} tok/s prefill · ` +
    `server TTFT ${n(stats.ttft * 1000, 2)}ms · ${stats.total_tokens} tokens\x1b[0m\n`);
}
if (flag("-v", "--verbose")) {
  process.stderr.write(`\x1b[2mfirst byte ${ttft.toFixed(0)}ms · total ${(performance.now() - START).toFixed(0)}ms (wall clock, includes TLS)\x1b[0m\n`);
}
