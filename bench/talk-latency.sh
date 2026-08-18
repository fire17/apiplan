#!/usr/bin/env bash
# talk-latency.sh — honest A/B of `apiplan talk` first-audio latency:
#   cold  = the direct path (a fresh realtime WebSocket per call, --direct)
#   warm  = the daemon path (a pre-opened, pre-`session.update`d socket handed over)
#
# How the number is obtained (no new instrumentation): this script stamps LX_T0_MS with
# epoch-ms immediately before exec, and src/talk.ts emits `first word in <N>ms` as an info
# event when the first audio delta lands (talk.ts:286-288). N is therefore
# launch → first audio — the interval a human actually feels — and it is measured by the
# product code, not by this harness second-guessing it.
#
# Honest by construction: a sample with no `first word in` line prints `NO AUDIO` and is
# EXCLUDED from the statistics. Recording it as 0 would make a build that never speaks look
# infinitely fast, which is the exact lie a latency harness exists to prevent.
#
# Usage: bench/talk-latency.sh [--mode cold|warm|both] [-n 5] [--installed] [--help]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="both"
N=5
GAP=3
TIMEOUT=30
INSTALLED=0
# One short FIXED sentence for every sample. The greeting text is part of the measurement:
# a longer prompt means more tokens before the first audio delta, so changing it between
# runs silently changes the number being compared.
GREET="Say the word ready."
VOICE=""

usage() {
  cat <<'USAGE'
talk-latency.sh — measure first-audio latency of `apiplan talk`, cold vs warm.

  --mode cold|warm|both   which path to measure          (default: both)
  -n, --samples N         repetitions per mode           (default: 5)
  --gap SECONDS           pause between samples, min 3   (default: 3)
  --timeout SECONDS       give up on one sample after    (default: 30)
  --greet TEXT            the fixed greeting spoken      (default: "Say the word ready.")
  --voice NAME            pass --voice to talk           (default: talk's own default)
  --installed             measure the `apiplan` on PATH instead of this working tree
  -h, --help              this text

Output: every sample, then min/median/mean per mode, then the warm-vs-cold delta.
Per-sample stdout + the JSONL sidecar are kept under /tmp so a failed sample is diagnosable.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    -n|--samples) N="${2:?-n needs a value}"; shift 2 ;;
    --gap) GAP="${2:?--gap needs a value}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
    --greet) GREET="${2:?--greet needs a value}"; shift 2 ;;
    --voice) VOICE="${2:?--voice needs a value}"; shift 2 ;;
    --installed) INSTALLED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$MODE" in cold|warm|both) ;; *) echo "--mode must be cold, warm or both" >&2; exit 2 ;; esac
# The realtime endpoint rate-limits rapid reconnects, and a throttled connect spends its
# backoff INSIDE the measured window — the sample then reports the throttle, not the code.
# VOICE_UPGRADE_PLAN.md records exactly that flakiness under heavy testing, so 3s is a
# floor here, not a suggestion.
[ "$GAP" -lt 3 ] && GAP=3

if [ "$INSTALLED" = 1 ]; then
  command -v apiplan >/dev/null || { echo "no \`apiplan\` on PATH (drop --installed to measure the working tree)" >&2; exit 1; }
  RUN=(apiplan)
else
  command -v bun >/dev/null || { echo "bun not found" >&2; exit 1; }
  RUN=(bun "$ROOT/bin/apiplan.ts")
fi

# BSD date has no %N, so epoch-ms needs a helper. perl ships with macOS; bun is the
# fallback. Either way the value is read AFTER the helper exits, so its startup cost lands
# before t0 and is never charged to the measurement.
if perl -MTime::HiRes -e '1' >/dev/null 2>&1; then
  now_ms() { perl -MTime::HiRes=time -e 'printf "%.0f", time()*1000'; }
elif command -v bun >/dev/null; then
  now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }
else
  echo "need perl or bun for millisecond timestamps" >&2; exit 1
fi

# SURGICAL cleanup only. NEVER `pkill ffmpeg`: this machine runs unrelated projects whose
# ffmpeg jobs would die with it. `pkill -x ffplay` matches only the exact playback binary,
# and `pkill -f avfoundation` only mic captures (that flag appears in no other argv here).
# A leftover player keeps the audio device open and the next sample measures a stall
# instead of a connect. Do not "fix" this into a broader pattern.
cleanup_between() {
  pkill -x ffplay 2>/dev/null || true
  pkill -f avfoundation 2>/dev/null || true
}

STATE_DIR="${APIPLAN_HOME:-$HOME/.apiplan}"
SOCK="$STATE_DIR/daemon.sock"
DAEMON_LOG="/tmp/apiplan-talk-latency-$$-daemon.log"

# Warm samples must not pay for daemon startup — that cost belongs to the first call ever,
# not to steady state. Start it if absent, then give the park a moment to arm (armPark is
# non-blocking, so a socket file existing does not yet mean a parked realtime socket).
ensure_daemon() {
  if [ ! -S "$SOCK" ]; then
    echo "  starting daemon (log: $DAEMON_LOG)"
    "${RUN[@]}" daemon >"$DAEMON_LOG" 2>&1 &
    for _ in $(seq 1 100); do [ -S "$SOCK" ] && break; sleep 0.1; done
  fi
  [ -S "$SOCK" ] || { echo "  daemon did not come up — see $DAEMON_LOG" >&2; return 1; }
  sleep 2
}

