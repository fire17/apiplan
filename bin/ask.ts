#!/usr/bin/env bun
// ask.ts — the entry point every generated model command runs.
// `opus`, `sonnet`, `gpt`, `sol`, and any custom command the user creates are all
// thin shims around this file with a different --model (plus any baked-in flags).
import { basename } from "node:path";
import { parseArgs, buildTurns, callDirect, callViaDaemon, runDaemon, daemonStop, runImage, runSpeech, runDictation, saveMediaFile, resolveModelOrDie, die, VERSION, type Opts } from "../src/engine.ts";
import { models, aliasesFor } from "../src/registry.ts";
import { providerFor } from "../src/providers.ts";
import type { Model } from "../src/registry.ts";

const ENTRY = import.meta.path;

function help(invoked: string, m: Model | null): string {
  const p = m ? providerFor(m) : null;
  const efforts = m && p ? p.efforts(m).join(" | ") : "low | medium | high | xhigh | max";
  const who = m ? `${m.label}  (${m.id})` : "no model bound — pass -m <model>";
  return `${invoked} — ask ${who}

USAGE
  ${invoked} <your question, no quotes needed>
  ${invoked} -i screenshot.png what is wrong here
  cat file | ${invoked} summarise this
  echo '[{"role":"user","content":"hi"}]' | ${invoked} --chat

MODEL
  -m, --model <name>     family (opus → newest Opus) · explicit (opus48) · variant (sol) · full id
  -e, --effort <level>   ${efforts}   ·   --thinking off|N   no reasoning / token budget
      --loop <n>         self-refine n times before answering (default 1)
      --max-tokens <n>   cap the answer length
  -t, --temperature <f>  sampling temperature (legacy models only)
      --fast             Anthropic Fast Mode (Opus 4.7/4.8 — separate rate limit)
      --1m               enable the 1M-context beta for very large inputs

MAKE THINGS
      --draw             image via AGY${m && !p?.canGenerateImages ? " (not on " + m.label + ")" : ""} · --video [--duration N] · --song (Veo/Lyria use your Gemini key)
      --raw              draw exactly what you typed (default: the model improves it)
      --aloud            read your newest ChatGPT reply aloud (--conversation/--message <id>)
      --speak            say your own text (Gemini uses its public TTS model + API key)
      --dictate          the mic types: live transcript, final text on stdout · Enter ends it · --lang en|he|… · --silence-stop <secs>
      --as <direction>   HOW to say it: "excited, laughing" · "whisper" · "furious" ·
                         "slowly, heartbroken" · any character (--as-file <f>; --local)
      --voice <name>     see apiplan voices   --play   --format aac|mp3|wav
  -o, --out <file>       where the image/audio goes (default ./apiplan-<time>.<ext>)

INPUT
  -i, --image <src>      image/URL/data/clipboard  ·  -f, --file <src> Gemini audio/video/PDF/text — repeatable
  -s, --system <text>    system prompt   ·   --system-file <f>  read it from a file
      --chat             read a JSON messages array from stdin (multi-turn)
      --                 everything after this is literal prompt text

OUTPUT
      --stream           print tokens as they arrive (default for *-fast commands)
      --show-thinking    stream the reasoning summary to stderr
      --json / --dry-run raw response · print the exact request without sending
  -v, --verbose          report first-token and total latency

SPEED  the warm daemon caches your login + connection and starts itself
      --no-daemon        one call in-process · --public Gemini API-key route · --daemon / --daemon-stop

  -h, --help             this help          ·  apiplan          manage every command
  -V, --version          print version      ·  apiplan models   list every model + alias

EXIT CODES  0 ok · 1 error · 3 auth · 4 rate limited`;
}

const argv = process.argv.slice(2);
// A shim may bind the model via --model, or be a symlink named after the alias.
const invoked = basename(process.argv[1] ?? "ask").replace(/\.(ts|cmd|ps1|exe)$/i, "");
const fromName = invoked === "ask" || invoked === "apiplan" ? undefined : invoked;
const o: Opts = parseArgs(argv, fromName);

if (o.version) { process.stdout.write(`apiplan ${VERSION}\n`); process.exit(0); }
if (o.daemon) { await runDaemon(); process.exit(0); }
if (o.daemonStop) { process.stdout.write((await daemonStop()) ? "apiplan daemon stopped\n" : "apiplan daemon not running\n"); process.exit(0); }

if (o.help) {
  let m: Model | null = null;
  try { m = o.model ? resolveModelOrDie(o.model) : null; } catch { m = null; }
  process.stdout.write(help(invoked, m) + "\n");
  process.exit(0);
}

const model = resolveModelOrDie(o.model);
if (o.genImage && !providerFor(model).canGenerateImages) {
  die(`${model.label} cannot generate images — use Gemini or an OpenAI model (sol / gpt / luna / terra).`);
}
if (o.files.length && model.provider !== "google") die("--file multimodal input currently requires Gemini (`gemini ...`); use --image for image-capable non-Gemini models");
// Silently dropping a flag is worse than not having it: say so once, then continue.
if (o.maxTokens && model.provider === "openai") {
  process.stderr.write(`\x1b[2mnote: ${model.label} has no length cap — its endpoint rejects max_output_tokens, so --max-tokens is ignored.\x1b[0m\n`);
}
if (o.effort) {
  const ok = providerFor(model).efforts(model);
  if (!ok.includes(o.effort)) die(`effort '${o.effort}' is not available on ${model.label}; valid: ${ok.join(", ")}`);
}

