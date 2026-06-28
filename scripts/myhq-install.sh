#!/usr/bin/env bash
#
# myhq-install.sh — one-shot installer/wizard for MyHQ.
#
#   curl -fsSL https://gyorgy.sh/myhq-install.sh | bash
#
# Self-contained: it does NOT assume the repo is checked out. It installs the
# prerequisites (Homebrew on macOS; Node 20+, git, and the Claude Code CLI on
# both platforms), checks RAM and offers swap on low-memory Linux boxes, clones
# the repo, builds it, walks you through .env, and finally asks whether to run
# as a background service or by hand.
#
# Non-interactive overrides (env vars): MYHQ_REPO, MYHQ_DIR, MYHQ_BRANCH,
# MYHQ_TOKEN, MYHQ_USER_IDS, MYHQ_API_KEY, MYHQ_MODE=service|manual,
# MYHQ_VOICE=none|api|vosk, MYHQ_OPENAI_KEY,
# MYHQ_PANEL=y|n, MYHQ_PANEL_PORT, MYHQ_PANEL_TOKEN,
# MYHQ_REMOTE=none|ngrok|cloudflare|both, MYHQ_YES=1.

set -euo pipefail

REPO_URL="${MYHQ_REPO:-https://github.com/gyorgysh/myhq.git}"
BRANCH="${MYHQ_BRANCH:-main}"
DEFAULT_DIR="${MYHQ_DIR:-$HOME/myhq}"
TUTORIAL="https://gyorgy.sh/blog/myhq"
MIN_NODE=20

PANEL_PORT_CHOSEN=""
PANEL_TOKEN_CHOSEN=""

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

# confirm "Question" "Y|N" -> returns 0 for yes. MYHQ_YES=1 auto-accepts; with no
# terminal we decline (so an unattended pipe never does anything destructive).
confirm() {
  local prompt="$1" def="${2:-Y}" ans=""
  [ "${MYHQ_YES:-0}" = "1" ] && return 0
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

# Soft package install for optional extras (ffmpeg, unzip): installs via brew or
# the detected Linux package manager. Returns non-zero instead of dying so an
# optional step can warn and carry on. Same package name across managers.
pkg_install() {
  local name="$1" S=""
  if [ "$OS" = "mac" ]; then brew install "$name"; return; fi
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 && S="sudo" || return 1
  fi
  detect_pkg_mgr
  case "$PKG" in
    apt) $S apt-get install -y "$name" ;;
    dnf|yum) $S "$PKG" install -y "$name" ;;
    pacman) $S pacman -Sy --noconfirm "$name" ;;
    zypper) $S zypper install -y "$name" ;;
    *) return 1 ;;
  esac
}

ensure_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1; then ok "ffmpeg present."; return 0; fi
  say "Installing ffmpeg (decodes voice notes for local transcription)…"
  pkg_install ffmpeg || { warn "Couldn't install ffmpeg automatically — install it manually."; return 1; }
  ok "ffmpeg installed."
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

# --- Ollama + nomic-embed-text (local semantic memory; opt-in, ~275MB model) -
ensure_ollama() {
  confirm "Install Ollama + pull nomic-embed-text for local semantic memory?" "Y" || {
    say "Skipping Ollama — semantic memory stays keyword-only (enable later in the panel)."
    return 0
  }
  if command -v ollama >/dev/null 2>&1; then
    ok "Ollama present."
  else
    say "Installing Ollama…"
    if [ "$OS" = "mac" ]; then
      brew install ollama 2>/dev/null || { warn "Couldn't install Ollama — get it from https://ollama.com/download and re-run."; return 0; }
    else
      curl -fsSL https://ollama.com/install.sh | sh || { warn "Ollama install failed — see https://ollama.com/download."; return 0; }
    fi
    ok "Ollama installed."
  fi
  # Pull the embedding model so autoProbeEmbeddings() lights up semantic memory.
  if command -v ollama >/dev/null 2>&1; then
    say "Pulling nomic-embed-text (~275MB)…"
    if ollama pull nomic-embed-text >/dev/null 2>&1; then
      ok "Embedding model ready — semantic memory will auto-enable."
    else
      warn "Couldn't pull nomic-embed-text — run 'ollama pull nomic-embed-text' once the daemon is up."
    fi
  fi
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
    say "Cloning $REPO_URL → ${APP_DIR}…"
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  ok "Repo ready at $APP_DIR."
}