# Run one call and echo the reported first-audio ms, or nothing when no audio arrived.
# The process is stopped as soon as the number appears: everything after first audio is
# conversation, and waiting for a hangup that needs a live mic would hang the harness.
sample() {
  local mode="$1" i="$2"
  local out="/tmp/apiplan-talk-latency-$$-$mode-$i.out"
  local log="/tmp/apiplan-talk-latency-$$-$mode-$i.jsonl"
  local extra=() ms="" waited=0
  [ "$mode" = cold ] && extra+=(--direct)
  [ -n "$VOICE" ] && extra+=(--voice "$VOICE")

  if [ "$mode" = cold ]; then export APIPLAN_DAEMON=off; else unset APIPLAN_DAEMON || true; fi
  export APIPLAN_TALK_LOG="$log"
  export LX_T0_MS="$(now_ms)"
  # ${extra[@]+…} because macOS ships bash 3.2, where expanding an EMPTY array under
  # `set -u` is an unbound-variable error — the harness would die before it measured anything.
  "${RUN[@]}" talk --greet "$GREET" ${extra[@]+"${extra[@]}"} >"$out" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    ms="$(grep -Eo 'first word in [0-9]+ms' "$out" 2>/dev/null | head -1 | grep -Eo '[0-9]+' | head -1 || true)"
    [ -n "$ms" ] && break
    [ "$waited" -ge $((TIMEOUT * 20)) ] && break
    waited=$((waited + 1))
    sleep 0.05
  done
  # SIGINT, not SIGKILL: talk.ts installs an idempotent close() on SIGINT/SIGTERM that
  # reaps the player and the mic. SIGKILL would skip it and leak the audio device into the
  # next sample.
  kill -INT "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  [ -n "$ms" ] || ms="$(grep -Eo 'first word in [0-9]+ms' "$out" 2>/dev/null | head -1 | grep -Eo '[0-9]+' | head -1 || true)"
  printf '%s' "$ms"
}

# min / median / mean / n from numbers on stdin. awk + sort only: no python, no jq — this
# harness must run on a machine with nothing installed but the project's own toolchain.
stats() {
  sort -n | awk '
    { v[NR] = $1 }
    END {
      if (NR == 0) { print "- - - 0"; exit }
      s = 0; for (i = 1; i <= NR; i++) s += v[i];
      m = (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2;
      printf "%d %.0f %.0f %d\n", v[1], m, s / NR, NR
    }'
}

# Prints the human-readable block for one mode and leaves its median in MEDIAN (empty when
# the mode produced no usable sample). A global, not stdout: capturing the function in
# $(...) would swallow the per-sample lines this harness exists to show.
run_mode() {
  local mode="$1" i ms line
  MEDIAN=""
  samples=()
  echo
  echo "── $mode ── ($N samples, ${GAP}s apart)"
  if [ "$mode" = warm ]; then ensure_daemon || return 0; fi
  for i in $(seq 1 "$N"); do
    cleanup_between
    ms="$(sample "$mode" "$i")"
    if [ -n "$ms" ]; then
      printf '  sample %d: %sms\n' "$i" "$ms"
      samples[${#samples[@]}]="$ms"
    else
      printf '  sample %d: NO AUDIO (see /tmp/apiplan-talk-latency-%s-%s-%d.out)\n' "$i" "$$" "$mode" "$i"
    fi
    if [ "$i" -lt "$N" ]; then sleep "$GAP"; fi
  done
  cleanup_between
  if [ "${#samples[@]}" -eq 0 ]; then
    echo "  no usable samples — every run failed to produce audio (nothing recorded as 0)"
    return 0
  fi
  line="$(printf '%s\n' ${samples[@]+"${samples[@]}"} | stats)"
  set -- $line
  printf '  min %sms · median %sms · mean %sms · n=%s of %s\n' "$1" "$2" "$3" "$4" "$N"
  MEDIAN="$2"
}

echo "apiplan talk latency — mode=$MODE n=$N greet=\"$GREET\" runner=${RUN[*]}"
COLD_MED=""; WARM_MED=""
if [ "$MODE" = cold ] || [ "$MODE" = both ]; then run_mode cold; COLD_MED="$MEDIAN"; fi
if [ "$MODE" = warm ] || [ "$MODE" = both ]; then run_mode warm; WARM_MED="$MEDIAN"; fi

# The delta is the whole point, so print it only when BOTH medians are real. A one-sided
# run stops at its own block rather than implying a comparison it does not have.
if [ -n "$COLD_MED" ] && [ -n "$WARM_MED" ]; then
  echo
  awk -v c="$COLD_MED" -v w="$WARM_MED" 'BEGIN {
    printf "── delta ──\n  warm median %dms vs cold %dms — %dms faster (%.0f%% of cold)\n", w, c, c - w, 100 * w / c
  }'
fi
