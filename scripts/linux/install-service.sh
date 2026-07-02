#!/usr/bin/env bash
#
# Linux/systemd installer. Creates /etc/systemd/system/myagens.service,
# builds the project, enables + starts it, and drops a scoped passwordless
# sudoers rule so the service user (and thus the agent) can restart THIS service.
#
# Migrates a pre-rename 'myhq' unit (from before the myhq->MyAgens rename) by
# stopping and removing it before installing the new one, so a re-run of this
# installer on an existing box doesn't end up with two competing instances of
# the bot polling Telegram at once.

set -euo pipefail

SERVICE=myagens
LEGACY_SERVICE=myhq
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "✖ systemd (systemctl) not found. This installer is for Linux." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "✖ node not found in PATH." >&2; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"
SYSTEMCTL="$(command -v systemctl)"
RUN_USER="${SUDO_USER:-$USER}"

[ -f "$APP_DIR/.env" ] || {
  echo "✖ $APP_DIR/.env is missing. Run 'cp .env.example .env' and fill it in first." >&2
  exit 1
}

echo "• Building the project…"
( cd "$APP_DIR" && npm install && npm run build )

UNIT="/etc/systemd/system/${SERVICE}.service"
echo "• Writing $UNIT (user: $RUN_USER)…"
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Claude Code Telegram agent
After=network-online.target
Wants=network-online.target
# Stop respawning after 5 failures in 5 min so a config error (missing .env vars →
# exit 1) enters a failed state instead of crash-looping every 3s forever.
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment="NODE_BIN=$NODE_BIN"
Environment="PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin"
ExecStart="$NODE_BIN" "$APP_DIR/dist/index.js"
Restart=on-failure
RestartSec=3
# Allow up to 85 s for graceful drain (30 s turn wait + 40 s hold + 3 s backstop).
TimeoutStopSec=85

[Install]
WantedBy=multi-user.target
EOF

SUDOERS="/etc/sudoers.d/${SERVICE}"
echo "• Allowing $RUN_USER to manage $SERVICE without a password…"
sudo tee "$SUDOERS" >/dev/null <<EOF
$RUN_USER ALL=(root) NOPASSWD: $SYSTEMCTL start $SERVICE, $SYSTEMCTL stop $SERVICE, $SYSTEMCTL restart $SERVICE, $SYSTEMCTL status $SERVICE, $SYSTEMCTL enable $SERVICE, $SYSTEMCTL disable $SERVICE
EOF
sudo chmod 0440 "$SUDOERS"
sudo visudo -cf "$SUDOERS" >/dev/null

if systemctl list-unit-files 2>/dev/null | grep -q "^${LEGACY_SERVICE}\.service"; then
  echo "• Migrating from the old '${LEGACY_SERVICE}' service…"
  sudo systemctl disable --now "$LEGACY_SERVICE" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/${LEGACY_SERVICE}.service" "/etc/sudoers.d/${LEGACY_SERVICE}"
  sudo systemctl reset-failed "$LEGACY_SERVICE" 2>/dev/null || true
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE"

echo "✓ Installed and started '$SERVICE'."
echo "  Manage with: ./scripts/agentctl.sh {start|stop|restart|status|logs}"