build_app() {
  say "Installing dependencies and building…"
  ( cd "$APP_DIR" && npm install && npm run build )
  ok "Built."
  if ( cd "$APP_DIR" && node -e "require('node-pty')" >/dev/null 2>&1 ); then
    ok "Terminal backend (node-pty) is available."
  else
    warn "Terminal backend (node-pty) not built — the panel Terminal tab will be disabled."
    case "$(uname -s)" in
      Linux)  say "  To enable it: install build tools ('sudo apt-get install -y build-essential python3') and re-run this installer." ;;
      Darwin) say "  To enable it: install Xcode command line tools ('xcode-select --install') and re-run this installer." ;;
    esac
  fi
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
  token="${MYHQ_TOKEN:-$(ask "Telegram bot token (from @BotFather)" "")}"
  ids="${MYHQ_USER_IDS:-$(ask "Allowed Telegram user id(s), comma-separated (from @userinfobot)" "")}"
  key="${MYHQ_API_KEY:-}"
  if [ -z "$key" ] && ! command -v claude >/dev/null 2>&1; then
    key="$(ask "Anthropic API key (blank = log in with a Pro/Max plan instead)" "")"
  fi

  [ -n "$token" ] || warn "No bot token entered — edit $env before starting."
  [ -n "$ids" ]   || warn "No user ids entered — edit $env before starting."

  set_env "$env" TELEGRAM_BOT_TOKEN "$token"
  set_env "$env" ALLOWED_USER_IDS "$ids"
  [ -n "$key" ] && set_env "$env" ANTHROPIC_API_KEY "$key"
  ok "Wrote $env."
}

# --- Claude CLI login -------------------------------------------------------
# Offer to log the CLI in now. Skipped when an API key is already configured
# (the key takes precedence) or when there's no terminal to drive the flow.
# Uses `claude setup-token`, the only launchable login path: plain `/login`
# only works inside the interactive TUI. setup-token requires a Claude
# subscription (Pro or Max), so we say so up front.
claude_login() {
  [ -n "${MYHQ_API_KEY:-}" ] && return 0
  local env="$APP_DIR/.env"
  if [ -f "$env" ] && grep -Eq '^[[:space:]]*ANTHROPIC_API_KEY=.+' "$env"; then
    return 0
  fi
  command -v claude >/dev/null 2>&1 || {
    say "Claude CLI not on PATH yet — open a new shell, then run ${B}claude setup-token${R} to log in."
    return 0
  }
  [ -z "$TTY" ] && {
    say "No terminal for interactive login — run ${B}claude setup-token${R} later (needs a Pro/Max plan)."
    return 0
  }
  printf '\n%s\n' "${DIM}Claude Code authenticates with your Anthropic login (a Pro or Max plan), or an API key.${R}" >"$TTY"
  confirm "Log in to Claude now? (opens a browser; needs a Pro/Max subscription)" "Y" || {
    say "Skipping login — run ${B}claude setup-token${R} later, or set ANTHROPIC_API_KEY in $env."
    return 0
  }
  say "Launching ${B}claude setup-token${R}… follow the browser prompt."
  claude setup-token <"$TTY" >"$TTY" 2>&1 || \
    warn "Login didn't complete — run ${B}claude setup-token${R} later (needs a Pro/Max plan) or set an API key."
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

# --- panel (optional web dashboard) ----------------------------------------

# Returns 0 if nothing is listening on the given TCP port.
port_free() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ! ss -tnlp 2>/dev/null | grep -q ":${port}[[:space:]]" && return 0
  elif command -v lsof >/dev/null 2>&1; then
    ! lsof -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | grep -q . && return 0
  else
    ! nc -z 127.0.0.1 "$port" 2>/dev/null && return 0
  fi
  return 1
}

