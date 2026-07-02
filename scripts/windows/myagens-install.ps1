#Requires -Version 5.1
<#
.SYNOPSIS
    MyAgens Windows installer — sets up Claude Code Telegram bot on Windows.

.DESCRIPTION
    One-shot wizard for Windows 10/11 (PowerShell 5.1+).
    Installs prerequisites (Node 20+, Git, Claude Code CLI), clones the repo,
    builds it, walks you through .env configuration, and optionally installs a
    Windows service via NSSM or a Task Scheduler entry.

    Run from an elevated PowerShell prompt, or allow the script to self-elevate.

.EXAMPLE
    # Download and run directly:
    irm https://gyorgy.sh/myagens-install.ps1 | iex

    # Or with overrides:
    $env:MYAGENS_REPO="https://github.com/yourfork/myagens.git"; iwr ... | iex

.NOTES
    Non-interactive overrides (set before running):
      MYAGENS_REPO         Git repository URL
      MYAGENS_DIR          Install directory (default: $HOME\myagens)
      MYAGENS_BRANCH       Branch to clone (default: main)
      MYAGENS_TOKEN        Telegram bot token
      MYAGENS_USER_IDS     Comma-separated allowed Telegram user IDs
      MYAGENS_API_KEY      Anthropic API key
      MYAGENS_MODEL        Default Claude model id (skips the model menu)
      MYAGENS_MODE         service | manual (default: prompt)
      MYAGENS_SVC_PASSWORD Windows password to run the service as the current user
                        (blank/unset = run as LocalSystem)
      MYAGENS_PANEL        y | n  (enable the web dashboard)
      MYAGENS_PANEL_PORT   Panel port number (default: 8787)
      MYAGENS_PANEL_TOKEN  Panel access token (auto-generated if empty)
      MYAGENS_HOSTS        y | n  (add a 'myagens' -> 127.0.0.1 hosts entry)
      MYAGENS_REMOTE       none | ngrok | cloudflare | both (phone access tunnel)
      MYAGENS_YES          Set to 1 to accept all defaults without prompting
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# npm/npx/claude ship PowerShell shims (npm.ps1, …). On a machine whose execution
# policy is Restricted (the Windows default) those shims fail to load with
# "running scripts is disabled on this system". Relax the policy for THIS process
# only — no admin needed, not persisted to the machine/user — so the child .ps1
# shims this installer calls can run.
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch {}

# ---------------------------------------------------------------------------
# Config / defaults
# ---------------------------------------------------------------------------
$RepoUrl    = if ($env:MYAGENS_REPO)   { $env:MYAGENS_REPO }   else { "https://github.com/gyorgysh/myagens.git" }
$Branch     = if ($env:MYAGENS_BRANCH) { $env:MYAGENS_BRANCH } else { "main" }
$InstallDir = if ($env:MYAGENS_DIR)    { $env:MYAGENS_DIR }    else { Join-Path $HOME "myagens" }
$MinNode    = 20
$AutoYes    = $env:MYAGENS_YES -eq "1"
$Tutorial   = "https://gyorgy.sh/blog/myagens"

$Script:PanelPortChosen  = ""
$Script:PanelTokenChosen = ""
$Script:ServiceMode      = ""   # "service" once the bot is installed as a service
$Script:HostnameAdded    = $false  # $true once 'myagens' resolves locally (existing or freshly added)
$Script:HostsFile        = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"

# ---------------------------------------------------------------------------
# Pretty output helpers
# ---------------------------------------------------------------------------
function Say   { param([string]$Msg) Write-Host "• $Msg" -ForegroundColor Cyan }
function Ok    { param([string]$Msg) Write-Host "✓ $Msg" -ForegroundColor Green }
function Warn  { param([string]$Msg) Write-Host "! $Msg" -ForegroundColor Yellow }
function Err   { param([string]$Msg) Write-Host "✖ $Msg" -ForegroundColor Red }
function Die   { param([string]$Msg) Err $Msg; exit 1 }
function Title { param([string]$Msg) Write-Host "`n=== $Msg ===" -ForegroundColor Magenta }

# ---------------------------------------------------------------------------
# Interactive prompt helpers
# ---------------------------------------------------------------------------
function Ask {
    param([string]$Prompt, [string]$Default = "")
    if ($AutoYes -and $Default) { return $Default }
    if ($Default) { $hint = " [$Default]" } else { $hint = "" }
    $ans = Read-Host "$Prompt$hint"
    if ([string]::IsNullOrWhiteSpace($ans)) { return $Default }
    return $ans.Trim()
}

