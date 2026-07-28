#!/usr/bin/env bun
// APIPlan — call Anthropic frontier models with your signed-in Claude Code
// subscription (no per-token API billing). Two routes:
//   direct  — raw POST to /v1/messages with the keychain OAuth token. Blazing
//             fast, stateless, trivially parallel. True completion/chat API.
//   harness — spawn `claude -p`. Full harness (tools, skills, agentic depth),
//             slower startup. Effort is the test-time-compute knob.
//
// Invoke as `opus`/`fable`/`sonnet`/`haiku` (argv0 picks the model) or `api -m <x>`.
// Pipeable both ways:  cat log | opus "find the bug" | pbcopy
//
// Exact API contract (identity line, beta header, endpoint) was lifted verbatim
// from the claude binary — not guessed. Every fragile constant is env-overridable
// so a server-side change can be patched without editing code.

const VERSION = "0.1.0";

// alias -> { harness alias for `claude --model`, explicit id for the direct route }
const ALIASES: Record<string, { alias: string; id: string }> = {
  opus:   { alias: "opus",   id: env("APIPLAN_ID_OPUS",   "claude-opus-4-8") },
  fable:  { alias: "fable",  id: env("APIPLAN_ID_FABLE",  "claude-fable-5") },
  sonnet: { alias: "sonnet", id: env("APIPLAN_ID_SONNET", "claude-sonnet-5") },
  haiku:  { alias: "haiku",  id: env("APIPLAN_ID_HAIKU",  "claude-haiku-4-5-20251001") },
};

// effort -> extended-thinking budget (test-time compute). low = thinking off.
const THINK: Record<string, number> = { low: 0, medium: 4000, high: 10000, xhigh: 24000, max: 48000 };
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const IDENTITY = env("APIPLAN_IDENTITY", "You are Claude Code, Anthropic's official CLI for Claude.");
const BASE = env("APIPLAN_BASE_URL", "https://api.anthropic.com");
const API_VERSION = env("APIPLAN_API_VERSION", "2023-06-01");
const OAUTH_BETA = env("APIPLAN_OAUTH_BETA", "oauth-2025-04-20");
const KEYCHAIN_SERVICE = env("APIPLAN_KEYCHAIN_SERVICE", "Claude Code-credentials");
const SOCK = env("APIPLAN_SOCK", `${process.env.HOME}/.apiplan.sock`);
const REFINE = "Review your previous answer, correct any mistakes, and output only the improved final answer.";

const START = performance.now(); // script-eval time ≈ process start, for --verbose timing
function env(k: string, d: string): string { return process.env[k] && process.env[k]!.length ? process.env[k]! : d; }
function die(msg: string, code = 1): never { process.stderr.write(`apiplan: ${msg}\n`); process.exit(code); }

