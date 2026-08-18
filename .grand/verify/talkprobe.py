#!/usr/bin/env python3
"""talkprobe — reusable live verification harness for `apiplan talk`.

Lane D (rev-verify). Read-only w.r.t. source: it only LAUNCHES the CLI and reads the
Phase-0 sidecar JSONL log. Nothing here edits src/.

  run       one trial: launch `apiplan talk --greet --log <sidecar>`, wait for
            response.done, extract first-word latency, confirm no error/abort, clean up.
  compare   N trials across one or more variants (cold CLI vs daemon parked socket),
            printing a median/p90 table — the Lane B before/after instrument.

Cleanup is deliberately narrow: `pkill -x ffplay` and `pkill -f avfoundation` ONLY.
NEVER a broad `pkill ffmpeg` — that kills unrelated projects on this machine (AirSec).

Usage:
  python3 talkprobe.py run [--label cold] [--timeout 25] [-- <extra apiplan talk flags>]
  python3 talkprobe.py compare --trials 5 --variant cold --variant daemon
  python3 talkprobe.py replay <sidecar.jsonl>        # parse an existing log, no launch
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # .../APIPlan
ENTRY = ROOT / "bin" / "apiplan.ts"
OUTDIR = Path(__file__).resolve().parent / "runs"

# Variants: how a trial is launched. `cold` is today's path; `daemon` is Lane B's
# parked-socket path and is expected to exist only once Phase 2 lands.
# Matches Lane B's actual flag contract (bench/talk-latency.sh, src/talk-daemon.ts:499):
# `--direct` forces a fresh WebSocket; the bare path goes through the daemon's parked socket.
VARIANTS = {
    "cold":   {"argv": ["talk", "--greet", "Say the word ready.", "--direct"],
               "desc": "cold — fresh WS per call (--direct)"},
    "daemon": {"argv": ["talk", "--greet", "Say the word ready."],
               "desc": "warm — daemon's parked, pre-session.update'd socket"},
}


# ───────────────────────────── sidecar parsing ─────────────────────────────

def parse_sidecar(path: Path) -> dict:
    """Turn the Phase-0 JSONL event log into a verdict dict. Pure; no side effects."""
    lines = []
    if path.exists():
        for raw in path.read_text(errors="replace").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                lines.append(json.loads(raw))
            except json.JSONDecodeError:
                lines.append({"_unparsed": raw})

    ws = [l for l in lines if "ws" in l]
    info = [l.get("text", "") for l in lines if l.get("ev") == "info"]
    ws_types = [l["ws"] for l in ws]
    t0 = lines[0]["t"] if lines and "t" in lines[0] else None

    def first_t(kind: str):
        for l in ws:
            if l["ws"] == kind:
                return l.get("t")
        return None

    # `first word in Nms` is stamped by talk.ts against LX_T0_MS, i.e. from process launch.
    first_word_ms = None
    for txt in info:
        if txt.startswith("first word in ") and txt.endswith("ms"):
            try:
                first_word_ms = int(txt[len("first word in "):-2])
            except ValueError:
                pass

    errors = [l.get("error") for l in ws if l["ws"] == "error"]
    errors += [t for t in info if t.startswith("error: ")]

    created, updated, done = first_t("session.created"), first_t("session.updated"), first_t("response.done")

    # An abort is: the response never completed, or the socket closed before response.done.
    closed_txt = next((t for t in info if t.startswith("socket closed")), None)
    aborted = ("response.created" in ws_types) and ("response.done" not in ws_types)

    return {
        "events": len(lines),
        "ws_types": ws_types,
        "first_word_ms": first_word_ms,
        "t_session_created_ms": (created - t0) if (created and t0) else None,
        "t_session_updated_ms": (updated - t0) if (updated and t0) else None,
        "t_response_done_ms": (done - t0) if (done and t0) else None,
        "spoke": any(t.endswith("audio_transcript.done") for t in ws_types),
        "response_done": "response.done" in ws_types,
        "aborted_mid_response": aborted,
        "errors": [e for e in errors if e],
        "connect_timeout": any("connect timed out" in t for t in info),
        # ws.onerror fires within ~200ms when the host is unreachable (firewall / sandbox
        # network allow-list / DNS) — that is NOT a latency result, so say so explicitly.
        "network_unreachable": any("connection failed" in t for t in info),
        "mic_died": any("microphone" in t for t in info),
        "player_died": any("audio player" in t for t in info),
        "socket_closed": closed_txt,
        "info": info,
        # Leak tripwires: the sidecar must never carry the bearer token or raw audio.
        "leaked_token": any("Bearer " in json.dumps(l) or "sk-" in json.dumps(l) for l in lines),
        "leaked_audio": any("delta" in json.dumps(l) for l in lines),
    }


def verdict(r: dict) -> tuple[bool, list[str]]:
    """PASS/FAIL plus the reasons. A trial passes only if it spoke and completed clean."""
    bad = []
    if r["network_unreachable"]:
        bad.append("could not reach wss://api.openai.com — network blocked (sandbox allow-list / firewall / DNS). "
                   "NOT a latency result; re-run outside the sandbox.")
    if r["connect_timeout"]:
        bad.append("connect timed out (network stall or realtime-session rate limit)")
    if r["aborted_mid_response"]:
        bad.append("response ABORTED mid-flight (no response.done) — the reversed-finding trap")
    if not r["response_done"]:
        bad.append("no response.done")
    if not r["spoke"]:
        bad.append("no audio transcript — nothing was spoken")
    if r["errors"]:
        bad.append(f"server/client errors: {r['errors']}")
    if r["player_died"]:
        bad.append("ffplay death reported (check the -autoexit-on-empty-pipe trap)")
    if r["leaked_token"]:
        bad.append("SECURITY: bearer token or key-shaped string in the sidecar log")
    if r["leaked_audio"]:
        bad.append("SECURITY/size: audio delta bytes in the sidecar log")
    if r["first_word_ms"] is None:
        bad.append("no first-word latency stamp (LX_T0_MS unset, or no audio arrived)")
    return (not bad), bad


# ───────────────────────────── launching ─────────────────────────────

def cleanup():
    """Narrow, project-scoped. NEVER `pkill ffmpeg` — other projects use it."""
    for cmd in (["pkill", "-x", "ffplay"], ["pkill", "-f", "avfoundation"]):
        try:
            subprocess.run(cmd, capture_output=True, timeout=5)
        except Exception:
            pass


def run_trial(variant: str, label: str, timeout_s: float, extra: list[str]) -> dict:
    if not ENTRY.exists():
        raise SystemExit(f"entry not found: {ENTRY}")
    runner = shutil.which("bun") or shutil.which("bunx")
    if not runner:
        raise SystemExit("bun not on PATH")

    OUTDIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    sidecar = OUTDIR / f"{label}-{stamp}.jsonl"
    stdio = OUTDIR / f"{label}-{stamp}.out"

    spec = VARIANTS[variant]
    argv = [runner, str(ENTRY), *spec["argv"], "--log", str(sidecar), *extra]
    env = dict(os.environ)
    env.update(spec.get("env", {}))
    t0 = time.time()
    env["LX_T0_MS"] = str(int(t0 * 1000))            # talk.ts measures first word against this

    cleanup()                                         # never inherit a stuck player/mic
    with open(stdio, "wb") as out:
        proc = subprocess.Popen(argv, stdout=out, stderr=subprocess.STDOUT, env=env,
                                cwd=str(ROOT), start_new_session=True)
        # Poll the sidecar rather than the process: the call is long-lived by design, and
        # `response.done` is the moment the greeting finished — that is what we measure.
        deadline = t0 + timeout_s
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            if sidecar.exists() and '"response.done"' in sidecar.read_text(errors="replace"):
                time.sleep(0.35)                      # let the trailing lines flush
                break
            time.sleep(0.15)
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                proc.kill()
    cleanup()

    r = parse_sidecar(sidecar)
    r["wall_ms"] = int((time.time() - t0) * 1000)
    r["variant"], r["label"] = variant, label
    r["sidecar"], r["stdio"] = str(sidecar), str(stdio)
    r["exit_code"] = proc.returncode
    ok, why = verdict(r)
    r["pass"], r["why"] = ok, why
    return r


def show(r: dict):
    mark = "PASS" if r["pass"] else "FAIL"
    print(f"[{mark}] {r['label']} ({r['variant']})  first_word={r['first_word_ms']}ms  "
          f"session.created={r['t_session_created_ms']}ms  session.updated={r['t_session_updated_ms']}ms  "
          f"response.done={r['t_response_done_ms']}ms  wall={r['wall_ms']}ms  events={r['events']}")
    for w in r["why"]:
        print(f"       ! {w}")
    print(f"       log {r['sidecar']}")


# ───────────────────────────── commands ─────────────────────────────

def cmd_run(a):
    r = run_trial(a.variant, a.label or a.variant, a.timeout, a.extra)
    show(r)
    if a.json:
        print(json.dumps(r, indent=2))
    return 0 if r["pass"] else 1


def cmd_compare(a):
    rows = []
    for v in a.variant:
        got = []
        for i in range(a.trials):
            r = run_trial(v, f"{v}-{i+1}", a.timeout, a.extra)
            show(r)
            got.append(r)
            time.sleep(a.gap)                        # the realtime endpoint rate-limits rapid reconnects
        rows.append((v, got))

    print(f"\n{'variant':10} {'n':>3} {'pass':>5} {'median':>8} {'p90':>8} {'min':>7} {'max':>7}")
    print("-" * 54)
    for v, got in rows:
        lat = sorted(r["first_word_ms"] for r in got if r["first_word_ms"] is not None)
        npass = sum(1 for r in got if r["pass"])
        if lat:
            p90 = lat[min(len(lat) - 1, int(round(0.9 * (len(lat) - 1))))]
            print(f"{v:10} {len(got):>3} {npass:>5} {statistics.median(lat):>8.0f} {p90:>8} {lat[0]:>7} {lat[-1]:>7}")
        else:
            print(f"{v:10} {len(got):>3} {npass:>5} {'—':>8} {'—':>8} {'—':>7} {'—':>7}")
    print(f"\n{VARIANTS['cold']['desc']}  |  {VARIANTS['daemon']['desc']}")
    return 0


def cmd_sweep(a):
    """Verdict-only pass over sidecars someone else produced — notably the ones
    bench/talk-latency.sh leaves in /tmp. Latency is that script's job; correctness is
    this one's, and neither has to re-run the calls."""
    import glob
    paths = sorted(p for pat in a.glob for p in glob.glob(pat))
    if not paths:
        print("no sidecars matched")
        return 1
    npass = 0
    for path in paths:
        r = parse_sidecar(Path(path))
        r["variant"], r["label"], r["wall_ms"], r["sidecar"] = "sweep", Path(path).stem, -1, path
        r["pass"], r["why"] = verdict(r)
        npass += bool(r["pass"])
        show(r)
    print(f"\n{npass}/{len(paths)} clean")
    return 0 if npass == len(paths) else 1