function Confirm {
    param([string]$Prompt, [bool]$DefaultYes = $true)
    # -AutoYes accepts the DEFAULT choice, not an unconditional yes. A default-No
    # prompt guards a destructive/overwrite action (e.g. reconfiguring an existing
    # .env), so an unattended run declines it rather than clobbering saved state.
    if ($AutoYes) { return $DefaultYes }
    $hint = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
    $ans = Read-Host "$Prompt $hint"
    if ([string]::IsNullOrWhiteSpace($ans)) { return $DefaultYes }
    return $ans -match "^[Yy]"
}

# ---------------------------------------------------------------------------
# Admin check
# ---------------------------------------------------------------------------
function Ensure-Admin {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return }

    # Self-elevation via UAC is unreliable when the script is piped through
    # `irm … | iex` (there is no file to relaunch), so instead give clear, plain
    # instructions and stop. Installing the service needs admin rights.
    Write-Host ""
    Err "MyAgens must be installed from an Administrator PowerShell."
    Write-Host ""
    Write-Host "  How to open one:" -ForegroundColor Cyan
    Write-Host "    1. Press the Windows key"
    Write-Host "    2. Type:  powershell"
    Write-Host "    3. Right-click 'Windows PowerShell' and choose 'Run as administrator'"
    Write-Host ""
    Write-Host "  Then run these two lines:" -ForegroundColor Cyan
    Write-Host "    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force"
    Write-Host "    irm https://gyorgy.sh/myagens-install.ps1 | iex"
    Write-Host ""
    # Pause so the window doesn't vanish before this can be read (a freshly
    # launched window closes the moment the script exits). Skipped in automation.
    if (-not $AutoYes) { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}

# ---------------------------------------------------------------------------
# Native command helper
# ---------------------------------------------------------------------------
function Invoke-Quiet {
    # Run a native command and swallow its output. Many CLIs (npm, winget, …)
    # write warnings/progress to stderr; under $ErrorActionPreference = "Stop"
    # a `2>&1` merge turns that into a terminating NativeCommandError. Drop to
    # "Continue" for the call so only a real non-zero exit code is treated as a
    # failure by the caller (via $LASTEXITCODE).
    param([scriptblock]$Cmd)
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Cmd 2>&1 | Out-Null } finally { $ErrorActionPreference = $old }
}

# Verify a Windows account password before we hand it to a service registration.
# Returns $true / $false when it can check, or $null when verification isn't
# possible (e.g. a domain controller is unreachable) — the caller then relies on
# the post-start status check as a backstop.
function Test-WindowsPassword {
    param([string]$User, [string]$Password)
    try {
        Add-Type -AssemblyName System.DirectoryServices.AccountManagement -ErrorAction Stop
        $ctxType = if ($env:USERDOMAIN -ne $env:COMPUTERNAME) {
            [System.DirectoryServices.AccountManagement.ContextType]::Domain
        } else {
            [System.DirectoryServices.AccountManagement.ContextType]::Machine
        }
        $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext($ctxType)
        return $ctx.ValidateCredentials($User, $Password)
    } catch {
        return $null
    }
}

# Obtain a *validated* Windows password for the service account. Non-interactive:
# reads MYAGENS_SVC_PASSWORD. Interactive: prompts up to 3 times, re-asking on a wrong
# password. Returns the plaintext password, or $null if none could be obtained
# (the caller then aborts — we never silently run the service as the wrong identity).
function Get-ServicePassword {
    param([string]$User)
    $name = ($User -split "\\")[-1]   # SAM account name (strip DOMAIN\)

    if ($env:MYAGENS_SVC_PASSWORD) {
        if ((Test-WindowsPassword $name $env:MYAGENS_SVC_PASSWORD) -eq $false) {
            Err "MYAGENS_SVC_PASSWORD is incorrect for $User."
            return $null
        }
        return $env:MYAGENS_SVC_PASSWORD
    }

    if ($AutoYes) { return $null }   # unattended and no password supplied

    for ($i = 1; $i -le 3; $i++) {
        Write-Host "  The service runs as your account ($User) so it uses your Claude login." -ForegroundColor Cyan
        $pw = Read-Host "  Windows password for $User" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        if (-not $plain) { Warn "Password can't be empty."; continue }
        # $true = verified, $false = wrong, $null = couldn't verify (e.g. domain DC
        # unreachable) — accept the latter and let the post-start check catch it.
        if ((Test-WindowsPassword $name $plain) -eq $false) {
            Warn "That password didn't validate — try again ($i/3)."
            continue
        }
        return $plain
    }
    return $null
}

