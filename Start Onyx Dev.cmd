@echo off
setlocal
title Onyx Dev

cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell was not found in PATH.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\check-toolchain.ps1"
if errorlevel 1 (
  echo.
  echo Development prerequisites are not satisfied.
  pause
  exit /b 1
)

echo Starting isolated Onyx Dev in Tauri dev mode...
echo.

call npm run tauri:dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo The app closed or failed to start. Exit code: %EXIT_CODE%
  pause
)

exit /b %EXIT_CODE%
