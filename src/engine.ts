// engine.ts — the provider-agnostic core: parse argv, load images, talk to the
// API (directly or through the warm daemon), stream the answer out.
//
// Latency is a feature here. Two rules keep it fast:
//   · nothing on the hot path touches the network except the one call itself
//   · the daemon holds the token AND a kept-alive TLS connection, so repeat calls
//     skip both the credential read and the handshake
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { STATE_DIR, TMP, ensureDir, ipc, ipcTarget, readJson, writeJson, clipboardImageBytes, speakLocally, playAudio, openFile, IS_WIN } from "./platform.ts";
import { models, resolve, type Model } from "./registry.ts";
import { PROVIDERS, providerFor, type CallOpts, type ImageRef, type Provider, type Turn } from "./providers.ts";

export const START = performance.now();
export const VERSION = "0.4.0";

/**
 * Self-instrumentation for the perf harness. Our own cost is everything before the
 * request leaves (dispatch) plus everything after the last byte arrives (drain) —
 * measured directly, because inferring it by subtracting two network-noisy medians
 * produced a metric that swung ±400ms on identical code (DARWIN.md round 5).
 */
export const TIMING = process.env.APIPLAN_TIMING === "1";
export const marks = { dispatch: 0, firstByte: 0, lastByte: 0 };
export function markDispatch() { if (TIMING && !marks.dispatch) marks.dispatch = performance.now() - START; }
export function reportTiming() {
  if (!TIMING) return;
  const drain = marks.lastByte ? performance.now() - START - marks.lastByte : 0;
  process.stderr.write(`[timing] dispatch=${marks.dispatch.toFixed(1)} drain=${drain.toFixed(1)}\n`);
}

export function die(msg: string, code = 1): never {
  process.stderr.write(`apiplan: ${msg}\n`);
  process.exit(code);
}

// ───────────────────────────── argv ─────────────────────────────
export type Opts = CallOpts & {
  model?: string; images: string[]; prompt: string[];
  loop: number; stream: boolean; chat: boolean; json: boolean;
  dryRun: boolean; verbose: boolean; help: boolean; version: boolean;
  daemon: boolean; daemonStop: boolean; noDaemon: boolean;
  thinking?: number; systemFile?: string;
  /** non-text jobs */
  out?: string; speak: boolean; voice?: string; audioFormat?: string; play: boolean; local: boolean;
  aloud: boolean; conversation?: string; message?: string; last: boolean; open: boolean;
};

/** Flags that consume the next argv item (so it is never mistaken for prompt text). */
const VALUED = new Set(["-m", "--model", "-e", "--effort", "-s", "--system", "--system-file",
  "--max-tokens", "-t", "--temp", "--temperature", "--thinking", "--loop", "-i", "--image",
  "-o", "--out", "--voice", "--format", "--size", "--quality", "--conversation", "--message"]);

/**
 * Everything that isn't a recognised flag becomes prompt text, so
 * `opus explain monads like im five` works with no quotes at all.
 * `--` ends flag parsing; the rest is literal prompt.
 */
