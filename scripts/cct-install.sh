#!/usr/bin/env bash
#
# cct-install.sh — one-shot installer/wizard for claude-code-telegram.
#
#   curl -fsSL https://gyorgy.sh/cct-install.sh | bash
#
# Self-contained: it does NOT assume the repo is checked out. It installs the
# prerequisites (Homebrew on macOS; Node 20+, git, and the Claude Code CLI on
# both platforms), checks RAM and offers swap on low-memory Linux boxes, clones
# the repo, builds it, walks you through .env, and finally asks whether to run
# as a background service or by hand.
#
# Non-interactive overrides (env vars): CCT_REPO, CCT_DIR, CCT_BRANCH,
# CCT_TOKEN, CCT_USER_IDS, CCT_API_KEY, CCT_MODE=service|manual, CCT_YES=1.

set -euo pipefail

REPO_URL="${CCT_REPO:-https://github.com/gyorgysh/claude-code-telegram.git}"
BRANCH="${CCT_BRANCH:-main}"
DEFAULT_DIR="${CCT_DIR:-$HOME/claude-code-telegram}"
TUTORIAL="https://gyorgy.sh/blog/claude-code-telegram"
MIN_NODE=20

# --- pretty output ----------------------------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  CY=$'\033[36m'; GR=$'\033[32m'; YE=$'\033[33m'; RD=$'\033[31m'
else
  B=""; DIM=""; R=""; CY=""; GR=""; YE=""; RD=""
fi
say()  { printf '%s\n' "${CY}•${R} $*"; }
ok()   { printf '%s\n' "${GR}✓${R} $*"; }
warn() { printf '%s\n' "${YE}!${R} $*"; }
err()  { printf '%s\n' "${RD}✖${R} $*" >&2; }
die()  { err "$*"; exit 1; }

# --- interactive prompts (read from the terminal, not the curl pipe) ---------
if [ -e /dev/tty ] && [ -r /dev/tty ]; then TTY=/dev/tty; else TTY=""; fi

# ask "Prompt" "default" -> echoes the answer (or the default if empty/no tty)
ask() {
  local prompt="$1" def="${2:-}" ans=""
  if [ -n "$TTY" ]; then
    if [ -n "$def" ]; then printf '%s [%s]: ' "$prompt" "$def" >"$TTY"
    else printf '%s: ' "$prompt" >"$TTY"; fi
    read -r ans <"$TTY" || ans=""
  fi
  printf '%s' "${ans:-$def}"
}

# confirm "Question" "Y|N" -> returns 0 for yes. CCT_YES=1 auto-accepts; with no
# terminal we decline (so an unattended pipe never does anything destructive).
confirm() {
  local prompt="$1" def="${2:-Y}" ans=""
  [ "${CCT_YES:-0}" = "1" ] && return 0
  [ -z "$TTY" ] && return 1
  local hint="[Y/n]"; [ "$def" = "N" ] && hint="[y/N]"
  printf '%s %s ' "$prompt" "$hint" >"$TTY"
  read -r ans <"$TTY" || ans=""
  ans="${ans:-$def}"
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# --- platform / privilege ---------------------------------------------------
OS=""
detect_os() {
  case "$(uname -s)" in
    Darwin) OS=mac ;;
    Linux)  OS=linux ;;
    *) die "Unsupported OS: $(uname -s). Linux and macOS only." ;;
  esac
}

SUDO=""
need_sudo() {
  [ -n "$SUDO" ] && return 0
  if [ "$(id -u)" -eq 0 ]; then SUDO=""
  elif command -v sudo >/dev/null 2>&1; then SUDO="sudo"
  else die "Need root for this step but 'sudo' isn't available. Re-run as root."; fi
}

PKG=""  # apt | dnf | yum | pacman | zypper
detect_pkg_mgr() {
  for m in apt-get dnf yum pacman zypper; do
    if command -v "$m" >/dev/null 2>&1; then PKG="${m%%-get}"; return; fi
  done
}

# --- prerequisites ----------------------------------------------------------
ensure_homebrew() {
  [ "$OS" = "mac" ] || return 0
  if command -v brew >/dev/null 2>&1; then ok "Homebrew present."; return; fi
  say "Installing Homebrew…"
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Make brew available in this shell (Apple Silicon vs Intel prefixes).
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$p" ] && eval "$("$p" shellenv)"
  done
  command -v brew >/dev/null 2>&1 || die "Homebrew install failed."
  ok "Homebrew installed."
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major; major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [ "${major:-0}" -ge "$MIN_NODE" ]
}

