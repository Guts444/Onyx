@echo off
setlocal
title Onyx Dev

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found in PATH.
  echo Install Node.js, reopen this window, and try again.
  pause
  exit /b 1
)

echo Starting Onyx in Tauri dev mode...
echo.

call npm run tauri dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo The app closed or failed to start. Exit code: %EXIT_CODE%
  pause
)

exit /b %EXIT_CODE%
