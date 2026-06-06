@echo off
chcp 65001 >nul
title KaaS RPA - 千牛自动回复

echo ========================================
echo   KaaS RPA 千牛自动回复 - 前台运行
echo   Ctrl+C 停止 / 关闭本窗口即停止进程
echo ========================================
echo.

cd /d "%~dp0"

REM === 可选：结束本机所有 python.exe / pythonw.exe（IDE/Jupyter 也会被关）===
REM 若不需要强杀，可整段注释掉，仅依赖程序内 data\.rpa.lock 单实例锁。
echo [INIT] 检查残留进程...
tasklist /FI "IMAGENAME eq python.exe" /FO CSV 2>nul | findstr /i "python" >nul
if %errorlevel%==0 (
    echo [INIT] 发现 python 进程，正在清理...
    taskkill /f /im python.exe 2>nul
    taskkill /f /im pythonw.exe 2>nul
    timeout /t 2 /nobreak >nul
    echo [INIT] 已清理。
) else (
    echo [INIT] 无残留进程。
)
echo.

set PYTHONUNBUFFERED=1

if exist ".venv\Scripts\activate.bat" (
    call ".venv\Scripts\activate.bat"
) else if exist "venv\Scripts\activate.bat" (
    call "venv\Scripts\activate.bat"
) else (
    echo [错误] 未找到 .venv\Scripts\activate.bat 或 venv\Scripts\activate.bat
    pause
    exit /b 1
)

python -m app.main
set EXITCODE=%ERRORLEVEL%

echo.
echo [已退出] code=%EXITCODE% 按任意键关闭窗口...
pause >nul
exit /b %EXITCODE%