# ---------------------------------------------------------------------------
# Prerequisite checks / installs
# ---------------------------------------------------------------------------
function Get-NodeVersion {
    try { $v = & node --version 2>$null; return [int]($v -replace "^v(\d+).*",'$1') }
    catch { return 0 }
}

function Ensure-Node {
    $ver = Get-NodeVersion
    if ($ver -ge $MinNode) { Ok "Node.js $ver found."; return }

    Say "Node.js $MinNode+ not found. Installing via winget…"
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Die "winget not available. Install Node.js $MinNode+ manually from https://nodejs.org and re-run."
    }
    winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
    $ver = Get-NodeVersion
    if ($ver -lt $MinNode) {
        Die "Node.js install completed but version check failed. Open a new terminal and re-run."
    }
    Ok "Node.js $ver installed."
}

function Ensure-Git {
    if (Get-Command git -ErrorAction SilentlyContinue) { Ok "Git found."; return }
    Say "Git not found. Installing via winget…"
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Die "winget not available. Install Git from https://git-scm.com and re-run."
    }
    winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Die "Git install completed but 'git' still not found. Open a new terminal and re-run."
    }
    Ok "Git installed."
}

function Ensure-ClaudeCLI {
    if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "Claude Code CLI found."; return }
    Say "Installing Claude Code CLI (npm install -g @anthropic-ai/claude-code)…"
    Invoke-Quiet { npm.cmd install -g "@anthropic-ai/claude-code" }
    # npm installs global bins to %APPDATA%\npm, which is often NOT on the current
    # session PATH yet — so without adding it here, `Get-Command claude` fails and
    # the later login step silently skips, leaving the bot with no credentials.
    $npmBin = Join-Path $env:APPDATA "npm"
    if ((Test-Path $npmBin) -and ($env:Path -notlike "*$npmBin*")) {
        $env:Path = "$env:Path;$npmBin"
    }
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Warn "Claude CLI not in PATH yet — you may need to re-open your terminal after setup."
    } else {
        Ok "Claude Code CLI installed."
    }
}

function Ensure-Ollama {
    # Opt-in (heavy ~275MB model). Powers local semantic memory via nomic-embed-text.
    if (-not (Confirm "Install Ollama + pull nomic-embed-text for local semantic memory?" $true)) {
        Say "Skipping Ollama — semantic memory stays keyword-only (enable later in the panel)."
        return
    }
    if (Get-Command ollama -ErrorAction SilentlyContinue) {
        Ok "Ollama found."
    } else {
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            Warn "winget not available — install Ollama from https://ollama.com/download and re-run."
            return
        }
        Say "Installing Ollama via winget…"
        try {
            winget install --id Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements 2>$null
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("Path","User")
        } catch {
            Warn "Ollama install failed — get it from https://ollama.com/download."
            return
        }
        if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
            Warn "Ollama installed but not in PATH yet — open a new terminal, then run 'ollama pull nomic-embed-text'."
            return
        }
        Ok "Ollama installed."
    }
    Say "Pulling nomic-embed-text (~275MB)…"
    try {
        Invoke-Quiet { ollama pull nomic-embed-text }
        if ($LASTEXITCODE -ne 0) { throw "ollama pull exited $LASTEXITCODE" }
        Ok "Embedding model ready — semantic memory will auto-enable."
    } catch {
        Warn "Couldn't pull nomic-embed-text — run 'ollama pull nomic-embed-text' once the daemon is up."
    }
}

# ---------------------------------------------------------------------------
# Clone / build
# ---------------------------------------------------------------------------
function Clone-Repo {
    if (Test-Path (Join-Path $InstallDir ".git")) {
        Ok "Repo already cloned at $InstallDir."
        return
    }
    Say "Cloning $RepoUrl (branch: $Branch) → $InstallDir"
    $parent = Split-Path $InstallDir -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    git clone --branch $Branch --depth 1 $RepoUrl $InstallDir
    Ok "Cloned."
}

