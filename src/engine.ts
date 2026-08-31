// engine.ts — the provider-agnostic core: parse argv, load images, talk to the
// API (directly or through the warm daemon), stream the answer out.
//
// Latency is a feature here. Two rules keep it fast:
//   · nothing on the hot path touches the network except the one call itself
//   · the daemon holds the token AND a kept-alive TLS connection, so repeat calls
//     skip both the credential read and the handshake
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { STATE_DIR, TMP, ensureDir, ipc, ipcTarget, readJson, writeJson, clipboardImageBytes, speakLocally, playAudio, openFile, IS_WIN } from "./platform.ts";
import { models, resolve, type Model } from "./registry.ts";
import { PROVIDERS, providerFor, providerRuntime, warmCreds, type CallOpts, type ImageRef, type Provider, type Turn } from "./providers.ts";
import { frameSep, framePayload, deltasOf, watchTerminal } from "./stream-shape.ts";

// Does this vendor accept the engine's `stream: true` body flag? providers.ts declares it
// (wantsStreamFlag, set false for Google's strict proto-JSON endpoint) and src/api.ts has
// always honoured it -- this file did not, so the SAME vendor fact was consumed on the
// serve path and ignored on the command path. Google answered
// 400 `Unknown name "stream"` to every command. build() cannot fix it: the flag is spread
// in AFTER build() returns, which is exactly why the fact lives on the provider.
const wantsStream = (prov: Provider): boolean => prov.wantsStreamFlag !== false;

export const START = performance.now();
export const VERSION = "0.7.1";

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
  model?: string; images: string[]; files: string[]; prompt: string[];
  loop: number; stream: boolean; chat: boolean; json: boolean;
  dryRun: boolean; verbose: boolean; help: boolean; version: boolean;
  daemon: boolean; daemonStop: boolean; noDaemon: boolean;
  publicGemini: boolean;
  thinking?: number; systemFile?: string;
  /** non-text jobs */
  out?: string; speak: boolean; voice?: string; audioFormat?: string; play: boolean; local: boolean;
  genVideo: boolean; genSong: boolean; duration?: number;
  aloud: boolean; conversation?: string; message?: string; last: boolean; open: boolean;
  direction?: string; directionFile?: string;
  dictate: boolean; lang?: string; silenceStop?: number;
};

/** Flags that consume the next argv item (so it is never mistaken for prompt text). */
const VALUED = new Set(["-m", "--model", "-e", "--effort", "-s", "--system", "--system-file",
  "--max-tokens", "-t", "--temp", "--temperature", "--thinking", "--loop", "-i", "--image", "-f", "--file", "--media",
  "-o", "--out", "--voice", "--format", "--size", "--quality", "--conversation", "--message",
  "--as", "--style", "--emotion", "--direction", "--as-file", "--lang", "--silence-stop", "--duration"]);

/**
 * Everything that isn't a recognised flag becomes prompt text, so
 * `opus explain monads like im five` works with no quotes at all.
 * `--` ends flag parsing; the rest is literal prompt.
 */
