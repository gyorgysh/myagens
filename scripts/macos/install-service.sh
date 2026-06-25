#!/usr/bin/env bash
#
# macOS/launchd installer. Installs a per-user LaunchAgent so the bot runs in
# your login session (where the `claude` CLI login lives) and restarts on crash
# and at login. No sudo needed — and so the agent can restart itself freely.

set -euo pipefail

LABEL=sh.gyorgy.myhq
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
LOG="$LOG_DIR/${LABEL}.log"

[ "$(uname -s)" = "Darwin" ] || { echo "✖ This installer is for macOS." >&2; exit 1; }

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "✖ node not found in PATH." >&2; exit 1; }

[ -f "$APP_DIR/.env" ] || {
  echo "✖ $APP_DIR/.env is missing. Run 'cp .env.example .env' and fill it in first." >&2
  exit 1
}

echo "• Building the project…"
( cd "$APP_DIR" && npm install && npm run build )

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
echo "• Writing $PLIST…"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${APP_DIR}/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>${APP_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
  <key>ExitTimeOut</key><integer>40</integer>
</dict>
</plist>
EOF

echo "• Loading the LaunchAgent…"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "✓ Installed and started '${LABEL}'."
echo "  Manage with: ./scripts/agentctl.sh {start|stop|restart|status|logs}"
echo "  Logs: $LOG"
