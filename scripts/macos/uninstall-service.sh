#!/usr/bin/env bash
#
# macOS/launchd uninstaller. Unloads and removes the per-user LaunchAgent.
# Leaves the checkout, .env, data/ and the log file untouched.

set -euo pipefail

LABEL=sh.gyorgy.telegram-agent
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/Library/Logs/${LABEL}.log"

[ "$(uname -s)" = "Darwin" ] || { echo "✖ This uninstaller is for macOS." >&2; exit 1; }

if [ -f "$PLIST" ]; then
  echo "• Unloading the LaunchAgent…"
  launchctl unload -w "$PLIST" 2>/dev/null || true
  echo "• Removing $PLIST…"
  rm -f "$PLIST"
  echo "✓ Removed the '${LABEL}' LaunchAgent. The checkout and your .env are untouched."
  echo "  (Log left in place: $LOG)"
else
  echo "• ${LABEL} is not installed — nothing to remove."
fi