function Build-App {
    Say "Installing npm dependencies…"
    Push-Location $InstallDir
    try {
        npm.cmd install
        Say "Building…"
        npm.cmd run build
        Ok "Build complete."
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# Port check and token generation
# ---------------------------------------------------------------------------
function Test-PortFree {
    param([int]$Port)
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        return ($null -eq $conns -or $conns.Count -eq 0)
    } catch {
        # Fallback: attempt a connection — failure means the port is free.
        $tcp = New-Object System.Net.Sockets.TcpClient
        try { $tcp.Connect('127.0.0.1', $Port); $tcp.Close(); return $false }
        catch { return $true }
        finally { $tcp.Dispose() }
    }
}

function New-RandomToken {
    $bytes = New-Object byte[] 48
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([Convert]::ToBase64String($bytes) -replace '[+/=]')
}

# ---------------------------------------------------------------------------
# .env wizard
# ---------------------------------------------------------------------------
function Write-Env {
    param([hashtable]$Values)
    $envPath = Join-Path $InstallDir ".env"
    $lines = $Values.GetEnumerator() | ForEach-Object {
        if ($_.Value) { "$($_.Key)=$($_.Value)" }
    }
    $lines | Set-Content -Path $envPath -Encoding UTF8
    Ok ".env written to $envPath"
}

function Configure-Env {
    $envPath = Join-Path $InstallDir ".env"
    if (Test-Path $envPath) {
        if (-not (Confirm "A .env already exists. Reconfigure it?" $false)) { return }
    }

    Title "Configuration"
    Write-Host "  You will need a Telegram bot token and your Telegram user ID."
    Write-Host "  Tutorial: $Tutorial`n"

    $token   = if ($env:MYAGENS_TOKEN)    { $env:MYAGENS_TOKEN }    else { Ask "Telegram bot token (from @BotFather)" }
    $userIds = if ($env:MYAGENS_USER_IDS) { $env:MYAGENS_USER_IDS } else { Ask "Your Telegram user ID(s), comma-separated" }
    $apiKey  = if ($env:MYAGENS_API_KEY)  { $env:MYAGENS_API_KEY }  else { Ask "Anthropic API key (blank = log in with a Pro/Max plan instead)" "" }

    if ($env:MYAGENS_MODEL) {
        $model = $env:MYAGENS_MODEL
    } else {
        Write-Host ""
        Write-Host "  Which Claude model should the bot use by default?" -ForegroundColor Cyan
        Write-Host "  Don't overthink it — you can change this anytime later in the panel or with /model in Telegram." -ForegroundColor DarkGray
        Write-Host "    1) Opus   - most capable           (claude-opus-4-8)   [recommended]"
        Write-Host "    2) Sonnet - faster, well-balanced  (claude-sonnet-5)"
        Write-Host "    3) Haiku  - fastest and cheapest   (claude-haiku-4-5-20251001)"
        Write-Host "    4) Enter a custom model name"
        switch (Ask "Choose 1-4" "1") {
            "2"     { $model = "claude-sonnet-5" }
            "3"     { $model = "claude-haiku-4-5-20251001" }
            "4"     { $model = Ask "Custom model name" "claude-opus-4-8" }
            default { $model = "claude-opus-4-8" }
        }
    }
    $workdir = Ask "Agent working directory (where files go)" (Join-Path $env:USERPROFILE "MyAgens-Workspace")
    $lang    = Ask "Default agent language (en, hu, fr, …)" "en"

    # Panel
    Title "MyAgens Panel"
    Write-Host "  Optional embedded web dashboard — health, sessions, tasks, memory, vault, and more."
    $panelChoice = if ($env:MYAGENS_PANEL) { $env:MYAGENS_PANEL } else { "" }
    $panelEnabled = if ($panelChoice -eq "y") { $true } elseif ($panelChoice -eq "n") { $false } else {
        Confirm "Enable the panel? (recommended)" $true
    }

    $panelToken = ""
    $panelPort  = "8787"

    if ($panelEnabled) {
        # Port — check if taken, offer alternative.
        $defaultPort = if ($env:MYAGENS_PANEL_PORT) { $env:MYAGENS_PANEL_PORT } else { "8787" }
        if (-not (Test-PortFree ([int]$defaultPort))) {
            Warn "Port $defaultPort is already in use by another service."
            $defaultPort = "8788"
        }
        $panelPort = Ask "Panel port" $defaultPort
        if (-not (Test-PortFree ([int]$panelPort))) {
            Warn "Port $panelPort also appears busy. You can change PANEL_PORT in .env later."
        }

        # Token — auto-generate or manual. The panel rejects tokens shorter
        # than 16 chars (SEC-3); replace a too-short env override with a strong one.
        if ($env:MYAGENS_PANEL_TOKEN -and $env:MYAGENS_PANEL_TOKEN.Length -lt 16) {
            Warn "MYAGENS_PANEL_TOKEN is shorter than 16 chars — using an auto-generated token instead."
            $panelToken = New-RandomToken
        } elseif ($env:MYAGENS_PANEL_TOKEN) {
            $panelToken = $env:MYAGENS_PANEL_TOKEN
        } else {
            Write-Host ""
            Write-Host "  Panel token — the password for all panel access." -ForegroundColor Cyan
            Write-Host "  1) Auto-generate a strong random token (recommended)"
            Write-Host "  2) Enter my own"
            $tokenChoice = Ask "Choose 1 or 2" "1"
            if ($tokenChoice -eq "2") {
                $entered = Ask "Your token (min 16 characters)" ""
                if ($entered.Length -lt 16) {
                    Warn "Too short — using an auto-generated token instead."
                    $panelToken = New-RandomToken
                } else {
                    $panelToken = $entered
                }
            } else {
                $panelToken = New-RandomToken
            }
        }

        $Script:PanelPortChosen  = $panelPort
        $Script:PanelTokenChosen = $panelToken
        Write-Host ""
        Ok "Panel configured on port $panelPort."
        Write-Host "  Token: $panelToken" -ForegroundColor Yellow
        Write-Host "  (Also saved to .env — keep it private.)" -ForegroundColor DarkGray
    }

    Write-Env @{
        TELEGRAM_BOT_TOKEN = $token
        ALLOWED_USER_IDS   = $userIds
        ANTHROPIC_API_KEY  = $apiKey
        CLAUDE_MODEL       = $model
        WORKDIR            = $workdir
        DEFAULT_LANGUAGE   = $lang
        PANEL_ENABLED      = if ($panelEnabled) { "true" } else { "false" }
        PANEL_TOKEN        = $panelToken
        PANEL_PORT         = $panelPort
    }
}

# ---------------------------------------------------------------------------
# Local hostname (optional hosts-file entry)
# ---------------------------------------------------------------------------
# Map 'myagens' to 127.0.0.1 in the Windows hosts file so the panel is reachable
# at http://myagens instead of http://127.0.0.1. Local-only convenience; the
# installer already runs elevated (Ensure-Admin), so the write normally succeeds.
# Idempotent: a second run detects the existing entry and leaves the file alone.
function Test-HostnamePresent {
    if (-not (Test-Path $Script:HostsFile)) { return $false }
    # Match an active (non-commented) line that lists 'myagens' as a host alias.
    $pattern = '^\s*[^#].*\bmyagens\b'
    return [bool](Select-String -Path $Script:HostsFile -Pattern $pattern -Quiet -ErrorAction SilentlyContinue)
}

function Configure-Hostname {
    # Only meaningful when the panel is on — otherwise there's nothing to reach.
    if (-not $Script:PanelPortChosen) { return }

    if (Test-HostnamePresent) {
        $Script:HostnameAdded = $true
        Ok "'myagens' already resolves locally — panel reachable at http://myagens:$($Script:PanelPortChosen)."
        return
    }

    $choice = $env:MYAGENS_HOSTS
    if (-not $choice) {
        Write-Host ""
        $choice = if (Confirm "Add 'myagens' as a local hostname for this machine?" $true) { "y" } else { "n" }
    }
    if ($choice -notmatch '^(y|yes)$') { return }

    try {
        # The installer runs elevated, so a plain append works. Tag the line so
        # uninstall can find it and a human reading the file knows who added it.
        Add-Content -Path $Script:HostsFile -Value "127.0.0.1`tmyagens`t# added by MyAgens installer" -ErrorAction Stop
        if (Test-HostnamePresent) {
            $Script:HostnameAdded = $true
            Ok "Added 'myagens' to the hosts file — panel reachable at http://myagens:$($Script:PanelPortChosen)."
        } else {
            Warn "Couldn't update the hosts file — the panel is still reachable at http://127.0.0.1:$($Script:PanelPortChosen)."
        }
    } catch {
        # Don't fail the install over a nice-to-have (e.g. AV lock on the hosts file).
        Warn "Skipping hostname setup — couldn't write $($Script:HostsFile). Panel stays at http://127.0.0.1:$($Script:PanelPortChosen)."
    }
}

# ---------------------------------------------------------------------------
# Remote access (optional tunnel relay)
# ---------------------------------------------------------------------------
function Install-TunnelCli {
    # $Name = ngrok | cloudflared. Returns $true on success.
    param([string]$Name)
    $wingetId = if ($Name -eq "ngrok") { "Ngrok.Ngrok" } else { "Cloudflare.cloudflared" }
    if (Get-Command $Name -ErrorAction SilentlyContinue) { Ok "$Name found."; return $true }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Warn "winget not available — install $Name manually, then start the tunnel from the panel."
        return $false
    }
    Say "Installing $Name via winget…"
    try {
        winget install --id $wingetId --silent --accept-package-agreements --accept-source-agreements 2>$null
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
    } catch { }
    if (Get-Command $Name -ErrorAction SilentlyContinue) { Ok "$Name installed."; return $true }
    Warn "$Name not on PATH yet — open a new terminal, or install it manually."
    return $false
}

