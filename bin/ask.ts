#!/usr/bin/env bun
// ask.ts — the entry point every generated model command runs.
// `opus`, `sonnet`, `gpt`, `sol`, and any custom command the user creates are all
// thin shims around this file with a different --model (plus any baked-in flags).
import { basename } from "node:path";
import { parseArgs, buildTurns, callDirect, callViaDaemon, runDaemon, daemonStop, runSpeech, resolveModelOrDie, die, VERSION, type Opts } from "../src/engine.ts";
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
  -e, --effort <level>   ${efforts}
      --thinking off|N   turn reasoning off entirely (or set a legacy token budget)
      --loop <n>         self-refine n times before answering (default 1)
      --max-tokens <n>   cap the answer length
  -t, --temperature <f>  sampling temperature (legacy models only)
      --fast             Anthropic Fast Mode (Opus 4.7/4.8 — separate rate limit)
      --1m               enable the 1M-context beta for very large inputs

MAKE THINGS (drawing + read-aloud run on the subscription; free-text speech needs a key)
      --draw             draw the prompt${m && !p?.canGenerateImages ? " (not on " + m.label + ")" : ""}   --size <WxH>  --quality <low|medium|high>
      --aloud            ChatGPT read-aloud, real product voices. Reads only what you
                         name: --last (newest reply) or --conversation/--message <id>
      --speak            say your own text (needs OPENAI_API_KEY)   --local (OS voice, offline)
      --voice <name>     apiplan voices lists both sets   --play   --format aac|mp3|wav
  -o, --out <file>       where the image/audio goes (default ./apiplan-<time>.<ext>)

INPUT
  -i, --image <src>      file · http(s) URL · data: URI · - (stdin) · clipboard — repeatable
  -s, --system <text>    system prompt / instructions
      --system-file <f>  read the system prompt from a file
      --chat             read a JSON messages array from stdin (multi-turn)
      --                 everything after this is literal prompt text

OUTPUT
      --stream           print tokens as they arrive (default for *-fast commands)
      --show-thinking    stream the reasoning summary to stderr
      --json / --dry-run raw response · print the exact request without sending
  -v, --verbose          report first-token and total latency

SPEED  the warm daemon caches your login and holds the connection open; it starts itself
      --no-daemon        run this one call in-process    --daemon / --daemon-stop
                         (APIPLAN_DAEMON=off disables it entirely)

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
  die(`${model.label} cannot generate images — use an OpenAI model (sol / gpt / luna / terra).`);
}
if (o.effort) {
  const ok = providerFor(model).efforts(model);
  if (!ok.includes(o.effort)) die(`effort '${o.effort}' is not available on ${model.label}; valid: ${ok.join(", ")}`);
}

// Speech is a different shape of job: no streaming, no daemon, binary out.
if (o.speak) {
  // --aloud reads a message that already exists in the account, so it takes no prompt
  // and must not sit waiting on stdin for one.
  const turns0 = o.aloud ? [] : await buildTurns(o);
  const said = turns0.map((t) => t.text).filter(Boolean).join("\n");
  try { await runSpeech(model, said, o); }
  catch (e: any) { die(e?.message ?? String(e)); }
  process.exit(0);
}

const turns = await buildTurns(o);
if (!turns.length) {
  process.stdout.write(help(invoked, model) + "\n");
  die("no prompt — type it after the command, or pipe it in.", 1);
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
