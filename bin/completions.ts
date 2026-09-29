// completions.ts — shell tab-completion for `apiplan` and every ask command on PATH.
//
// Scripts are thin: at TAB they call `apiplan __complete <kind> …`, so model names, efforts
// and aliases always follow the CURRENT catalog (the day `luna` moved to GPT-6 a baked list
// would already have been wrong). Only the command NAMES are baked, at eval time, because
// `compdef` / `complete` need them to register. Imported lazily by bin/apiplan.ts.
import { models, aliasesFor, resolve } from "../src/registry.ts";
import { PROVIDERS, providerFor } from "../src/providers.ts";
import { LIVE_MODELS } from "../src/live-models.ts";
import * as C from "../src/commands.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SHELLS = ["zsh", "bash", "fish"] as const;
export type Shell = (typeof SHELLS)[number];
export const SUBCOMMANDS = ["status", "roster", "models", "media", "vision", "commands", "voices", "live-models", "live-check",
  "install", "add", "rename", "rm", "sync", "prune", "doctor", "update", "daemon", "serve", "hotswap", "talk", "path",
  "shell-init", "completions", "chatgpt", "help"];
/** Every flag bin/ask.ts accepts — src/engine.ts parseArgs is the truth; a test pins the two together. */
export const ASK_FLAGS = [
  "-h", "--help", "-V", "--version", "-m", "--model", "-e", "--effort", "-s", "--system", "--system-file", "--max-tokens", "-t", "--temp",
  "--temperature", "--thinking", "--loop", "-i", "--image", "-f", "--file", "--media", "-o", "--out", "--draw", "--gen-image", "--image-out",
  "--raw", "--enhance", "--size", "--quality", "--video", "--gen-video", "--song", "--music", "--gen-song", "--duration", "--speak", "--say",
  "--as", "--style", "--emotion", "--direction", "--as-file", "--voice", "--live-model", "--realtime-model", "--format", "--play", "--open",
  "--local", "--aloud", "--read-aloud", "--dictate", "--stt", "--lang", "--language", "--silence-stop", "--last", "--conversation",
  "--message", "--stream", "--no-stream", "--chat", "--chatmode", "--chat-mode", "--work", "--workmode", "--work-mode", "--mode",
  "--session", "--cache-key", "--json", "--show-thinking", "--fast", "--1m", "--dry-run", "--daemon", "--daemon-stop", "--no-daemon",
  "--public", "--api-key-route", "-v", "--verbose"];
const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** ASK_FLAGS ∪ whatever src/engine.ts parseArgs accepts TODAY — read from source at TAB time
 *  (~1 ms), so a flag another lane adds is completable without touching this file. */
function askFlags(): string[] {
  try {
    const src = readFileSync(join(import.meta.dir, "..", "src", "engine.ts"), "utf8");
    const i = src.indexOf("export function parseArgs");
    const body = i >= 0 ? src.slice(i, src.indexOf("\n}\n", i)) : "";
    return [...new Set([...ASK_FLAGS, ...[...body.matchAll(/case "(-{1,2}[\w-]+)"/g)].map((m) => m[1])])];
  } catch { return ASK_FLAGS; }
}

/** Candidates for one completion request. Pure reads: never network, never writes, never throws. */
export function candidates(kind: string, args: string[]): string[] {
  try {
    switch (kind) {
      case "subcommands": return SUBCOMMANDS;
      case "shells": return [...SHELLS];
      case "providers": return Object.keys(PROVIDERS);
      case "commands": return C.load().commands.map((c) => c.name);
      case "flags": return askFlags();
      case "live-models": return [...new Set(LIVE_MODELS.flatMap((l) => [l.id, ...(l.aliases ?? [])]))];
      case "models": {
        const names = new Set<string>();
        for (const m of models()) for (const n of [...aliasesFor(m), m.id]) names.add(n);
        // Pinned generation words (luna6 / luna56) — offered only when the registry resolves them.
        for (const m of models("openai")) if (m.variant && m.version.length) names.add(`${m.variant}${m.version.join("")}`);
        for (const r of ["online/astra", "online/chat"]) names.add(r);
        return [...names].filter((n) => { try { return !!resolve(n); } catch { return false; } });
      }
      case "efforts": {
        const [cmd = "", explicit = ""] = args;
        const bound = C.load().commands.find((c) => c.name === cmd)?.model;
        const m = resolve(explicit || bound || cmd);
        const e = m ? providerFor(m).efforts(m) : [];
        return e.length ? e : DEFAULT_EFFORTS;
      }
      default: return [];
    }
  } catch { return []; }
}

const safeNames = (names: string[]) => names.filter((n) => /^[A-Za-z0-9._-]+$/.test(n));

export function script(shell: Shell, names: string[]): string {
  const ns = safeNames(names);
  if (shell === "zsh") return zsh(ns);
  if (shell === "bash") return bash(ns);
  return fish(ns);
}

