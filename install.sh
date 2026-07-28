#!/usr/bin/env sh
# apiplan installer — macOS, Linux, WSL.  (Windows: install.ps1)
#
#   sh install.sh              install the default command set
#   APIPLAN_BIN=~/bin sh install.sh    choose where commands go
#
# Everything it does is also available as `apiplan install` / `apiplan sync`;
# this script exists only to bootstrap the first `apiplan` command.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)

# ---- runtime ----------------------------------------------------------------
if command -v bun >/dev/null 2>&1; then
  BUN=$(command -v bun)
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  echo "apiplan needs bun (a single ~50MB binary, no root required)."
  printf "install it now? [Y/n] "
  read -r a || a=y
  case "${a:-y}" in
    [Nn]*) echo "aborted — see https://bun.sh"; exit 1 ;;
  esac
  curl -fsSL https://bun.sh/install | sh
  BUN="$HOME/.bun/bin/bun"
  [ -x "$BUN" ] || { echo "bun install failed; see https://bun.sh"; exit 1; }
fi
echo "runtime: $("$BUN" --version 2>/dev/null) at $BUN"

# ---- install commands -------------------------------------------------------
"$BUN" "$HERE/bin/apiplan.ts" install "$@"

# ---- shell glue -------------------------------------------------------------
BIN=$("$BUN" "$HERE/bin/apiplan.ts" path 2>/dev/null | sed -E 's/^export PATH="([^:]*).*/\1/')
SHELL_NAME=$(basename "${SHELL:-sh}")
RC=""
case "$SHELL_NAME" in
  zsh)  RC="$HOME/.zshrc" ;;
  bash) [ -f "$HOME/.bashrc" ] && RC="$HOME/.bashrc" || RC="$HOME/.bash_profile" ;;
  fish) RC="$HOME/.config/fish/config.fish" ;;
esac

echo
echo "Add these two lines to ${RC:-your shell rc} to finish:"
echo
[ -n "${BIN:-}" ] && printf '  export PATH="%s:$PATH"\n' "$(printf '%s' "$BIN" | sed "s|$HOME|\$HOME|")"
echo '  eval "$(apiplan shell-init)"      # so `opus is this right?` needs no quotes'
echo
if [ -n "$RC" ]; then
  printf "append them for me? [y/N] "
  read -r b || b=n
  case "${b:-n}" in
    [Yy]*)
      {
        echo ""
        echo "# apiplan"
        [ -n "${BIN:-}" ] && printf 'export PATH="%s:$PATH"\n' "$(printf '%s' "$BIN" | sed "s|$HOME|\$HOME|")"
        echo 'eval "$(apiplan shell-init)"'
      } >> "$RC"
      echo "appended to $RC — open a new shell, then try:  opus hello"
      ;;
    *) echo "left alone. Run the two lines above yourself when ready." ;;
  esac
fi
echo
echo "Then:  apiplan          (dashboard)      apiplan doctor    (check everything)"
