#!/usr/bin/env bun
// composer — predict your next message, the way Codex's "composer predictions" do, on the
// Codex subscription you already have. Also reachable as `apiplan composer …`.
// How Codex does it, and what this does differently: docs/COMPOSER.md.
import { resolve } from "../src/registry.ts";
import {
  predict, predictionConfig, turnsFromMessages, turnsFromCodexRollout, turnsFromClaudeTranscript,
  findCodexRollout, findClaudeTranscript, tailTurns, readText, type Prediction,
} from "../src/composer.ts";
import type { Turn } from "../src/providers.ts";

const HELP = `composer — predict the user's next message from a conversation (Codex composer predictions)

  composer                         predict for your newest Codex thread
  composer --codex <id|last|path>  a Codex thread (rollout under ~/.codex/sessions)
  composer --claude <id|last|path> a Claude Code session transcript
  composer --file <path>           a JSON array of {role, content} messages
  echo '[{"role":"user","content":"…"}, …]' | composer
  composer config [--json]         the live server config (prompt, version, effort, models)

  -m, --model <id>      default gpt-6-astra (the app supports gpt-6-astra and gpt-6.1-sol)
  -e, --effort <level>  default: the server config's prediction effort
  --json                print the full prediction record (usage, cache, latency, windows)
  --no-tag              omit the composer_predictions turn metadata (an A/B control)
  --prompt-file <path>  use this prompt instead of the server's
  --max-chars <n>       keep only the newest turns up to n characters (default 200000)

  exit 0 = a suggestion was printed · 2 = the model chose no suggestion · 1 = error`;

export async function main(argv: string[]): Promise<number> {
  const vals = new Map<string, string>();
  const flags = new Set<string>();
  const pos: string[] = [];
  const valued = new Set(["codex", "claude", "file", "model", "effort", "prompt-file", "max-chars", "m", "e"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      const [k, inline] = a.replace(/^--?/, "").split(/=(.*)/s);
      if (valued.has(k)) {
        const v = inline ?? argv[++i];
        if (v === undefined) return fail(`--${k} needs a value`);
        vals.set(k === "m" ? "model" : k === "e" ? "effort" : k, v);
      } else flags.add(k);
    } else pos.push(a);
  }
  if (flags.has("h") || flags.has("help") || pos[0] === "help") { process.stdout.write(HELP + "\n"); return 0; }

  if (pos[0] === "config") {
    const { cfg, source, error } = await predictionConfig({ fresh: true });
    if (flags.has("json")) { process.stdout.write(JSON.stringify({ source, ...(error ? { error } : {}), ...cfg }, null, 2) + "\n"); return 0; }
    process.stdout.write(`source     ${source}${error ? ` (${error})` : ""}\n`);
    process.stdout.write(`enabled    ${cfg.is_enabled}\n`);
    process.stdout.write(`version    ${cfg.prompt_version}\n`);
    process.stdout.write(`effort     ${cfg.prediction_reasoning_effort ?? "(parent's)"}\n`);
    if (cfg.sample_rate !== undefined) process.stdout.write(`sample     ${cfg.sample_rate}\n`);
    if (cfg.unsupported_models?.length) process.stdout.write(`unsupported ${cfg.unsupported_models.join(", ")}\n`);
    process.stdout.write(`\n${cfg.prompt}\n`);
    return 0;
  }
  if (pos.length) return fail(`unknown argument '${pos[0]}' — composer --help`);

  const modelName = vals.get("model") ?? process.env.APIPLAN_COMPOSER_MODEL ?? "gpt-6-astra";
  const model = resolve(modelName);
  if (!model) return fail(`unknown model '${modelName}' — apiplan models lists them`);

  let turns: Turn[];
  let forkedFrom: string | undefined;
  try {
    if (vals.has("claude")) turns = turnsFromClaudeTranscript(readText(findClaudeTranscript(vals.get("claude")!)));
    else if (vals.has("file")) turns = turnsFromMessages(JSON.parse(readText(vals.get("file")!)));
    else if (vals.has("codex") || process.stdin.isTTY) {
      const r = findCodexRollout(vals.get("codex") ?? "last");
      forkedFrom = r.threadId;
      turns = turnsFromCodexRollout(readText(r.file));
    } else {
      const raw = (await new Response(Bun.stdin.stream()).text()).trim();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      turns = parsed === undefined ? [{ role: "user", text: raw }] : turnsFromMessages((parsed as any)?.messages ?? parsed);
    }
  } catch (e: any) { return fail(e.message); }
  const maxChars = Number(vals.get("max-chars") ?? 200_000);
  if (!Number.isFinite(maxChars) || maxChars <= 0) return fail("--max-chars must be a positive number");
  turns = tailTurns(turns, maxChars);
  if (!turns.length) return fail("the conversation has no user or assistant messages");

  let p: Prediction;
  try {
    p = await predict(turns, {
      model, effort: vals.get("effort"), tag: !flags.has("no-tag"), forkedFrom,
      prompt: vals.has("prompt-file") ? readText(vals.get("prompt-file")!) : undefined,
    });
  } catch (e: any) { return fail(e.message); }
  if (flags.has("json")) process.stdout.write(JSON.stringify(p, null, 2) + "\n");
  else if (p.suggestion) process.stdout.write(p.suggestion + "\n");
  if (p.unsupported_model && !flags.has("json")) process.stderr.write(`composer: note — the server config lists ${p.model} as unsupported for predictions\n`);
  return p.suggestion ? 0 : 2;
}

function fail(msg: string): number { process.stderr.write(`composer: ${msg}\n`); return 1; }

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
