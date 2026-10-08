@echo off
rem ============================================================
rem  《拾物奇谭》启动器 —— 双击这一个就够了
rem
rem  会做三件事：
rem    1. 确保 Web 服务在跑（5178），死了会自动救活（守护循环）
rem    2. 摄像头（5179）由 Web 服务自动拉起，不用管
rem    3. 打开游戏页面
rem
rem  玩完想关：运行 stop.bat
rem ============================================================

cd /d "%~dp0"

if not exist logs mkdir logs

rem ---- Node：优先 current，其次扫版本目录，最后靠 PATH ----
set "NODE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" (
  set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"
)
if not defined NODE (
  for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%d\node.exe" set "NODE=%%d\node.exe"
  )
)
if not defined NODE set "NODE=node"

echo.
echo   《拾物奇谭》
echo   ============================================

rem ---- 已经有人在听 5178 就直接开页面 ----
netstat -ano | findstr "127.0.0.1:5178" | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
  echo   Web 服务已经在跑了。
  goto open
)

echo   正在启动 Web 服务（守护模式，崩溃会自动重启）...
start "拾物奇谭-web" /min cmd /c "for /l %%i in (1,1,86400) do ( %NODE% server.js >> logs\web-out.log 2>&1 & timeout /t 3 /nobreak >nul )"

rem ---- 等服务就绪（最多 15 秒）----
set /a tries=0
:waitready
timeout /t 1 >nul
curl -s -m 3 http://127.0.0.1:5178/api/game/state >nul 2>&1
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% lss 15 goto waitready

echo.
echo   [警告] Web 服务 15 秒内没有应答。
echo   请看 logs\web-out.log 里的报错。
echo   当前用的 Node：%NODE%
echo.
pause
exit /b 1

:ready
echo   Web 服务就绪。

:open
echo   打开游戏页面 ...
start "" http://127.0.0.1:5178/public/game.html

echo.
echo   ============================================
echo   一切就绪。点「推门进阁」开始游戏。
echo.
echo   那个最小化的窗口别关——
echo   它守着服务，服务崩了会自动拉起来。
echo   想全部关闭：运行 stop.bat
echo.
timeout /t 4 >nul
