# apiplan

**Call frontier models from your shell using the subscriptions you already pay for.**

You're logged into Claude Code and Codex. Those logins can answer API-shaped questions —
so `apiplan` turns them into ordinary Unix commands. No API key, no per-token bill, no
quotes around your question.

```console
$ opus explain monads in one sentence
A monad is a way to chain operations that carry context — like error state or I/O —
without writing the plumbing at every step.

$ cat server.log | sonnet find the root cause | pbcopy
$ sol -i screenshot.png what is wrong with this layout
$ haiku-fast is 91 prime
No — 91 = 7 × 13.
```

Every model becomes its own command. Pipes work in both directions. Images work.
A background daemon keeps your login and connection warm, so a repeat call answers in
under a second.

---

## Install

```sh
git clone https://github.com/fire17/apiplan && cd apiplan
sh install.sh                  # macOS · Linux · WSL
```

```powershell
git clone https://github.com/fire17/apiplan; cd apiplan
powershell -ExecutionPolicy Bypass -File install.ps1    # Windows
```

Needs [bun](https://bun.sh) (one binary, no admin) — the installer offers to fetch it.
You must already be logged into `claude` and/or `codex`; apiplan never asks for a
credential and never stores one.

Then `apiplan` shows you everything:

```console
$ apiplan status
apiplan v0.2.0  ·  macOS  ·  daemon warm

PROVIDERS
  ● anthropic    Keychain (Claude Code-credentials) · expires 2026-07-28 20:14 · team
    Anthropic (Claude Code subscription) · 11 models, just now
  ● openai       ~/.codex/auth.json · chatgpt · expires 2026-07-28 21:07
    OpenAI (Codex / ChatGPT subscription) · 6 models, just now

COMMANDS 13 configured in ~/.bun/bin
  opus  opus-fast  sonnet  sonnet-fast  fable  fable-fast  haiku  haiku-fast
  gpt-fast  sol  luna  terra
```

## A family name always means the newest model

`opus` is whichever Opus is current — today `claude-opus-5`. When Opus 6 ships, `opus`
follows it, because the list comes from the provider's own model endpoint rather than a
table someone has to remember to edit. Explicit versions never stop working:

| you type | you get |
|---|---|
| `opus` | newest Opus (`claude-opus-5`) |
| `opus5` · `opus48` · `opus47` · `opus45` | that exact version |
| `opus4.8` · `Opus-4-8` · `OPUS_4_8` | same thing — separators and case are folded |
| `sonnet` · `haiku` · `fable` | newest of each family |
| `sol` · `luna` · `terra` | the current GPT-5.6 variants |
| `gpt55` · `gpt54mini` | that exact OpenAI model |
| `claude-opus-4-8` | a full id passes straight through |

```console
$ apiplan models
ANTHROPIC connected · just now
  MODEL                       ALIASES         EFFORT
  claude-opus-5               opus opus5      low/medium/high/xhigh/max
  claude-opus-4-8             opus48          low/medium/high/xhigh/max
  …
```

Every alias is verified against the API's own report of which model answered — run any
command with `-v` and it tells you: `served by claude-opus-5 · first token 958ms`.

## Usage

```sh
opus <your question>                 # no quotes needed
opus -e xhigh design a rate limiter  # reasoning effort: low → max
opus -i chart.png -i notes.jpg compare these
opus -i clipboard whats wrong here   # paste a screenshot straight in
cat file | opus summarise            # stdin is appended to your prompt
opus --loop 3 write a haiku          # self-refine before answering
opus -s be extremely terse hello     # system prompt
echo '[{"role":"user","content":"hi"}]' | opus --chat    # multi-turn
opus --dry-run hello                 # show the exact request, send nothing
opus --help                          # every flag, one screen
```

`*-fast` twins (`opus-fast`, `sol-fast`, …) bake in the least reasoning the provider
allows plus streaming, for the quickest possible first token.

### Quotes, `?` and `*`

Your shell — not this tool — is what eats `?` in `opus is this right?`. zsh needs one
line to stop:

```sh
eval "$(apiplan shell-init)"     # add to ~/.zshrc
```

bash, cmd.exe and PowerShell already pass them through, and `apiplan shell-init` tells
you so instead of adding aliases you don't need.

## Make your own commands

Commands are data, not code. `~/.apiplan/commands.json` is the source of truth and the
shims on your `PATH` are generated from it.

```sh
apiplan add ask --model sonnet --flags "-e low --stream"   # a new command
apiplan rename ask q                                       # call it whatever you like
apiplan rm q
apiplan commands                                           # what exists, and is it on PATH
apiplan sync                                               # rebuild every shim from config
```

Or run `apiplan` with no arguments for a dashboard: `↑↓` to select, `1`/`2`/`3` to move
between providers, models and commands, `n` new, `r` rename, `f` flags, `d` delete,
`R` refresh, `i` install the default set.

apiplan refuses to install a command whose name a real system tool already owns — on
macOS `gpt` is `/usr/sbin/gpt`, the partition-table editor — and tells you how to pick
another name or take it anyway.

## Speed

Measured on this machine (bun 1.3.14, darwin arm64); reproduce with `bun bench/perf.ts`.

| | |
|---|---|
| client overhead, no network | **18 ms** (bun's own floor is 11 ms) |
| overhead we add to a warm call | **−362 ms** — a warm call beats a cold raw `fetch`, because the connection is already open |
| first token, warm | **~0.96 s** (text) · ~1.7 s (with an image) |
| 25 calls in parallel | **25/25**, 2.4 s wall clock, per-call p50 1.06 s |
| idle daemon | **44 MB**, ~0 % CPU, exits itself after 30 min |

The daemon starts on your first call, caches the credential (a Keychain read costs 13 ms
every time otherwise) and holds the connection to each provider open. It never delays a
cold call: if it isn't up yet, that call goes direct and the daemon warms up for the next
one. `--no-daemon` opts out; `APIPLAN_DAEMON=off` disables it globally.

What it can't fix: network round-trip and the provider's own first-token time. Those are
most of the ~1 s, and no client can remove them.

## How it works

```
opus / sonnet / sol / …        thin shims, generated from commands.json
        └── bin/ask.ts         one CLI for every model
                ├── src/registry.ts    aliases → model ids, from each provider's own list
                ├── src/providers.ts   per-vendor: credential, endpoint, request, stream
                ├── src/engine.ts      argv · images · SSE · the warm daemon
                └── src/platform.ts    macOS · Linux · WSL · Windows differences
bin/apiplan.ts                 status · models · commands · doctor · TUI
```

Anthropic calls go to `/v1/messages` with the subscription's OAuth token and the Claude
Code identity block; OpenAI calls go to the Codex Responses endpoint with the
`chatgpt-account-id` header. Both contracts were read out of the official binaries rather
than guessed, and every fragile constant is overridable by environment variable
(`apiplan --help` lists them) so a server-side change is a config tweak, not a rebuild.

## Cross-platform

| | credentials | commands | daemon IPC |
|---|---|---|---|
| macOS | Keychain, then `~/.claude/.credentials.json` | `sh` shim | unix socket, mode 0600 |
| Linux · WSL | `~/.claude/.credentials.json` | `sh` shim | unix socket, mode 0600 |
| Windows | `%USERPROFILE%\.claude\.credentials.json` | `.cmd` + `.ps1` | loopback TCP + per-run token |

Codex reads `~/.codex/auth.json` everywhere. The Windows transport is exercised on every
platform via `APIPLAN_IPC=tcp`, and an unauthenticated request to that port gets a 403.

**Honest status:** developed and live-verified on macOS. Linux, WSL and Windows are
covered by the platform test-suite and the forced-TCP run, but have **not yet been run on
those operating systems** — see `DARWIN.md`.

## Troubleshooting

```sh
apiplan doctor      # PATH, logins, daemon, shadowed names — with the fix for each
```

| symptom | cause | fix |
|---|---|---|
| `auth rejected (401/403)` | login expired | run `claude` / `codex` once |
| `no matches found: right?` | your shell ate the `?` | `eval "$(apiplan shell-init)"` |
| `command not found: opus` | bin dir not on PATH | `apiplan path` prints the line to add |
| `skipped gpt — would shadow …` | a real tool owns that name | `apiplan rename gpt g5`, or `apiplan sync --force` |
| `image is 1×1px — too small` | model needs ≥ 8×8 | send a real image |
| answers ignore an `APIPLAN_*` override | — | overrides bypass the daemon automatically; nothing to do |

## Development

```sh
bun test                  # 79 tests: aliases, wire contracts, CLI, platform layer
bun bench/perf.ts         # the budgets in BUDGETS.md, with regression detection
```

`VISION.md` is the founding brief, `BUDGETS.md` turns its adjectives into enforced
numbers, `LADDER.md` is the information architecture, and `DARWIN.md` logs five rounds of
measure-fix-verify — including the round where the daemon turned out to be making calls
1.6 s *slower*, and the optimisation that was measured, rejected and recorded.

## Notes

Your subscription's terms and rate limits apply exactly as they do in the official
clients; this only changes the shape of the call, not the agreement. OpenAI calls set
`store: false`, so they stay out of your Codex history.

MIT
