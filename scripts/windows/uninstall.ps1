#Requires -Version 5.1
<#
.SYNOPSIS
    uninstall.ps1 - remove the MyAgens Windows service (and optionally the files).

.DESCRIPTION
    Stops and removes the NSSM service ('myagens') and/or the 'MyAgens Bot' scheduled
    task, whichever the installer created. Optionally deletes the install
    directory so you can start over cleanly.

    Run from an elevated PowerShell:
      powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall.ps1

    Non-interactive overrides:
      MYAGENS_DIR   Install directory (default: $HOME\myagens)
      MYAGENS_YES   1 = accept all defaults (also deletes the install dir)
.NOTES
    Your Claude login (in %USERPROFILE%\.claude) is NOT touched.
#>

try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch {}
$ErrorActionPreference = "Continue"

$DefaultDir = Join-Path $HOME "myagens"
$LegacyDir  = Join-Path $HOME "myhq"
# Fall back to the pre-rename install dir if that's what's actually there and
# no override was given, so this uninstaller still finds a not-yet-migrated box.
if (-not $env:MYAGENS_DIR -and -not (Test-Path $DefaultDir) -and (Test-Path $LegacyDir)) {
    $DefaultDir = $LegacyDir
}
$InstallDir  = if ($env:MYAGENS_DIR) { $env:MYAGENS_DIR } else { $DefaultDir }
$AutoYes     = $env:MYAGENS_YES -eq "1"
$SvcNames    = @("myagens", "myhq")
$TaskNames   = @("MyAgens Bot", "MyHQ Bot")

function Say  { param([string]$m) Write-Host "* $m" -ForegroundColor Cyan }
function Ok   { param([string]$m) Write-Host "+ $m" -ForegroundColor Green }
function Warn { param([string]$m) Write-Host "! $m" -ForegroundColor Yellow }
function Confirm {
    param([string]$Prompt, [bool]$DefaultYes = $true)
    if ($AutoYes) { return $true }
    $hint = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
    $ans = Read-Host "$Prompt $hint"
    if ([string]::IsNullOrWhiteSpace($ans)) { return $DefaultYes }
    return $ans -match "^[Yy]"
}

# Must be elevated to remove a service / scheduled task.
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Warn "Please run this from an Administrator PowerShell (Win key -> type powershell -> Run as administrator)."
    if (-not $AutoYes) { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}

Write-Host "`n  MyAgens Uninstaller" -ForegroundColor Magenta
Write-Host "  Install dir: $InstallDir`n"

# --- NSSM service (current name + pre-rename 'myhq') ------------------------
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if ($nssm) {
    foreach ($SvcName in $SvcNames) {
        $status = "$(& nssm status $SvcName 2>$null)"
        if ($LASTEXITCODE -eq 0 -and $status) {
            Say "Stopping and removing NSSM service '$SvcName' ..."
            & nssm stop $SvcName 2>$null | Out-Null
            & nssm remove $SvcName confirm 2>$null | Out-Null
            Ok "NSSM service removed."
        } else {
            Say "No NSSM service '$SvcName' found."
        }
    }
} else {
    Say "nssm not on PATH - skipping NSSM service check."
}

# --- Scheduled task (current name + pre-rename 'MyHQ Bot') -------------------
foreach ($TaskName in $TaskNames) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Say "Removing scheduled task '$TaskName' ..."
        Stop-ScheduledTask       -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Ok "Scheduled task removed."
    } else {
        Say "No scheduled task '$TaskName' found."
    }
}

# --- Files ------------------------------------------------------------------
if (Test-Path $InstallDir) {
    if (Confirm "Delete the install directory ($InstallDir)? This removes the bot, its data, vault and .env" $AutoYes) {
        Say "Deleting $InstallDir ..."
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $InstallDir) {
            Warn "Couldn't fully delete $InstallDir (a file may be in use). Remove it manually after a reboot."
        } else {
            Ok "Install directory deleted."
        }
    } else {
        Say "Left the install directory in place: $InstallDir"
    }
}

Write-Host ""
Ok "Uninstall complete."
Write-Host "  Your Claude login (%USERPROFILE%\.claude) was left untouched." -ForegroundColor DarkGray
Write-Host ""
