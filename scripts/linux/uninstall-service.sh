#!/usr/bin/env bash
#
# Linux/systemd uninstaller. Stops and disables the unit, then removes the unit
# file and the scoped sudoers rule the installer added. Leaves the checkout,
# .env and data/ untouched. Also cleans up the pre-rename 'myhq' unit, in case
# this box was never migrated to the 'myagens' name.

set -euo pipefail

command -v systemctl >/dev/null 2>&1 || { echo "✖ systemd not found." >&2; exit 1; }

for SERVICE in myagens myhq; do
  UNIT="/etc/systemd/system/${SERVICE}.service"
  SUDOERS="/etc/sudoers.d/${SERVICE}"

  if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}\.service"; then
    echo "• Stopping and disabling ${SERVICE}…"
    sudo systemctl disable --now "$SERVICE" 2>/dev/null || true
  elif [ ! -f "$UNIT" ] && [ ! -f "$SUDOERS" ]; then
    continue
  fi

  [ -f "$UNIT" ] && { echo "• Removing ${UNIT}…"; sudo rm -f "$UNIT"; }
  [ -f "$SUDOERS" ] && { echo "• Removing ${SUDOERS}…"; sudo rm -f "$SUDOERS"; }
  sudo systemctl reset-failed "$SERVICE" 2>/dev/null || true
done

sudo systemctl daemon-reload

echo "✓ Removed the service. The checkout and your .env are untouched."
