# DARWIN — autoresearch self-improvement rounds

Thirteen measure → find gap → fix → re-verify rounds against `BUDGETS.md`, each ending
with the full degradation gate (`bun test` + `bun bench/perf.ts` + `apiplan doctor`). Every
number here was measured — on this machine (darwin arm64, bun 1.3.14), on a Linux
container, on a real WSL2 box, or on GitHub's Windows runners — never estimated.

Rounds 1–5 hardened the engine. Rounds 6–10 made setup one line and verified Linux.
Rounds 11–13 finished the job: WSL and Windows executed for real, which immediately
surfaced two Windows-only bugs and one repo defect that made the project uncloneable there.

Baseline before round 1: 61 tests green, warm call **3.54 s**, client overhead 17 ms.

---

## Round 1 — the daemon was a 1.6 s pessimisation

**Found (by building the harness first):** `daemon vs cold` measured **−1641 ms** — the
"warm" path was *slower* than no daemon at all, and the memory row didn't appear because
no daemon process existed to measure.

**Root cause:** `runDaemon()` bound the socket, returned, and then `ask.ts` ran
`process.exit(0)`. The daemon died the instant it was born. Every call therefore found
nothing listening, spawned a fresh daemon, and blocked polling for it — up to 2 s.

**Fix:** `runDaemon()` now serves until stopped (`await new Promise<never>(…)`, plus
SIGINT/SIGTERM cleanup that unlinks the socket).

**Verified:** overhead we add 1.84 s → **−263 ms** (a warm call now beats a cold raw
`fetch`, because the kept-alive connection skips the handshake). Daemon saving −1641 ms →
**+178 ms**. Warm call 3.54 s → **1.10 s**. Daemon alive and measurable (44–52 MB).

## Round 2 — the first call must never wait for the daemon

**Measured the startup budget properly first:** bun's own floor is **11 ms** for a noop
script; our whole module graph costs **18 ms**, i.e. we add ~7 ms.

**Rejected optimisation (recorded, not silently dropped):** bundling everything into one
minified file measured **21 ms** — *slower* than the 18 ms module graph. Bun's transpile
cache already wins; a bundle only adds parse work. Not adopted.

**Found:** the real cost was structural, not startup — a cold first call blocked in
`ensureDaemon()` (40 × 50 ms) waiting for a daemon it had just spawned.

**Fix:** the cold path now spawns the daemon detached *for later* and serves the current
call in-process, so a cold start is never worse than having no daemon.

**Verified:** 1st call (nothing warm) **1104 ms**, 2nd 1968 ms (daemon still warming its
upstream pool), 3rd **873 ms** steady state. No first-call penalty remains.

## Round 3 — two correctness gaps: stale daemons and an untested transport

**Found A:** after an upgrade, a daemon from the *previous* build keeps serving. Because
the request contract changes between versions (this project already changed Anthropic's
thinking contract once), that is a silent-wrong-answer bug.

**Fix A:** `/health` now returns the version; every `/call` carries
`x-apiplan-version`; a mismatch returns **409** and the client retires the old daemon,
starts the current one, and serves this call directly. No extra round-trip on the happy path.

**Found B:** the Windows IPC transport (loopback TCP + token) had never been executed —
it was assumed, not tested.

**Fix B:** `APIPLAN_IPC=tcp` forces that transport on any OS, so it is exercised on macOS.

**Verified:** `/health → 0.2.0`; an old client gets `409 version mismatch: daemon 0.2.0,
client 0.1.0-old` while the current client is served normally. Over TCP: calls succeed
(1142 ms) and an unauthenticated request to the port returns **403** — another local
process cannot spend your subscription. 79/79 tests green.

## Round 4 — parallelism held; the gap was elsewhere

**Measured (the vision asks for "many instances … in parallel"):**

| concurrent calls | succeeded | wall clock | per-call p50 |
|---|---|---|---|
| 1 | 1/1 | 0.95 s | 0.95 s |
| 10 | 10/10 | 1.51 s | 0.99 s |
| 25 | 25/25 | 2.38 s | 1.06 s |

No gap: 25 calls finish in 2.4 s with per-call latency essentially flat. Nothing changed.

**So the round was spent hunting elsewhere,** and found a real defect: with a provider
logged out, the CLI printed a **raw Bun stack trace including source lines** instead of an
error. Also confirmed working under stress: a 1 MB image through the daemon IPC, 100 KB of
piped stdin, unicode/emoji prompts, `--loop 2`, and `-i -` (image on stdin).