export function parseArgs(argv: string[], model0?: string): Opts {
  const o: Opts = {
    model: model0, images: [], files: [], prompt: [], loop: 1, stream: false, chat: false, json: false,
    dryRun: false, verbose: false, help: false, version: false,
    daemon: false, daemonStop: false, noDaemon: false, publicGemini: false,
    speak: false, genVideo: false, genSong: false, play: false, local: false, aloud: false, last: false, open: false, dictate: false,
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
      case "-f": case "--file": case "--media": o.files.push(val()); break;
      case "-o": case "--out": o.out = val(); break;
      case "--draw": case "--gen-image": case "--image-out": o.genImage = true; break;
      case "--raw": o.rawPrompt = true; o.genImage = true; break;
      case "--enhance": o.rawPrompt = false; o.genImage = true; break;
      case "--size": o.imageSize = val(); break;
      case "--quality": o.imageQuality = val(); break;
      case "--video": case "--gen-video": o.genVideo = true; break;
      case "--song": case "--music": case "--gen-song": o.genSong = true; break;
      case "--duration": o.duration = Number(val()) || 0; break;
      case "--speak": case "--say": o.speak = true; break;
      case "--as": case "--style": case "--emotion": case "--direction": o.direction = val(); o.speak = true; break;
      case "--as-file": o.directionFile = val(); o.speak = true; break;
      case "--voice": o.voice = val(); break;
      case "--format": o.audioFormat = val(); break;
      case "--play": o.play = true; break;
      case "--open": o.open = true; break;
      case "--local": o.local = true; o.speak = true; break;
      case "--aloud": case "--read-aloud": o.aloud = true; o.speak = true; break;
      case "--dictate": case "--stt": o.dictate = true; break;
      case "--lang": case "--language": o.lang = val(); break;
      case "--silence-stop": o.silenceStop = Number(val()) || 0; break;
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
      case "--public": case "--api-key-route": o.publicGemini = true; break;
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

/** MIME types advertised by the live Antigravity Gemini catalog, plus GIF for the existing
 * cross-provider --image path. This deliberately rejects unknown binaries: "any file" in
 * the CLI means any format the backend says it understands, not silently mislabeled bytes. */
const MEDIA_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mj2": "video/mj2",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".flac": "audio/flac", ".opus": "audio/opus", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".l16": "audio/l16",
  ".pdf": "application/pdf", ".json": "application/json", ".rtf": "application/rtf", ".ipynb": "application/x-ipynb+json",
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".html": "text/html", ".htm": "text/html",
  ".css": "text/css", ".csv": "text/csv", ".xml": "text/xml", ".js": "text/javascript", ".mjs": "text/javascript",
  ".ts": "text/typescript", ".tsx": "text/typescript", ".py": "text/x-python",
};

function mediaTypeFor(src: string, bytes?: Uint8Array): string | null {
  const byName = MEDIA_BY_EXT[extname(src.split(/[?#]/, 1)[0]).toLowerCase()];
  if (bytes) {
    const image = sniff(bytes);
    if (image) return image;
    const ascii = Buffer.from(bytes.subarray(0, 16)).toString("latin1");
    if (ascii.startsWith("%PDF-")) return "application/pdf";
    if (ascii.startsWith("fLaC")) return "audio/flac";
    if (ascii.startsWith("OggS")) return byName?.startsWith("video/") ? byName : (byName ?? "audio/ogg");
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return byName ?? "video/webm";
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") return "audio/wav";
    if (ascii.startsWith("ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
    if (ascii.slice(4, 8) === "ftyp") return byName ?? "video/mp4";
  }
  return byName ?? null;
}

/** File/URL/data URI loader for Gemini's full multimodal input surface. */
export async function loadMedia(src: string): Promise<ImageRef> {
  if (/^https?:\/\//i.test(src)) {
    const mediaType = mediaTypeFor(src);
    if (!mediaType) die(`cannot infer the media type of URL '${src}' — add a recognised extension or use a data: URI`);
    return { url: src, mediaType };
  }
  if (src.startsWith("data:")) {
    const m = src.match(/^data:([^;,]+);base64,(.*)$/s);
    if (!m) die("bad data: URI for --file (base64 form required)");
    return { mediaType: m[1], base64: m[2] };
  }
  let bytes: Uint8Array;
  if (src === "-") bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  else {
    if (!existsSync(src)) die(`file not found: ${src}`);
    bytes = new Uint8Array(readFileSync(src));
  }
  let mediaType = mediaTypeFor(src, bytes);
  if (!mediaType && !bytes.includes(0)) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); mediaType = "text/plain"; } catch {}
  }
  if (!mediaType) die(`unsupported binary format: ${src} — Gemini accepts common image, audio, video, PDF, notebook, JSON, RTF, and text/code formats`);
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
  // ── TRUNCATED SUCCESS, on the CLI path ──
  // The server learned this on 2026-08-27 and this reader did not, so `sol "…"`, `apiplan
  // -p`, `apiplan chat` and every call served by the warm daemon still printed whatever
  // arrived before the upstream stopped and exited 0 — a half answer indistinguishable
  // from a short one, and a zero-event cut that printed nothing at all. Same watch, same
  // message, same off-switch as the server: see stream-shape.ts.
  const term = watchTerminal(p);
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", ttft = 0, served = "", imageB64 = "", revised = "", lastProgress = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (TIMING) marks.lastByte = performance.now() - START;
    buf += dec.decode(value, { stream: true });
    // Split on "\n", exactly as the other two readers do (api.ts:268, streamReply below).
    // Splitting on frameSep's "\n\n" assumes every SSE vendor separates frames with a BLANK
    // line. Google's v1internal:streamGenerateContent?alt=sse does not, so no complete part
    // ever formed, every event stayed in the buffer, and the turn ended with the truncation
    // guard firing on "nothing was received" -- a live-looking failure with zero events.
    // framePayload already carries the per-vendor fact (the "data:" prefix, or ndjson's
    // bare "{"), so a line split is correct for SSE and NDJSON alike.
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of [part]) {
        const payload = framePayload(p, line);
        if (!payload) continue;
        let ev: any; try { ev = JSON.parse(payload); } catch { continue; }
        term.see(ev);
        for (const d of deltasOf(p, ev)) {
          if (d.error) die(`stream error: ${d.error}`);
          if (d.served && !served) served = d.served;
          if (d.imageB64) imageB64 = d.imageB64;
          if (d.revisedPrompt) revised = d.revisedPrompt;
          if (d.progress && d.progress !== lastProgress && process.stderr.isTTY) {
            lastProgress = d.progress;                    // a drawing call is slow; show life
            process.stderr.write(`\r\x1b[2m${d.progress}\x1b[0m\x1b[K`);
          }
          if (d.text) { if (!ttft) ttft = performance.now() - START; text += d.text; if (o.stream) process.stdout.write(d.text); }
          if (d.reasoning && o.showThinking) process.stderr.write(d.reasoning);
        }
      }
    }
  }
  if (lastProgress && process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  // The body ended. Without the vendor's own end-of-turn event the answer is INCOMPLETE,
  // and printing it as the reply is the whole "it went silent / half an answer" fault.
  // Streamed text is already on stdout — close the line and say so; buffered text is NOT
  // printed, because on stdout it would be indistinguishable from a finished reply.
  if (term.missing()) {
    if (o.stream && text) process.stdout.write("\n");
    die(`${term.message()}${text ? ` (${text.length} chars received${o.stream ? " and shown above" : ", discarded"})` : " (nothing was received)"}`, 5);
  }
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

/**
 * One streamed reply, delivered through a callback instead of stdout — what the
 * interactive chat needs. Kept separate from callDirect(), which owns the CLI's
 * printing, timing and exit behaviour and would fight a REPL for the terminal.
 */
export async function streamReply(
  m: Model, turns: Turn[], o: Opts, onText: (t: string) => void, signal?: AbortSignal,
): Promise<string> {
  const p = providerFor(m);
  const b = p.build(m, turns, o, p.creds());
  const res = await fetch(b.url, { method: "POST", headers: b.headers, body: JSON.stringify(wantsStream(p) ? { ...b.body, stream: true } : b.body), signal });
  if (!res.ok || !res.body) {
    let detail = (await res.text()).slice(0, 300);
    try { const j = JSON.parse(detail); detail = j?.error?.message ?? detail; } catch {}
    throw new Error(`${m.label} answered ${res.status}: ${detail}`);
  }
  const term = watchTerminal(p);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", all = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const payload = framePayload(p, line);
      if (!payload) continue;
      let ev: any; try { ev = JSON.parse(payload); } catch { continue }
      term.see(ev);
      for (const d of deltasOf(p, ev)) {
        if (d.error) throw new Error(d.error);
        if (d.text) { all += d.text; onText(d.text); }
      }
    }
  }
  // Same rule as the CLI and the server: no end-of-turn event, no finished answer. The
  // REPL catches this and shows it as an error rather than folding half a turn into the
  // conversation, where every later turn would be built on it.
  if (term.missing()) throw new Error(term.message());
  return all;
}

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
    const res = await fetch(b.url, { method: "POST", headers: b.headers, body: JSON.stringify(wantsStream(p) ? { ...b.body, stream: true } : b.body) });
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

export function saveMediaFile(bytes: Uint8Array, contentType: string, out: string | undefined, kind: "video" | "song" | "speech", open = false): string {
  const ext = contentType.includes("mp4") ? "mp4" : contentType.includes("wav") ? "wav" : contentType.includes("ogg") ? "ogg" : contentType.includes("mpeg") ? "mp3" : kind === "video" ? "mp4" : "mp3";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const path = out ?? `apiplan-${kind}-${stamp}.${ext}`;
  writeFileSync(path, bytes);
  process.stderr.write(`\x1b[2m${kind} saved: ${path} (${Math.round(bytes.length / 1024)}KB)\x1b[0m\n`);
  if (open) openFile(path);
  return path;
}

/** Direct binary image job for providers whose image generator is not a chat-stream tool. */
export async function runImage(m: Model, prompt: string, o: Opts): Promise<void> {
  if (!prompt.trim()) die("nothing to draw — give me an image prompt, or pipe it in.");
  const p = providerFor(m);
  if (!p.generateImage) die(`${p.label} has no direct image-generation endpoint`);
  await p.prepare?.();
  const r = await p.generateImage(prompt, o, p.creds());
  const path = saveImage(r.base64, o.out, r.revisedPrompt ?? "", o.open);
  process.stdout.write(path + "\n");
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
  try { out = await p.speak({ text, voice, format: fmt, direction: o.direction }); }
  catch (e: any) { sayItHere(e?.message ?? String(e)); return; }
  const ext = out.contentType.includes("wav") ? "wav" : fmt;
  const how = o.direction ? `voice ${voice}, as “${o.direction.replace(/\s+/g, " ").slice(0, 48)}”` : `voice ${voice}`;
  deliverAudio(out.bytes, ext, `${how} via ${live.backend}`, o);
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

/**
 * Dictation: microphone → subscription STT → text on stdout. The live transcript
 * paints one stderr line while you speak; stdout gets ONLY the final text, so
 * `dictation | pbcopy` and `msg=$(dictation)` behave like any Unix tool.
 */
export async function runDictation(m: Model, o: Opts): Promise<void> {
  const { dictate } = await import("./dictation.ts");
  const tty = process.stderr.isTTY;
  const width = () => (process.stderr.columns ?? 80) - 2;
  const paint = (text: string, dim: boolean) => {
    if (!tty) return;
    const w = width();
    const t = text.length > w ? "…" + text.slice(-(w - 1)) : text;
    process.stderr.write(`\r\x1b[2K${dim ? "\x1b[2m" : ""}${t}\x1b[0m`);
  };
  const text = await dictate({
    provider: m.provider, lang: o.lang, silenceStop: o.silenceStop,
    onEvent: (kind, t) => {
      if (kind === "info") { if (tty) process.stderr.write(`\r\x1b[2K\x1b[2m[${t}]\x1b[0m\n`); }
      else paint(t, kind === "interim");
    },
  });
  if (tty) process.stderr.write("\r\x1b[2K");
  if (!text) die("heard nothing — is the microphone working? (macOS: check the terminal's mic permission)");
  process.stdout.write(text + "\n");
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

/**
 * The talk daemon is loaded LAZILY, never as a top-level import: importing it pulls in
 * the realtime/voice stack and (lazily) provider credentials, and engine.ts is also the
 * hot path for plain text calls, where every millisecond of module init is charged to
 * the user. Memoised in a module-level handle rather than re-`await import()`ing at each
 * use so that bye() — which must stay synchronous — can tell whether the park was ever
 * armed and only then close it.
 */
let td: typeof import("./talk-daemon.ts") | null = null;
async function talkDaemon(): Promise<typeof import("./talk-daemon.ts")> {
  return (td ??= await import("./talk-daemon.ts"));
}

export async function runDaemon(): Promise<void> {
  if (await daemonAlive()) { process.stderr.write("apiplan daemon already running\n"); return; }
  ensureDir(STATE_DIR);
  if (IPC.kind === "unix" && existsSync(IPC.path)) { try { unlinkSync(IPC.path); } catch {} }
  const token = crypto.randomUUID();

  // ── S-1 (2026-08-28): THIS IS A RESIDENT SERVER TOO ──────────────────────────────
  // A token mint that blocks is correct in a one-shot CLI, where nothing else is waiting,
  // and wrong in anything with an event loop. R-1 took the sync mint off the request path
  // of serve() and left this daemon — which is long-lived, shared by every warm `apiplan
  // ask` on the machine, and single-threaded exactly like serve() — still calling the
  // spawnSync(curl) mint from inside creds(). Measured on an isolated daemon with the OAuth
  // endpoint hanging: ONE ask froze the whole daemon, and its own /health went from 0.0005 s
  // to 5.8 s. The two lines that fix it are the same two serve() got: turn the sync path
  // off, and do whatever the credential needs from the network in prepare(), awaited, where
  // awaiting frees the loop for every other request instead of stalling it.
  // The CLI is untouched: it never calls runDaemon() in its own process (`--daemon` is its
  // own process, and spawnDaemonDetached spawns another), so a one-shot ask still mints
  // synchronously, which is the right thing there.
  providerRuntime.syncRefresh = false;
  // F9-2: and the PLAIN reads are blocking too — `security` on this machine, ~15 ms each,
  // several per health check. Filling every snapshot here, before the socket is listening,
  // is what makes the one unavoidable blocking read of each well happen while nobody is
  // queued behind it. Never throws.
  warmCreds();

  // credential cache, refreshed a few minutes before expiry
  const cache = new Map<string, { c: any; exp: number }>();
  const creds = async (pid: keyof typeof PROVIDERS) => {
    const hit = cache.get(pid);
    if (hit && hit.exp - Date.now() > 300_000) return hit.c;
    // Off the request path by construction: prepare() either returns at once (serving the
    // token already in hand while a mint runs in the background) or awaits a bounded async
    // mint. Never throws by contract; a provider with nothing to prepare has no hook.
    try { await PROVIDERS[pid].prepare?.(); } catch {}
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
    if (u.pathname === "/talk" && req.method === "POST") {
      // Same guard as /call: a thin CLI from another build must not be served by this
      // daemon — its streaming line contract may have changed underneath it.
      const cv = req.headers.get("x-apiplan-version");
      if (cv && cv !== VERSION) return new Response(`version mismatch: daemon ${VERSION}, client ${cv}`, { status: 409 });
      return (await talkDaemon()).handleTalk(req);
    }
    if (u.pathname === "/talk/status") {
      // Built by hand rather than with Response.json: nothing else in this file relies
      // on it, and the /call error path already spells the JSON response out this way.
      return new Response(JSON.stringify((await talkDaemon()).parkStatus()), { headers: { "content-type": "application/json" } });
    }
    if (u.pathname === "/call" && req.method === "POST") {
      // A client from a different build must not be served by this one: the request
      // contract may have changed. Tell it to replace us instead of answering wrongly.
      const cv = req.headers.get("x-apiplan-version");
      if (cv && cv !== VERSION) return new Response(`version mismatch: daemon ${VERSION}, client ${cv}`, { status: 409 });
      try {
        const s: any = await req.json();
        const m: Model = s.model;
        const p = PROVIDERS[m.provider as keyof typeof PROVIDERS];
        const b = p.build(m, s.turns, s.opts, await creds(m.provider));
        const up = await fetch(b.url, { method: "POST", headers: b.headers, body: JSON.stringify(wantsStream(p) ? { ...b.body, stream: true } : b.body) });
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
      const hosts: [string, string][] = p.id === "anthropic"
        ? [["https://api.anthropic.com/v1/models", "GET"]]
        // api.openai.com is the host the realtime WebSocket resolves and handshakes
        // against, so keeping its DNS/TLS path hot shaves the handshake off a call that
        // finds the park cold. Deliberately a SMALL win, not the main event: TLS is only
        // ~15ms of the ~1200ms cold `apiplan talk` — the parked session is what buys the
        // other ~900ms. Unauthenticated HEAD on purpose: establishing the path needs no
        // credentials, and sending them to a probe endpoint would leak them for nothing.
        : [["https://chatgpt.com", "HEAD"], ["https://api.openai.com/", "HEAD"]];
      for (const [host, method] of hosts) {
        try { await fetch(host, { method }); } catch {}
      }
    }
  };
  warm();
  const ka = +(process.env.APIPLAN_KEEPALIVE_MS ?? 45_000);
  if (ka > 0) setInterval(warm, ka);
  const idle = +(process.env.APIPLAN_DAEMON_IDLE_MS ?? 30 * 60_000);
  if (idle > 0) setInterval(() => { if (Date.now() - lastReq > idle) process.exit(0); }, 60_000);
  const where = IPC.kind === "unix" ? IPC.path : `127.0.0.1:${server.port}`;
  process.stderr.write(`apiplan daemon listening on ${where} (warm+keepalive ${ka}ms, idle-exit ${Math.round(idle / 60_000)}m)\n`);

  // Parking holds an OpenAI realtime session open, so it is opt-in at boot: most daemon
  // lifetimes serve only text calls and should not hold a voice session. The first
  // `apiplan talk` arms it, and it re-parks after every call (see talk-daemon.ts).
  if (/^(1|on|true|yes)$/i.test(process.env.APIPLAN_TALK_PARK ?? "")) {
    talkDaemon().then((m) => m.armPark("daemon boot")).catch(() => {});
  }

  // Serve until told to stop. Without this the function returns, the caller exits,
  // and the daemon dies the instant it was born — which silently turned the warm
  // path into a 2s penalty (every call re-spawned it). See DARWIN.md round 1.
  // A parked realtime socket dropped on process exit leaves the server side waiting on a
  // session that will never speak again, so close it politely first. Guarded on the
  // memoised handle: when no talk ever ran the module was never loaded, and awaiting an
  // import inside a signal handler would delay (or, if it threw, block) the exit.
  const bye = () => {
    if (td) { try { td.shutdownPark(); } catch {} }
    if (IPC.kind === "unix") { try { unlinkSync(IPC.path); } catch {} }
    process.exit(0);
  };
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
  // One attachment may claim stdin; it must not also be read as prompt text.
  const stdinAttachments = [...o.images, ...o.files].filter((x) => x === "-").length;
  if (stdinAttachments > 1) die("stdin can only be used by one --image/--file attachment");
  const piped = !stdinAttachments && !process.stdin.isTTY ? await Bun.stdin.text() : "";
  const media = [
    ...(await Promise.all(o.images.map(loadImage))),
    ...(await Promise.all(o.files.map(loadMedia))),
  ];
  if (o.systemFile) o.system = (o.system ? o.system + "\n\n" : "") + readFileSync(o.systemFile, "utf8");
  if (o.directionFile) o.direction = (o.direction ? o.direction + "\n\n" : "") + readFileSync(o.directionFile, "utf8").trim();

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
    if (media.length) {
      const i = turns.map((t) => t.role).lastIndexOf("user");
      if (i < 0) die("--chat with --image/--file needs a user message to attach the media to.");
      turns[i].images = media;
    }
    return turns;
  }
  const text = [o.prompt.join(" ").trim(), piped.trim()].filter(Boolean).join("\n\n");
  if (!text && !media.length) return [];
  return [{ role: "user", text: text || "What is in this file?", images: media.length ? media : undefined }];
}

export function resolveModelOrDie(name: string | undefined): Model {
  if (!name) die("no model — use a model command (opus/sonnet/gpt/…) or -m <model>. Try `apiplan models`.");
  const m = resolve(name);
  if (m) return m;
  const near = models().slice(0, 6).map((x) => x.family + x.version.join("")).join(", ");
  die(`unknown model '${name}'. Try one of: ${near} … or run \`apiplan models\` for the full list.`);
}