def cmd_replay(a):
    r = parse_sidecar(Path(a.path))
    r["variant"], r["label"], r["wall_ms"] = "replay", Path(a.path).stem, -1
    r["sidecar"] = a.path
    r["pass"], r["why"] = verdict(r)
    show(r)
    if a.json:
        print(json.dumps(r, indent=2))
    return 0 if r["pass"] else 1


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="one live trial")
    r.add_argument("--variant", choices=list(VARIANTS), default="cold")
    r.add_argument("--label")
    r.add_argument("--timeout", type=float, default=25.0)
    r.add_argument("--json", action="store_true")
    r.add_argument("extra", nargs="*", help="extra flags passed to `apiplan talk`")
    r.set_defaults(fn=cmd_run)

    c = sub.add_parser("compare", help="N trials per variant, median/p90 table")
    c.add_argument("--variant", action="append", default=[])
    c.add_argument("--trials", type=int, default=5)
    c.add_argument("--timeout", type=float, default=25.0)
    c.add_argument("--gap", type=float, default=4.0, help="seconds between trials (rate limit)")
    c.add_argument("extra", nargs="*")
    c.set_defaults(fn=cmd_compare)

    w = sub.add_parser("sweep", help="verdict-only pass over existing sidecars (e.g. bench/talk-latency.sh's /tmp logs)")
    w.add_argument("glob", nargs="+", help="one or more shell globs, e.g. '/tmp/apiplan-talk-*/*.jsonl'")
    w.set_defaults(fn=cmd_sweep)

    q = sub.add_parser("replay", help="parse an existing sidecar log, no launch")
    q.add_argument("path")
    q.add_argument("--json", action="store_true")
    q.set_defaults(fn=cmd_replay)

    a = p.parse_args()
    if a.cmd == "compare" and not a.variant:
        a.variant = ["cold"]
    try:
        return a.fn(a)
    finally:
        cleanup()


if __name__ == "__main__":
    sys.exit(main())
