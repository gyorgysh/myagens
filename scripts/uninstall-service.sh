#!/usr/bin/env bash
#
# uninstall-service.sh — remove the bot's OS service. Dispatches to the
# platform implementation: systemd on Linux, launchd on macOS.
#
# This removes the service only; the checkout, .env and data/ are left intact.

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -s)" in
  Darwin) exec "$DIR/macos/uninstall-service.sh" "$@" ;;
  Linux)  exec "$DIR/linux/uninstall-service.sh" "$@" ;;
  *) echo "✖ Unsupported OS: $(uname -s) (Linux and macOS only)." >&2; exit 1 ;;
esac