# Generates a cryptographically random token (tries openssl, then python3, then urandom).
gen_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-48
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import secrets; print(secrets.token_urlsafe(48))"
  else
    head -c 48 /dev/urandom | base64 | tr -d '=+/\n' | cut -c1-48
  fi
}

configure_panel() {
  local env="$APP_DIR/.env"
  local choice="${MYHQ_PANEL:-}"

  printf '\n' >"${TTY:-/dev/stdout}"
  if [ -z "$choice" ]; then
    printf '%s\n' "${B}MyHQ Panel${R} ${DIM}(embedded web dashboard — health, sessions, tasks, memory, vault, and more)${R}" >"${TTY:-/dev/stdout}"
    if confirm "Enable the panel? (recommended)" "Y"; then choice=y; else choice=n; fi
  fi

  if [ "$choice" != "y" ]; then
    ok "Panel skipped. Enable later: set PANEL_ENABLED=true and PANEL_TOKEN in .env."
    return
  fi

  # Port — default 8787, check if taken, fall through to manual entry.
  local port="${MYHQ_PANEL_PORT:-8787}"
  if [ -z "${MYHQ_PANEL_PORT:-}" ]; then
    if ! port_free "$port"; then
      warn "Port $port is already in use by another service."
      port="$(ask "Enter an alternative port" "8788")"
    else
      port="$(ask "Panel port" "$port")"
    fi
  fi
  if ! port_free "$port"; then
    warn "Port $port still appears busy — you can change PANEL_PORT in .env later."
  fi

  # Token — auto-generate (recommended) or enter manually.
  local token="${MYHQ_PANEL_TOKEN:-}"
  # The panel rejects tokens shorter than 16 chars (SEC-3); if one was passed
  # in via the env override, replace it with a strong generated one.
  if [ -n "$token" ] && [ "${#token}" -lt 16 ]; then
    warn "MYHQ_PANEL_TOKEN is shorter than 16 chars — using an auto-generated token instead."
    token=""
  fi
  if [ -z "$token" ]; then
    printf '\n%s\n' "${B}Panel token${R} ${DIM}(the password for all panel access — treat it like a root password)${R}" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}1)${R} Auto-generate a strong random token ${DIM}(recommended)${R}" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}2)${R} Enter my own" >"${TTY:-/dev/stdout}"
    case "$(ask "Choose 1 or 2" "1")" in
      2)
        token="$(ask "Your token (min 16 characters)" "")"
        if [ "${#token}" -lt 16 ]; then
          warn "Too short — falling back to an auto-generated token."
          token=""
        fi
        ;;
    esac
    [ -z "$token" ] && token="$(gen_token)"
  fi

  set_env "$env" PANEL_ENABLED true
  set_env "$env" PANEL_TOKEN   "$token"
  set_env "$env" PANEL_PORT    "$port"

  PANEL_PORT_CHOSEN="$port"
  PANEL_TOKEN_CHOSEN="$token"

  ok "Panel enabled on port $port."
  printf '%s\n' "  Token: ${B}${token}${R} ${DIM}(also saved to .env — keep it private)${R}" >"${TTY:-/dev/stdout}"
}

