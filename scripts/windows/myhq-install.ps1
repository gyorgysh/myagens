#Requires -Version 5.1
<#
.SYNOPSIS
    MyHQ Windows installer — sets up Claude Code Telegram bot on Windows.

.DESCRIPTION
    One-shot wizard for Windows 10/11 (PowerShell 5.1+).
    Installs prerequisites (Node 20+, Git, Claude Code CLI), clones the repo,
    builds it, walks you through .env configuration, and optionally installs a
    Windows service via NSSM or a Task Scheduler entry.

    Run from an elevated PowerShell prompt, or allow the script to self-elevate.

.EXAMPLE
    # Download and run directly:
    irm https://gyorgy.sh/myhq-install.ps1 | iex

    # Or with overrides:
    $env:MYHQ_REPO="https://github.com/yourfork/myhq.git"; iwr ... | iex

.NOTES
    Non-interactive overrides (set before running):
      MYHQ_REPO         Git repository URL
      MYHQ_DIR          Install directory (default: $HOME\myhq)
      MYHQ_BRANCH       Branch to clone (default: main)
      MYHQ_TOKEN        Telegram bot token
      MYHQ_USER_IDS     Comma-separated allowed Telegram user IDs
      MYHQ_API_KEY      Anthropic API key
      MYHQ_MODE         service | manual (default: prompt)
      MYHQ_PANEL        y | n  (enable the web dashboard)
      MYHQ_PANEL_PORT   Panel port number (default: 8787)
      MYHQ_PANEL_TOKEN  Panel access token (auto-generated if empty)
      MYHQ_REMOTE       none | ngrok | cloudflare | both (phone access tunnel)
      MYHQ_YES          Set to 1 to accept all defaults without prompting
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
$RepoUrl    = if ($env:MYHQ_REPO)   { $env:MYHQ_REPO }   else { "https://github.com/gyorgysh/myhq.git" }
$Branch     = if ($env:MYHQ_BRANCH) { $env:MYHQ_BRANCH } else { "main" }
$InstallDir = if ($env:MYHQ_DIR)    { $env:MYHQ_DIR }    else { Join-Path $HOME "myhq" }
$MinNode    = 20
$AutoYes    = $env:MYHQ_YES -eq "1"
$Tutorial   = "https://gyorgy.sh/blog/myhq"

