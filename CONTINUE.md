# APIPlan — continue here

**What it is.** A terminal CLI that calls Anthropic's frontier models
(Opus/Fable/Sonnet/Haiku) using the **signed-in Claude Code subscription** OAuth
token from the macOS Keychain — so calls draw on the plan, not a per-token API
key. One core (`api.ts`, bun); `opus`/`fable`/`sonnet`/`haiku` are thin wrapper
commands. Pipeable in and out; stateless → massively parallel.

**Why.** fire17 wanted a fast, one-shot "just like the API" call to the frontier
models on the subscription, with model aliases, effort/test-time-compute control,
settable system prompt, and multiple candidate routes to compare.

## Current state (honest)

- **Built + self-verified (in-sandbox):** help, arg parsing, prompt assembly
  (args + piped stdin), `--system`/`--system-file`, `--chat` message-array parse,
  `--effort`→thinking-budget mapping, `--loop` marker, temperature-vs-thinking
  rule, `--route harness` command build, error paths (bad effort, chat-on-harness),
  the installer, and generated wrappers (model baking + `-m` override + generic `api`).
  All confirmed via `--dry-run` (prints the exact request without sending).
- **NOT yet live-verified:** the actual network call. The build sandbox blocks
  both Keychain reads and `api.anthropic.com`, so no real request was fired here.
  The credential path + endpoint are **proven** by the FluidVoice dictation tool
  (`~/Creations/cactuspi/FluidVoice/tools/ccvoice/ccvoice.ts`), which uses the
  identical `security find-generic-password -s "Claude Code-credentials" -w` →
  `claudeAiOauth.accessToken` token against `api.anthropic.com`. The API contract
  (identity line, `anthropic-beta: oauth-2025-04-20`, endpoint, headers) was lifted
  **verbatim from the `claude` binary strings**, not guessed.
- **First real test the user must run:** `opus "say pong"` (direct route). If it
  returns text, the subscription→Messages-API path works end to end.

## How to resume

- `claude --resume 9d23ea6c-4fa0-4293-a3a7-34a7577c376f` from `~/Creations/APIPlan`
  (or read `conversation/9d23ea6c-…jsonl`).
- Files (canonical, in-registry): `api.ts`, `install.sh`, `bench.ts`, `README.md`.
- Install: `bash install.sh` → `~/.local/bin/{opus,fable,sonnet,haiku,api}`.

## Added after first save (2026-07-14)

- **`-fast` variants** (`opus-fast` etc.): bake `--effort low --thinking 0 --stream`
  → thinking off, tokens stream immediately. Lowest latency.
- **Warm daemon** (`api --daemon` / `--daemon-stop`): unix-socket background process
  (`~/.apiplan.sock`, 0600) caching the OAuth token + a kept-alive API connection.
  Auto-starts on first direct call, transparent in-process fallback, 30m idle-exit.
  Client-side fallback verified in-sandbox; the socket **server** is user-tested
  (sandbox blocks `listen`, same as it blocks the live API call). New code in
  `api.ts`: `buildDirect` (shared builder), `consumeSSE` (unified SSE parser),
  `runDaemon`/`ensureDaemon`/`tryDaemonCall`.

## Next steps

1. User installs + tests `opus "say pong"` (direct) and `--route harness`.
2. If direct 403s: the identity/beta contract shifted — adjust `APIPLAN_IDENTITY`
   / `APIPLAN_OAUTH_BETA` (both env-overridable); re-check binary strings.
3. Benchmark: `bun bench.ts --model haiku --n 5 [--parallel]` to compare routes.
4. Only after the user confirms it works: publish via `/shipit` (held now per the
   "nothing leaves the machine without confirmation" rule + user wants to test first).

## Key decisions

- **Two routes, one core.** `direct` (raw `/v1/messages`, fast, parallel, chat) is
  default; `harness` (`claude -p`, full tools/skills) for agentic depth. Chosen over
  a single approach because the user asked for candidates to compare.
- **Test-time compute** = `--effort`→thinking budget (both routes) + `--loop N`
  self-refine passes (direct). v2.1.209 has no `--max-turns`, so effort/thinking is
  the real knob.
- **System prompt / virtual CLAUDE.md** = supported. Direct: appended as a 2nd
  system block after the mandatory Claude Code identity block. Harness:
  `--append-system-prompt`.
