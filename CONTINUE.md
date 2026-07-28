# apiplan — continue here

**What it is.** One CLI per frontier model, powered by the Claude Code and Codex
**subscriptions already logged in on this machine** — no API key, no per-token bill.
`opus explain monads` just works, unquoted, piped, with images, in under a second warm.

**Why.** fire17 wanted the frontier models as ordinary Unix commands on the plan he
already pays for. `VISION.md` is the verbatim founding brief and governs everything here.

## Current state (v0.2.0, honest)

**Live-verified on macOS** (every claim below was observed, not assumed):

- Both providers answer through one engine: Anthropic `/v1/messages` (subscription OAuth
  from the Keychain) and OpenAI's Codex Responses endpoint (`~/.codex/auth.json`).
- Alias contract holds at the wire level, confirmed by the API's own served-model field:
  `opus → claude-opus-5`, `opus48 → claude-opus-4-8`, `sonnet → claude-sonnet-5`,
  `haiku → claude-haiku-4-5-20251001`, `sol → gpt-5.6-sol`, `gpt55 → gpt-5.5`.
- Pipes both ways, `--chat` multi-turn (remembers across turns), images from file/URL/
  data:/stdin/clipboard, `--loop`, `--dry-run`, effort per provider-advertised levels.
- 13 global commands installed in `~/.bun/bin`; `apiplan doctor` reports **all clear**.
- 80 tests green; 7 of 7 budgets met (`bun test`, `bun bench/perf.ts`).
- Warm call ≈ 1.0 s first token, of which **4 ms is ours** (measured directly, not
  inferred). 25 parallel calls all succeed, p50 1.06 s.

**NOT yet live-verified:** Linux, WSL and Windows. The platform layer is unit-tested for
all four targets and the Windows loopback-TCP transport is exercised on macOS via
`APIPLAN_IPC=tcp`, but nobody has run it on those OSes. That is the single biggest open
item — see the "Cross-platform" section of `README.md`.

## Layout

```
bin/ask.ts        the CLI every model command execs (shims pass --model)
bin/apiplan.ts    status · models · commands · install/add/rename/rm/sync/prune ·
                  doctor · daemon · path · shell-init · interactive TUI
src/registry.ts   aliases → model ids, from each provider's own list (family = newest)
src/providers.ts  per-vendor credential/endpoint/request/stream behind one interface
src/engine.ts     argv · images · SSE · warm daemon · self-timing
src/platform.ts   every macOS/Linux/WSL/Windows difference, in one file
src/commands.ts   ~/.apiplan/commands.json ⇄ the shims on PATH
test/ bench/      80 tests · the budget harness with regression detection
```

State lives in `~/.apiplan/`: `commands.json` (your commands — plain JSON, editable),
`models.*.json` (cached model lists), `daemon.sock` / `daemon.json`.

## How to resume

```sh
cd ~/Creations/APIPlan
bun test && bun bench/perf.ts && bun bin/apiplan.ts doctor   # the whole gate
claude --resume 9d23ea6c-4fa0-4293-a3a7-34a7577c376f          # this session
```

Read in this order: `VISION.md` (what was asked) → `BUDGETS.md` (what "fast" means as
numbers) → `DARWIN.md` (five rounds of findings, including the fixes that mattered) →
`LADDER.md` (why the TUI has the three views it has).

## Next steps

1. **Run it on Linux / WSL / Windows** and record the result. Everything is in place;
   only observation is missing.
2. **Publish.** Repo is committed and clean (secret-scanned: only source + docs). The
   vision asks for `/save_and_ship` + publish.
3. **Grok and Gemini.** The provider interface is the extension point: add one adapter
   with `probe/creds/build/delta` plus its model list, and every command, image, pipe and
   daemon behaviour comes for free. Grok is OpenAI-shaped (`api.x.ai`); Gemini needs its
   own `inline_data` mapping.
4. **Optional:** completions (`apiplan completions zsh`), and a real usage log — which
   would finally justify the "spend" rung deliberately left in `LADDER.md`'s graveyard.

## Traps worth knowing (learned the hard way)

- **`gpt` is `/usr/sbin/gpt` on macOS**, a partition-table editor. Installing over it
  silently shadows a disk tool; the installer refuses by design. Use `sol`, or force it.
- **The shell eats `?`**, not this tool. zsh needs `eval "$(apiplan shell-init)"`.
- **A model's self-description is not evidence of routing.** Opus 5 called itself
  "Sonnet 4.5" once. Trust the API's served-model field (`-v`) instead.
- **Never gate a perf budget on end-to-end latency.** Provider jitter is ±0.7 s; the same
  code measured −362 ms and +108 ms on consecutive runs. Measure inside the client.
- **A daemon that exits immediately looks like a working daemon** and made calls 1.6 s
  slower for a while. `ps` for it before believing it is warm.