export function parseArgs(argv: string[], model0?: string): Opts {
  const o: Opts = {
    model: model0, images: [], prompt: [], loop: 1, stream: false, chat: false, json: false,
    dryRun: false, verbose: false, help: false, version: false,
    daemon: false, daemonStop: false, noDaemon: false,
    speak: false, play: false, local: false, aloud: false, last: false, open: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--") { o.prompt.push(...argv.slice(i + 1)); break; }
    let inline: string | undefined;
    if (a.startsWith("--") && a.includes("=")) { const j = a.indexOf("="); inline = a.slice(j + 1); a = a.slice(0, j); }
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (a) {
      case "-h": case "--help": o.help = true; break;
      case "-V": case "--version": o.version = true; break;
      case "-m": case "--model": o.model = val(); break;
      case "-e": case "--effort": o.effort = val(); break;
      case "-s": case "--system": o.system = val(); break;
      case "--system-file": o.systemFile = val(); break;
      case "--max-tokens": o.maxTokens = +val(); break;
      case "-t": case "--temp": case "--temperature": o.temperature = +val(); break;
      case "--thinking": { const v = val(); o.thinking = v === "off" ? 0 : +v; if (o.thinking <= 0) o.thinkOff = true; break; }
      case "--loop": o.loop = Math.max(1, +val() || 1); break;
      case "-i": case "--image": o.images.push(val()); break;
      case "-o": case "--out": o.out = val(); break;
      case "--draw": case "--gen-image": case "--image-out": o.genImage = true; break;
      case "--size": o.imageSize = val(); break;
      case "--quality": o.imageQuality = val(); break;
      case "--speak": case "--say": o.speak = true; break;
      case "--voice": o.voice = val(); break;
      case "--format": o.audioFormat = val(); break;
      case "--play": o.play = true; break;
      case "--open": o.open = true; break;
      case "--local": o.local = true; o.speak = true; break;
      case "--aloud": case "--read-aloud": o.aloud = true; o.speak = true; break;
      case "--last": o.last = true; o.aloud = true; o.speak = true; break;
      case "--conversation": o.conversation = val(); o.aloud = true; o.speak = true; break;
      case "--message": o.message = val(); o.aloud = true; o.speak = true; break;
      case "--stream": o.stream = true; break;
      case "--no-stream": o.stream = false; break;
      case "--chat": o.chat = true; break;
      case "--json": o.json = true; break;
      case "--show-thinking": o.showThinking = true; break;
      case "--fast": o.fast = true; break;
      case "--1m": o.oneM = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--daemon": o.daemon = true; break;
      case "--daemon-stop": o.daemonStop = true; break;
      case "--no-daemon": o.noDaemon = true; break;
      case "-v": case "--verbose": o.verbose = true; break;
      default:
        if (a.startsWith("-") && a.length > 1 && VALUED.has(a)) break; // unreachable, keeps switch honest
        o.prompt.push(argv[i]);
    }
  }
  return o;
}

// ───────────────────────────── images ─────────────────────────────
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return null;
}
/** file path · http(s) URL · data: URI · "-" (stdin) · "clipboard"/"paste" */
export async function loadImage(src: string): Promise<ImageRef> {
  if (/^https?:\/\//i.test(src)) return { url: src };
  if (src.startsWith("data:")) {
    const m = src.match(/^data:([^;]+);base64,(.*)$/s);
    if (!m) die(`bad data: URI for --image`);
    return { mediaType: m[1], base64: m[2] };
  }
  let bytes: Uint8Array;
  if (src === "-") bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  else if (src === "clipboard" || src === "paste" || src === "clip") {
    const b = clipboardImageBytes();
    if (!b) die("no image in the clipboard (macOS: `brew install pngpaste`; Linux: wl-paste/xclip) — or pass a file/URL.");
    bytes = b;
  } else {
    if (!existsSync(src)) die(`image not found: ${src}`);
    bytes = new Uint8Array(readFileSync(src));
  }
  const mediaType = sniff(bytes);
  if (!mediaType) die(`unrecognised image format (png/jpeg/gif/webp): ${src}`);
  // Providers reject images below a few pixels with an opaque "could not process
  // image" 400. Catch it here where we can say exactly what is wrong.
  if (mediaType === "image/png") {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length > 24) {
      const w = dv.getUint32(16), h = dv.getUint32(20);
      if (w < 8 || h < 8) die(`image is ${w}×${h}px — too small for the model to process (needs at least 8×8): ${src}`);
    }
  }
  return { mediaType, base64: Buffer.from(bytes).toString("base64") };
}
/** Keep --dry-run readable: never print a full base64 payload. */
export function redact(o: any): any {
  return JSON.parse(JSON.stringify(o), (k, v) => {
    if (typeof v !== "string") return v;
    if ((k === "data" || k === "base64") && v.length > 64) return `<base64 ${v.length}b>`;
    if (k === "image_url" && v.length > 80) return `${v.slice(0, 32)}…<${v.length}b>`;
    if (k === "authorization") return "Bearer <token>";
    return v;
  });
}

