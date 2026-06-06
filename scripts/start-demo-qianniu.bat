@echo off
REM KaaS one-click: msg-router :8000 (if not up) + wait /health + rpa-qianniu in new CMD windows.
REM RPA only (no msg-router): start-rpa-qianniu-only.bat
chcp 65001 >nul
setlocal

pushd "%~dp0.."
set "ROOT=%CD%"
popd
set "MR=%ROOT%\msg-router"
set "QN=%ROOT%\rpa-qianniu"

title KaaS-Qianniu-Demo
echo [KaaS] ROOT=%ROOT%
echo.

set "START_ROUTER=0"
curl.exe -s http://127.0.0.1:8000/health 2>nul | findstr /c:"ok" >nul
if errorlevel 1 set "START_ROUTER=1"

if "%START_ROUTER%"=="0" goto :skip_uvicorn_block
if not exist "%MR%\.venv\Scripts\uvicorn.exe" (
  echo [WARN] No uvicorn.exe under msg-router\.venv
  echo        cd msg-router ^&^& python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
  goto :after_uvicorn_block
)

echo [KaaS] Starting msg-router 127.0.0.1:8000 ...
start "KaaS msg-router :8000" /D "%MR%" cmd /k "title KaaS-msg-router-8000 && .venv\Scripts\uvicorn.exe app.main:app --host 127.0.0.1 --port 8000"

echo [KaaS] Wait /health max 25s ...
set /a _n=0
:wait_health
curl.exe -s http://127.0.0.1:8000/health 2>nul | findstr /c:"ok" >nul
if not errorlevel 1 goto :uv_ok
set /a _n+=1
if %_n% geq 25 goto :uv_bad
timeout /t 1 /nobreak >nul
goto :wait_health

:uv_ok
echo [KaaS] msg-router OK.
goto :after_uvicorn_block

:uv_bad
echo [WARN] msg-router not ready in 25s. Check window KaaS-msg-router-8000.
echo        RPA will still start.

:after_uvicorn_block
goto :start_rpa

:skip_uvicorn_block
echo [KaaS] 8000 has /health, skip uvicorn.

:start_rpa
if not exist "%QN%\.venv\Scripts\python.exe" (
  echo [ERR] Missing rpa-qianniu .venv python.exe
  echo       cd rpa-qianniu ^&^& python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
  pause
  exit /b 1
)

if not exist "%QN%\.env" copy /Y "%QN%\.env.example" "%QN%\.env" >nul

echo [KaaS] Starting rpa-qianniu ...
start "KaaS rpa-qianniu" /D "%QN%" cmd /k "title KaaS-rpa-qianniu && .venv\Scripts\python.exe -m app.main"

echo.
echo Look for window: KaaS rpa-qianniu
echo If none: double-click this file in Explorer.
echo.
pause
endlocal