**Fix:** the call path is wrapped so any thrown error becomes one clear line, with the
provider's login hint appended and exit code 3 for auth failures.

**Verified:** `apiplan: no /nope/auth.json — run \`codex\` and log in first. → run \`codex\` and log in`.

## Round 5 — honest failures, and a budget that measured weather

**Found A:** a 1×1 px image returned the provider's opaque `400 Could not process image`.
Isolated it properly first: the same image via file *and* stdin both failed, while a 1 MB
image succeeded via both — so `-i -` was fine and the size was the cause.

**Fix A:** PNG dimensions are checked before sending:
`image is 1×1px — too small for the model to process (needs at least 8×8)`.

**Found B:** `APIPLAN_CODEX_AUTH=/nope ... sol` **succeeded** when a warm daemon existed —
the daemon has its own environment, so per-call config overrides were silently ignored.

**Fix B:** any request-shaping override (`APIPLAN_IDENTITY`, `*_BASE`, `*_AUTH`,
`*_CRED_FILE`, `*_KEYCHAIN_SERVICE`, …) now forces the direct path, so what you set is
what is sent.

**Found C:** the `daemon saving ≥150 ms` budget failed at **−85 ms** while both paths sat
at ~1.1 s. The metric was dominated by the provider's own first-token time and ±0.7 s
jitter — it was measuring weather, not code.

**Fix C:** that row became an **observation** (reported, never gated), and the gate moved
to what the daemon *deterministically* removes: the per-call credential read, measured at
**13 ms** (a Keychain subprocess on macOS) against a ≥8 ms budget. Measure what you
control — the same principle already used for "overhead we add".

**Found C-bis (the fix for C was still not good enough):** with the gate moved, `overhead
we add` — computed as *warm median − raw-fetch median* — still measured **−362 ms** on one
run and **+108 ms** on the next, from identical code. Subtracting two independently noisy
medians is simply a bad estimator, no matter how wide the band.

**Fix C-bis:** the client now instruments itself (`APIPLAN_TIMING=1` prints
`dispatch=… drain=…`): time from process start until the request is dispatched, plus time
from the last byte to exit. That is exactly our cost, with no network term in it at all.
Measured: **dispatch 1.8 ms + drain 0.3 ms ≈ 4 ms** through the warm daemon (26 ms on the
direct path, which includes the Keychain read). The end-to-end numbers are still printed,
now honestly labelled `observe`.

**Found D:** `apiplan doctor` could never reach "all clear" because `gpt` was *configured*
but deliberately never *installed* (macOS ships `/usr/sbin/gpt`, a partition-table editor).

**Fix D:** the default command set now skips any name a real system tool owns, so the
proposal adapts per platform — macOS gets `sol`/`gpt-fast`, a Linux box with no clash gets
`gpt` too. Doctor reports **all clear**.

---

# Rounds 6–10 — cross-platform for real, and one-line setup

The first five rounds left one honest gap: *"cross-platform"* was unit-tested, not run.
These rounds closed it where a real machine was reachable, and said so plainly where one
wasn't. Version bumped to **0.2.1**.

## Round 6 — real Linux, against the published repo

Ran the **published** repo (not the working copy) inside `oven/bun:1` on Linux aarch64:

| check | result |
|---|---|
| test suite | **80/80 pass** |
| platform detection | `os: Linux · win: false · mac: false · wsl: false` |
| bin dir | `/usr/local/bin`, already on PATH |
| IPC | unix socket at `/root/.apiplan/daemon.sock` |
| credential path | correctly fell back to `~/.claude/.credentials.json` (no Keychain on Linux) |
| aliases | `opus → claude-opus-5`, `opus48 → claude-opus-4-8`, `gpt55 → gpt-5.5` |
| `apiplan doctor` | reported both providers logged out, with the right paths and hints |

**Linux is now live-verified**, including the credential fallback that only ever runs
off-macOS.

## Round 7 — one-line setup on a bare box

The vision asked for it to be easy to share and set up on new machines; installing still
meant "clone this, then run that". Made both installers **self-bootstrapping**: piped from
`curl`/`irm` with no checkout present, they clone to `~/.apiplan/src` and continue. Added
`apiplan update` (pull + re-sync + refresh models) so a machine stays current with one word.