// ───────────────────────────── streaming ─────────────────────────────
export type StreamResult = { text: string; ttft: number; served?: string; imagePath?: string };

/** Consume an SSE body through the provider's event mapper. */
export async function consume(p: Provider, body: ReadableStream<Uint8Array> | null, status: number, retryAfter: string | null, o: Opts): Promise<StreamResult> {
  if (!body) die("empty response body");
  if (status >= 400) {
    const raw = await new Response(body).text();
    let msg = raw.slice(0, 500);
    try { const j = JSON.parse(raw); msg = j?.error?.message || j?.detail || msg; } catch {}
    surface(status, msg, retryAfter);
  }
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", ttft = 0, served = "", imageB64 = "", revised = "", lastProgress = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (TIMING) marks.lastByte = performance.now() - START;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev: any; try { ev = JSON.parse(payload); } catch { continue; }
        const d = p.delta(ev);
        if (d.error) die(`stream error: ${d.error}`);
        if (d.served && !served) served = d.served;
        if (d.imageB64) imageB64 = d.imageB64;
        if (d.revisedPrompt) revised = d.revisedPrompt;
        if (d.progress && d.progress !== lastProgress && process.stderr.isTTY) {
          lastProgress = d.progress;                      // a drawing call is slow; show life
          process.stderr.write(`\r\x1b[2m${d.progress}\x1b[0m\x1b[K`);
        }
        if (d.text) { if (!ttft) ttft = performance.now() - START; text += d.text; if (o.stream) process.stdout.write(d.text); }
        if (d.reasoning && o.showThinking) process.stderr.write(d.reasoning);
      }
    }
  }
  if (lastProgress && process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  let imagePath: string | undefined;
  if (imageB64) imagePath = saveImage(imageB64, o.out, revised, o.open);
  if (o.stream) process.stdout.write("\n");
  else if (text) process.stdout.write(text.replace(/\n?$/, "\n"));
  reportTiming();
  if (o.verbose) process.stderr.write(`[apiplan] ${served ? `served by ${served} · ` : ""}first token ${(ttft || 0).toFixed(0)}ms · total ${(performance.now() - START).toFixed(0)}ms\n`);
  return { text, ttft, served, imagePath };
}
function surface(status: number, msg: string, retryAfter?: string | null): never {
  if (status === 401 || status === 403) die(`auth rejected (${status}): ${msg}\n  → the login may be stale (run \`claude\` / \`codex\`), or the provider contract changed.`, 3);
  if (status === 429) die(`rate limited (429): ${msg}${retryAfter ? ` — retry after ${retryAfter}s` : ""}`, 4);
  die(`API error (${status}): ${msg}`);
}

// ───────────────────────────── the call ─────────────────────────────
const REFINE = "Review your previous answer, correct any mistakes, and output only the improved final answer.";

export async function callDirect(m: Model, turns: Turn[], o: Opts): Promise<void> {
  const p = providerFor(m);
  const creds = o.dryRun ? { token: "<token>", account: "<account>", source: "dry-run" } : p.creds();
  const built = p.build(m, turns, o, creds);
  if (o.dryRun) {
    process.stdout.write(JSON.stringify(redact({ method: "POST", url: built.url, headers: built.headers, body: built.body }), null, 2) + "\n");
    return;
  }
  let convo = [...turns];
  for (let pass = 0; pass < o.loop; pass++) {
    if (pass > 0) convo = [...convo, { role: "user", text: REFINE }];
    const b = p.build(m, convo, o, creds);
    markDispatch();
    const res = await fetch(b.url, { method: "POST", headers: b.headers, body: JSON.stringify({ ...b.body, stream: true }) });
    const last = pass === o.loop - 1;
    const r = await consume(p, res.body, res.status, res.headers.get("retry-after"), { ...o, stream: o.stream && last, verbose: o.verbose && last });
    if (!last) convo = [...convo, { role: "assistant", text: r.text }];
  }
}

