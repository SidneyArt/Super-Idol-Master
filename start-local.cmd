@echo off
title Super Idol Master Local Web
cd /d "%~dp0web"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer was not found.
  echo Install Node.js and run this script again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies for the first run...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist "data" mkdir "data"
set NODE_NO_WARNINGS=1
call npm run local

if errorlevel 1 (
  echo.
  echo The local site stopped with an error. Keep this window for troubleshooting.
  pause
)