# --- remote access (optional tunnel relay) ----------------------------------
# Installs a tunnel CLI (ngrok and/or cloudflared) and flips PANEL_TUNNEL_ENABLED
# so the user can reach the panel from their phone over a secure public URL,
# still behind the panel login. Only offered when the panel is on. The relay
# itself is started later from the panel's Remote Access view, not here.
install_tunnel_cli() {
  # $1 = ngrok | cloudflared. Returns 0 on success.
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then ok "$name present."; return 0; fi
  say "Installing ${name}…"
  if [ "$OS" = "mac" ]; then
    case "$name" in
      ngrok)       brew install ngrok 2>/dev/null || brew install ngrok/ngrok/ngrok 2>/dev/null ;;
      cloudflared) brew install cloudflared 2>/dev/null ;;
    esac
  else
    case "$name" in
      ngrok)
        # ngrok publishes an apt repo; fall back to the raw binary otherwise.
        if [ "${PKG:-}" = "apt" ] || command -v apt-get >/dev/null 2>&1; then
          need_sudo
          curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
            | $SUDO tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null 2>&1 || true
          echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
            | $SUDO tee /etc/apt/sources.list.d/ngrok.list >/dev/null 2>&1 || true
          $SUDO apt-get update -y >/dev/null 2>&1 || true
          $SUDO apt-get install -y ngrok >/dev/null 2>&1 || true
        fi ;;
      cloudflared)
        pkg_install cloudflared >/dev/null 2>&1 || true ;;
    esac
  fi
  if command -v "$name" >/dev/null 2>&1; then
    ok "$name installed."; return 0
  fi
  case "$name" in
    ngrok)       warn "Couldn't install ngrok automatically — get it from https://ngrok.com/download." ;;
    cloudflared) warn "Couldn't install cloudflared automatically — see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/." ;;
  esac
  return 1
}

configure_remote_access() {
  local env="$APP_DIR/.env"
  # No point exposing a panel that isn't enabled.
  [ -n "$PANEL_PORT_CHOSEN" ] || return 0

  local choice="${MYHQ_REMOTE:-}"
  if [ -z "$choice" ]; then
    printf '\n%s\n' "${B}Reach the panel from your phone?${R} ${DIM}(secure public tunnel to this panel, still behind your login)${R}" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}1)${R} No, local only ${DIM}(default, most secure)${R}" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}2)${R} Cloudflare ${DIM}(free quick tunnel, no account or token needed)${R}" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}3)${R} ngrok ${DIM}(needs a free authtoken from ngrok.com)${R}" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}4)${R} Install both, decide later in the panel" >"${TTY:-/dev/stdout}"
    case "$(ask "Choose 1-4" "1")" in
      2) choice=cloudflare ;; 3) choice=ngrok ;; 4) choice=both ;; *) choice=none ;;
    esac
  fi

  case "$choice" in
    none)
      ok "Remote access off. Enable it later in the panel's Remote Access view."
      return ;;
    cloudflare)  install_tunnel_cli cloudflared || true ;;
    ngrok)       install_tunnel_cli ngrok || true ;;
    both)        install_tunnel_cli cloudflared || true; install_tunnel_cli ngrok || true ;;
  esac

  set_env "$env" PANEL_TUNNEL_ENABLED true
  ok "Remote access unlocked. Open the panel's ${B}Remote Access${R} view to start the tunnel (Cloudflare needs no token). Ask the bot /status from Telegram for the public URL."
  if [ "$choice" = "ngrok" ] || [ "$choice" = "both" ]; then
    say "  ngrok needs a free authtoken from https://dashboard.ngrok.com/get-started/your-authtoken, paste it in that view."
  fi
}

