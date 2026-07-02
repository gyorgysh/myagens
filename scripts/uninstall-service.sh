#!/usr/bin/env bash
#
# uninstall-service.sh — remove the bot's OS service. Dispatches to the
# platform implementation: systemd on Linux, launchd on macOS.
#
# This removes the service only; the checkout, .env and data/ are left intact.

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# Remove the local 'myagens' hosts entry the installer may have added (both
# macOS and Linux use /etc/hosts). Only touch the line WE tagged, so a hand-made
# alias is left alone. Best-effort: no tag = nothing to do, and we never fail
# the uninstall over it. Runs before the exec-based dispatch below.
remove_hosts_entry() {
  local hosts="/etc/hosts"
  [ -f "$hosts" ] || return 0
  grep -q 'added by MyAgens installer' "$hosts" 2>/dev/null || return 0
  local sudo=""
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || { echo "• Left the 'myagens' hosts entry in place (need root to edit $hosts)."; return 0; }
    sudo="sudo"
  fi
  local tmp; tmp="$(mktemp)"
  grep -v 'added by MyAgens installer' "$hosts" >"$tmp" 2>/dev/null || true
  if $sudo cp "$tmp" "$hosts" 2>/dev/null; then
    echo "• Removed the 'myagens' entry from $hosts."
  else
    echo "• Couldn't edit $hosts — remove the 'myagens' line by hand if you want."
  fi
  rm -f "$tmp"
}
remove_hosts_entry

case "$(uname -s)" in
  Darwin) exec "$DIR/macos/uninstall-service.sh" "$@" ;;
  Linux)  exec "$DIR/linux/uninstall-service.sh" "$@" ;;
  *) echo "✖ Unsupported OS: $(uname -s) (Linux and macOS only)." >&2; exit 1 ;;
esac
