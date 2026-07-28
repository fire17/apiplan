# APIPlan

Call Anthropic's frontier models (Opus / Fable / Sonnet / Haiku) straight from
your terminal using your **signed-in Claude Code subscription** — no
per-token API key, no per-token billing. It's a one-shot API call that draws on
the same OAuth credential Claude Code already stores in your macOS Keychain.

```sh
opus "explain monads in one sentence"
cat server.log | sonnet "find the root cause" | pbcopy
echo '[{"role":"user","content":"hi"}]' | haiku --chat
fable -e xhigh --loop 3 "design a lock-free queue"
opus -i screenshot.png "what's wrong in this UI?"      # attach an image
opus -i clipboard "describe this"                       # paste from clipboard (macOS)
opus -i https://example.com/cat.jpg -i diagram.png "compare"   # repeatable; URL or file
```

Multimodal: `-i/--image <src>` (repeatable) accepts a **file · http(s) URL · `data:` URI · `-` (stdin) · `clipboard`/`paste`** (macOS clipboard image via `pngpaste`/AppleScript). Works in `--chat` too (attaches to the last user turn).

One core (`api.ts`, [bun](https://bun.sh)); four model commands are thin wrappers
around it. Pipeable in **and** out. Stateless → run hundreds in parallel.

## Install

```sh
bash install.sh            # → ~/.local/bin/{opus,fable,sonnet,haiku,api} + *-fast twins
# or into a dir already on PATH:  APIPLAN_BIN=~/.bun/bin bash install.sh
```

`opus-fast` / `fable-fast` / `sonnet-fast` / `haiku-fast` bake in `--effort low`
(thinking off, single-shot) for the quickest possible answer.

Requires `bun` and a logged-in `claude` (run `claude` once so the Keychain has a
token). The token is read live per call and refreshes itself whenever you use
`claude`.

## Two routes (the candidates — pick per call with `--route`)

| | **direct** (default) | **harness** |
|---|---|---|
| How | raw `POST /v1/messages` with the OAuth token | spawns `claude -p` |
| Speed | **blazing** — no process spin-up, ~network latency | slower — full harness boot each call |
| Parallelism | ideal — stateless HTTP, hundreds at once | heavier — one `claude` process per call |
| Chat completion | ✅ `--chat` (messages array) | ❌ (single prompt only) |
| System prompt | ✅ appended after the CC identity block | ✅ `--append-system-prompt` |
| Test-time compute | `--effort`→thinking budget, plus `--loop N` self-refine | `--effort` (harness agentic depth) |
| Tools / skills / MCP | ❌ pure completion | ✅ full Claude Code tool loop |
| Streaming | ✅ `--stream` (SSE) | ✅ `--stream` (stream-json) |

Rule of thumb: **direct** for fast one-shot/chat completions and parallel
fan-out; **harness** when you need tools, skills, or agentic depth.

Benchmark them yourself: `bun bench.ts --model haiku --n 5 [--parallel]`.

## Speed & the warm daemon

Per one-shot call the fixed cost is ~15ms (bun start) — the real latency is the
`security` keychain read, the fresh TLS handshake to the API, and model
time-to-first-token. Two things cut it:

- **Streaming.** `--stream` prints tokens as they arrive (the `-fast` commands
  stream by default) so you see output in a few hundred ms instead of waiting for
  the whole answer.
- **The warm daemon.** A tiny background process holds the **cached OAuth token**
  and a **kept-alive TLS connection**, so repeated calls skip the keychain read and
  the handshake (~150–350ms saved each). It **auto-starts on the first call** and
  every direct call transparently routes through it; if it can't start, calls fall
  back to running in-process. Manage it explicitly:

  ```sh
  api --daemon        # start in foreground (auto-exits after 30m idle)
  api --daemon-stop   # stop it
  opus --no-daemon …  # force one call in-process
  APIPLAN_DAEMON=off  # disable globally
  ```

  Skipped automatically for `--json`, `--loop>1`, and `--dry-run`. Socket:
  `~/.apiplan.sock` (mode 0600, override with `APIPLAN_SOCK`).

## Answers to the design questions

- **Can we set the system prompt / a virtual CLAUDE.md?** Yes. `--system "..."`
  or `--system-file path`. On the direct route your text is added as a second
  system block *after* the required Claude Code identity block (that identity
  line is mandatory for the subscription token — see risks). On the harness route
  it's passed as `--append-system-prompt`.
- **Effort / test-time compute?** `--effort low|medium|high|xhigh|max` maps to an
  extended-thinking token budget on the direct route (low = off). `--loop N`
  adds N self-refinement passes (direct) — a controllable compute horizon.
- **How much control?** Direct exposes the real Messages-API knobs: model,
  max_tokens, temperature, thinking budget, 1M-context beta, full message array.
  Harness exposes the whole Claude Code surface (tools, skills, agents).

## The contract (lifted from the `claude` binary, not guessed)

Direct route sends `POST https://api.anthropic.com/v1/messages?beta=true` with:
`authorization: Bearer <keychain oauth token>`, `anthropic-version: 2023-06-01`,
`anthropic-beta: oauth-2025-04-20`, `anthropic-client-platform: cli`, `x-app: cli`,
and system block 0 = `You are Claude Code, Anthropic's official CLI for Claude.`
Every one of these is overridable by env var (see `opus --help`) so a server-side
change can be patched without touching code.

## Risk register (pre-solved)

| Symptom | Cause | Fix |
|---|---|---|
| `token expired` | OAuth token past `expiresAt` | run `claude` once to refresh |
| `no credentials in Keychain` | never logged in / wrong service name | `claude` login; or set `APIPLAN_KEYCHAIN_SERVICE` |
| `auth rejected (403)` | identity/beta contract changed server-side | set `APIPLAN_IDENTITY` / `APIPLAN_OAUTH_BETA` to the new values |
| `rate limited (429)` | subscription cap | honor the printed retry-after; throttle parallel fan-out |
| newest model not resolving | alias→id map stale | use `--route harness` (claude resolves aliases) or pass a full id / `APIPLAN_ID_*` |
| daemon won't start | socket dir unwritable / another instance | calls fall back to in-process automatically; `api --daemon-stop` then retry, or `APIPLAN_DAEMON=off` |
| `bun not found` | bun missing | install from bun.sh |

## Notes

- This uses your subscription, so usage counts against your Claude plan's limits
  (not metered per-token). Be a good citizen with parallel fan-out.
- macOS only (Keychain). `APIPLAN_KEYCHAIN_SERVICE` + a token in that entry would
  port it elsewhere.
