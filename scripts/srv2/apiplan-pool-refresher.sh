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
  echo "pool $(basename "$f" .json):"
  CRED_CLAUDE_FILE="$f" /usr/bin/python3 "$REFRESHER" --only claude || rc=1
done
exit $rc
