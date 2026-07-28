#!/usr/bin/env bash
# APIPlan installer — puts `opus`, `fable`, `sonnet`, `haiku`, and `api` on your PATH.
# Each alias is a 2-line wrapper that execs the core with the model baked in
# (robust — no argv0/shebang-resolution guesswork). Re-run any time; it's idempotent.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/api.ts"
BIN="${APIPLAN_BIN:-$HOME/.local/bin}"

command -v bun >/dev/null || { echo "apiplan: bun not found — install from https://bun.sh"; exit 1; }
[ -f "$SRC" ] || { echo "apiplan: cannot find api.ts next to installer"; exit 1; }
mkdir -p "$BIN"

make() { # $1 = command name, $2 = model alias ("" for generic `api`), $3 = extra flags baked in
  local f="$BIN/$1" extra="${3:-}"
  if [ -n "$2" ]; then
    printf '#!/bin/sh\nexec bun "%s" --model %s %s "$@"\n' "$SRC" "$2" "$extra" > "$f"
  else
    printf '#!/bin/sh\nexec bun "%s" %s "$@"\n' "$SRC" "$extra" > "$f"
  fi
  chmod +x "$f"
  echo "  $f"
}

echo "apiplan: installing wrappers into $BIN"
make opus opus
make fable fable
make sonnet sonnet
make haiku haiku
make api ""
# -fast: min effort + thinking pinned to 0 + streaming → lowest-latency, tokens appear as they arrive
make opus-fast   opus   "--effort low --thinking 0 --stream"
make fable-fast  fable  "--effort low --thinking 0 --stream"
make sonnet-fast sonnet "--effort low --thinking 0 --stream"
make haiku-fast  haiku  "--effort low --thinking 0 --stream"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo; echo "apiplan: $BIN is not on PATH — add this to your shell rc:"; echo "  export PATH=\"$BIN:\$PATH\"";;
esac

echo
echo "apiplan: done. Try:  opus \"say pong\"    ·    cat file | sonnet \"summarize\""
