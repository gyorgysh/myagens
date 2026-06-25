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
      MYHQ_YES          Set to 1 to accept all defaults without prompting
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Config / defaults
# ---------------------------------------------------------------------------
$RepoUrl    = if ($env:MYHQ_REPO)   { $env:MYHQ_REPO }   else { "https://github.com/gyorgysh/claude-code-telegram.git" }
$Branch     = if ($env:MYHQ_BRANCH) { $env:MYHQ_BRANCH } else { "main" }
$InstallDir = if ($env:MYHQ_DIR)    { $env:MYHQ_DIR }    else { Join-Path $HOME "myhq" }
$MinNode    = 20
$AutoYes    = $env:MYHQ_YES -eq "1"
$Tutorial   = "https://gyorgy.sh/blog/claude-code-telegram"

$Script:PanelPortChosen = ""

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
# Self-elevation
# ---------------------------------------------------------------------------
function Ensure-Admin {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Warn "Not running as Administrator. Attempting to re-launch elevated…"
        $args = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
        Start-Process powershell -Verb RunAs -ArgumentList $args
        exit 0
    }
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
    npm install -g "@anthropic-ai/claude-code" 2>&1 | Out-Null
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Warn "Claude CLI not in PATH yet — you may need to re-open your terminal after setup."
    } else {
        Ok "Claude Code CLI installed."
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
        npm install
        Say "Building…"
        npm run build
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
    $apiKey  = if ($env:MYHQ_API_KEY)  { $env:MYHQ_API_KEY }  else { Ask "Anthropic API key (leave blank to use claude CLI login)" "" }

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

        # Token — auto-generate or manual.
        if ($env:MYHQ_PANEL_TOKEN) {
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

        $Script:PanelPortChosen = $panelPort
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
Set-Location '$InstallDir'
git pull origin $Branch
npm install
npm run build
nssm restart myhq 2>$null; Start-ScheduledTask -TaskName 'MyHQ Bot' 2>$null
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
    if (Confirm "Log in to Claude Code CLI now? (needed if you didn't set an API key)") {
        Push-Location $InstallDir
        try { claude auth login } finally { Pop-Location }
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
Build-App
Configure-Env
Claude-Login
Install-Service
Write-UpdateScript

Write-Host "`n"
Ok "MyHQ installation complete!"
Write-Host "  Install dir : $InstallDir" -ForegroundColor Cyan
if ($Script:PanelPortChosen) {
    Write-Host "  Panel       : http://127.0.0.1:$($Script:PanelPortChosen)  (token saved to .env)" -ForegroundColor Cyan
}
Write-Host "  Tutorial    : $Tutorial" -ForegroundColor Cyan
Write-Host "  To update   : .\scripts\windows\myhq-update.ps1" -ForegroundColor Cyan
Write-Host ""