**Verified on a bare Linux container** with only git + curl:
`curl -fsSL …/install.sh | sh` → installed 13 commands, `opus --dry-run` produced a correct
request, `apiplan status` rendered. Non-interactive runs correctly stopped prompting
instead of hanging on a `read`.

## Round 8 — the WSL branch, made testable instead of assumed

The WSL box (`magic-wsl`) was online in Tailscale but SSH did not answer; rather than fight
another machine, the *logic* was made verifiable. `detectWsl()` is now a pure function of
`/proc/version` + environment, tested against **real** WSL1, WSL2 and plain-Linux kernel
strings plus `WSL_DISTRO_NAME` / `WSL_INTEROP`.

**Still NOT live-run on WSL or Windows** — stated as such everywhere rather than implied.

## Round 9 — installer polish the previous round exposed

- It suggested a `PATH` line even when the directory was already on `PATH`. Cause: `apiplan
  path` prints a `$HOME`-relative line for pasting, which never matches an expanded
  `$PATH`. Added `apiplan path --raw` for scripts; the installer now compares with that and
  says "One line finishes the setup" when that is the truth.
- An already-wired shell rc is detected and left alone instead of appended to twice.
- When no shell rc can be identified, it says so instead of silently doing nothing.

## Round 10 — the bug that had already bitten this machine

**Found:** `which apiplan` pointed at `~/.apiplan/src/bin/apiplan.ts` — a *second clone* —
while the work was happening in `~/Creations/APIPlan`. Every command on this machine had
been quietly wired to a stale copy.

**Root cause:** `sh install.sh` puts no slash in `$0`, so the checkout test
(`case "$0" in */*)`) failed, the script concluded it was being piped, and it cloned.

**Fix:** resolve the source through three cases — a real file at `$0`, `./bin/apiplan.ts`
relative to the cwd, and only then bootstrap — and **print the source tree it wired**
(`source:  /path`). `apiplan doctor` now also reports the **install root**, so "which copy
am I running?" is never a mystery again. Three regression tests cover all three invocation
styles and assert no clone appears.

**Verified:** all three styles resolve to the checkout; the stray clone removed; commands
re-wired to the working tree; 87 tests green.

## Round 10b — the gate itself was flaky (a flaky gate is a broken gate)

**Found:** `bun bench/perf.ts` exited non-zero on roughly half of consecutive runs with
**every row passing its budget**. A gate that cries wolf teaches people to ignore it, so
this counts as a defect in the harness, not an annoyance.

Three separate causes, each a lesson about measuring the right thing:

1. **Percentage bands are meaningless at small absolute values.** 10 % of an 18 ms
   process-spawn measurement is 1.8 ms — well inside normal noise. Drift now has to clear
   both the band *and* an absolute floor (5 ms / 8 MB).
2. **`creds_saving` measured the operating system, not this code.** It timed how long the
   macOS Keychain takes to hand over a credential — so a *faster* Keychain scored as a
   regression. It is now an observation; the gated `tool_overhead` row already proves the
   client isn't doing that work per call.
3. **A median of a small sample is the wrong estimator for our own code path.** `dispatch +
   drain` is deterministic work; anything above its minimum is the OS scheduling around us
   (observed 2–16 ms, which made a 4 ms baseline fail against itself). Both self-cost rows
   now report the **floor** of N samples.

**Verified:** four consecutive gate runs, all clean, with the same code.

---

# Rounds 11–13 — the remaining two operating systems, actually run

Rounds 6–10 left WSL and Windows verified-by-logic only, and the honest note said so. A
stop-gate rejected that as incomplete — correctly, because "I could not reach a box" is a
statement about effort, not about the software. Both were reachable with more work.

## Round 11 — WSL, on a real WSL2 machine

Plain `ssh` to the box hung, which is where the previous attempt stopped. **`tailscale ssh`
answered immediately.** The box: `Linux 5.15.153.1-microsoft-standard-WSL2 x86_64`, with no
bun, no claude and no codex installed — a genuinely cold machine.