// ---- credentials (reused from FluidVoice/ccvoice — the proven path) ----
function oauthCred(): { accessToken: string; expiresAt: number } {
  const raw = Bun.spawnSync(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  if (raw.exitCode !== 0) die("no Claude Code credentials in Keychain — run `claude` and log in first.");
  let t: any;
  try { t = JSON.parse(raw.stdout.toString()).claudeAiOauth; }
  catch { die("could not parse Keychain credentials JSON."); }
  if (!t?.accessToken) die("Keychain entry has no claudeAiOauth.accessToken.");
  if (t.expiresAt && t.expiresAt < Date.now()) die("Claude OAuth token expired — run `claude` once to refresh it.");
  return { accessToken: t.accessToken, expiresAt: t.expiresAt || 0 };
}
function oauthToken(): string { return oauthCred().accessToken; }

// ---- images (multimodal): file | http(s) URL | data: URI | - (stdin) | clipboard/paste ----
function sniffImage(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return null;
}
async function clipboardImage(): Promise<Uint8Array> {
  const pp = Bun.spawnSync(["pngpaste", "-"]);
  if (pp.exitCode === 0 && pp.stdout.length) return new Uint8Array(pp.stdout);
  const tmp = `${process.env.TMPDIR || "/tmp"}/apiplan-clip-${process.pid}.png`;
  Bun.spawnSync(["osascript", "-e", `try
set png to (the clipboard as «class PNGf»)
set f to open for access POSIX file "${tmp}" with write permission
write png to f
close access f
end try`]);
  const f = Bun.file(tmp);
  if (await f.exists()) { const d = new Uint8Array(await f.arrayBuffer()); try { require("node:fs").unlinkSync(tmp); } catch {} if (d.length) return d; }
  die("no image in clipboard (install pngpaste: `brew install pngpaste`, or pass a file/URL).");
}
// provider-agnostic descriptor: {url} for remote, {media_type,data} for base64
async function loadImage(src: string): Promise<{ url?: string; media_type?: string; data?: string }> {
  if (/^https?:\/\//.test(src)) return { url: src };
  if (src.startsWith("data:")) { const m = src.match(/^data:([^;]+);base64,(.*)$/s); if (!m) die(`bad data: URI`); return { media_type: m[1], data: m[2] }; }
  let bytes: Uint8Array;
  if (src === "-") bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  else if (src === "clipboard" || src === "paste") bytes = await clipboardImage();
  else { const f = Bun.file(src); if (!(await f.exists())) die(`image not found: ${src}`); bytes = new Uint8Array(await f.arrayBuffer()); }
  const mt = sniffImage(bytes); if (!mt) die(`unrecognized image (png/jpeg/gif/webp): ${src}`);
  return { media_type: mt, data: Buffer.from(bytes).toString("base64") };
}
// Anthropic image content blocks from loaded descriptors
function imageBlocks(imgs: { url?: string; media_type?: string; data?: string }[]): any[] {
  return imgs.map((im) => im.url
    ? { type: "image", source: { type: "url", url: im.url } }
    : { type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
}
// attach images to a message content (string or block-array) → block array
function withImages(content: any, blocks: any[]): any {
  if (!blocks.length) return content;
  const arr = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? [...content] : [content];
  return [...arr, ...blocks];
}
// shorten long base64 in dry-run output so it stays readable
function redactImages(o: any): any {
  return JSON.parse(JSON.stringify(o), (k, v) => (k === "data" && typeof v === "string" && v.length > 64) ? `<base64 ${v.length}b>` : v);
}

// ---- arg parsing (no deps) ----
type Opts = {
  model?: string; effort?: string; system?: string; systemFile?: string;
  route: "direct" | "harness"; maxTokens?: number; temperature?: number;
  thinking?: number; loop: number; json: boolean; stream: boolean; chat: boolean;
  showThinking: boolean; oneM: boolean; verbose: boolean; help: boolean;
  dryRun: boolean; daemon: boolean; daemonStop: boolean; noDaemon: boolean; fast: boolean;
  images: string[]; prompt: string[];
};

function parse(argv: string[], model0?: string): Opts {
  const o: Opts = {
    model: model0, route: (env("APIPLAN_ROUTE", "direct") as any),
    loop: 1, json: false, stream: false, chat: false, showThinking: false,
    oneM: false, verbose: false, help: false, dryRun: false,
    daemon: false, daemonStop: false, noDaemon: false, fast: false, images: [], prompt: [],
  };
  const takesVal = new Set(["-m","--model","-e","--effort","-s","--system","--system-file",
    "--route","--max-tokens","-t","--temp","--temperature","--thinking","--loop","-i","--image"]);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--") { o.prompt.push(...argv.slice(i + 1)); break; }
    let inlineVal: string | undefined;
    if (a.startsWith("--") && a.includes("=")) { const j = a.indexOf("="); inlineVal = a.slice(j + 1); a = a.slice(0, j); }
    const val = () => inlineVal !== undefined ? inlineVal : argv[++i];
    switch (a) {
      case "-h": case "--help": o.help = true; break;
      case "-m": case "--model": o.model = val(); break;
      case "-e": case "--effort": o.effort = val(); break;
      case "-s": case "--system": o.system = val(); break;
      case "--system-file": o.systemFile = val(); break;
      case "--route": o.route = val() as any; break;
      case "--max-tokens": o.maxTokens = +val(); break;
      case "-t": case "--temp": case "--temperature": o.temperature = +val(); break;
      case "--thinking": { const v = val(); o.thinking = v === "off" ? 0 : +v; break; }
      case "--loop": o.loop = Math.max(1, +val() || 1); break;
      case "--json": o.json = true; break;
      case "--stream": o.stream = true; break;
      case "--chat": o.chat = true; break;
      case "--show-thinking": o.showThinking = true; break;
      case "--1m": o.oneM = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--daemon": o.daemon = true; break;
      case "--daemon-stop": o.daemonStop = true; break;
      case "--no-daemon": o.noDaemon = true; break;
      case "--fast": o.fast = true; break;
      case "-i": case "--image": o.images.push(val()); break;
      case "-v": case "--verbose": o.verbose = true; break;
      default:
        if (a.startsWith("-") && a.length > 1 && takesVal.has(a)) { /* unreachable */ }
        else o.prompt.push(argv[i]);
    }
  }
  return o;
}

function resolveModel(m: string | undefined): { alias: string; id: string } {
  if (!m) die("no model — use an alias command (opus/fable/sonnet/haiku) or -m <model>.");
  if (ALIASES[m]) return ALIASES[m];
  // full id or unknown alias: pass through verbatim to both routes
  return { alias: m, id: m };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return (await Bun.stdin.text());
}

function effortToThinking(o: Opts): number {
  if (o.thinking !== undefined) return Math.max(0, o.thinking | 0);
  if (o.effort) {
    if (!(o.effort in THINK)) die(`bad effort '${o.effort}'; valid: ${EFFORTS.join(", ")}`);
    return THINK[o.effort];
  }
  return 0;
}

// Modern thinking contract (Opus 4.5+, Sonnet 4.6/5, Fable 5): output_config.effort +
// adaptive thinking; budget_tokens AND temperature are rejected with 400. Legacy models
// (Haiku 4.5 and older) use the budget_tokens path with temperature allowed.
function isModernThinking(id: string): boolean {
  return /opus-4-(5|6|7|8)|sonnet-5|sonnet-4-6|fable-5|mythos-5/.test(id);
}
const HIGH_EFFORT = new Set(["high", "xhigh", "max"]);

// ---- Route: direct (raw Messages API) ----
// Pure request builder — shared by the in-process path and the daemon.
function buildDirect(o: Opts, modelId: string, userSystem: string, token: string):
    { url: string; headers: Record<string, string>; baseBody: any } {
  if (o.effort && !EFFORTS.includes(o.effort)) die(`bad effort '${o.effort}'; valid: ${EFFORTS.join(", ")}`);
  const modern = isModernThinking(modelId);
  const betas = [OAUTH_BETA];
  if (o.oneM) betas.push("context-1m-2025-08-07");
  if (o.fast) betas.push("fast-mode-2026-02-01"); // Fast Mode — ~2.5x output speed (Opus 4.8/4.7 only)
  const system = [{ type: "text", text: IDENTITY }];
  if (userSystem) system.push({ type: "text", text: userSystem });
  const baseBody: any = { model: modelId, system };
  if (o.fast) baseBody.speed = "fast";

  if (modern) {
    // effort → output_config.effort; thinking is adaptive (or disabled). No budget_tokens/temperature.
    const thinkOff = o.thinking !== undefined && o.thinking <= 0;
    if (thinkOff) baseBody.thinking = { type: "disabled" };
    else if (o.effort) baseBody.thinking = o.showThinking ? { type: "adaptive", display: "summarized" } : { type: "adaptive" };
    // else: omit thinking → runs without thinking (fast default on Opus 4.8)
    if (o.effort) baseBody.output_config = { effort: o.effort };
    baseBody.max_tokens = o.maxTokens ?? (o.effort && HIGH_EFFORT.has(o.effort) ? 32000 : 8192);
  } else {
    // legacy budget_tokens path (Haiku 4.5, older)
    const think = effortToThinking(o);
    if (think > 0) betas.push("interleaved-thinking-2025-05-14");
    baseBody.max_tokens = o.maxTokens ?? (think > 0 ? think + 8192 : 8192);
    if (think > 0 && baseBody.max_tokens <= think) die(`--max-tokens (${baseBody.max_tokens}) must exceed thinking budget (${think}).`);
    if (think > 0) baseBody.thinking = { type: "enabled", budget_tokens: think };
    else if (o.temperature !== undefined) baseBody.temperature = o.temperature;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${token}`,
    "anthropic-version": API_VERSION,
    "anthropic-beta": betas.join(","),
    "anthropic-client-platform": "cli",
    "x-app": "cli",
  };
  return { url: `${BASE}/v1/messages?beta=true`, headers, baseBody };
}

function surfaceError(status: number, msg: string, retryAfter?: string | null): never {
  if (status === 401 || status === 403) die(`auth rejected (${status}): ${msg}\n  → token may be stale (run \`claude\`) or the identity/beta contract changed (see APIPLAN_IDENTITY / APIPLAN_OAUTH_BETA).`, 3);
  if (status === 429) die(`rate limited (429): ${msg}${retryAfter ? ` — retry after ${retryAfter}s` : ""}`, 4);
  die(`API error (${status}): ${msg}`);
}

// In-process direct call (fallback when the daemon is off/unavailable; also the json/loop/dry-run path).
async function routeDirect(o: Opts, model: { id: string }, messages: any[], userSystem: string) {
  const token = o.dryRun ? "<oauth-token>" : oauthToken();
  const { url, headers, baseBody } = buildDirect(o, model.id, userSystem, token);

  if (o.dryRun) {
    const redacted = { ...headers, authorization: "Bearer <oauth-token>" };
    process.stdout.write(JSON.stringify(redactImages({ method: "POST", url, headers: redacted, body: { ...baseBody, messages, ...(o.loop > 1 ? { _loop: o.loop } : {}) } }), null, 2) + "\n");
    return;
  }

  let convo = [...messages];
  let lastText = "";
  for (let pass = 0; pass < o.loop; pass++) {
    if (pass > 0) convo.push({ role: "user", content: REFINE });
    const stream = o.stream && pass === o.loop - 1;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...baseBody, messages: convo, ...(stream ? { stream: true } : {}) }) });
    if (stream) { await consumeSSE(res.body, res.status, res.headers.get("retry-after"), o); return; }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) surfaceError(res.status, data?.error?.message || res.statusText, res.headers.get("retry-after"));
    if (o.json && pass === o.loop - 1) { process.stdout.write(JSON.stringify(data) + "\n"); return; }
    lastText = renderBlocks(data.content, o.showThinking);
    convo.push({ role: "assistant", content: data.content });
  }
  process.stdout.write(lastText.replace(/\n?$/, "\n"));
}

