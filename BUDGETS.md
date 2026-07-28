# BUDGETS

Every quality adjective in `VISION.md` translated into a number measured on the real
target, with the command that checks it. A regression here is a build failure, not a
ticket. Measured on: MacBook (darwin arm64), bun 1.3.14, home network.

| # | Vision adjective | Metric | Budget | Test |
|---|---|---|---|---|
| B1 | "blazingly fast" | client overhead — process start → request built, no network | **≤ 25 ms** | `bun bench/perf.ts --client` |
| B2 | "blazingly fast" | overhead the tool adds on a warm call, measured **inside** the client (dispatch + drain) | **≤ 60 ms** (measured 4 ms) | `bun bench/perf.ts --overhead` |
| B3 | "blazingly fast" | per-call credential read the daemon removes | observation only (12 ms) — it measures the OS, not this code | `bun bench/perf.ts --warm` |
| B4 | "no overhead on the machine" | idle daemon RSS | **≤ 80 MB** | `bun bench/perf.ts --mem` |
| B5 | "no overhead on the machine" | idle daemon CPU between calls | **≈ 0 %** (self-exits after 30 min idle) | `bun bench/perf.ts --mem` |
| B6 | "without any degredation" | every test green before any ship | **100 % pass** | `bun test` |
| B7 | "globally available cli" | configured commands resolving on PATH | **100 %** | `apiplan doctor` |
| B8 | "no `""` needed to send a sentence" | bare prompt containing `?` and `*` reaches the model unchanged | **works in zsh + bash** | `bun test test/shell.test.ts` |
| B9 | "good --help flags" | every command self-documents; help fits one screen | **≤ 48 lines, every flag listed** | `bun test test/help.test.ts` |
| B10 | "crossplatform completely" | platform layer resolves creds/IPC/shims for all 4 targets | **4/4 simulated + macOS live** | `bun test test/platform.test.ts` |
| B11 | "coherent system … claude + all openai" | both providers answer through one engine | **2/2 live** | `bun bench/perf.ts --providers` |
| B12 | "opus → opus 5, explicit versions too" | alias contract | **31/31** | `bun test test/registry.test.ts` |

## Degradation gate

Before any commit that touches `src/` or `bin/`:

```sh
bun test                 # B6, B8, B9, B10, B12
bun bench/perf.ts        # B1–B5, B11 — compares against bench/baseline.json
apiplan doctor           # B7
```

`bench/perf.ts` writes `bench/baseline.json` on first run and afterwards fails if a gated
number regresses by more than **10 %**.

**Only what we control is gated.** End-to-end comparisons (warm vs cold, warm vs a raw
`fetch`) and the credential-read timing are printed as `observe` rows and never fail the
build: the first two are dominated by ±0.7 s provider jitter, and the third measures how
fast the OS Keychain is — a faster Keychain would otherwise be scored as a regression.
Round 5 of `DARWIN.md` records the moment that distinction was forced (the same code
measured −362 ms and then +108 ms on consecutive runs).

**The gate must not be flaky.** Drift has to clear both a percentage band and an absolute
floor (5 ms / 8 MB), because 10 % of an 18 ms spawn measurement is inside normal noise; and
the two rows measuring *our own* deterministic work report the **floor** of N samples
rather than the median, since anything above the minimum is the OS scheduling around us.
Round 10b has the full reasoning.

## What is deliberately NOT budgeted

- **Absolute time-to-first-token.** It is dominated by network round-trip and the
  provider's own queue + prefill, neither of which this tool controls. Budgets B2/B3
  measure only the part we own. Round 1 of DARWIN.md records the measured floor
  (~1.6 s warm text, ~2.3 s with an image) as context, not as a target.
- **Answer quality.** Set by the model, not by this CLI.