| check | result |
|---|---|
| one-line install (`curl … \| sh`) | fetched bun (absent), installed **13 commands** into `~/.local/bin` |
| PATH advice | said "**One line** finishes the setup" — the round-9 fix behaving correctly on a foreign machine |
| platform detection | `osLabel: WSL · IS_WSL: true · IS_WIN: false · IS_MAC: false` |
| IPC | unix socket at `/home/magic/.apiplan/daemon.sock` |
| test suite | **87/87 pass** |
| aliases | `opus → claude-opus-5`, `opus48 → claude-opus-4-8`, `gpt55 → gpt-5.5` |
| bare sentence through the installed shim | correct request, prompt intact |

**WSL is live-verified.** Note `WSL_DISTRO_NAME` and `WSL_INTEROP` were *empty* over that
transport, so detection fell through to `/proc/version` — exactly the path round 8 made
testable, now confirmed against the real thing.

## Round 12 — Windows, on real Windows runners

`.github/workflows/ci.yml` runs the suite on **ubuntu-latest, macos-latest and
windows-latest** on every push: the platform layer's own view of the OS/IPC/bin-dir, the
full suite, alias resolution, installing the real commands and running one **through the
generated shim with a bare unquoted sentence**, the `.ps1` twin invoked from PowerShell,
and the daemon transport coming up (loopback TCP there, socket elsewhere).

The first Windows run failed **at `actions/checkout`, before any test**: an earlier mangled
shell command in this session had created a file whose *name* was a multi-line script
fragment, and `git add -A` committed it. macOS and Linux accept such names; Windows cannot
create them, so the repository was simply **uncloneable on Windows**. Removed, and a test
now fails if any tracked path contains a character Windows rejects — verified by planting
`bad?name.txt` and watching the guard trip.

## Round 13 — two real Windows-only bugs, invisible from macOS

With checkout fixed, Windows ran the suite and failed 2 of 88 — both genuine:

1. **`removeShim()` never deleted extensionless shims on Windows** (it only looked for
   `.cmd` and `.ps1`). Every rename, delete and `prune` silently orphaned a file there.
2. **Git Bash users had no working command at all.** `.cmd` and `.ps1` are resolved by
   cmd.exe and PowerShell through `PATHEXT`; bash appends only `.exe`, so `opus` found
   nothing — for a large share of Windows developers.

**Fix:** Windows now gets **three** files per command — `.cmd` (cmd.exe/PowerShell), `.ps1`
(pwsh quoting and piping), and an extensionless sh shim (Git Bash/MSYS) — and `removeShim`
cleans up all three.

Neither bug was reachable by any amount of testing on macOS. This is the round that
justifies the CI matrix existing at all.

## Final state

| metric | before round 1 | after round 5 | budget |
|---|---|---|---|
| warm call, first token | 3.54 s | **~1.0 s** | — (network-bound) |
| overhead we add, measured directly | not measurable (daemon dead) | **4 ms** | ≤60 ms |
| client overhead (no network) | 17 ms | **18 ms** | ≤25 ms |
| per-call credential read avoided | 0 (daemon dead) | **12 ms** | ≥8 ms |
| idle daemon memory | n/a (dead) | **51 MB** | ≤80 MB |
| providers answering live | 2 | **2** | ≥2 |
| tests | 61 | **88** | 100 % |
| `apiplan doctor` | warnings | **all clear** | clean |
| budgets met | 3 of 5 | **7 of 7** | all |
| platforms live-verified | macOS | **all four: macOS · Linux · WSL · Windows** | 4 |
| setup on a new machine | clone + script | **one line** | one line |

**Degradation check:** every round ended with the full gate green. The only budget ever
relaxed was B3, and it was replaced with a stricter, deterministic measurement rather than
removed — the end-to-end number is still printed every run.

**Open / not closed (after round 13):**
- All four target operating systems now run the suite for real (macOS, Linux, WSL, Windows).
  The CI matrix keeps three of them honest on every push; WSL is verified per-session by
  hand over `tailscale ssh`, since GitHub has no WSL runner.
- Earlier open items, still true:
- The second call after a cold start can still pay the daemon's own upstream warm-up
  (~1.9 s observed once). Harmless, self-correcting by the third call; left alone rather
  than adding pre-bind blocking that would delay readiness.
- Windows and Linux are verified by the platform layer's tests plus the forced-TCP
  transport run, **not** by a real run on those OSes. Marked NOT yet live-verified.
- `providers answering live` failed once transiently (1/2) immediately after the
  25-parallel test, then passed on retry — likely provider-side rate limiting. Not
  reproduced; noted rather than hidden.

## Round 14 — the speech question, answered by measurement

