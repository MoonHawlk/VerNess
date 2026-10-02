#!/usr/bin/env pwsh
# FiNess launcher (Windows PowerShell / pwsh on any platform).
# Everything is configured in finess.config.json — see docs/06-SETUP-AND-LAUNCHER.md.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'node is not on PATH. Install Node 22.19+ or 24+ from https://nodejs.org'
  exit 1
}
& node (Join-Path $PSScriptRoot 'scripts/cli.mjs') @args
exit $LASTEXITCODE