function renderBlocks(content: any[], showThinking: boolean): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const b of content) {
    if (b.type === "text") out.push(b.text);
    else if (b.type === "thinking" && showThinking) out.push(`\x1b[2m[thinking] ${b.thinking}\x1b[0m`);
  }
  return out.join("");
}

// Parse an Anthropic SSE stream (from a live fetch OR piped back by the daemon).
// Writes text deltas live when --stream; otherwise buffers and prints once at the end.
async function consumeSSE(body: ReadableStream<Uint8Array> | null, status: number, retryAfter: string | null, o: Opts) {
  if (!body) die("empty response body");
  if (status >= 400) {
    const raw = await new Response(body).text();
    let msg = raw.slice(0, 400);
    try { msg = JSON.parse(raw)?.error?.message || msg; } catch {}
    surfaceError(status, msg, retryAfter);
  }
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", acc = "", firstAt = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
    for (const p of parts) {
      const line = p.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      let ev: any; try { ev = JSON.parse(json); } catch { continue; }
      if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta") { if (!firstAt) firstAt = performance.now(); acc += ev.delta.text; if (o.stream) process.stdout.write(ev.delta.text); }
        else if (ev.delta?.type === "thinking_delta" && o.showThinking) process.stderr.write(ev.delta.thinking);
      } else if (ev.type === "error") die(`stream error: ${ev.error?.message ?? "unknown"}`);
    }
  }
  if (o.stream) process.stdout.write("\n");
  else process.stdout.write(acc.replace(/\n?$/, "\n"));
  if (o.verbose) process.stderr.write(`[apiplan] first token ${(firstAt ? firstAt - START : 0).toFixed(0)}ms · total ${(performance.now() - START).toFixed(0)}ms\n`);
}

