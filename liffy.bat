@echo off
REM ─────────────────────────────────────────────
REM  Liffy — launcher shim for Windows.
REM
REM    liffy           start everything
REM    liffy down      stop everything
REM    liffy logs      tail docker service logs
REM    liffy check     confirm repo/PR data survived the last build
REM
REM  All this does is run liffy.ps1. It exists because PowerShell's default
REM  execution policy on Windows blocks unsigned .ps1 files, so a new user's
REM  first `.\liffy.ps1` is a red error about scripts being disabled rather
REM  than a running app. -ExecutionPolicy Bypass applies to this one process
REM  only — it changes nothing about the machine's policy.
REM
REM  -NoProfile so a user's PowerShell profile cannot alter the launcher's
REM  behaviour, and %~dp0 so this works from any working directory.
REM ─────────────────────────────────────────────
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0liffy.ps1" %*
exit /b %ERRORLEVEL%
