@echo off
rem Double-click to start Claude Setup from the project folder (development build).
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "node_modules\electron\dist\electron.exe" (
  echo Downloading Electron...
  call npx install-electron || goto :error
)
if not exist "out\main\index.js" (
  echo Building Claude Setup...
  call npx electron-vite build || goto :error
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:error
echo.
echo Something went wrong. Run "npm install" in this folder first, then try again.
pause
exit /b 1