/**
 * Write a generated image next to the user, not into a temp dir they'll never find.
 * Path goes to stdout when it is the whole answer, so `imagine … | xargs open` works;
 * the human-facing note goes to stderr so pipes stay clean.
 */
export function saveImage(b64: string, out: string | undefined, revised: string, open = false): string {
  const bytes = Buffer.from(b64, "base64");
  const ext = bytes[0] === 0x89 ? "png" : bytes[0] === 0xff ? "jpg" : bytes[0] === 0x52 ? "webp" : "png";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const path = out ?? `apiplan-${stamp}.${ext}`;
  writeFileSync(path, bytes);
  const kb = Math.round(bytes.length / 1024);
  process.stderr.write(`\x1b[2m${revised ? `prompt used: ${revised.slice(0, 120)}\n` : ""}\x1b[0mimage saved: ${path} (${kb}KB)\n`);
  if (open) {
    const tool = openFile(path);
    if (!tool) process.stderr.write(`\x1b[2mno opener found — open ${path} yourself\x1b[0m\n`);
  }
  return path;
}

/** The speech path: one request, binary back — no SSE, no daemon. */
export async function runSpeech(m: Model, text: string, o: Opts): Promise<void> {
  // Read-aloud speaks a message that already exists in the account, so unlike every
  // other speech path it needs no prompt — the text comes from the conversation.
  if (o.aloud) return runAloud(m, o);
  if (!text.trim()) die("nothing to say — give me some text, or pipe it in.");
  const p = providerFor(m);
  const sayItHere = (why?: string) => {
    const tool = speakLocally(text);
    if (!tool) die(why ? `${why}\n  and no local voice is available either (macOS \`say\`, Linux \`spd-say\`/\`espeak\`, Windows SAPI).`
                       : "no local voice available (macOS `say`, Linux `spd-say`/`espeak`, Windows SAPI).");
    if (why) process.stderr.write(`\x1b[2m${why}\n  spoke with your ${tool === "say" ? "system" : tool} voice instead.\x1b[0m\n`);
    else if (o.verbose) process.stderr.write(`[apiplan] spoke locally via ${tool}\n`);
  };
  if (o.local || !p.speak) { sayItHere(); return; }
  const fmt = o.audioFormat ?? "mp3";
  // Ask the BACKEND what it serves: a local neural server has its own voice names, and
  // validating those against OpenAI's static list rejects every one of them.
  const live = p.listVoices ? await p.listVoices() : { backend: "", voices: p.voices ?? [] };
  const voice = o.voice ?? (live.voices.includes("alloy") ? "alloy" : live.voices[0] ?? "alloy");
  if (live.voices.length && !live.voices.includes(voice)) {
    die(`unknown voice '${voice}' for ${live.backend || "this backend"}.\n  available: ${live.voices.slice(0, 24).join(", ")}${live.voices.length > 24 ? ` … (${live.voices.length} total — \`apiplan voices\`)` : ""}`);
  }
  // The subscription path returns wav whatever was asked for — it hands back raw PCM
  // and we add the header — so report the format actually produced, never a guess.
  let out: { bytes: Uint8Array; contentType: string };
  try { out = await p.speak({ text, voice, format: fmt }); }
  catch (e: any) { sayItHere(e?.message ?? String(e)); return; }
  const ext = out.contentType.includes("wav") ? "wav" : fmt;
  deliverAudio(out.bytes, ext, `voice ${voice} via ${live.backend}`, o);
}

/**
 * ChatGPT's own read-aloud, on the subscription. Speaks a message already in the
 * account (newest reply by default) in the real product voices.
 */
async function runAloud(m: Model, o: Opts): Promise<void> {
  const p = providerFor(m);
  if (!p.readAloud) die(`${p.label} has no read-aloud — that is a ChatGPT feature (try an OpenAI model: sol / gpt).`);
  const fmt = o.audioFormat ?? "aac";
  if (o.voice && p.aloudVoices) {
    const { voices } = await p.aloudVoices();
    if (voices.length && !voices.includes(o.voice)) die(`unknown read-aloud voice '${o.voice}'.\n  available: ${voices.join(", ")}`);
  }
  const { bytes, spoke, voice } = await p.readAloud({ conversation: o.conversation, message: o.message, voice: o.voice, format: fmt, last: o.last });
  if (spoke) process.stderr.write(`\x1b[2m“${spoke.slice(0, 140).replace(/\s+/g, " ")}${spoke.length > 140 ? "…" : ""}”\x1b[0m\n`);
  deliverAudio(bytes, fmt, `ChatGPT voice ${voice}, on the subscription`, o);
}

/** Every speech path ends the same way: write it, optionally play it, print the path. */
function deliverAudio(bytes: Uint8Array, fmt: string, note: string, o: Opts): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const path = o.out ?? `apiplan-${stamp}.${fmt}`;
  writeFileSync(path, bytes);
  process.stderr.write(`audio saved: ${path} (${Math.round(bytes.length / 1024)}KB, ${note})\n`);
  if (o.play) {
    const tool = playAudio(path);
    process.stderr.write(tool ? `\x1b[2mplayed with ${tool}\x1b[0m\n` : `\x1b[2mno audio player found — open ${path} yourself\x1b[0m\n`);
  }
  if (!process.stdout.isTTY) process.stdout.write(path + "\n");   // pipeable
}

// ───────────────────────────── warm daemon ─────────────────────────────
const IPC = ipc();
async function ipcFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const t = ipcTarget(IPC, path);
  if (!t) return null;
  try { return await fetch(t.url, { ...(t.opts as any), ...init, headers: { ...(t.opts as any).headers, ...(init?.headers ?? {}) } }); }
  catch { return null; }
}
/**
 * Alive AND running this build. A daemon left over from an older version would
 * keep serving the old request contract after an upgrade — invisible and nasty —
 * so a version mismatch counts as "not alive" and the caller replaces it.
 */
export async function daemonAlive(): Promise<boolean> {
  const r = await ipcFetch("/health");
  if (!r?.ok) return false;
  const v = (await r.text().catch(() => "")).trim();
  return v === "" || v === VERSION || v === "ok"; // "ok" = pre-versioning daemon, treated as current
}
/** Version the running daemon reports, or null when nothing is listening. */
export async function daemonVersion(): Promise<string | null> {
  const r = await ipcFetch("/health");
  if (!r?.ok) return null;
  const v = (await r.text().catch(() => "")).trim();
  return v === "ok" ? "pre-0.2" : v;
}
export async function daemonStop(): Promise<boolean> {
  const r = await ipcFetch("/stop");
  return !!r?.ok;
}

export async function runDaemon(): Promise<void> {
  if (await daemonAlive()) { process.stderr.write("apiplan daemon already running\n"); return; }
  ensureDir(STATE_DIR);
  if (IPC.kind === "unix" && existsSync(IPC.path)) { try { unlinkSync(IPC.path); } catch {} }
  const token = crypto.randomUUID();

  // credential cache, refreshed a few minutes before expiry
  const cache = new Map<string, { c: any; exp: number }>();
  const creds = (pid: keyof typeof PROVIDERS) => {
    const hit = cache.get(pid);
    if (hit && hit.exp - Date.now() > 300_000) return hit.c;
    const c = PROVIDERS[pid].creds();
    cache.set(pid, { c, exp: c.expiresAt ?? Date.now() + 3_300_000 });
    return c;
  };

  let lastReq = Date.now();
  const handler = async (req: Request): Promise<Response> => {
    lastReq = Date.now();
    const u = new URL(req.url);
    if (IPC.kind === "tcp" && req.headers.get("x-apiplan-token") !== token && u.pathname !== "/health") {
      return new Response("forbidden", { status: 403 });
    }
    if (u.pathname === "/health") return new Response(VERSION);
    if (u.pathname === "/stop") { queueMicrotask(() => process.exit(0)); return new Response("bye"); }
    if (u.pathname === "/call" && req.method === "POST") {
      // A client from a different build must not be served by this one: the request
      // contract may have changed. Tell it to replace us instead of answering wrongly.
      const cv = req.headers.get("x-apiplan-version");
      if (cv && cv !== VERSION) return new Response(`version mismatch: daemon ${VERSION}, client ${cv}`, { status: 409 });
      try {
        const s: any = await req.json();
        const m: Model = s.model;
        const p = PROVIDERS[m.provider as keyof typeof PROVIDERS];
        const b = p.build(m, s.turns, s.opts, creds(m.provider));
        const up = await fetch(b.url, { method: "POST", headers: b.headers, body: JSON.stringify({ ...b.body, stream: true }) });
        return new Response(up.body, {
          status: up.status,
          headers: { "content-type": up.headers.get("content-type") || "text/event-stream", "x-retry-after": up.headers.get("retry-after") || "" },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e?.message || String(e) } }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  };

  let server: any;
  try {
    server = IPC.kind === "unix"
      ? Bun.serve({ unix: IPC.path, idleTimeout: 240, fetch: handler })
      : Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 240, fetch: handler });
  } catch (e: any) {
    process.stderr.write(`apiplan daemon: cannot listen (${e?.message || e})\n`);
    return;
  }
  if (IPC.kind === "unix") { try { require("node:fs").chmodSync(IPC.path, 0o600); } catch {} }
  else writeJson(IPC.portFile, { port: server.port, token, pid: process.pid });

  // Pre-warm + hold the TLS/HTTP-2 pool open to each provider we're logged into,
  // so a real call never pays a cold handshake. This is the biggest daemon win.
  const warm = async () => {
    for (const p of Object.values(PROVIDERS)) {
      if (!p.probe().connected) continue;
      const host = p.id === "anthropic" ? "https://api.anthropic.com/v1/models" : "https://chatgpt.com";
      try { await fetch(host, { method: p.id === "anthropic" ? "GET" : "HEAD" }); } catch {}
    }
  };
  warm();
  const ka = +(process.env.APIPLAN_KEEPALIVE_MS ?? 45_000);
  if (ka > 0) setInterval(warm, ka);
  const idle = +(process.env.APIPLAN_DAEMON_IDLE_MS ?? 30 * 60_000);
  if (idle > 0) setInterval(() => { if (Date.now() - lastReq > idle) process.exit(0); }, 60_000);
  const where = IPC.kind === "unix" ? IPC.path : `127.0.0.1:${server.port}`;
  process.stderr.write(`apiplan daemon listening on ${where} (warm+keepalive ${ka}ms, idle-exit ${Math.round(idle / 60_000)}m)\n`);

  // Serve until told to stop. Without this the function returns, the caller exits,
  // and the daemon dies the instant it was born — which silently turned the warm
  // path into a 2s penalty (every call re-spawned it). See DARWIN.md round 1.
  const bye = () => { if (IPC.kind === "unix") { try { unlinkSync(IPC.path); } catch {} } process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  await new Promise<never>(() => {});
}

/**
 * Start the daemon for LATER calls without making this one wait for it. Blocking
 * on startup used to cost the first call up to 2s — worse than not having a daemon.
 * Fire and forget: this call goes direct, the next one finds a warm daemon.
 */
function spawnDaemonDetached(entry: string) {
  try {
    const p = Bun.spawn([process.execPath, entry, "--daemon"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    p.unref();
  } catch {}
}

/**
 * Config that changes what a request IS (endpoint, identity, credential source).
 * The daemon runs with its own environment, so if the caller has overridden any of
 * these, the daemon would silently ignore them — go direct instead and honour them.
 */
const OVERRIDE_ENV = ["APIPLAN_ANTHROPIC_BASE", "APIPLAN_OPENAI_BASE", "APIPLAN_IDENTITY",
  "APIPLAN_OAUTH_BETA", "APIPLAN_API_VERSION", "APIPLAN_ORIGINATOR", "APIPLAN_RESPONSES_PATH",
  "APIPLAN_CODEX_AUTH", "APIPLAN_ANTHROPIC_CRED_FILE", "APIPLAN_KEYCHAIN_SERVICE"];
export const hasRequestOverrides = () => OVERRIDE_ENV.some((k) => process.env[k]?.length);

/** Serve the call through the daemon; false means "fall back to in-process". */
export async function callViaDaemon(m: Model, turns: Turn[], o: Opts, entry: string): Promise<boolean> {
  if (hasRequestOverrides()) return false;
  const p = providerFor(m);
  const spec = JSON.stringify({ model: m, turns, opts: o });
  const post = () => (markDispatch(), ipcFetch("/call", {
    method: "POST",
    headers: { "content-type": "application/json", "x-apiplan-version": VERSION },
    body: spec,
  }));
  const res = await post();
  if (!res) {
    // No daemon yet (or a stale socket). Warm one up for next time and let THIS
    // call go direct, so a cold start is never slower than having no daemon at all.
    if ((process.env.APIPLAN_DAEMON ?? "auto") !== "off") spawnDaemonDetached(entry);
    return false;
  }
  if (res.status === 409) {
    // Left over from an older install: retire it, start the current one for next
    // time, and serve this call directly.
    await daemonStop();
    spawnDaemonDetached(entry);
    return false;
  }
  if (res.status === 500) { // daemon-side failure (e.g. bad creds): report it properly
    const j = await res.json().catch(() => ({} as any));
    die(j?.error?.message ?? "daemon call failed");
  }
  await consume(p, res.body, res.status, res.headers.get("x-retry-after"), o);
  return true;
}

// ───────────────────────────── shared entry ─────────────────────────────
/** Turn parsed options + stdin into the turns array both routes take. */
export async function buildTurns(o: Opts): Promise<Turn[]> {
  // `-i -` claims stdin for the image, so it must not also be read as prompt text
  const stdinIsImage = o.images.includes("-");
  const piped = !stdinIsImage && !process.stdin.isTTY ? await Bun.stdin.text() : "";
  const images = await Promise.all(o.images.map(loadImage));
  if (o.systemFile) o.system = (o.system ? o.system + "\n\n" : "") + readFileSync(o.systemFile, "utf8");

  if (o.chat) {
    if (!piped.trim()) die("--chat needs a JSON messages array (or {messages:[…]}) on stdin.");
    let parsed: any;
    try { parsed = JSON.parse(piped); } catch { die("--chat stdin is not valid JSON."); }
    const msgs = Array.isArray(parsed) ? parsed : parsed.messages;
    if (!Array.isArray(msgs)) die("--chat JSON must be an array or {messages:[…]}.");
    if (!Array.isArray(parsed) && parsed.system) o.system = String(parsed.system);
    const turns: Turn[] = msgs.map((m: any) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
    if (images.length) {
      const i = turns.map((t) => t.role).lastIndexOf("user");
      if (i < 0) die("--chat with --image needs a user message to attach the image to.");
      turns[i].images = images;
    }
    return turns;
  }
  const text = [o.prompt.join(" ").trim(), piped.trim()].filter(Boolean).join("\n\n");
  if (!text && !images.length) return [];
  return [{ role: "user", text: text || "What is in this image?", images: images.length ? images : undefined }];
}

export function resolveModelOrDie(name: string | undefined): Model {
  if (!name) die("no model — use a model command (opus/sonnet/gpt/…) or -m <model>. Try `apiplan models`.");
  const m = resolve(name);
  if (m) return m;
  const near = models().slice(0, 6).map((x) => x.family + x.version.join("")).join(", ");
  die(`unknown model '${name}'. Try one of: ${near} … or run \`apiplan models\` for the full list.`);
}
