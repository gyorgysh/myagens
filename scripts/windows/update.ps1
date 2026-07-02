#Requires -Version 5.1
<#
.SYNOPSIS
    update.ps1 - Windows counterpart of scripts/update.sh.

.DESCRIPTION
    Sync to the latest code, reinstall deps, rebuild (panel UI + bot), and
    restart the service if one is installed (NSSM 'myagens' or the 'MyAgens Bot'
    scheduled task). Hard-resets the checkout to the remote ref: local edits to
    *tracked* files are discarded; untracked files (data/, .env, vault) are left
    alone. work.md (the operator playbook) is preserved across the reset.

    Used by the in-panel updater on Windows, and runnable by hand:
      powershell -ExecutionPolicy Bypass -File scripts\windows\update.ps1 [git-ref]

    Also fixes up the git remote if it's still the pre-rename canonical URL,
    and prints a migration hint if the pre-rename 'myhq' service/task name is
    still what's actually installed.
#>

# Let npm/git PowerShell shims run for this process (Windows blocks .ps1 by
# default); not persisted, no admin needed.
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch {}

# NOTE: we deliberately leave $ErrorActionPreference at its default ("Continue").
# git and npm write normal progress to stderr; with "Stop" a stderr line can be
# turned into a terminating NativeCommandError. Instead we check $LASTEXITCODE
# after each critical native command and exit non-zero ourselves, so the panel
# sees a real failure code.

$AppDir = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent  # scripts\windows -> repo root
Set-Location $AppDir

# When launched by the background service its PATH can be minimal, so make sure
# git/node/npm resolve by prepending their standard locations. Without this the
# update silently no-ops (a missing command never sets $LASTEXITCODE).
$env:Path = (@(
    $env:Path,
    "$env:ProgramFiles\nodejs",
    "$env:ProgramFiles\Git\cmd",
    "$env:ProgramFiles\Git\bin",
    (Join-Path $env:APPDATA "npm")
) | Where-Object { $_ }) -join ";"

# Use Write-Output (stdout, stream 1) NOT Write-Host (the information stream),
# because the in-panel updater captures the child's stdout pipe - Write-Host
# output would never reach it, leaving the panel showing no progress at all.
function Say { param([string]$m) Write-Output "* $m" }
function Ok  { param([string]$m) Write-Output "+ $m" }
function Step {
    param([string]$Name, [scriptblock]$Cmd)
    $global:LASTEXITCODE = 0
    # try/catch turns a missing command (CommandNotFoundException) into an honest
    # failure instead of a silent skip that exits 0 and reports "success".
    try { & $Cmd } catch { Write-Output "x $Name failed: $($_.Exception.Message)"; exit 1 }
    if ($LASTEXITCODE -ne 0) {
        Write-Output "x $Name failed (exit $LASTEXITCODE)."
        exit 1
    }
}

$ref = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { (git rev-parse --abbrev-ref HEAD).Trim() }

# Repo was renamed gyorgysh/myhq -> gyorgysh/myagens. GitHub redirects the old
# URL, so this isn't strictly required, but fix it up if origin is still the
# exact canonical old URL (never touch a fork under a different owner).
$currentRemote = (git remote get-url origin 2>$null)
if ($currentRemote -eq "https://github.com/gyorgysh/myhq.git") {
    Say "Updating git remote (repo renamed): $currentRemote -> https://github.com/gyorgysh/myagens.git"
    git remote set-url origin "https://github.com/gyorgysh/myagens.git"
} elseif ($currentRemote -eq "git@github.com:gyorgysh/myhq.git") {
    Say "Updating git remote (repo renamed): $currentRemote -> git@github.com:gyorgysh/myagens.git"
    git remote set-url origin "git@github.com:gyorgysh/myagens.git"
}

# Preserve work.md across the hard reset (it's a per-box playbook the panel edits).
$workBackup = $null
if (Test-Path "work.md") {
    $workBackup = Join-Path $env:TEMP ("work.md." + [guid]::NewGuid().ToString("N"))
    Copy-Item "work.md" $workBackup -Force
}

