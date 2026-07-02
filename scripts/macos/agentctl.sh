#!/usr/bin/env bash
#
# macOS/launchd manager.
# Usage: agentctl.sh {start|stop|restart|status|logs}

set -euo pipefail
LABEL=sh.gyorgy.myagens
LEGACY_LABEL=sh.gyorgy.myhq

[ "$(uname -s)" = "Darwin" ] || { echo "✖ This manager is for macOS." >&2; exit 1; }

# Fall back to the pre-rename label if that's what's actually installed — lets
# this checkout keep managing a not-yet-migrated LaunchAgent until the user
# re-runs install-service.sh.
if [ ! -f "$HOME/Library/LaunchAgents/${LABEL}.plist" ] \
   && [ -f "$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist" ]; then
  LABEL=$LEGACY_LABEL
fi
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/Library/Logs/${LABEL}.log"

cmd="${1:-status}"
case "$cmd" in
  start)   launchctl load -w "$PLIST" ;;
  stop)    launchctl unload -w "$PLIST" ;;
  restart) launchctl kickstart -k "gui/$(id -u)/${LABEL}" ;;
  status)  launchctl list | grep "$LABEL" || echo "not loaded" ;;
  logs)    tail -n 100 -f "$LOG" ;;
  *) echo "Usage: $0 {start|stop|restart|status|logs}" >&2; exit 1 ;;
esac
