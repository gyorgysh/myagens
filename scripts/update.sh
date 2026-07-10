#!/usr/bin/env bash
#
# update.sh — sync to the latest code, reinstall deps, rebuild (panel UI + bot),
# and restart the service if one is installed. Safe to run whether you run as a
# service or by hand (it only restarts when a service is actually present).
# Also fixes up the git remote and migrates a pre-rename ('myhq') service to
# the current name if one is found still running (see restart_if_service).
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
err() { printf '✖ %s\n' "$*" >&2; }

REF="${1:-$(git rev-parse --abbrev-ref HEAD)}"

# Repo was renamed gyorgysh/myhq -> gyorgysh/myagens. GitHub redirects the old
# URL, so this isn't strictly required, but fix it up if origin is still the
# exact canonical old URL (never touch a fork under a different owner).
CURRENT_REMOTE="$(git remote get-url origin 2>/dev/null || true)"
case "$CURRENT_REMOTE" in
  "git@github.com:gyorgysh/myhq.git")
    say "Updating git remote (repo renamed): $CURRENT_REMOTE -> git@github.com:gyorgysh/myagens.git"
    git remote set-url origin "git@github.com:gyorgysh/myagens.git" ;;
  "https://github.com/gyorgysh/myhq.git")
    say "Updating git remote (repo renamed): $CURRENT_REMOTE -> https://github.com/gyorgysh/myagens.git"
    git remote set-url origin "https://github.com/gyorgysh/myagens.git" ;;
esac

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

# Version before the reset, for the post-restart "updated vX -> vY" notice.
FROM_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"

say "Fetching origin/${REF}…"
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

# Force a dev install. If the service account (or a parent shell) has
# NODE_ENV=production set, a bare `npm install` skips devDependencies —
# typescript/tsx for the bot, vite for the panel — so the `npm run build` step
# below then fails with "tsc: not found" / "vite: not found". Clearing NODE_ENV
# for the install step *and* passing --include=dev makes the dev deps install
# regardless of the inherited environment.
say "Installing dependencies…"
NODE_ENV=development npm install --include=dev
# `npm run build` builds the panel UI first (panel/ deps + vite build) then the
# bot (tsc), so the management panel is always rebuilt alongside the bot. The
# panel's own `npm install` (in package.json's build:panel) needs the same
# dev-deps treatment, so keep NODE_ENV cleared for the build too.
say "Building (panel UI + bot)…"
NODE_ENV=development npm run build

# Leave a restart marker so the freshly booted process can tell this restart was
# update-driven and confirm "back online" to the user (consumed in src/bot.ts).
# The in-panel/Telegram update paths write the same file from TS before spawning
# this script; writing it again here also covers manual shell runs. Only reached
# on a green build (set -e), so a failed update never leaves a success marker.
if [ -d data ]; then
  printf '{ "mode": "update", "fromVersion": "%s", "at": %s000 }\n' "$FROM_VERSION" "$(date +%s)" > data/update-pending.json || true
fi

# Probe the optional node-pty native addon (powers the panel Terminal tab). It's
# an optionalDependency, so a missing build toolchain doesn't fail the install —
# the terminal just stays disabled. Surface that here with a fix hint.
probe_node_pty() {
  if node -e "require('node-pty')" >/dev/null 2>&1; then
    ok "Terminal backend (node-pty) is available."
  else
    say "Terminal backend (node-pty) not built — the panel Terminal tab will be disabled."
    case "$(uname -s)" in
      Linux)  say "  To enable it: install build tools (e.g. 'sudo apt-get install -y build-essential python3') and re-run this script." ;;
      Darwin) say "  To enable it: install Xcode command line tools ('xcode-select --install') and re-run this script." ;;
    esac
  fi
}
probe_node_pty || true

# Restart only if a service is installed for this machine.
restart_if_service() {
  local new_present=0 old_present=0
  case "$(uname -s)" in
    Darwin)
      [ -f "$HOME/Library/LaunchAgents/sh.gyorgy.myagens.plist" ] && new_present=1
      [ -f "$HOME/Library/LaunchAgents/sh.gyorgy.myhq.plist" ] && old_present=1 ;;
    Linux)
      command -v systemctl >/dev/null 2>&1 || return 1
      local units; units="$(systemctl list-unit-files 2>/dev/null)"
      echo "$units" | grep -q '^myagens\.service' && new_present=1
      echo "$units" | grep -q '^myhq\.service' && old_present=1 ;;
    *) return 1 ;;
  esac
  [ "$new_present" = "1" ] || [ "$old_present" = "1" ] || return 1

  # Still on the pre-rename service and haven't migrated yet: run the installer,
  # which builds, writes the new unit/LaunchAgent, starts it, and stops/removes
  # the old one — a strict superset of a plain restart. On Linux this needs sudo
  # to write the new unit file; with no TTY (e.g. triggered from the panel) sudo
  # fails fast rather than hanging, so this falls through to a plain restart
  # under whichever service name still works, keeping the bot up either way.
  if [ "$old_present" = "1" ] && [ "$new_present" = "0" ]; then
    say "Found the pre-rename service — migrating to 'myagens' (may prompt for sudo on Linux)…"
    if "$APP_DIR/scripts/install-service.sh"; then
      ok "Migrated and restarted as the 'myagens' service."
      return 0
    fi
    err "Automatic migration didn't complete (likely needs an interactive sudo prompt) — falling back to a plain restart under the old service name. Run ./scripts/install-service.sh by hand to finish migrating."
  fi

  say "Restarting the service…"
  # Check the restart explicitly. Because this runs as an `if` condition, `set -e`
  # is disabled inside it, so a failed `agentctl restart` (e.g. launchctl kickstart
  # from an SSH session with no GUI domain, or missing sudo) would otherwise fall
  # through to "Service restarted." and update.sh would exit 0 — the in-panel
  # updater then reports success while the OLD code keeps running.
  if ! "$APP_DIR/scripts/agentctl.sh" restart; then
    err "Service restart FAILED — the new build is in place but the running process was NOT restarted. Restart manually: $APP_DIR/scripts/agentctl.sh restart"
    return 2
  fi
  ok "Service restarted."
}

restart_rc=0
restart_if_service || restart_rc=$?   # `|| …` keeps set -e from exiting on 1/2
case "$restart_rc" in
  0) : ;;                                   # restarted (message already printed)
  2) exit 1 ;;                              # restart failed (error already printed)
  *) ok "Build complete. No service installed — restart your manual run to pick up changes." ;;
esac
