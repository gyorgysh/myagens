#!/usr/bin/env bash
#
# Linux/systemd manager.
# Usage: agentctl.sh {start|stop|restart|status|logs|enable|disable}

set -euo pipefail
SERVICE=myagens
LEGACY_SERVICE=myhq

command -v systemctl >/dev/null 2>&1 || { echo "✖ systemd not found." >&2; exit 1; }

# Fall back to the pre-rename unit name if that's what's actually installed —
# lets this checkout keep managing a not-yet-migrated service until the user
# re-runs install-service.sh.
if ! systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}\.service" \
   && systemctl list-unit-files 2>/dev/null | grep -q "^${LEGACY_SERVICE}\.service"; then
  SERVICE=$LEGACY_SERVICE
fi

cmd="${1:-status}"
case "$cmd" in
  start|stop|restart|enable|disable) sudo systemctl "$cmd" "$SERVICE" ;;
  status) systemctl status "$SERVICE" --no-pager ;;
  logs)   journalctl -u "$SERVICE" -n 100 -f ;;
  *) echo "Usage: $0 {start|stop|restart|status|logs|enable|disable}" >&2; exit 1 ;;
esac
