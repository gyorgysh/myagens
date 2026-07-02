#!/usr/bin/env bash
#
# macOS/launchd uninstaller. Unloads and removes the per-user LaunchAgent.
# Leaves the checkout, .env, data/ and the log file untouched. Also cleans up
# the pre-rename 'sh.gyorgy.myhq' LaunchAgent, in case this box was never
# migrated to the 'sh.gyorgy.myagens' label.

set -euo pipefail

[ "$(uname -s)" = "Darwin" ] || { echo "✖ This uninstaller is for macOS." >&2; exit 1; }

removed_any=0
for LABEL in sh.gyorgy.myagens sh.gyorgy.myhq; do
  PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  LOG="$HOME/Library/Logs/${LABEL}.log"
  if [ -f "$PLIST" ]; then
    removed_any=1
    echo "• Unloading the LaunchAgent…"
    launchctl unload -w "$PLIST" 2>/dev/null || true
    echo "• Removing ${PLIST}…"
    rm -f "$PLIST"
    echo "✓ Removed the '${LABEL}' LaunchAgent. The checkout and your .env are untouched."
    echo "  (Log left in place: $LOG)"
  fi
done
[ "$removed_any" = "1" ] || echo "• Not installed — nothing to remove."