if (o.genVideo || o.genSong) {
  if (o.genVideo && o.genSong) die("choose one media job: --video or --song");
  if (model.provider !== "google") die("--video and --song are Gemini media jobs; run them with the global `gemini` command");
  if (o.images.length || o.files.length) die("text-to-video/music currently accepts a prompt only");
  const turns0 = await buildTurns(o);
  const prompt = turns0.map((t) => t.text).filter(Boolean).join("\n");
  if (!prompt.trim()) die(`nothing to generate — give me a ${o.genVideo ? "video" : "song"} prompt, or pipe it in`);
  try {
    const media = await import("../src/gemini-media.ts");
    const r = o.genVideo
      ? await media.generateGeminiVideo(prompt, {
          ...(o.duration ? { duration: o.duration } : {}),
          ...(o.imageSize ? { aspectRatio: o.imageSize } : {}),
          onProgress: (note) => process.stderr.write(`\x1b[2m${note}\x1b[0m\r`),
        })
      : await media.generateGeminiMusic(prompt);
    if (o.genVideo) process.stderr.write("\n");
    process.stdout.write(saveMediaFile(r.bytes, r.contentType, o.out, o.genVideo ? "video" : "song", o.open) + "\n");
  } catch (e: any) { die(e?.message ?? String(e)); }
  process.exit(0);
}

// Google's image generator is a dedicated non-streaming endpoint, not a chat tool.
if (o.genImage && providerFor(model).generateImage) {
  if (o.images.length || o.files.length) die("Gemini image generation currently accepts a text prompt only; reference-image editing is not exposed by AGY's generate_image contract");
  const turns0 = await buildTurns(o);
  const prompt = turns0.map((t) => t.text).filter(Boolean).join("\n");
  try { await runImage(model, prompt, o); }
  catch (e: any) { die(e?.message ?? String(e)); }
  process.exit(0);
}

// Dictation is the reverse of speech: microphone in, text out, no prompt at all.
if (o.dictate) {
  try { await runDictation(model, o); }
  catch (e: any) { die(e?.message ?? String(e)); }
  process.exit(0);
}

// Speech is a different shape of job: no streaming, no daemon, binary out.
if (o.speak) {
  // --aloud reads a message that already exists in the account, so it takes no prompt
  // and must not sit waiting on stdin for one.
  const turns0 = o.aloud ? [] : await buildTurns(o);
  const said = turns0.map((t) => t.text).filter(Boolean).join("\n");
  try {
    if (model.provider === "google" && !o.local && !o.aloud) {
      const { generateGeminiSpeech } = await import("../src/gemini-media.ts");
      const r = await generateGeminiSpeech(said, o.voice ?? "Kore");
      process.stdout.write(saveMediaFile(r.bytes, r.contentType, o.out, "speech", o.open) + "\n");
    } else await runSpeech(model, said, o);
  }
  catch (e: any) { die(e?.message ?? String(e)); }
  process.exit(0);
}

const turns = await buildTurns(o);
if (!turns.length) {
  // No prompt and a real terminal means you want to talk, not to be told off.
  // Piped/scripted use still gets the help + error, so nothing automated changes.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { chat } = await import("../src/chat.ts");
    const { streamReply } = await import("../src/engine.ts");
    await chat({
      label: `${model.label}  (${model.id})`,
      send: (t, onText, signal) => streamReply(model, t.map((x) => ({ role: x.role, text: x.content })), o, onText, signal),
    }, { system: o.system });
    process.exit(0);
  }
  process.stdout.write(help(invoked, model) + "\n");
  die("no prompt — type it after the command, or pipe it in.", 1);
}

if (o.publicGemini) {
  if (model.provider !== "google") die("--public is the Gemini API-key route and requires a Gemini model");
  if (o.dryRun) die("--dry-run is not implemented for the public Gemini route; omit --public to inspect AGY's request");
  try {
    const { callGeminiPublic } = await import("../src/gemini-media.ts");
    const r = await callGeminiPublic(model.id, turns, o, o.stream ? (s) => process.stdout.write(s) : undefined);
    if (o.json) process.stdout.write(JSON.stringify(r) + "\n");
    else {
      if (!o.stream) process.stdout.write(r.text);
      process.stdout.write("\n");
      if (o.verbose) process.stderr.write(`[apiplan] public ${r.model} · first token ${r.ttft.toFixed(0)}ms · total ${r.total.toFixed(0)}ms\n`);
    }
  } catch (e: any) { die(e?.message ?? String(e)); }
  process.exit(0);
}

// Anything that throws from here (a missing login, a network failure) is a normal
// operating condition, not a crash: report one clear line, never a stack trace.
try {
  // The daemon can't help with dry-runs, raw JSON, or multi-pass loops; those go direct.
  const eligible = !o.dryRun && !o.json && o.loop === 1 && !o.noDaemon && (process.env.APIPLAN_DAEMON ?? "auto") !== "off";
  if (!(eligible && (await callViaDaemon(model, turns, o, ENTRY)))) {
    await callDirect(model, turns, o);
  }
} catch (e: any) {
  const msg = e?.message ?? String(e);
  const hint = providerFor(model).probe().loginHint;
  die(hint && /credential|token|auth|log ?in/i.test(msg) ? `${msg}\n  → ${hint}` : msg, /auth|token|credential/i.test(msg) ? 3 : 1);
}