Say "Fetching origin/$ref ..."
Step "git fetch" { git fetch --prune origin $ref }
$before = (git rev-parse HEAD).Trim()
Say "Resetting to origin/$ref (local changes to tracked files are discarded) ..."
Step "git reset" { git reset --hard FETCH_HEAD }
$after = (git rev-parse HEAD).Trim()

if ($workBackup) {
    $changed = -not (Test-Path "work.md") -or
        (Get-FileHash $workBackup).Hash -ne (Get-FileHash "work.md").Hash
    if ($changed) {
        Copy-Item $workBackup "work.md" -Force
        Ok "Preserved your local work.md (operator playbook) over the shipped template."
    }
    Remove-Item $workBackup -Force -ErrorAction SilentlyContinue
}

if ($before -eq $after) {
    Ok "Already up to date ($((git rev-parse --short HEAD).Trim()))."
} else {
    Ok "Updated $((git rev-parse --short $before).Trim())..$((git rev-parse --short $after).Trim())."
}

# Force a dev install. If the service account has NODE_ENV=production set, a
# bare `npm install` skips devDependencies (typescript/tsx for the bot, vite for
# the panel), so the following `npm run build` fails with "tsc/vite not found".
# Clearing NODE_ENV for this process *and* passing --include=dev makes the dev
# deps install regardless of the inherited environment. (build:panel runs its
# own `npm install` inside panel/, which inherits this same NODE_ENV.)
$env:NODE_ENV = "development"
Say "Installing dependencies ..."
Step "npm install" { npm.cmd install --include=dev }
Say "Building (panel UI + bot) ..."
Step "npm run build" { npm.cmd run build }

# Restart the service if one is installed.
#
# IMPORTANT: when launched by the in-panel updater (MYAGENS_INPANEL=1) this script
# runs AS the service account (.\admin), which does NOT hold service-control
# rights on its own service object — so Restart-Service / sc.exe are denied
# ("The system cannot find the file specified." / access denied). In that case
# we do NOT restart here. The bot process self-exits after we return, and the
# service manager (NSSM AppExit Default Restart, or the task's RestartCount)
# relaunches it with the new code. This is the privilege-free path.
#
# When run by hand from an elevated terminal (MYAGENS_INPANEL unset) Restart-Service
# works, so we do it here for convenience.
$inPanel = $env:MYAGENS_INPANEL -eq "1"

if ($inPanel) {
    Ok "Build complete. The bot will exit so the service manager relaunches it."
    exit 0
}

$restarted = $false
# Try the current service/task name, then the pre-rename one (not yet migrated).
foreach ($svcName in @("myagens", "myhq")) {
    if ($restarted) { break }
    if (Get-Service -Name $svcName -ErrorAction SilentlyContinue) {
        Say "Restarting the '$svcName' service ..."
        Restart-Service -Name $svcName -Force -ErrorAction SilentlyContinue
        Ok "Service restarted."
        $restarted = $true
        # NSSM/task renaming needs admin + reconfiguring AppEnvironmentExtra etc,
        # which this script doesn't do — point at the full installer instead of
        # trying (and likely failing) to migrate it here.
        if ($svcName -eq "myhq") {
            Say "Still running under the pre-rename 'myhq' service name. To migrate: re-run .\scripts\windows\myagens-install.ps1 from an elevated PowerShell."
        }
    }
}
if (-not $restarted) {
    foreach ($taskName in @("MyAgens Bot", "MyHQ Bot")) {
        if ($restarted) { break }
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            Say "Restarting the scheduled task ..."
            Stop-ScheduledTask  -TaskName $taskName -ErrorAction SilentlyContinue
            Start-ScheduledTask -TaskName $taskName
            Ok "Scheduled task restarted."
            $restarted = $true
            if ($taskName -eq "MyHQ Bot") {
                Say "Still running under the pre-rename 'MyHQ Bot' task name. To migrate: re-run .\scripts\windows\myagens-install.ps1 from an elevated PowerShell."
            }
        }
    }
}
if (-not $restarted) {
    Ok "Build complete. No service installed - restart your manual run to pick up changes."
}

exit 0