function Configure-RemoteAccess {
    # Only meaningful when the panel is enabled.
    if (-not $Script:PanelPortChosen) { return }

    Title "Remote access"
    Write-Host "  Reach the panel from your phone over a secure public tunnel (still behind your login)."
    $choice = if ($env:MYAGENS_REMOTE) { $env:MYAGENS_REMOTE } else { "" }
    if (-not $choice) {
        Write-Host "  1) No, local only (default - most secure)"
        Write-Host "  2) Cloudflare (free quick tunnel, no account or token needed) [recommended]"
        Write-Host "  3) ngrok (needs a free authtoken from ngrok.com)"
        Write-Host "  4) Install both, decide later in the panel"
        switch (Ask "Choose 1-4" "1") {
            "2" { $choice = "cloudflare" }
            "3" { $choice = "ngrok" }
            "4" { $choice = "both" }
            default { $choice = "none" }
        }
    }

    if ($choice -eq "none") {
        Ok "Remote access off. Enable it later in the panel's Remote Access view."
        return
    }

    if ($choice -eq "ngrok" -or $choice -eq "both") { Install-TunnelCli "ngrok"      | Out-Null }
    if ($choice -eq "cloudflare" -or $choice -eq "both") { Install-TunnelCli "cloudflared" | Out-Null }

    # Flip the flag in the already-written .env.
    $envPath = Join-Path $InstallDir ".env"
    $lines = @(Get-Content $envPath | Where-Object { $_ -notmatch "^\s*#?\s*PANEL_TUNNEL_ENABLED=" })
    $lines += "PANEL_TUNNEL_ENABLED=true"
    $lines | Set-Content -Path $envPath -Encoding UTF8

    Ok "Remote access unlocked. Open the panel's Remote Access view to add a token (if needed) and start the tunnel."
    if ($choice -eq "ngrok" -or $choice -eq "both") {
        Write-Host "  ngrok needs a free authtoken from https://dashboard.ngrok.com/get-started/your-authtoken — paste it in that view." -ForegroundColor Cyan
    }
}