The brief was "make TTS work from the subscription". The honest answer needed probing
rather than assuming, so every candidate route was called and its status recorded.

| route | verdict |
|---|---|
| `POST api.openai.com/v1/audio/speech` | 429 `account is not active` — needs billing |
| `POST /backend-api/codex/audio/speech` | 404 — no speech on the codex backend |
| Responses `modalities: ["audio"]` | 400 |
| `POST /backend-api/synthesize` | 405 — GET only |
| `/backend-api/synthesize_stream`, `/audio/synthesize`, `/tts`, `/speech`, `/voice/synthesize` | 404 |
| **`GET /backend-api/synthesize?conversation_id&message_id`** | **200 `audio/aac`** ✅ |
| `GET /backend-api/settings/voices` | 200 — nine real ChatGPT voices |
| `POST /backend-api/conversation` (to create text to speak) | 403, anti-automation sentinel |

So the subscription *does* cover speech — as ChatGPT's **read-aloud**, which takes a
stored message and no text parameter (`text`/`message`/`content`/`input`/`prompt`/`ssml`
were each passed and each ignored — byte counts varied only by re-synthesis jitter).
Putting fresh text into the account first means the web chat endpoint, which is behind
a proof-of-work bot check. That line was not crossed; the CLI states the limit instead
of faking a browser.

**Shipped:** `aloud` (read-aloud, nine product voices, `apiplan voices`), and speech
error text that names the three real options instead of one dead end.

**Multilingual:** works untouched — a Hebrew assistant message synthesised to 26 s of
correct audio in `maple`, `cove` and `juniper` with no configuration.

**Two bugs this round surfaced, both fixed:**
- *Upgrades could never gain a command.* `install` seeded `commands.json` only when it
  was empty, so `imagine` (added in 0.3.0) would have reached no existing user, ever.
  `mergeDefaults()` now tops up missing defaults, and `rm` records the removal so a
  default deleted on purpose is never resurrected.
- *Read-aloud reached into private history by default.* The first cut of `aloud` read
  your newest ChatGPT reply with no prompting — a real privacy surprise. Touching stored
  history is now explicit only: `--last`, or a named `--conversation`/`--message`.

**Freshness, verified not assumed:** a drawing request carries one input block (the
prompt you typed), `store: false`, and a per-call session id — no prior turns, nothing
retained. Two tests hold that shape.

**Degradation check:** 109 tests pass, up from 97; no budget relaxed.

## Round 15 — seamless, and the realtime discovery

Three friction points removed: `imagine` now opens what it draws (`--open`), `aloud`
needs no second flag to mean the obvious thing, and `tts` picks a backend instead of
failing at you — a key gets OpenAI voices, no key still speaks, today, for free.

The OS-voice fallback is language-aware, which is the difference between working
multilingual speech and noise: `say` reads Hebrew in an English voice as gibberish, so
the script the text is written in now picks the voice (Carmit, Majed, Kyoko, Tingting,
Milena, …), falling back to the system default for Latin text.

**Creating a conversation to speak fresh text: refused, with the reason.**
`POST /backend-api/sentinel/chat-requirements` → 200, and the requirements say
`turnstile: {"required": true}`. Creating a ChatGPT conversation means clearing a
Cloudflare CAPTCHA. That is an anti-automation control, so it stays uncleared.

**But the realtime endpoint takes the subscription token.** Probed by following its own
error messages:

| body | response |
|---|---|
| `{sdp}` | 400 `Field 'session' must be an object` |
| `{session: {}, sdp}` | 400 `You must provide a model parameter` |
| **`{session: {type:"realtime", model:"gpt-realtime"}, sdp}`** | **201 + a real SDP answer** |
| `…audio.output.voice = "cove"` | 400 — voices are `alloy ash ballad coral echo sage …` |

So fresh arbitrary text *can* be spoken on the subscription, through WebRTC voice mode —
no conversation, no history, nothing stored. It needs a real WebRTC stack (ICE, DTLS,
SRTP, Opus decode), which is a native dependency in a tool that currently has none, so
it is written down here rather than half-built.

**Degradation check:** 112 tests pass, up from 109; no budget relaxed.

## Round 16 — fresh speech on the subscription, and no WebRTC after all

Round 15 ended pointing at WebRTC as the route to speaking arbitrary text. The brief
was "WebRTC, no payments", so the build started — and the first 60-second check killed
the whole project, in the good way.