# --- voice (optional) -------------------------------------------------------
configure_voice() {
  local env="$APP_DIR/.env"
  local choice="${MYHQ_VOICE:-}"
  if [ -z "$choice" ]; then
    printf '\n%s\n' "${B}Voice notes?${R} ${DIM}(transcribe Telegram voice messages into prompts)${R}" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}1)${R} Skip" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}2)${R} Cloud API ${DIM}(OpenAI, or Groq's free tier)${R}" >"${TTY:-/dev/stdout}"
    printf '%s\n' "  ${B}3)${R} Local / offline ${DIM}(Vosk + ffmpeg, English)${R}" >"${TTY:-/dev/stdout}"
    case "$(ask "Choose 1, 2 or 3" "1")" in
      2) choice=api ;; 3) choice=vosk ;; *) choice=none ;;
    esac
  fi

  case "$choice" in
    api)
      local key; key="${MYHQ_OPENAI_KEY:-$(ask "Transcription API key (OpenAI or Groq)" "")}"
      set_env "$env" TRANSCRIBE_PROVIDER openai
      [ -n "$key" ] && set_env "$env" OPENAI_API_KEY "$key"
      say "For Groq's free tier, set TRANSCRIBE_BASE_URL + TRANSCRIBE_MODEL in .env (see its comments)."
      ok "Voice via API configured."
      ;;
    vosk)
      ensure_ffmpeg || warn "Vosk needs ffmpeg — install it before using voice."
      say "Installing the vosk npm package (optional native dependency)…"
      ( cd "$APP_DIR" && npm install vosk ) \
        || warn "vosk failed to build — see the README; you can retry 'npm install vosk' later."
      local model; model="$(install_vosk_model)" || model=""
      if [ -n "$model" ]; then
        set_env "$env" TRANSCRIBE_PROVIDER vosk
        set_env "$env" VOSK_MODEL_PATH "$model"
        ok "Local voice (Vosk) configured."
      else
        warn "Model not installed. Download one from https://alphacephei.com/vosk/models,"
        warn "set VOSK_MODEL_PATH to it and TRANSCRIBE_PROVIDER=vosk in $env."
      fi
      ;;
    *) ok "Skipping voice setup." ;;
  esac
}

# Download + unpack the small English Vosk model into <app>/models; echoes its
# path on stdout (logs go to stderr so they don't pollute the captured path).
install_vosk_model() {
  local url="https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
  local dir="$APP_DIR/models" target="$APP_DIR/models/vosk-model-small-en-us-0.15"
  [ -d "$target" ] && { printf '%s' "$target"; return 0; }
  command -v unzip >/dev/null 2>&1 || pkg_install unzip >/dev/null 2>&1 || {
    echo "unzip not available" >&2; return 1; }
  mkdir -p "$dir"
  say "Downloading Vosk English model (~40MB)…" >&2
  curl -fsSL "$url" -o "$dir/model.zip" || return 1
  unzip -q "$dir/model.zip" -d "$dir" || return 1
  rm -f "$dir/model.zip"
  [ -d "$target" ] && printf '%s' "$target"
}

# --- run mode ---------------------------------------------------------------
choose_run_mode() {
  local mode="${MYHQ_MODE:-}"
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
  local panel_line=""
  if [ -n "$PANEL_PORT_CHOSEN" ]; then
    panel_line="  • Open the panel:   ${B}http://127.0.0.1:${PANEL_PORT_CHOSEN}${R}  (unlock with the token saved to .env)"$'\n'
  fi

  cat <<EOF

${GR}${B}Done.${R} MyHQ is installed at ${B}${APP_DIR}${R}.

${B}Next steps${R}
  • If you didn't log in or set an API key: ${B}claude setup-token${R}  (needs a Pro/Max plan)
${panel_line}  • Tune the operator playbook: ${B}${APP_DIR}/work.md${R}
  • Manage the service: ${B}${APP_DIR}/scripts/agentctl.sh${R} {start|stop|restart|status|logs}
  • Update later:        ${B}${APP_DIR}/scripts/update.sh${R}
  • Uninstall service:   ${B}${APP_DIR}/scripts/uninstall-service.sh${R}

${B}Learn more${R}
  • Repo:     https://github.com/gyorgysh/myhq
  • Tutorial: ${TUTORIAL}

${YE}Reminder:${R} this bot can read, write, and run anything on this machine.
Keep ALLOWED_USER_IDS tight.
EOF
}

main() {
  printf '\n%s\n%s\n\n' \
    "${B}MyHQ installer${R}" \
    "${DIM}Claude Code, driven from Telegram.${R}"
  detect_os
  check_ram_swap
  ensure_homebrew
  ensure_node
  ensure_git
  ensure_claude_cli
  ensure_ollama
  clone_repo
  build_app
  configure_env
  claude_login
  configure_panel
  configure_remote_access
  configure_voice
  choose_run_mode
  final_notes
}

main "$@"