# ---------------------------------------------------------------------------
# Service installation (NSSM or Task Scheduler)
# ---------------------------------------------------------------------------
function Install-Service {
    Title "Service setup"
    $mode = if ($env:MYAGENS_MODE) { $env:MYAGENS_MODE } else {
        if (Confirm "Run as a background Windows service (auto-restart on boot)?") { "service" } else { "manual" }
    }

    if ($mode -ne "service") {
        Write-Host "`nTo start manually, run:"
        Write-Host "  cd `"$InstallDir`"; node dist\index.js" -ForegroundColor Cyan
        return
    }

    # Try NSSM first (best option — handles restarts, logging)
    $nssm = Get-Command nssm -ErrorAction SilentlyContinue
    if (-not $nssm) {
        Say "Trying to install NSSM via winget…"
        try {
            winget install --id NSSM.NSSM --silent --accept-package-agreements --accept-source-agreements 2>$null
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("Path","User")
            $nssm = Get-Command nssm -ErrorAction SilentlyContinue
        } catch { $nssm = $null }
    }

    $nodeBin = (Get-Command node).Source
    $entryPoint = Join-Path $InstallDir "dist\index.js"

    # Migrate a pre-rename install (re-running this installer against an
    # existing $InstallDir): remove the old 'myhq' NSSM service / 'MyHQ Bot'
    # task first so it doesn't keep running alongside the new one.
    if ($nssm) {
        $legacyStatus = "$(& nssm status myhq 2>$null)"
        if ($LASTEXITCODE -eq 0 -and $legacyStatus) {
            Say "Migrating from the old 'myhq' NSSM service…"
            & nssm stop myhq 2>$null | Out-Null
            & nssm remove myhq confirm 2>$null | Out-Null
        }
    }
    $legacyTask = Get-ScheduledTask -TaskName "MyHQ Bot" -ErrorAction SilentlyContinue
    if ($legacyTask) {
        Say "Migrating from the old 'MyHQ Bot' scheduled task…"
        Stop-ScheduledTask       -TaskName "MyHQ Bot" -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName "MyHQ Bot" -Confirm:$false -ErrorAction SilentlyContinue
    }

    if ($nssm) {
        $svcName = "myagens"
        Say "Installing NSSM service '$svcName'…"
        & nssm install $svcName $nodeBin $entryPoint
        & nssm set $svcName AppDirectory $InstallDir

        # PATH for the service session. Start from the installer's own working PATH
        # (which already has node, git and npm after the prerequisite steps) and
        # append the known tool dirs defensively. This is what lets the bot spawn
        # node/claude/git at runtime — without it you get "spawn git ENOENT", etc.
        $nodeDir = Split-Path $nodeBin -Parent
        $npmBin  = Join-Path $env:APPDATA "npm"
        $gitDir  = if (Get-Command git -ErrorAction SilentlyContinue) { Split-Path (Get-Command git).Source -Parent } else { "" }
        $svcPath = (@($env:Path, $nodeDir, $npmBin, $gitDir) | Where-Object { $_ }) -join ";"

        # The service runs as the installing user so it inherits their profile and
        # Claude login (the OAuth token lives in their %USERPROFILE%\.claude).
        # Windows requires the account password to register a service under a user —
        # we insist on a VALID one. No LocalSystem fallback: that would split the
        # bot's login from the user's and cause silent auth failures.
        $svcUser = "$env:USERDOMAIN\$env:USERNAME"
        $plainPw = Get-ServicePassword $svcUser
        if (-not $plainPw) {
            Die "A valid Windows password for $svcUser is required to run the service. Re-run and enter it (or set MYAGENS_SVC_PASSWORD), or choose manual run mode."
        }

        & nssm set $svcName ObjectName $svcUser $plainPw
        & nssm set $svcName AppEnvironmentExtra "NODE_ENV=production" "PATH=$svcPath"
        $plainPw = $null
        Ok "Service will run as $svcUser."

        & nssm set $svcName AppStdout (Join-Path $InstallDir "logs\myagens.log")
        & nssm set $svcName AppStderr (Join-Path $InstallDir "logs\myagens-err.log")
        & nssm set $svcName AppRotateFiles 1
        & nssm set $svcName AppRotateOnline 1
        New-Item -ItemType Directory -Path (Join-Path $InstallDir "logs") -Force | Out-Null

        # --- Crash recovery: auto-restart the service if the process exits. ---
        # NSSM's own restart engine (independent of the SCM recovery tab):
        #   AppExit Default Restart  -> on any exit code, restart the app.
        #   AppRestartDelay 5000     -> wait 5s before relaunching (ms).
        #   AppThrottle 5000         -> if it dies within 5s of starting, NSSM
        #                               treats it as a crash loop and backs off
        #                               (paused/throttled) instead of hammering.
        # This keeps the bot up across transient crashes without a fast respawn
        # storm. Also mirror it onto the Windows SCM recovery actions so the
        # Services snap-in shows "Restart the Service" on first/second/subsequent
        # failures (reset the failure counter after a day of stability).
        & nssm set $svcName AppExit Default Restart
        & nssm set $svcName AppRestartDelay 5000
        & nssm set $svcName AppThrottle 5000
        try {
            & sc.exe failure $svcName reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null
            & sc.exe failureflag $svcName 1 | Out-Null
        } catch { Warn "Could not set SCM recovery actions (NSSM auto-restart is still active)." }

        # NOTE: no service-object ACL grant is needed. The bot restarts itself
        # (panel Restart button and post-update) simply by EXITING — a process
        # is always allowed to terminate itself — and NSSM's AppExit Default
        # Restart (set above) relaunches it. That needs zero service-control
        # rights, so we don't fiddle with the service SDDL (which was fragile
        # and account-specific). See src/core/agentControl.ts restartService().

        & nssm start $svcName

        # Confirm it actually started (a bad 'log on as a service' right or an
        # unverifiable domain password would otherwise leave a stopped service).
        Start-Sleep -Seconds 2
        $status = "$(& nssm status $svcName 2>$null)"
        if ($status -notmatch "RUNNING") {
            Die "Service '$svcName' failed to start ($status). Check the password and the account's 'Log on as a service' right, then re-run. Logs: $InstallDir\logs\myagens-err.log"
        }

        $Script:ServiceMode = "service"
        Ok "Service '$svcName' installed and started."
        Write-Host "  Control: nssm start|stop|restart $svcName" -ForegroundColor Cyan
    } else {
        # Fall back to Task Scheduler
        Say "NSSM not available. Setting up Task Scheduler entry…"
        $taskName  = "MyAgens Bot"
        $startCmd  = "node"
        $startArgs = "`"$entryPoint`""
        $action    = New-ScheduledTaskAction -Execute $startCmd -Argument $startArgs -WorkingDirectory $InstallDir
        $trigger   = New-ScheduledTaskTrigger -AtLogOn
        $settings  = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
            -Settings $settings -Principal $principal -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName
        $Script:ServiceMode = "service"
        Ok "Task Scheduler entry '$taskName' created and started."
        Write-Host "  Control: Task Scheduler → $taskName" -ForegroundColor Cyan
    }
}

