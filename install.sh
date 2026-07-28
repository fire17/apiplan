#!/usr/bin/env sh
# apiplan installer — macOS, Linux, WSL.  (Windows: install.ps1)
#
# One line on a brand-new machine:
#   curl -fsSL https://raw.githubusercontent.com/fire17/apiplan/main/install.sh | sh
#
# Or from a checkout:
#   sh install.sh
#
# Works both ways: piped from curl it clones itself to ~/.apiplan/src first, so there
# is nothing to download by hand. Re-running it updates in place.
set -eu

REPO="${APIPLAN_REPO:-https://github.com/fire17/apiplan.git}"
SRC="${APIPLAN_SRC:-$HOME/.apiplan/src}"

# ---- find the source: this checkout, or clone/update one -------------------------
HERE=""
case "${0:-}" in
  */*) HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ;;
esac
if [ -n "$HERE" ] && [ -f "$HERE/bin/apiplan.ts" ]; then
  ROOT="$HERE"                        # running inside a checkout
else
  command -v git >/dev/null 2>&1 || { echo "apiplan: git is required to bootstrap"; exit 1; }
  if [ -d "$SRC/.git" ]; then
    echo "updating $SRC"
    git -C "$SRC" pull --ff-only -q || echo "  (pull skipped — local changes?)"
  else
    echo "fetching apiplan into $SRC"
    mkdir -p "$(dirname "$SRC")"
    git clone -q --depth 1 "$REPO" "$SRC"
  fi
  ROOT="$SRC"
fi

# ---- runtime --------------------------------------------------------------------
if command -v bun >/dev/null 2>&1; then
  BUN=$(command -v bun)
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  echo "apiplan needs bun (one ~50MB binary, no root)."
  # Non-interactive (curl | sh) can't prompt, so install it; APIPLAN_NO_BUN=1 opts out.
  if [ -t 0 ] && [ "${APIPLAN_ASSUME_YES:-0}" != "1" ]; then
    printf "install it now? [Y/n] "
    read -r a || a=y
    case "${a:-y}" in [Nn]*) echo "aborted — see https://bun.sh"; exit 1 ;; esac
  fi
  [ "${APIPLAN_NO_BUN:-0}" = "1" ] && { echo "aborted (APIPLAN_NO_BUN=1) — see https://bun.sh"; exit 1; }
  curl -fsSL https://bun.sh/install | bash
  BUN="$HOME/.bun/bin/bun"
  [ -x "$BUN" ] || { echo "bun install failed; see https://bun.sh"; exit 1; }
fi
echo "runtime: bun $("$BUN" --version 2>/dev/null) at $BUN"

# ---- install the commands -------------------------------------------------------
"$BUN" "$ROOT/bin/apiplan.ts" install "$@"

# ---- shell glue -----------------------------------------------------------------
BIN=$("$BUN" "$ROOT/bin/apiplan.ts" path 2>/dev/null | sed -E 's/^export PATH="([^:]*).*/\1/')
SHELL_NAME=$(basename "${SHELL:-sh}")
case "$SHELL_NAME" in
  zsh)  RC="$HOME/.zshrc" ;;
  bash) if [ -f "$HOME/.bashrc" ]; then RC="$HOME/.bashrc"; else RC="$HOME/.bash_profile"; fi ;;
  fish) RC="$HOME/.config/fish/config.fish" ;;
  *)    RC="" ;;
esac

PATH_LINE=""
[ -n "${BIN:-}" ] && PATH_LINE=$(printf 'export PATH="%s:$PATH"' "$(printf '%s' "$BIN" | sed "s|$HOME|\$HOME|")")
INIT_LINE='eval "$(apiplan shell-init)"'

# Already wired? Then say so and stop.
if [ -n "$RC" ] && [ -f "$RC" ] && grep -q 'apiplan shell-init' "$RC" 2>/dev/null; then
  echo
  echo "shell already wired in $RC — open a new shell and try:  opus hello"
else
  echo
  echo "Two lines finish the setup:"
  echo
  [ -n "$PATH_LINE" ] && echo "  $PATH_LINE"
  echo "  $INIT_LINE      # so \`opus is this right?\` needs no quotes"
  echo
  DO=n
  if [ -t 0 ] && [ "${APIPLAN_ASSUME_YES:-0}" != "1" ]; then
    printf "append them to %s for me? [y/N] " "${RC:-your shell rc}"
    read -r b || b=n
    case "${b:-n}" in [Yy]*) DO=y ;; esac
  elif [ "${APIPLAN_ASSUME_YES:-0}" = "1" ]; then
    DO=y                              # unattended installs opt in explicitly
  fi
  if [ "$DO" = "y" ] && [ -n "$RC" ]; then
    { echo ""; echo "# apiplan"; [ -n "$PATH_LINE" ] && echo "$PATH_LINE"; echo "$INIT_LINE"; } >> "$RC"
    echo "appended to $RC"
  else
    echo "left alone — run those lines yourself when ready."
  fi
fi

echo
echo "  apiplan            dashboard: providers · models · commands"
echo "  apiplan doctor     check PATH, logins, daemon"
echo "  apiplan update     pull the latest and re-sync"
echo
echo "You need to be logged into \`claude\` and/or \`codex\` — apiplan never asks for a key."