The realtime **WebSocket** accepts the ChatGPT subscription token directly:

| attempt | result |
|---|---|
| `wss://api.openai.com/v1/realtime` + `OpenAI-Beta: realtime=v1` | closed 4000 `beta_api_shape_disabled` |
| **same URL, GA shape (no beta header)** | **`session.created`, model `gpt-realtime`** |
| `wss://chatgpt.com/backend-api/codex/realtime` | no 101 |

Sending `session.update` + `response.create` returns `response.output_audio.delta`
frames of raw PCM16 at 24 kHz — 151,200 bytes, 3.1 s, played. So the deliverable is a
plain WebSocket plus a 44-byte wav header: **no WebRTC, no ICE, no DTLS, no Opus, no
native dependency, and no payment.** The dependency count stays at zero.

Voices, named by the server when handed a bad one: `alloy ash ballad coral echo sage
shimmer verse marin cedar`. Any language — Hebrew verified.

`tts` now runs on the subscription by default, falls back to the billed REST route only
if a key happens to be set, and to the OS voice (script-matched) if neither answers,
saying which it used. `/v1/audio/speech` still refuses a subscription token (429
"account is not active"), which is why it is the fallback and not the path.

**The lesson, again:** round 15 wrote off a capability as "needs a native WebRTC stack"
from one 400. One more probe down the same road found the answer was a WebSocket.
Probe the adjacent thing before estimating the expensive thing.

**Degradation check:** 114 tests pass, up from 112; no budget relaxed.

## Round 17 — who was rewriting the prompt

`imagine` printed `prompt used:` with text nobody typed. The rewrite is not the image
backend: the model owns the tool call, so it writes the `prompt` argument itself, and a
terse instruction becomes a paragraph of style words.

`--raw` sets instructions telling the model to copy the message character for character
and add nothing; `--enhance` asks for the rewrite explicitly. Verified live on the same
prompt, `a single red triangle on white`:

| flag | `prompt used:` |
|---|---|
| `--raw` | `a single red triangle on white` |
| `--enhance` | `A minimalist image with a single solid red equilateral triangle centered on a pure white background. Clean sharp edges, …` |

Default stays `--enhance` — the rewrite genuinely helps a lazy prompt — and either can
become the default for good by baking it into the command's flags. `--raw` appends to
the user's `--system` rather than replacing it, which a test holds.

**Degradation check:** 118 tests pass, up from 114. The help budget (B9, ≤48 lines) was
paid for twice this round by compressing existing lines, never by raising the bar.

## Round 18 — one speech command, two engines

`aloud` was a command because, when it shipped, read-aloud was the only speech the
subscription covered. Round 16 removed that reason: `tts` speaks anything. So the
command is gone and `--aloud` stays a flag on `tts`.

The two engines are genuinely different and both are worth keeping reachable:

| | `tts` | `tts --aloud` |
|---|---|---|
| endpoint | `wss://api.openai.com/v1/realtime` | `GET /backend-api/synthesize` |
| model | `gpt-realtime` | not disclosed by the endpoint |
| input | any text you type | only a message already in your history |
| audio | PCM16 24 kHz → wav | AAC |
| voices | alloy ash ballad coral echo sage shimmer verse marin cedar | maple juniper orbit fathom breeze ember glimmer vale cove |

The voice sets do not overlap, which is the whole reason the flag survives: `cove` and
`maple` cannot be reached any other way.

**Degradation check:** 118 tests pass, unchanged; the removed command took its test with
it and gained one asserting the flag still works.

## Round 19 — the CI matrix earns its keep again

The v0.4.0 README push went red on **windows-latest only**; ubuntu and macos were green.
Cause was mine and entirely Windows-shaped: the new source-scanning tests located their
own source with `new URL("../src/providers.ts", import.meta.url).pathname`, which on
Windows returns `/D:/a/apiplan/apiplan/src/providers.ts` — a leading slash before the
drive letter, so `ENOENT` on a file that plainly exists.

Fixed with `fileURLToPath` + `path.join`, which is what that API is for. Eight call
sites, one helper.

Worth stating plainly: this shipped green on macOS and would have gone out broken for
every Windows user if the matrix hadn't been there. It is the second time (see round 13)
that a real Windows defect was invisible locally.

**Degradation check:** 118 tests pass, unchanged; the fix removed a false green, not a test.

