@echo off
setlocal
title Onyx Release Build

cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell was not found in PATH.
  pause
  exit /b 1
)

echo Building synchronized Onyx release artifacts...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-release.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo Build finished successfully.
  echo Output folder:
  echo %~dp0src-tauri\target\release\bundle
) else (
  echo Build failed. Exit code: %EXIT_CODE%
)

pause
exit /b %EXIT_CODE%
