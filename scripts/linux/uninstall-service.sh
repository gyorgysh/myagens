#!/usr/bin/env bash
#
# Linux/systemd uninstaller. Stops and disables the unit, then removes the unit
# file and the scoped sudoers rule the installer added. Leaves the checkout,
# .env and data/ untouched.

set -euo pipefail

SERVICE=telegram-agent
UNIT="/etc/systemd/system/${SERVICE}.service"
SUDOERS="/etc/sudoers.d/${SERVICE}"

command -v systemctl >/dev/null 2>&1 || { echo "✖ systemd not found." >&2; exit 1; }

if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}\.service"; then
  echo "• Stopping and disabling ${SERVICE}…"
  sudo systemctl disable --now "$SERVICE" 2>/dev/null || true
else
  echo "• ${SERVICE} is not installed — cleaning up any leftovers."
fi

[ -f "$UNIT" ] && { echo "• Removing $UNIT…"; sudo rm -f "$UNIT"; }
[ -f "$SUDOERS" ] && { echo "• Removing $SUDOERS…"; sudo rm -f "$SUDOERS"; }

sudo systemctl daemon-reload
sudo systemctl reset-failed "$SERVICE" 2>/dev/null || true

echo "✓ Removed the '${SERVICE}' service. The checkout and your .env are untouched."
