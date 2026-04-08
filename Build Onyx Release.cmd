@echo off
setlocal
title Onyx Release Build

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found in PATH.
  echo Install Node.js, reopen this window, and try again.
  pause
  exit /b 1
)

echo Building Onyx release bundle...
echo.

if exist "%~dp0src-tauri\target\release\onyx.exe" del /q "%~dp0src-tauri\target\release\onyx.exe"
if exist "%~dp0src-tauri\target\release\onyx.pdb" del /q "%~dp0src-tauri\target\release\onyx.pdb"
if exist "%~dp0src-tauri\target\release\onyx.d" del /q "%~dp0src-tauri\target\release\onyx.d"
if exist "%~dp0src-tauri\target\release\bundle\msi\Onyx_0.5.0_x64_en-US.msi" del /q "%~dp0src-tauri\target\release\bundle\msi\Onyx_0.5.0_x64_en-US.msi"
if exist "%~dp0src-tauri\target\release\bundle\nsis\Onyx_0.5.0_x64-setup.exe" del /q "%~dp0src-tauri\target\release\bundle\nsis\Onyx_0.5.0_x64-setup.exe"

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
