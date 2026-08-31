# apiplan — continue here

**What it is.** One CLI per frontier model, powered by the Claude Code and Codex
**subscriptions already logged in on this machine** — no API key, no per-token bill.
`opus explain monads` just works, unquoted, piped, with images, in under a second warm.

**Why.** fire17 wanted the frontier models as ordinary Unix commands on the plan he
already pays for. `VISION.md` is the verbatim founding brief and governs everything here.

## Current state (v0.7.0, honest)

**Live-verified on macOS** (every claim below was observed, not assumed):

- Four provider families answer through one engine: Anthropic (Claude Code OAuth), OpenAI
  (Codex/ChatGPT), Google (Antigravity/Gemini Code Assist) and Ollama (loopback/local).
- The localhost API preserves native cache identity: Anthropic `cache_control` blocks and
  metadata; OpenAI `prompt_cache_key` and session routing. Repeat live calls measured
  **16,226 Anthropic cache-read tokens** and **4,864 OpenAI cached tokens**.
- `apiplan hotswap upgrade` drained and replaced the live server on port 8787; the cached
  policy is now the only production path. A 40-way post-switch continuity burst was 40/40.
- Alias contract holds at wire level: `opus → claude-opus-5`, `sol → gpt-5.6-sol`,
  `gemini → gemini-3.7-flash`, `heretic → heretic:latest`. The live API lists 32 models:
  10 Anthropic, 8 OpenAI, 4 Google, 9 Ollama and jimmy.
- 37 global commands are installed in `~/.bun/bin`; `apiplan doctor` reports all clear.
- **271 tests green; 7 of 7 performance budgets met.** Release measurements: 24 ms
  client overhead, 3 ms dispatch+drain, 55 MB idle daemon.
- Text, images, speech, dictation, Gemini multimodal files/media, bounded video vision,
  tool-call round trips, credential rotation recovery, honest health verdicts and
  truncated-stream detection are all folded into this release.
- Making things stays explicit about billing: Codex image generation and OpenAI realtime
  TTS use the logged-in subscription; Gemini public vision/Veo/Lyria/TTS require the
  operator's Gemini API key and say so.

**Cross-platform state:** macOS is live-verified in this release. Linux, WSL and Windows
remain covered by the existing real-execution history and the GitHub Actions OS matrix;
the release must not be called published until the pushed v0.7.0 CI run is green and a
fresh installation from the published channel passes.

**Local API:** `apiplan serve` speaks OpenAI and Anthropic shapes on 127.0.0.1:8787.
`GET /health` is an evidence-based provider verdict rather than an always-green liveness
bit; after one real call on each credential it reports `ok: true` for all four families.
The current server PID owns the cached policy and has no stable/candidate switch.

## Layout

bin/ask.ts          CLI every model command executes
bin/apiplan.ts      status · models · commands · doctor · hotswap · serve · TUI
bin/vision.ts       ordered bounded-concurrency video frame analysis
src/registry.ts     aliases → live provider model ids
src/providers.ts    Anthropic/OpenAI/Google credentials, requests, deltas and media
src/providers-ollama.ts local model discovery and transport
src/engine.ts       argv · media · stream consumption · warm daemon
src/stream-shape.ts shared SSE/NDJSON framing and truncation detection
src/api.ts          OpenAI/Anthropic-shaped local server and evidence health
src/platform.ts     macOS · Linux · WSL · Windows differences
freeauth/           experimental ChatGPT OAuth bridge, included and tested
test/ bench/        271 tests and the seven-budget performance harness

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

1. Publish v0.7.0 only after version/docs tests, complete suite, perf gate and doctor pass.
2. Wait for ubuntu/macos/windows GitHub Actions to finish green on the release commit.
3. Install from `https://raw.githubusercontent.com/fire17/apiplan/main/install.sh` into a
   clean temporary HOME/PATH and exercise `apiplan`, `opus --dry-run`, models and doctor.
4. Stop the obsolete 8788 cache candidate after release cleanup; 8787 is the sole server.

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