$Script:PanelPortChosen  = ""
$Script:PanelTokenChosen = ""
$Script:ServiceMode      = ""   # "service" once the bot is installed as a service

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
    if ($AutoYes) { return $true }
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
    Err "MyHQ must be installed from an Administrator PowerShell."
    Write-Host ""
    Write-Host "  How to open one:" -ForegroundColor Cyan
    Write-Host "    1. Press the Windows key"
    Write-Host "    2. Type:  powershell"
    Write-Host "    3. Right-click 'Windows PowerShell' and choose 'Run as administrator'"
    Write-Host ""
    Write-Host "  Then run these two lines:" -ForegroundColor Cyan
    Write-Host "    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force"
    Write-Host "    irm https://gyorgy.sh/myhq-install.ps1 | iex"
    Write-Host ""
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
        if (-not (Confirm "A .env already exists. Reconfigure it?")) { return }
    }

    Title "Configuration"
    Write-Host "  You will need a Telegram bot token and your Telegram user ID."
    Write-Host "  Tutorial: $Tutorial`n"

    $token   = if ($env:MYHQ_TOKEN)    { $env:MYHQ_TOKEN }    else { Ask "Telegram bot token (from @BotFather)" }
    $userIds = if ($env:MYHQ_USER_IDS) { $env:MYHQ_USER_IDS } else { Ask "Your Telegram user ID(s), comma-separated" }
    $apiKey  = if ($env:MYHQ_API_KEY)  { $env:MYHQ_API_KEY }  else { Ask "Anthropic API key (blank = log in with a Pro/Max plan instead)" "" }

    $model   = Ask "Default Claude model" "claude-opus-4-8"
    $workdir = Ask "Agent working directory (where files go)" (Join-Path $InstallDir "data")
    $lang    = Ask "Default agent language (en, hu, fr, …)" "en"

    # Panel
    Title "MyHQ Panel"
    Write-Host "  Optional embedded web dashboard — health, sessions, tasks, memory, vault, and more."
    $panelChoice = if ($env:MYHQ_PANEL) { $env:MYHQ_PANEL } else { "" }
    $panelEnabled = if ($panelChoice -eq "y") { $true } elseif ($panelChoice -eq "n") { $false } else {
        Confirm "Enable the panel? (recommended)" $true
    }

    $panelToken = ""
    $panelPort  = "8787"

    if ($panelEnabled) {
        # Port — check if taken, offer alternative.
        $defaultPort = if ($env:MYHQ_PANEL_PORT) { $env:MYHQ_PANEL_PORT } else { "8787" }
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
        if ($env:MYHQ_PANEL_TOKEN -and $env:MYHQ_PANEL_TOKEN.Length -lt 16) {
            Warn "MYHQ_PANEL_TOKEN is shorter than 16 chars — using an auto-generated token instead."
            $panelToken = New-RandomToken
        } elseif ($env:MYHQ_PANEL_TOKEN) {
            $panelToken = $env:MYHQ_PANEL_TOKEN
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
    $choice = if ($env:MYHQ_REMOTE) { $env:MYHQ_REMOTE } else { "" }
    if (-not $choice) {
        Write-Host "  1) No, local only (default — most secure)"
        Write-Host "  2) ngrok (needs a free authtoken from ngrok.com)"
        Write-Host "  3) Cloudflare (free quick tunnel, no account needed)"
        Write-Host "  4) Install both, decide later in the panel"
        switch (Ask "Choose 1-4" "1") {
            "2" { $choice = "ngrok" }
            "3" { $choice = "cloudflare" }
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
    $mode = if ($env:MYHQ_MODE) { $env:MYHQ_MODE } else {
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

    if ($nssm) {
        $svcName = "myhq"
        Say "Installing NSSM service '$svcName'…"
        & nssm install $svcName $nodeBin $entryPoint
        & nssm set $svcName AppDirectory $InstallDir
        & nssm set $svcName AppEnvironmentExtra "NODE_ENV=production"
        & nssm set $svcName AppStdout (Join-Path $InstallDir "logs\myhq.log")
        & nssm set $svcName AppStderr (Join-Path $InstallDir "logs\myhq-err.log")
        & nssm set $svcName AppRotateFiles 1
        & nssm set $svcName AppRotateOnline 1
        New-Item -ItemType Directory -Path (Join-Path $InstallDir "logs") -Force | Out-Null
        & nssm start $svcName
        $Script:ServiceMode = "service"
        Ok "Service '$svcName' installed and started."
        Write-Host "  Control: nssm start|stop|restart $svcName" -ForegroundColor Cyan
    } else {
        # Fall back to Task Scheduler
        Say "NSSM not available. Setting up Task Scheduler entry…"
        $taskName  = "MyHQ Bot"
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
# Update script (scripts\windows\myhq-update.ps1 sibling)
# ---------------------------------------------------------------------------
function Write-UpdateScript {
    $updatePath = Join-Path $InstallDir "scripts\windows\myhq-update.ps1"
    $content = @"
# Auto-generated update script for MyHQ
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch {}
Set-Location '$InstallDir'
git pull origin $Branch
npm.cmd install
npm.cmd run build
nssm restart myhq 2>`$null; Start-ScheduledTask -TaskName 'MyHQ Bot' 2>`$null
Write-Host '✓ MyHQ updated and restarted.' -ForegroundColor Green
"@
    $content | Set-Content $updatePath -Encoding UTF8
    Ok "Update script written to $updatePath"
}

# ---------------------------------------------------------------------------
# Claude CLI login
# ---------------------------------------------------------------------------
function Claude-Login {
    if ($env:MYHQ_API_KEY) { return }  # API key takes precedence
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

    Say "Waiting for the panel to come up…"
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-PortFree ([int]$Script:PanelPortChosen))) { break }  # not free = listening
        Start-Sleep -Milliseconds 500
    }
    try {
        Start-Process (Get-PanelLoginUrl)
        Ok "Opened the panel in your browser — you're logged in."
    } catch {
        Warn "Couldn't auto-open a browser. Open the login link below manually."
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
Write-Host "`n  MyHQ Windows Installer" -ForegroundColor Magenta
Write-Host "  $Tutorial`n"

Ensure-Admin
Ensure-Node
Ensure-Git
Clone-Repo
Ensure-ClaudeCLI
Ensure-Ollama
Build-App
Configure-Env
Configure-RemoteAccess
Claude-Login
Install-Service
Write-UpdateScript
Open-Panel

Write-Host "`n"
Ok "MyHQ installation complete!"
Write-Host "  Install dir : $InstallDir" -ForegroundColor Cyan
if ($Script:PanelPortChosen) {
    Write-Host ""
    Write-Host "  Panel login" -ForegroundColor Cyan
    Write-Host "    One-click login link (token included — keep it private):"
    Write-Host "      $(Get-PanelLoginUrl)" -ForegroundColor Yellow
    Write-Host "    Or open http://127.0.0.1:$($Script:PanelPortChosen) and paste the token:"
    Write-Host "      $($Script:PanelTokenChosen)" -ForegroundColor Yellow
    Write-Host "      (also saved as PANEL_TOKEN in .env)" -ForegroundColor DarkGray
    Write-Host ""
}
Write-Host "  Tutorial    : $Tutorial" -ForegroundColor Cyan
Write-Host "  To update   : .\scripts\windows\myhq-update.ps1" -ForegroundColor Cyan
Write-Host "  If not logged in / no API key: claude setup-token  (needs a Pro/Max plan)" -ForegroundColor Cyan
Write-Host ""
