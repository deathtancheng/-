@echo off
rem ============================================================
rem  停掉《拾物奇谭》的全部服务：
rem    1. 先关守护窗口（不然它 3 秒后又把服务拉起来）
rem    2. 再按端口停 Web（5178）和摄像头（5179）
rem  Ollama 是别的东西在用，这里不动它。
rem ============================================================

echo.
echo   停止《拾物奇谭》的服务 ...
echo.

rem ---- 1. 先关守护窗口（按窗口标题找，找不到就跳过）----
taskkill /FI "WINDOWTITLE eq 拾物奇谭-web*" /F >nul 2>&1

set KILLED=0

rem ---- 2. 停 Web 服务（5178）----
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:5178" ^| findstr LISTENING') do (
  echo   停 Web 服务     PID %%p
  taskkill /PID %%p /F >nul 2>&1
  set KILLED=1
)

rem ---- 3. 停摄像头服务（5179）----
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:5179" ^| findstr LISTENING') do (
  echo   停 摄像头服务   PID %%p
  taskkill /PID %%p /F >nul 2>&1
  set KILLED=1
)

if "%KILLED%"=="0" (
  echo   服务本来就没在跑，没什么要停的。
) else (
  echo.
  echo   已全部停止。Ollama 没有动。
)

echo.
pause
