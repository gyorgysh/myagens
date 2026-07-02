#!/usr/bin/env bash
#
# tmpswap.sh — add or remove a temporary swap file on Linux.
#
# Usage:
#   ./scripts/tmpswap.sh on  [SIZE_GB]  [PATH]   create and enable swap
#   ./scripts/tmpswap.sh off [PATH]               disable and delete swap
#
# SIZE_GB  defaults to 4. Must not exceed 80% of free disk space.
# PATH     defaults to /var/tmp/myagens-swap (survives /tmp tmpfs mounts).
#
# The file is NOT added to /etc/fstab and will not survive a reboot.
# Run "off" when the heavy task is done to reclaim disk space.
#
# Example (add 4GB, do the work, remove):
#   ./scripts/tmpswap.sh on 4
#   ... heavy build, model inference, etc. ...
#   ./scripts/tmpswap.sh off

set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "tmpswap.sh is Linux-only (macOS manages swap automatically)." >&2
  exit 1
fi

ACTION="${1:-on}"
SIZE_GB="${2:-4}"
SWAP_PATH="${3:-/var/tmp/myagens-swap}"

# When called as "off", the second argument is the path, not a size.
if [ "$ACTION" = "off" ] && [ $# -ge 2 ]; then
  SWAP_PATH="$2"
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || { echo "Need root or sudo." >&2; exit 1; }
  SUDO="sudo"
fi

# ---------- off ---------------------------------------------------------------
if [ "$ACTION" = "off" ]; then
  if [ ! -f "$SWAP_PATH" ]; then
    echo "Swap file not found: $SWAP_PATH" >&2
    exit 1
  fi
  echo "Disabling and removing $SWAP_PATH …"
  $SUDO swapoff "$SWAP_PATH" 2>/dev/null || true
  $SUDO rm -f "$SWAP_PATH"
  echo "Done. Temporary swap removed."
  exit 0
fi

# ---------- on ----------------------------------------------------------------
if [ "$ACTION" != "on" ]; then
  echo "Usage: $0 on [SIZE_GB] [PATH] | off [PATH]" >&2
  exit 1
fi

if [ -f "$SWAP_PATH" ]; then
  echo "Swap file already exists at $SWAP_PATH — remove it first with: $0 off $SWAP_PATH" >&2
  exit 1
fi

# Validate size is a positive integer.
if ! printf '%s' "$SIZE_GB" | grep -qE '^[1-9][0-9]*$'; then
  echo "SIZE_GB must be a positive integer." >&2; exit 1
fi

# Check free disk space in the target directory.
SWAP_DIR="$(dirname "$SWAP_PATH")"
FREE_KB="$(df -Pk "$SWAP_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
FREE_GB=$(( ${FREE_KB:-0} / 1024 / 1024 ))
MAX_GB=$(( FREE_GB * 80 / 100 ))   # cap at 80% of free space

if [ "$SIZE_GB" -gt "$MAX_GB" ]; then
  echo "Only ${FREE_GB}GB free on $(df -Pk "$SWAP_DIR" | awk 'NR==2{print $1}'). Requested ${SIZE_GB}GB exceeds 80% limit (${MAX_GB}GB)." >&2
  exit 1
fi

echo "Creating ${SIZE_GB}GB swap file at $SWAP_PATH …"
if $SUDO fallocate -l "${SIZE_GB}G" "$SWAP_PATH" 2>/dev/null; then
  :
else
  # fallocate not available (e.g. on Btrfs) — fall back to dd.
  echo "(fallocate unavailable, using dd — this will take a moment)"
  $SUDO dd if=/dev/zero of="$SWAP_PATH" bs=1M count=$(( SIZE_GB * 1024 )) status=progress
fi

$SUDO chmod 600 "$SWAP_PATH"
$SUDO mkswap "$SWAP_PATH" >/dev/null
$SUDO swapon "$SWAP_PATH"

CURRENT_SWAP_KB="$(awk '/^SwapTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
echo "Done. Total swap now: $(( CURRENT_SWAP_KB / 1024 / 1024 ))GB."
echo "Remove when finished:  $0 off $SWAP_PATH"
