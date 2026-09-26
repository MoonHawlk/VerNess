@echo off
rem VerNess launcher (Windows cmd.exe). Prefer turn_on.ps1 in PowerShell.
where node >nul 2>nul || (echo error: node is not on PATH. Install Node 22.19+ or 24+ & exit /b 1)
node "%~dp0scripts\verness.mjs" %*