// ---- Warm daemon (unix socket) ----
// One process holds the cached OAuth token + a kept-alive TLS connection to the API,
// so repeated calls skip the per-call keychain read and TLS handshake. The daemon does
// a single upstream call per request and pipes the SSE straight back to the client.
async function daemonHealthy(): Promise<boolean> {
  try { const h = await fetch("http://d/health", { unix: SOCK } as any); return h.ok; } catch { return false; }
}

async function runDaemon() {
  if (await daemonHealthy()) { process.stderr.write("apiplan daemon already running\n"); return; }
  try { require("node:fs").unlinkSync(SOCK); } catch {} // clear a stale socket
  let cache: { tok: string; exp: number } | null = null;
  const tok = () => {
    const now = Date.now();
    if (cache && cache.exp - now > 300_000) return cache.tok;
    const c = oauthCred();
    cache = { tok: c.accessToken, exp: c.expiresAt || now + 3_300_000 };
    return cache.tok;
  };
  let lastReq = Date.now();
  try {
    Bun.serve({
      unix: SOCK,
      idleTimeout: 240,
      async fetch(req) {
        lastReq = Date.now();
        const u = new URL(req.url);
        if (u.pathname === "/health") return new Response("ok");
        if (u.pathname === "/stop") { queueMicrotask(() => process.exit(0)); return new Response("bye"); }
        if (u.pathname === "/call" && req.method === "POST") {
          try {
            const s: any = await req.json();
            const { url, headers, baseBody } = buildDirect(s.o, s.modelId, s.userSystem, tok());
            const up = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...baseBody, messages: s.messages, stream: true }) });
            return new Response(up.body, { status: up.status, headers: { "content-type": up.headers.get("content-type") || "text/event-stream", "x-retry-after": up.headers.get("retry-after") || "" } });
          } catch (e: any) {
            return new Response(JSON.stringify({ error: { message: e?.message || String(e) } }), { status: 500 });
          }
        }
        return new Response("not found", { status: 404 });
      },
    });
  } catch (e: any) { process.stderr.write(`apiplan daemon: cannot listen on ${SOCK}: ${e?.message || e}\n`); return; }
  try { require("node:fs").chmodSync(SOCK, 0o600); } catch {}

  // Connection pre-warm + keepalive: establish and hold a pooled TLS/HTTP-2
  // connection to the API host so real calls never pay a cold handshake. Even a
  // 401 warms the pool (the handshake completes before the HTTP response). This
  // is the single biggest daemon-side TTFT lever after thinking-off.
  const warm = async () => {
    try { await fetch(`${BASE}/v1/models?limit=1`, { headers: { authorization: `Bearer ${tok()}`, "anthropic-version": API_VERSION, "anthropic-beta": OAUTH_BETA } }); } catch {}
  };
  warm();
  const ka = +env("APIPLAN_KEEPALIVE_MS", "45000"); // servers drop idle keep-alive ~60s; ping under that
  if (ka > 0) setInterval(warm, ka);

  const idle = +env("APIPLAN_DAEMON_IDLE_MS", String(30 * 60_000));
  if (idle > 0) setInterval(() => { if (Date.now() - lastReq > idle) process.exit(0); }, 60_000);
  process.stderr.write(`apiplan daemon listening on ${SOCK} (warm+keepalive ${ka}ms, idle-exit ${Math.round(idle / 60_000)}m)\n`);
}

