#!/bin/sh
# apiplan-safe-restart — drain srv2's apiplan serve, then ALWAYS restart it, within a hard bound.
#
# Why (2026-10-28): an ad-hoc drain loop read activeRequests from /health, which a draining serve does
# not answer in that shape; the loop ran out its 5 min, the exec timed out before `systemctl restart`,
# and serve sat drained (refusing every request) for ~6 min. Here the drain endpoint itself reports
# activeRequests (it is idempotent), the wait is capped at MAX_WAIT_S, and the restart runs no matter what.
#
#   apiplan-safe-restart.sh [MAX_WAIT_S]     default 60
MAX="${1:-60}"
KEY="$(cat /root/.apiplan-owner.key)"
drain() { curl -s -m 5 -X POST -H "authorization: Bearer $KEY" localhost:8787/_apiplan/drain 2>/dev/null |
          python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("activeRequests","?"))
except Exception: print("?")'; }
t=0
while [ "$t" -lt "$MAX" ]; do
  a="$(drain)"
  [ "$a" = 0 ] && break
  sleep 2; t=$((t + 2))
done
echo "drained: activeRequests=${a:-?} after ${t}s (cap ${MAX}s)"
systemctl restart apiplan-serve
sleep 5
echo "apiplan-serve: $(systemctl is-active apiplan-serve) since $(systemctl show -p ActiveEnterTimestamp --value apiplan-serve)"