function zsh(ns: string[]): string {
  return `# apiplan completions (zsh) — generated; command names as of this shell's start
_apiplan_c() { command apiplan __complete "$@" 2>/dev/null }
_apiplan_ask() {
  local prev=\${words[CURRENT-1]} cmd=\${words[1]} m="" i
  for (( i=2; i<CURRENT; i++ )); do [[ \${words[i]} == (-m|--model) ]] && m=\${words[i+1]}; done
  case $prev in
    -m|--model) compadd -- \${(f)"$(_apiplan_c models)"}; return;;
    -e|--effort) compadd -- \${(f)"$(_apiplan_c efforts $cmd $m)"}; return;;
    -i|--image) _files; compadd clipboard; return;;
    -f|--file|--media|-o|--out|--system-file|--as-file) _files; return;;
    --thinking) compadd off; return;;
    --mode) compadd chat work; return;;
    --format) compadd aac mp3 wav; return;;
    --live-model|--realtime-model) compadd -- \${(f)"$(_apiplan_c live-models)"}; return;;
  esac
  [[ $PREFIX == -* ]] && compadd -- \${(f)"$(_apiplan_c flags)"}
}
_apiplan() {
  if (( CURRENT == 2 )); then compadd -- \${(f)"$(_apiplan_c subcommands)"}; return; fi
  case \${words[2]}:\${words[CURRENT-1]} in
    *:--model|*:-m) compadd -- \${(f)"$(_apiplan_c models)"};;
    *:--provider) compadd -- \${(f)"$(_apiplan_c providers)"};;
    *:--live-model) compadd -- \${(f)"$(_apiplan_c live-models)"};;
    models:*) compadd -- \${(f)"$(_apiplan_c providers)"};;
    rename:*|rm:*|sync:*) compadd -- \${(f)"$(_apiplan_c commands)"};;
    completions:*|shell-init:*) compadd zsh bash fish;;
    daemon:*) compadd stop;;
    hotswap:*) compadd status upgrade;;
    roster:*) compadd omp;;
  esac
}
if (( $+functions[compdef] )); then compdef _apiplan apiplan;${ns.length ? ` compdef _apiplan_ask ${ns.join(" ")};` : ""} fi
`;
}

function bash(ns: string[]): string {
  // Must run on macOS /bin/bash 3.2: no mapfile, no compopt, no \${var,,}.
  return `# apiplan completions (bash) — generated; command names as of this shell's start
_apiplan_ask_complete() {
  local cur=\${COMP_WORDS[COMP_CWORD]} prev=\${COMP_WORDS[COMP_CWORD-1]} cmd=\${COMP_WORDS[0]} m="" i IFS=$'\\n'
  for ((i=1; i<COMP_CWORD; i++)); do case \${COMP_WORDS[i]} in -m|--model) m=\${COMP_WORDS[i+1]};; esac; done
  case $prev in
    -m|--model) COMPREPLY=($(compgen -W "$(command apiplan __complete models 2>/dev/null)" -- "$cur")); return;;
    -e|--effort) COMPREPLY=($(compgen -W "$(command apiplan __complete efforts "$cmd" "$m" 2>/dev/null)" -- "$cur")); return;;
    -i|--image) COMPREPLY=($(compgen -f -- "$cur") $(compgen -W clipboard -- "$cur")); return;;
    -f|--file|--media|-o|--out|--system-file|--as-file) COMPREPLY=($(compgen -f -- "$cur")); return;;
    --thinking) COMPREPLY=($(compgen -W off -- "$cur")); return;;
    --mode) COMPREPLY=($(compgen -W "chat"$'\\n'"work" -- "$cur")); return;;
    --format) COMPREPLY=($(compgen -W "aac"$'\\n'"mp3"$'\\n'"wav" -- "$cur")); return;;
    --live-model|--realtime-model) COMPREPLY=($(compgen -W "$(command apiplan __complete live-models 2>/dev/null)" -- "$cur")); return;;
  esac
  case $cur in -*) COMPREPLY=($(compgen -W "$(command apiplan __complete flags 2>/dev/null)" -- "$cur"));; esac
}
_apiplan_complete() {
  local cur=\${COMP_WORDS[COMP_CWORD]} prev=\${COMP_WORDS[COMP_CWORD-1]} sub=\${COMP_WORDS[1]} IFS=$'\\n' w=""
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=($(compgen -W "$(command apiplan __complete subcommands 2>/dev/null)" -- "$cur")); return; fi
  case $prev in
    -m|--model) w=$(command apiplan __complete models 2>/dev/null);;
    --provider) w=$(command apiplan __complete providers 2>/dev/null);;
    --live-model) w=$(command apiplan __complete live-models 2>/dev/null);;
    *) case $sub in
         models) w=$(command apiplan __complete providers 2>/dev/null);;
         rename|rm|sync) w=$(command apiplan __complete commands 2>/dev/null);;
         completions|shell-init) w="zsh"$'\\n'"bash"$'\\n'"fish";;
         daemon) w=stop;;
         hotswap) w="status"$'\\n'"upgrade";;
         roster) w=omp;;
       esac;;
  esac
  COMPREPLY=($(compgen -W "$w" -- "$cur"))
}
complete -o default -F _apiplan_complete apiplan
${ns.length ? `complete -o default -F _apiplan_ask_complete ${ns.join(" ")}\n` : ""}`;
}

function fish(ns: string[]): string {
  const lines = [
    "# apiplan completions (fish) — generated; command names as of this shell's start",
    `complete -c apiplan -f -n __fish_use_subcommand -a "(command apiplan __complete subcommands)"`,
    `complete -c apiplan -f -n "__fish_seen_subcommand_from models" -a "(command apiplan __complete providers)"`,
    `complete -c apiplan -f -n "__fish_seen_subcommand_from rename rm sync" -a "(command apiplan __complete commands)"`,
    `complete -c apiplan -f -n "__fish_seen_subcommand_from completions shell-init" -a "zsh bash fish"`,
    `complete -c apiplan -l model -s m -x -a "(command apiplan __complete models)"`,
  ];
  for (const n of ns) {
    lines.push(
      `complete -c ${n} -s m -l model -x -a "(command apiplan __complete models)"`,
      `complete -c ${n} -s e -l effort -x -a "(command apiplan __complete efforts ${n})"`,
      `complete -c ${n} -s i -l image -r -F`,
      `complete -c ${n} -l thinking -x -a off`,
      `complete -c ${n} -l mode -x -a "chat work"`,
      `complete -c ${n} -l live-model -x -a "(command apiplan __complete live-models)"`,
    );
  }
  return lines.join("\n") + "\n";
}