ensure_node() {
  if node_ok; then ok "Node $(node -v) present."; return; fi
  say "Installing Node ${MIN_NODE}+…"
  if [ "$OS" = "mac" ]; then
    brew install node
  else
    detect_pkg_mgr
    need_sudo
    local ns="/tmp/nodesource-setup.sh"
    case "$PKG" in
      apt)
        # Download then run (works as root with empty $SUDO and via sudo alike).
        curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE}.x" -o "$ns"
        $SUDO bash "$ns"; rm -f "$ns"
        $SUDO apt-get install -y nodejs ;;
      dnf|yum)
        curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE}.x" -o "$ns"
        $SUDO bash "$ns"; rm -f "$ns"
        $SUDO "$PKG" install -y nodejs ;;
      pacman) $SUDO pacman -Sy --noconfirm nodejs npm ;;
      zypper) $SUDO zypper install -y nodejs"${MIN_NODE}" npm"${MIN_NODE}" ;;
      *) die "Couldn't detect a package manager. Install Node ${MIN_NODE}+ manually, then re-run." ;;
    esac
  fi
  node_ok || die "Node ${MIN_NODE}+ still not available after install."
  ok "Node $(node -v) installed."
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then ok "git present."; return; fi
  say "Installing git…"
  if [ "$OS" = "mac" ]; then brew install git
  else
    detect_pkg_mgr; need_sudo
    case "$PKG" in
      apt) $SUDO apt-get install -y git ;;
      dnf|yum) $SUDO "$PKG" install -y git ;;
      pacman) $SUDO pacman -Sy --noconfirm git ;;
      zypper) $SUDO zypper install -y git ;;
      *) die "Install git manually, then re-run." ;;
    esac
  fi
  ok "git installed."
}

ensure_claude_cli() {
  if command -v claude >/dev/null 2>&1; then ok "Claude Code CLI present."; return; fi
  say "Installing the Claude Code CLI (npm -g @anthropic-ai/claude-code)…"
  if npm install -g @anthropic-ai/claude-code >/dev/null 2>&1; then :
  else
    warn "Global npm install needs elevated permissions — retrying with sudo."
    need_sudo
    $SUDO npm install -g @anthropic-ai/claude-code
  fi
  command -v claude >/dev/null 2>&1 || warn \
    "Claude CLI not on PATH yet — you may need to open a new shell. You can also use an API key instead."
  ok "Claude Code CLI installed."
}

# --- RAM / swap (Claude Code is memory-hungry; 4GB is the comfortable floor) -
check_ram_swap() {
  if [ "$OS" = "mac" ]; then
    local bytes gb; bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    gb=$(( bytes / 1024 / 1024 / 1024 ))
    if [ "$gb" -lt 4 ]; then
      warn "Only ${gb}GB RAM. macOS manages swap automatically, but builds may be slow."
    else ok "${gb}GB RAM."; fi
    return
  fi

  # Linux: read totals from /proc/meminfo (kB).
  local mem_kb swap_kb mem_gb
  mem_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  swap_kb="$(awk '/^SwapTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  mem_gb=$(( mem_kb / 1024 / 1024 ))
  if [ "$mem_kb" -ge $((4 * 1024 * 1024)) ]; then ok "${mem_gb}GB RAM."; return; fi

  warn "Only ${mem_gb}GB RAM — Claude Code runs best with at least 4GB."
  if [ "$swap_kb" -ge $((2 * 1024 * 1024)) ]; then
    ok "Swap already configured ($(( swap_kb / 1024 / 1024 ))GB) — leaving it alone."
    return
  fi
  if [ -e /swapfile ]; then
    warn "/swapfile already exists — skipping swap setup."
    return
  fi
  if confirm "Create a 2GB swap file at /swapfile to compensate?" "Y"; then
    need_sudo
    say "Creating 2GB swap file…"
    if ! $SUDO fallocate -l 2G /swapfile 2>/dev/null; then
      $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    fi
    $SUDO chmod 600 /swapfile
    $SUDO mkswap /swapfile >/dev/null
    $SUDO swapon /swapfile
    if ! grep -q '^/swapfile' /etc/fstab 2>/dev/null; then
      echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
    fi
    ok "Swap enabled (persists across reboots)."
  else
    warn "Skipping swap — installs/builds may fail if memory runs out."
  fi
}