# ---------------------------------------------------------------------------
# Claude CLI login
# ---------------------------------------------------------------------------
function Claude-Login {
    if ($env:MYAGENS_API_KEY) { return }  # API key takes precedence
    $envPath = Join-Path $InstallDir ".env"
    $hasKey = Select-String -Path $envPath -Pattern "^ANTHROPIC_API_KEY=.+" -Quiet 2>$null
    if ($hasKey) { return }
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Say "Claude CLI not in PATH yet — re-open your terminal, then run 'claude setup-token' to log in."
        return
    }
    # `/login` only works inside the interactive TUI; `claude setup-token` is the
    # launchable login path and requires a Claude subscription (Pro or Max).
    Write-Host "`n  Claude Code authenticates with your Anthropic login (a Pro or Max plan), or an API key." -ForegroundColor DarkGray
    if (Confirm "Log in to Claude now? (opens a browser; needs a Pro/Max subscription)") {
        Push-Location $InstallDir
        try { claude setup-token }
        catch { Warn "Login didn't complete — run 'claude setup-token' later (needs a Pro/Max plan) or set an API key." }
        finally { Pop-Location }
    } else {
        Say "Skipping login — run 'claude setup-token' later, or set ANTHROPIC_API_KEY in $envPath."
    }
}

# ---------------------------------------------------------------------------
# Panel login link + browser auto-open
# ---------------------------------------------------------------------------
function Get-PanelLoginUrl {
    # Token in the query — the SPA consumes it on first load, then strips it
    # from the address bar. Empty when the panel is disabled.
    if (-not $Script:PanelPortChosen) { return "" }
    return "http://127.0.0.1:$($Script:PanelPortChosen)/?token=$($Script:PanelTokenChosen)"
}