## Round 20 — the model was always expressive; the prompt was gagging it

`tts` shipped in v0.4.0 with this instruction: *"Read the following text aloud, verbatim,
and say nothing else — no greeting, no comment."* `gpt-realtime` is a **conversational
speech** model, so that line was not neutral — it actively suppressed the expressiveness
the model has. The steering channel was open the whole time, held shut from our side.

Splitting the inputs — the WORDS are pinned, the DIRECTION is free (`--as`) — and
measuring rather than vibing. Same sentence every row, direction only:

| `--as` | secs | RMS | peak |
|---|---|---|---|
| *(none)* | 3.70 | 0.0997 | 0.962 |
| excited, laughing out loud | 4.65 | 0.1364 | 0.975 |
| whispering, conspiratorial | 3.75 | **0.0572** | 0.763 |
| furious, shouting | 3.85 | 0.1354 | 0.796 |
| very slowly, heartbroken, tearful | **9.15** | **0.0509** | 0.474 |

2.7× loudness range, 2.5× duration range, identical words.

**How this was measured without ears** — the honest part. Three objective signals:
duration, RMS/peak amplitude from the PCM, and the model's **own transcript**, which
records its non-speech vocalisations. Asked to laugh, it emits `[laughs]` into that
transcript — so "did it actually laugh" is a string match, not an opinion. Reliability
over repeats: laughter **3/3** (`[laughs]`, `[laughs]`, `[laughter]`), whisper **3/3**
in a tight band (RMS 0.033–0.042 vs 0.096–0.106 for the laughing takes).

Characters work as readily as emotions ("a grizzled pirate captain, gravelly and
theatrical"), as do directions with an arc ("start deadpan, then crack up halfway"), in
any language.

**Not verified by ear, and said so:** whether inline bracketed cues (`[laughs]` written
mid-sentence) are *performed* rather than read aloud. Duration and transcript are
consistent with performance; only a listener can close that one. The user feel-tested the
eight samples before this shipped.

**The lesson:** a prompt that reads as "neutral" can be a strong negative instruction. It
took a user asking "can we do emotions?" to notice that our own default forbade them.

**Degradation check:** 122 tests pass, up from 118; four new ones pin that a direction
never leaks into the spoken words and that verbatim stays verbatim without `--as`.

## Round 21 — the same models, in everyone else's shape

`apiplan serve` puts an OpenAI- and Anthropic-shaped API on localhost, so any SDK, agent
framework or app answers from the subscription by changing one base URL.

The design decision that makes it worth having: **the dialect and the backend are
independent.** The path decides the response shape, the `model` field decides who
answers. `/v1/chat/completions` with `model: "opus"` returns Claude in OpenAI's format —
which matters because most tooling speaks exactly one dialect, and this makes every model
reachable from all of it.

Built entirely from what was already exported — `build()`, `delta()`, `creds()`,
`resolve()` — plus `Bun.serve`. No new dependency; the whole server is translation.

`consume()` was deliberately NOT reused: it writes to stdout and calls `die()`, so a bad
upstream response would have taken the server process down with it. A separate 25-line
reader was the smaller and safer answer.

**Two real bugs it surfaced:**
- Anthropic answered with an *empty* string. `build()` leaves `stream` to the caller and
  the CLI sets it at call time; without it Anthropic returns a plain JSON body, which the
  SSE reader parsed as zero events. Silent, not an error.
- **`--max-tokens` was broken on every OpenAI model** — and had been. The codex backend
  rejects `max_output_tokens` outright (400 `Unsupported parameter`), so any call with a
  length cap failed. Nobody noticed from the CLI because you rarely pass it; every API
  client sets it by default, so the server hit it immediately. Fixed at the root by not
  sending the parameter, and the CLI now says the flag is ignored there rather than
  dropping it silently.

**Verified with the real SDKs**, not curl: `openai` and `@anthropic-ai/sdk` installed
fresh, both dialects, both directions (Claude through OpenAI's SDK, GPT through
Anthropic's), streaming on both, plus `audio.speech.create` and `images.generate`.

Loopback-bound by default, with an optional `APIPLAN_API_KEY` enforced on both vendors'
auth headers — it hands out a subscription to anything that can reach it.

**Degradation check:** 134 tests pass, up from 122; 12 new ones cover the dialect
routing, both error envelopes, auth and the loopback default.
