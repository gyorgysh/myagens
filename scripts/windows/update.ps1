#Requires -Version 5.1
<#
.SYNOPSIS
    update.ps1 - Windows counterpart of scripts/update.sh.

.DESCRIPTION
    Sync to the latest code, reinstall deps, rebuild (panel UI + bot), and
    restart the service if one is installed (NSSM 'myhq' or the 'MyHQ Bot'
    scheduled task). Hard-resets the checkout to the remote ref: local edits to
    *tracked* files are discarded; untracked files (data/, .env, vault) are left
    alone. work.md (the operator playbook) is preserved across the reset.

    Used by the in-panel updater on Windows, and runnable by hand:
      powershell -ExecutionPolicy Bypass -File scripts\windows\update.ps1 [git-ref]
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

function Say { param([string]$m) Write-Host "* $m" }
function Ok  { param([string]$m) Write-Host "+ $m" }
function Step {
    param([string]$Name, [scriptblock]$Cmd)
    & $Cmd
    if ($LASTEXITCODE -ne 0) {
        Write-Host "x $Name failed (exit $LASTEXITCODE)."
        exit 1
    }
}

$ref = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { (git rev-parse --abbrev-ref HEAD).Trim() }

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

Say "Installing dependencies ..."
Step "npm install" { npm.cmd install }
Say "Building (panel UI + bot) ..."
Step "npm run build" { npm.cmd run build }

# Restart the service if one is installed. The bot process IS the service, so this
# kills the current run near the end; the service manager completes the restart.
# Use the built-in Get-Service/Restart-Service (an NSSM service is a real Windows
# service) instead of the `nssm` CLI - nssm is usually NOT on the service's
# restricted PATH, which is why this step used to silently no-op.
$restarted = $false
if (Get-Service -Name "myhq" -ErrorAction SilentlyContinue) {
    Say "Restarting the 'myhq' service ..."
    Restart-Service -Name "myhq" -Force -ErrorAction SilentlyContinue
    Ok "Service restarted."
    $restarted = $true
}
if (-not $restarted) {
    $task = Get-ScheduledTask -TaskName "MyHQ Bot" -ErrorAction SilentlyContinue
    if ($task) {
        Say "Restarting the scheduled task ..."
        Stop-ScheduledTask  -TaskName "MyHQ Bot" -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName "MyHQ Bot"
        Ok "Scheduled task restarted."
        $restarted = $true
    }
}
if (-not $restarted) {
    Ok "Build complete. No service installed - restart your manual run to pick up changes."
}

exit 0
