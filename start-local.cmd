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

where uv >nul 2>nul
if errorlevel 1 (
  echo [ERROR] uv was not found.
  echo Install uv from https://docs.astral.sh/uv/ and run this script again.
  pause
  exit /b 1
)

echo Checking frontend dependencies...
call npm ls --depth=0 --silent >nul 2>nul
if errorlevel 1 (
  echo Frontend dependencies are missing or out of date. Installing...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo npm ci could not use the current lock file.
    echo Attempting to repair the dependency lock automatically...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
      echo [ERROR] Dependency installation and automatic repair failed.
      pause
      exit /b 1
    )
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