// Spawn the daemon detached and wait (≤2s) for it to accept.
async function ensureDaemon(): Promise<boolean> {
  if (await daemonHealthy()) return true;
  const p = Bun.spawn([process.execPath, import.meta.path, "--daemon"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  p.unref();
  for (let i = 0; i < 40; i++) { await Bun.sleep(50); if (await daemonHealthy()) return true; }
  return false;
}

// Try to serve the call through the daemon. Returns true if handled, false if the
// daemon is unavailable (caller then falls back to the in-process path).
async function tryDaemonCall(o: Opts, model: { id: string }, messages: any[], userSystem: string): Promise<boolean> {
  const spec = JSON.stringify({ o, modelId: model.id, userSystem, messages });
  const post = () => fetch("http://d/call", { unix: SOCK, method: "POST", headers: { "content-type": "application/json" }, body: spec } as any);
  let res: Response;
  try { res = await post(); }
  catch {
    if (env("APIPLAN_DAEMON", "auto") === "off") return false;
    if (!(await ensureDaemon())) return false;
    try { res = await post(); } catch { return false; }
  }
  await consumeSSE(res.body, res.status, res.headers.get("x-retry-after") || null, o);
  return true;
}

// ---- Route: harness (claude -p) ----
async function routeHarness(o: Opts, model: { alias: string }, prompt: string, userSystem: string) {
  if (o.chat) die("--chat is not supported on the harness route; use --route direct.");
  const cmd = ["claude", "-p", "--model", model.alias];
  if (o.effort) cmd.push("--effort", o.effort);
  if (userSystem) cmd.push("--append-system-prompt", userSystem);
  if (o.json) cmd.push("--output-format", "json");
  else if (o.stream) cmd.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");
  cmd.push(prompt);
  if (o.dryRun) { process.stdout.write(cmd.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(" ") + "\n"); return; }
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  process.exit(await proc.exited);
}

function help(): string {
  return `apiplan v${VERSION} — call Anthropic frontier models on your Claude subscription (no per-token billing)

USAGE
  opus  [flags] [prompt...]          fable [flags] [prompt...]
  sonnet [flags] [prompt...]         haiku [flags] [prompt...]
  api -m <model> [flags] [prompt...]
  cat file | opus "instruction"      # stdin is appended to the prompt
  echo '[{"role":"user","content":"hi"}]' | opus --chat   # chat completion

FLAGS
  -m, --model <a>       opus|fable|sonnet|haiku or a full model id
  -e, --effort <lvl>    low|medium|high|xhigh|max  (maps to thinking budget)
      --thinking <n>    explicit extended-thinking token budget (or "off")
      --loop <n>        self-refine passes / test-time-compute horizon (direct only, default 1)
  -s, --system <text>   append a system prompt (your "virtual CLAUDE.md")
      --system-file <f> read the system prompt from a file
      --route <r>       direct (default, fast) | harness (claude -p, full tools)
      --max-tokens <n>  max output tokens (default 8192)
  -t, --temperature <f> sampling temperature (ignored when thinking is on)
      --chat            read a JSON messages array/object from stdin (direct only)
      --stream          stream tokens as they arrive
      --show-thinking   include thinking blocks
  -i, --image <src>     attach an image (repeatable): file · http(s) URL · data: URI · - (stdin) · clipboard/paste
      --fast            Fast Mode — ~2.5x output tokens/sec (Opus 4.8/4.7 only; separate rate limit)
      --1m              enable the 1M-context beta (large inputs)
      --json            print the raw API JSON response
      --dry-run         print the exact request (token redacted) without sending
      --no-daemon       force this call to run in-process (skip the warm daemon)
  -v, --verbose         verbose
  -h, --help            this help

WARM DAEMON (lower latency — caches token + keeps the API connection alive)
  Auto-starts on first call and every direct call routes through it transparently
  (falls back to in-process if it can't start). Manage it explicitly:
      api --daemon          start in foreground (auto-exits after 30m idle)
      api --daemon-stop     stop it
  Skipped automatically for --json / --loop>1 / --dry-run. Disable: APIPLAN_DAEMON=off

ENV OVERRIDES
  APIPLAN_ROUTE, APIPLAN_DAEMON(auto|off), APIPLAN_SOCK, APIPLAN_DAEMON_IDLE_MS,
  APIPLAN_IDENTITY, APIPLAN_OAUTH_BETA, APIPLAN_API_VERSION, APIPLAN_BASE_URL,
  APIPLAN_KEYCHAIN_SERVICE, APIPLAN_ID_{OPUS,FABLE,SONNET,HAIKU}

EXIT CODES  0 ok · 1 error · 3 auth · 4 rate-limit`;
}

// ---- main ----
async function main() {
  const argv0 = (process.argv[1] || "").split("/").pop() || "";
  const model0 = ALIASES[argv0] ? argv0 : undefined; // invoked via alias symlink?
  const o = parse(process.argv.slice(2), model0);
  if (o.help) { process.stdout.write(help() + "\n"); return; }

  // daemon lifecycle (no model/prompt needed)
  if (o.daemon) { await runDaemon(); return; }
  if (o.daemonStop) {
    try { await fetch("http://d/stop", { unix: SOCK } as any); process.stdout.write("apiplan daemon stopped\n"); }
    catch { process.stdout.write("apiplan daemon not running\n"); }
    return;
  }

  if (o.route !== "direct" && o.route !== "harness") die(`bad --route '${o.route}'; use direct|harness.`);
  const model = resolveModel(o.model);
  let userSystem = o.system ?? "";
  if (o.systemFile) userSystem = (userSystem ? userSystem + "\n\n" : "") + (await Bun.file(o.systemFile).text());

  // -i - claims stdin as an image, so don't also drain it as prompt text
  const stdin = o.images.includes("-") ? "" : await readStdin();
  const blocks = imageBlocks(await Promise.all(o.images.map(loadImage)));
  if (blocks.length && o.route === "harness") die("images require --route direct.");

  // resolve messages + system for either mode
  let messages: any[], sys = userSystem;
  if (o.chat) {
    if (o.route === "harness") die("--chat is direct-only; use --route direct.");
    if (!stdin.trim()) die("--chat needs a JSON messages array/object on stdin.");
    let parsed: any; try { parsed = JSON.parse(stdin); } catch { die("--chat stdin is not valid JSON."); }
    messages = Array.isArray(parsed) ? parsed : parsed.messages;
    if (!Array.isArray(messages)) die("--chat JSON must be an array or {messages:[...]}.");
    if (!Array.isArray(parsed) && parsed.system) sys = String(parsed.system);
    if (blocks.length) { // attach images to the last user turn
      const i = messages.map((m) => m.role).lastIndexOf("user");
      if (i < 0) die("--chat with -i needs a user message to attach the image to.");
      messages[i] = { ...messages[i], content: withImages(messages[i].content, blocks) };
    }
  } else {
    const prompt = [o.prompt.join(" ").trim(), stdin.trim()].filter(Boolean).join("\n\n");
    if (!prompt && !blocks.length) { process.stdout.write(help() + "\n"); die("no prompt — pass text as args or pipe it on stdin.", 1); }
    if (o.route === "harness") { await routeHarness(o, model, prompt, userSystem); return; }
    messages = [{ role: "user", content: withImages(prompt || "What is in this image?", blocks) }];
  }

  // direct route: warm daemon first (unless off/ineligible), else in-process
  const daemonEligible = !o.dryRun && !o.json && o.loop === 1 && !o.noDaemon && env("APIPLAN_DAEMON", "auto") !== "off";
  if (daemonEligible && await tryDaemonCall(o, model, messages, sys)) return;
  await routeDirect(o, model, messages, sys);
}

main().catch((e) => die(e?.message ?? String(e)));