# --- repo + build -----------------------------------------------------------
APP_DIR=""
clone_repo() {
  local dir
  dir="$(ask "Install location" "$DEFAULT_DIR")"
  # Expand a leading ~ since it's a literal inside a quoted answer.
  case "$dir" in "~"/*) dir="$HOME/${dir#~/}" ;; "~") dir="$HOME" ;; esac
  APP_DIR="$dir"

  if [ -d "$APP_DIR/.git" ]; then
    say "Existing checkout at $APP_DIR — updating…"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  elif [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    die "$APP_DIR exists and isn't empty. Pick another location or remove it."
  else
    say "Cloning $REPO_URL → $APP_DIR…"
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  ok "Repo ready at $APP_DIR."
}

build_app() {
  say "Installing dependencies and building…"
  ( cd "$APP_DIR" && npm install && npm run build )
  ok "Built."
}

# --- .env -------------------------------------------------------------------
configure_env() {
  local env="$APP_DIR/.env"
  if [ -f "$env" ] && ! confirm "$env already exists — reconfigure it?" "N"; then
    ok "Keeping existing .env."
    return
  fi
  cp "$APP_DIR/.env.example" "$env"

  local token ids key
  token="${CCT_TOKEN:-$(ask "Telegram bot token (from @BotFather)" "")}"
  ids="${CCT_USER_IDS:-$(ask "Allowed Telegram user id(s), comma-separated (from @userinfobot)" "")}"
  key="${CCT_API_KEY:-}"
  if [ -z "$key" ] && ! command -v claude >/dev/null 2>&1; then
    key="$(ask "Anthropic API key (leave blank to use 'claude' CLI login)" "")"
  fi

  [ -n "$token" ] || warn "No bot token entered — edit $env before starting."
  [ -n "$ids" ]   || warn "No user ids entered — edit $env before starting."

  set_env "$env" TELEGRAM_BOT_TOKEN "$token"
  set_env "$env" ALLOWED_USER_IDS "$ids"
  [ -n "$key" ] && set_env "$env" ANTHROPIC_API_KEY "$key"
  ok "Wrote $env."
}

# set_env FILE KEY VALUE — replace `KEY=...` (commented or not) or append it.
set_env() {
  local file="$1" key="$2" val="$3" tmp
  [ -n "$val" ] || return 0
  tmp="$(mktemp)"
  # Drop any existing (possibly commented) line for this key, then append.
  grep -vE "^[#[:space:]]*${key}=" "$file" >"$tmp" || true
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv "$tmp" "$file"
}

# --- run mode ---------------------------------------------------------------
choose_run_mode() {
  local mode="${CCT_MODE:-}"
  if [ -z "$mode" ]; then
    printf '\n%s\n' "${B}How should the bot run?${R}" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}1)${R} Install as a background service ${DIM}(recommended — always on, restarts on crash/boot)${R}" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}2)${R} Run manually by command ${DIM}(advanced)${R}" >"${TTY:-/dev/stdout}"
    case "$(ask "Choose 1 or 2" "1")" in
      2) mode="manual" ;; *) mode="service" ;;
    esac
  fi

  if [ "$mode" = "service" ]; then
    say "Installing as a service…"
    ( cd "$APP_DIR" && ./scripts/install-service.sh )
  else
    cat <<EOF

${B}Run it manually${R} from ${APP_DIR}:
  ${DIM}# foreground, auto-reload while developing${R}
  npm run dev
  ${DIM}# or build once and run${R}
  npm run build && npm start
  ${DIM}# or via the launcher (also used by the service)${R}
  ./scripts/run.sh

You can install it as a service later with:
  ./scripts/install-service.sh
EOF
  fi
}

final_notes() {
  cat <<EOF

${GR}${B}Done.${R} claude-code-telegram is installed at ${B}${APP_DIR}${R}.

${B}Next steps${R}
  • If you didn't set an API key, log the CLI in once: ${B}claude${R}  (then /login)
  • Tune the operator playbook: ${B}${APP_DIR}/work.md${R}
  • Manage the service: ${B}${APP_DIR}/scripts/agentctl.sh${R} {start|stop|restart|status|logs}
  • Update later:        ${B}${APP_DIR}/scripts/update.sh${R}
  • Uninstall service:   ${B}${APP_DIR}/scripts/uninstall-service.sh${R}

${B}Learn more${R}
  • Repo:     https://github.com/gyorgysh/claude-code-telegram
  • Tutorial: ${TUTORIAL}

${YE}Reminder:${R} this bot can read, write, and run anything on this machine.
Keep ALLOWED_USER_IDS tight.
EOF
}

main() {
  printf '\n%s\n%s\n\n' \
    "${B}claude-code-telegram installer${R}" \
    "${DIM}Claude Code, driven from Telegram.${R}"
  detect_os
  check_ram_swap
  ensure_homebrew
  ensure_node
  ensure_git
  ensure_claude_cli
  clone_repo
  build_app
  configure_env
  choose_run_mode
  final_notes
}

main "$@"
