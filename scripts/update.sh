#!/usr/bin/env bash
#
# update.sh — sync to the latest code, reinstall deps, rebuild (panel UI + bot),
# and restart the service if one is installed. Safe to run whether you run as a
# service or by hand (it only restarts when a service is actually present).
#
# It hard-resets the checkout to the remote ref: local edits to tracked files
# are discarded, untracked extra files are left alone. This box mirrors the
# remote — don't keep local-only commits here.
#
# Usage: ./scripts/update.sh [git-ref]   (defaults to the current branch)

set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

say() { printf '• %s\n' "$*"; }
ok()  { printf '✓ %s\n' "$*"; }

REF="${1:-$(git rev-parse --abbrev-ref HEAD)}"

# This box tracks the remote exactly. We hard-reset to the fetched ref instead
# of `git pull`, which means:
#   - local edits to *tracked* files (including regenerated package-lock.json
#     drift from `npm install`) are discarded — no commit/stash dance needed;
#   - *untracked* extra files in the tree (stray scripts, scratch output, the
#     gitignored data/ dir) are left untouched and never block the update the
#     way `git pull` does ("untracked files would be overwritten").
# Exception: work.md (the operator playbook) is backed up and restored across the
# reset below, so local/panel edits to it survive an update.
# Preserve the operator playbook (work.md). It's tracked in the repo as a starter
# template, but is meant to be customized per-box — and the management panel
# writes the live playbook to it. The hard reset below would otherwise discard
# those local edits, so stash a copy and restore it afterward (local wins over
# the shipped template).
WORK_BACKUP=""
if [ -f work.md ]; then
  WORK_BACKUP="$(mktemp)"
  cp work.md "$WORK_BACKUP"
fi

say "Fetching origin/$REF…"
git fetch --prune origin "$REF"
BEFORE="$(git rev-parse HEAD)"
say "Resetting to origin/$REF (local changes to tracked files are discarded)…"
git reset --hard FETCH_HEAD
AFTER="$(git rev-parse HEAD)"

if [ -n "$WORK_BACKUP" ]; then
  if ! cmp -s "$WORK_BACKUP" work.md; then
    cp "$WORK_BACKUP" work.md
    ok "Preserved your local work.md (operator playbook) over the shipped template."
  fi
  rm -f "$WORK_BACKUP"
fi

if [ "$BEFORE" = "$AFTER" ]; then
  ok "Already up to date ($(git rev-parse --short HEAD))."
else
  ok "Updated $(git rev-parse --short "$BEFORE")..$(git rev-parse --short "$AFTER")."
fi

say "Installing dependencies…"
npm install
# `npm run build` builds the panel UI first (panel/ deps + vite build) then the
# bot (tsc), so the management panel is always rebuilt alongside the bot.
say "Building (panel UI + bot)…"
npm run build

# Restart only if a service is installed for this machine.
restart_if_service() {
  case "$(uname -s)" in
    Darwin)
      local plist="$HOME/Library/LaunchAgents/sh.gyorgy.telegram-agent.plist"
      [ -f "$plist" ] || return 1 ;;
    Linux)
      command -v systemctl >/dev/null 2>&1 || return 1
      systemctl list-unit-files 2>/dev/null | grep -q '^telegram-agent\.service' || return 1 ;;
    *) return 1 ;;
  esac
  say "Restarting the service…"
  "$APP_DIR/scripts/agentctl.sh" restart
  ok "Service restarted."
}

if restart_if_service; then :; else
  ok "Build complete. No service installed — restart your manual run to pick up changes."
fi
