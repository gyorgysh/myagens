#Requires -Version 5.1
# Run MyAgens bot from the install directory.
# Usage: .\scripts\windows\myagens-run.ps1

$AppDir = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $AppDir

$Node = if ($env:NODE_BIN) { $env:NODE_BIN } else {
    $n = Get-Command node -ErrorAction SilentlyContinue
    if ($n) { $n.Source } else { $null }
}

if (-not $Node) {
    Write-Host "x node not found. Install Node 20+ or set NODE_BIN." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "dist\index.js")) {
    Write-Host "* Building..." -ForegroundColor Cyan
    npm run build
}

& $Node "dist\index.js"
