# apiplan — continue here

**What it is.** One CLI per frontier model, powered by the Claude Code and Codex
**subscriptions already logged in on this machine** — no API key, no per-token bill.
`opus explain monads` just works, unquoted, piped, with images, in under a second warm.

**Why.** fire17 wanted the frontier models as ordinary Unix commands on the plan he
already pays for. `VISION.md` is the verbatim founding brief and governs everything here.

## Current state (v0.4.0, honest)

**Live-verified on macOS** (every claim below was observed, not assumed):

- Both providers answer through one engine: Anthropic `/v1/messages` (subscription OAuth
  from the Keychain) and OpenAI's Codex Responses endpoint (`~/.codex/auth.json`).
- Alias contract holds at the wire level, confirmed by the API's own served-model field:
  `opus → claude-opus-5`, `opus48 → claude-opus-4-8`, `sonnet → claude-sonnet-5`,
  `haiku → claude-haiku-4-5-20251001`, `sol → gpt-5.6-sol`, `gpt55 → gpt-5.5`.
- Pipes both ways, `--chat` multi-turn (remembers across turns), images from file/URL/
  data:/stdin/clipboard, `--loop`, `--dry-run`, effort per provider-advertised levels.
- 13 global commands installed in `~/.bun/bin`; `apiplan doctor` reports **all clear**.
- 118 tests green; 7 of 7 budgets met (`bun test`, `bun bench/perf.ts`).
- **Making things, all on the subscription, no API key** (added 2026-08-02):
  `imagine` draws (image_generation tool on the same codex endpoint; `--raw` sends your
  prompt character-for-character, default `--enhance` lets the model rewrite it, which is
  what `prompt used:` reports); `tts` speaks any text over the realtime WebSocket
  (`gpt-realtime`, 10 voices, PCM16 → wav, any language — Hebrew verified); `tts --aloud`
  re-reads a ChatGPT message via `/backend-api/synthesize` in the 9 product voices.
- Warm call ≈ 1.0 s first token, of which **4 ms is ours** (measured directly, not
  inferred). 25 parallel calls all succeed, p50 1.06 s.

**Also live-verified on Linux** (rounds 6–7): the *published* repo run in a container on
Linux aarch64 — 80/80 tests, correct platform detection, unix-socket IPC, the
`~/.claude/.credentials.json` credential fallback that only executes off-macOS, and the
one-line `curl … | sh` install working on a bare box with only git + curl.

**NOT yet live-verified: WSL and Windows.** `detectWsl()` is tested against real WSL1/WSL2
kernel strings and the interop env vars, and the Windows `.cmd`/`.ps1` shims plus the
loopback-TCP daemon (including its 403 without a token) are tested — but no process has
executed on either OS. **This is the single biggest open item.** The WSL box (`magic-wsl`)
was reachable in Tailscale but SSH did not answer.

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

1. ~~Run it on WSL and Windows~~ — done (round 13): all four target OSes verified by
   execution; the CI matrix keeps ubuntu/macos/windows honest on every push.
2. ~~Publish~~ — done: github.com/fire17/apiplan, releases through v0.4.0.
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
- **`sh install.sh` puts no slash in `$0`.** That made the checkout test fail, so the
  installer decided it was being piped and cloned a second copy to `~/.apiplan/src` —
  every command on this machine ran a stale tree for a while. `apiplan doctor` now prints
  the **install root**; check it first when behaviour doesn't match the code you're editing.
- **Don't gate a metric you don't own.** The credential-read timing measured how fast the
  macOS Keychain is, so a *faster* Keychain registered as a regression.
- **The model rewrites a drawing prompt, not the image backend.** It owns the tool call,
  so it authors the `prompt` argument — that is what `prompt used:` shows. `--raw` pins it.
- **`OpenAI-Beta: realtime=v1` kills the realtime socket** (closed 4000
  `beta_api_shape_disabled`). Omit it and the subscription token is accepted on the GA
  shape. One header was the whole difference between "needs a WebRTC stack" and "works".
- **Creating a ChatGPT conversation is CAPTCHA-gated.** `sentinel/chat-requirements`
  reports `turnstile.required = true`; that path stays closed, which is why read-aloud can
  only speak messages that already exist.
- **Percentage drift bands are meaningless at small absolute values** (10 % of 18 ms is
  1.8 ms), and a median of a few samples is the wrong estimator for deterministic work —
  use the floor. Both made the perf gate fail on ~half of identical runs.