function Open-Panel {
    # When the panel is enabled and the bot runs as a service, wait for the port
    # to come up, then open the one-click login URL in the default browser so the
    # user lands logged-in. Skipped in non-interactive ($AutoYes) runs.
    if (-not $Script:PanelPortChosen) { return }
    if ($Script:ServiceMode -ne "service") { return }
    if ($AutoYes) { return }

    Say "Waiting for the panel to come up..."
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Test-PortFree ([int]$Script:PanelPortChosen))) { break }  # not free = listening
        Start-Sleep -Milliseconds 500
    }

    # The installer runs elevated. A plain Start-Process of a URL often fails to
    # hand off to the user's (non-elevated) default browser, so it silently does
    # nothing. explorer.exe opens the URL in the user's context reliably; fall
    # back to Start-Process if explorer isn't available.
    $url = Get-PanelLoginUrl
    $opened = $false
    try { Start-Process "explorer.exe" -ArgumentList $url; $opened = $true } catch {}
    if (-not $opened) { try { Start-Process $url; $opened = $true } catch {} }
    if ($opened) {
        Ok "Opened the panel in your browser - you're logged in."
    } else {
        Warn "Couldn't auto-open a browser. Open the login link shown below manually."
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
Write-Host "`n  MyAgens Windows Installer" -ForegroundColor Magenta
Write-Host "  $Tutorial`n"

Ensure-Admin
Ensure-Node
Ensure-Git
Clone-Repo
Ensure-ClaudeCLI
Ensure-Ollama
Build-App
Configure-Env
Configure-Hostname
Configure-RemoteAccess
Claude-Login
Install-Service
Open-Panel

Write-Host "`n"
Ok "MyAgens installation complete!"
Write-Host "  Install dir : $InstallDir" -ForegroundColor Cyan
if ($Script:PanelPortChosen) {
    $panelHost = if ($Script:HostnameAdded) { "myagens" } else { "127.0.0.1" }
    Write-Host ""
    Write-Host "  Panel login" -ForegroundColor Cyan
    Write-Host "    One-click login link (token included — keep it private):"
    Write-Host "      http://${panelHost}:$($Script:PanelPortChosen)/?token=$($Script:PanelTokenChosen)" -ForegroundColor Yellow
    Write-Host "    Or open http://${panelHost}:$($Script:PanelPortChosen) and paste the token:"
    Write-Host "      $($Script:PanelTokenChosen)" -ForegroundColor Yellow
    Write-Host "      (also saved as PANEL_TOKEN in .env)" -ForegroundColor DarkGray
    Write-Host ""
}
Write-Host "  Tutorial    : $Tutorial" -ForegroundColor Cyan
Write-Host "  To update   : .\scripts\windows\update.ps1  (or use the panel's Updates view)" -ForegroundColor Cyan
Write-Host "  To uninstall: .\scripts\windows\uninstall.ps1" -ForegroundColor Cyan
Write-Host "  If not logged in / no API key: claude setup-token  (needs a Pro/Max plan)" -ForegroundColor Cyan
Write-Host ""
