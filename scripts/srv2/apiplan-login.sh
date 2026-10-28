#!/bin/sh
# apiplan-login — add a Claude account to srv2's APIPlan pool from ONE sign-in link (Tami AC61B89F 2026-10-28:
# "the server sends me links to log in one by one … after I log in I never have to manage it again").
#
#   apiplan-login.sh start <label>          prints the sign-in URL (runs `claude setup-token` in a private tmux)
#   apiplan-login.sh code  <label> <code>   feeds the code shown after sign-in; lands the token as
#                                           <pool dir>/<label>.json and prints "LANDED <label>" — never the token
#   apiplan-login.sh status|cancel <label>
#
# `claude setup-token` is Claude Code's own sanctioned flow: a 1-YEAR access token (inference scope) and no
# refresh token, so nothing on srv2 rotates it and no other holder can be orphaned. The sign-in code is single-use
# and bound to this tmux session's PKCE verifier: once fed it is worthless, so it may travel in the command text.
# Each label gets its own CLAUDE_CONFIG_DIR, wiped (with the tmux scrollback) once the token has landed.
set -u
SOCK=apiplan-login
LOGINS=/root/.apiplan-logins
POOL="${APIPLAN_ANTHROPIC_POOL_DIR:-/root/.apiplan-creds/pool/anthropic}"
CLAUDE=/root/.local/bin/claude
cmd="${1:-}"; label="${2:-}"
case "$label" in ""|*/*|.*|base) echo "usage: apiplan-login.sh start|code|status|cancel <label> [code]" >&2; exit 2 ;; esac
sess="login-$label"
pane() { tmux -L "$SOCK" capture-pane -p -J -S -200 -t "$sess" 2>/dev/null; }
wipe() { tmux -L "$SOCK" clear-history -t "$sess" 2>/dev/null; tmux -L "$SOCK" kill-session -t "$sess" 2>/dev/null; rm -rf "${LOGINS:?}/$label"; }

case "$cmd" in
start)
  [ -e "$POOL/$label.json" ] && { echo "$label is already in the pool ($POOL/$label.json)" >&2; exit 3; }
  wipe
  mkdir -p "$LOGINS/$label" && chmod 700 "$LOGINS" "$LOGINS/$label"
  tmux -L "$SOCK" new-session -d -s "$sess" -x 500 -y 60 "CLAUDE_CONFIG_DIR=$LOGINS/$label $CLAUDE setup-token; sleep 600"
  i=0
  while [ $i -lt 30 ]; do
    url=$(pane | tr -d '\n' | grep -o 'https://claude\.com/cai/oauth/authorize?[^ ]*' | head -1)
    [ -n "$url" ] && { echo "$url"; exit 0; }
    sleep 1; i=$((i + 1))
  done
  echo "no sign-in URL after 30 s" >&2; exit 1 ;;
code)
  code="${3:-}"; [ -n "$code" ] || { echo "usage: apiplan-login.sh code <label> <code>" >&2; exit 2; }
  tmux -L "$SOCK" has-session -t "$sess" 2>/dev/null || { echo "no login in progress for $label — run start first" >&2; exit 3; }
  tmux -L "$SOCK" send-keys -t "$sess" -l "$code"; tmux -L "$SOCK" send-keys -t "$sess" Enter
  i=0
  while [ $i -lt 60 ]; do
    if pane | grep -qo 'sk-ant-oat01-[A-Za-z0-9_-]*'; then
      pane | grep -o 'sk-ant-oat01-[A-Za-z0-9_-]*' | head -1 | POOL="$POOL" LABEL="$label" /usr/bin/python3 -c '
import json, os, sys, time
tok = sys.stdin.read().strip()
if len(tok) < 60: sys.exit("token looks truncated")
out = os.path.join(os.environ["POOL"], os.environ["LABEL"] + ".json")
tmp = out + ".tmp-login"
body = {"claudeAiOauth": {"accessToken": tok, "refreshToken": None, "expiresAt": int((time.time() + 365 * 86400 - 86400) * 1000),
        "scopes": ["user:inference"], "subscriptionType": None, "source": "claude setup-token via apiplan-login.sh",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}}
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, json.dumps(body).encode()); os.close(fd); os.replace(tmp, out)
' || { echo "could not write the token" >&2; wipe; exit 1; }
      wipe
      echo "LANDED $label → $POOL/$label.json (setup-token, 1 year)"; exit 0
    fi
    if pane | grep -qiE 'error|invalid|failed'; then
      echo "sign-in failed:"; pane | grep -iE 'error|invalid|failed' | tail -3 | cut -c1-200; wipe; exit 1
    fi
    sleep 1; i=$((i + 1))
  done
  echo "no token after 60 s (session kept: status $label)" >&2; exit 1 ;;
status) pane | grep -v '^$' | grep -v 'sk-ant-' | tail -8 ;;
cancel) wipe; echo "cancelled $label" ;;
*) echo "usage: apiplan-login.sh start|code|status|cancel <label> [code]" >&2; exit 2 ;;
esac
