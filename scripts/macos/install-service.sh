#!/usr/bin/env bash
#
# macOS/launchd installer. Installs a per-user LaunchAgent so the bot runs in
# your login session (where the `claude` CLI login lives) and restarts on crash
# and at login. No sudo needed — and so the agent can restart itself freely.
#
# Migrates a pre-rename 'sh.gyorgy.myhq' LaunchAgent (from before the
# myhq->MyAgens rename) by unloading and removing it before loading the new
# one, so a re-run of this installer on an existing box doesn't end up with
# two competing instances of the bot polling Telegram at once.

set -euo pipefail

LABEL=sh.gyorgy.myagens
LEGACY_LABEL=sh.gyorgy.myhq
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
LOG="$LOG_DIR/${LABEL}.log"

[ "$(uname -s)" = "Darwin" ] || { echo "✖ This installer is for macOS." >&2; exit 1; }

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "✖ node not found in PATH." >&2; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"

# launchd starts the agent with a minimal PATH. The bot itself is launched by
# absolute node path, but the Claude Code SDK spawns the `claude` CLI as a
# `node` child process and relies on `node` (and `claude`) being on PATH — so
# without this the bot starts but every turn fails with "spawn node ENOENT".
# Prepend node's own dir, then the usual Homebrew/local bin dirs.
SERVICE_PATH="${NODE_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

[ -f "$APP_DIR/.env" ] || {
  echo "✖ $APP_DIR/.env is missing. Run 'cp .env.example .env' and fill it in first." >&2
  exit 1
}

echo "• Building the project…"
( cd "$APP_DIR" && npm install && npm run build )

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
echo "• Writing ${PLIST}…"
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${SERVICE_PATH}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Relaunch only on crash / unsuccessful exit, not after a clean exit(0). An
       unconditional <true/> also relaunches a deliberate graceful shutdown,
       fighting an in-progress restart/update. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
  <key>ExitTimeOut</key><integer>85</integer>
</dict>
</plist>
EOF

LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
if [ -f "$LEGACY_PLIST" ]; then
  echo "• Migrating from the old '${LEGACY_LABEL}' LaunchAgent…"
  launchctl unload -w "$LEGACY_PLIST" 2>/dev/null || true
  rm -f "$LEGACY_PLIST"
fi

echo "• Loading the LaunchAgent…"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "✓ Installed and started '${LABEL}'."
echo "  Manage with: ./scripts/agentctl.sh {start|stop|restart|status|logs}"
echo "  Logs: $LOG"
