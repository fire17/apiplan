#!/bin/sh
# apiplan-pool-refresher — keep every Claude credential in the APIPlan account pool fresh on srv2.
# The pool (APIPLAN_ANTHROPIC_POOL_DIR, default /root/.apiplan-creds/pool/anthropic) holds logins MOVED here
# from the Mac: srv2 is their ONLY holder, so srv2 is the only thing that may refresh them (a refresh rotates
# the refresh token and orphans every other copy). Each file is refreshed by the server's existing
# /usr/local/lib/livemind/cred-refresher.py (same endpoint, client id, UA, atomic write-back, RECOVER-* rescue),
# pointed at that one file through CRED_CLAUDE_FILE. cred-refresher holds one global flock, so a file skipped
# because the main cred-refresher.timer was running is simply retried on the next 15-min tick.
DIR="${APIPLAN_ANTHROPIC_POOL_DIR:-/root/.apiplan-creds/pool/anthropic}"
REFRESHER=/usr/local/lib/livemind/cred-refresher.py
rc=0
for f in "$DIR"/*.json; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in .*|*.RECOVER-*|*.tmp-*) continue ;; esac
  # A `claude setup-token` login (apiplan-login.sh) is a 1-year access token with no refresh token: nothing to
  # refresh, and cred-refresher would fail on it every tick. It is only reported once it nears its end.
  if ! /usr/bin/python3 -c 'import json,sys; sys.exit(0 if (json.load(open(sys.argv[1])).get("claudeAiOauth") or {}).get("refreshToken") else 1)' "$f" 2>/dev/null; then
    left=$(/usr/bin/python3 -c 'import json,sys,time; e=(json.load(open(sys.argv[1])).get("claudeAiOauth") or {}).get("expiresAt") or 0; print(int((e/1000-time.time())/86400))' "$f" 2>/dev/null)
    echo "pool $(basename "$f" .json): setup-token, ${left:-?} d left — no refresh"
    [ "${left:-0}" -lt 21 ] && { echo "pool $(basename "$f" .json): WARN setup-token expires in ${left:-?} d — re-run apiplan-login.sh"; rc=1; }
    continue
  fi
  echo "pool $(basename "$f" .json):"
  CRED_CLAUDE_FILE="$f" /usr/bin/python3 "$REFRESHER" --only claude || rc=1
done
exit $rc
