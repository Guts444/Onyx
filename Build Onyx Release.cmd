@echo off
setlocal
title Onyx Release Build
set "VERSION=0.5.7"

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
  echo Release prerequisites are not satisfied.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\verify-native-deps.ps1"
if errorlevel 1 (
  echo.
  echo Native dependency verification failed. Packaging was not started.
  pause
  exit /b 1
)

echo Building Onyx %VERSION% release bundle...
echo.

if exist "%~dp0src-tauri\target\release\onyx.exe" del /q "%~dp0src-tauri\target\release\onyx.exe"
if exist "%~dp0src-tauri\target\release\onyx.pdb" del /q "%~dp0src-tauri\target\release\onyx.pdb"
if exist "%~dp0src-tauri\target\release\onyx.d" del /q "%~dp0src-tauri\target\release\onyx.d"
if exist "%~dp0src-tauri\target\release\bundle\msi\Onyx_*_x64_en-US.msi" del /q "%~dp0src-tauri\target\release\bundle\msi\Onyx_*_x64_en-US.msi"
if exist "%~dp0src-tauri\target\release\bundle\nsis\Onyx_*_x64-setup.exe" del /q "%~dp0src-tauri\target\release\bundle\nsis\Onyx_*_x64-setup.exe"

call npm run tauri build
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
