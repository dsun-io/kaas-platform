@echo off
REM RPA only (no uvicorn). Use when AI_STUB_MODE=true or msg-router already running elsewhere.
REM Full stack: start-demo-qianniu.bat
REM 前台单窗、关窗即停：请用 rpa-qianniu\start.bat（勿与本脚本同时开两个 RPA）
chcp 65001 >nul
pushd "%~dp0.."
set "ROOT=%CD%"
popd
set "QN=%ROOT%\rpa-qianniu"
title KaaS-RPA-only
if not exist "%QN%\.venv\Scripts\python.exe" (
  echo [ERR] Missing %QN%\.venv\Scripts\python.exe
  pause
  exit /b 1
)
if not exist "%QN%\.env" copy /Y "%QN%\.env.example" "%QN%\.env" >nul
start "KaaS rpa-qianniu" /D "%QN%" cmd /k "title KaaS-rpa-qianniu && .venv\Scripts\python.exe -m app.main"
echo Started. Check taskbar: KaaS rpa-qianniu
pause
