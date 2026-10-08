@echo off
setlocal enabledelayedexpansion

rem ============================================================
rem  《拾物奇谭》一键启动
rem  双击这个脚本，三件事自动做完：
rem    1. 确认 Ollama 在跑（没跑就拉起来）
rem    2. 启动摄像头 YOLO 服务（5179）
rem    3. 启动 Web 服务（5178）并打开浏览器
rem
rem  摄像头起不来也没关系 —— 游戏页上有「手动举物」按钮，
rem  没有摄像头一样能完整玩完五层。
rem ============================================================

cd /d "%~dp0"

rem ---- Node：优先用 current 软链（版本号变了也不用改脚本）----
set "NODE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" (
  set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"
)
if not defined NODE (
  for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%d\node.exe" set "NODE=%%d\node.exe"
  )
)
rem 兜底：系统 PATH 里的 node
if not defined NODE set "NODE=node"

rem ---- Python：YOLO 专用 venv 优先，退回 WorkBuddy 自带环境 ----
set "PY="
if exist "D:\yolo-venv\Scripts\python.exe" (
  set "PY=D:\yolo-venv\Scripts\python.exe"
) else if exist "%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe" (
  set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
)

rem ---- 权重：目录结构可能变，直接搜 ----
set "WEIGHTS="
for /f "delims=" %%f in ('dir /b /s "yolo\runs\*best.pt" 2^>nul') do set "WEIGHTS=%%f"

echo.
echo   拾物奇谭 —— 启动中
echo   ============================================
echo.

rem ---------------------------------------------- 1. Ollama
echo [1/4] 检查 Ollama ...
curl -s -m 3 http://127.0.0.1:11434/api/tags >nul 2>&1
if errorlevel 1 (
  echo       Ollama 没在跑，正在启动 ...
  start "" /min ollama serve
  echo       等它加载模型，最多 20 秒
  for /L %%i in (1,1,20) do (
    timeout /t 1 >nul
    curl -s -m 2 http://127.0.0.1:11434/api/tags >nul 2>&1
    if not errorlevel 1 goto ollama_ok
  )
  echo       [警告] Ollama 还是没起来，守阁灵不会说话。
) else (
  echo       已经在跑了
)
:ollama_ok

rem ---------------------------------------------- 2. 摄像头服务
echo [2/4] 启动摄像头 YOLO 服务（5179）...
netstat -ano | findstr "127.0.0.1:5179" | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
  echo       已经在跑了，跳过
  goto cam_done
)
if not defined PY (
  echo       [跳过] 没找到 Python 环境（试过 D:\yolo-venv 与 WorkBuddy 自带）
  echo       摄像头用不了，游戏仍可用「手动举物」玩
  goto cam_done
)
if not defined WEIGHTS (
  echo       [跳过] 没找到训练权重 best.pt（在 yolo\runs 下搜过了）
  echo       游戏仍可用「手动举物」玩
  goto cam_done
)
start "camera-yolo" /min "%PY%" yolo\camera_server.py --weights "%WEIGHTS%"
echo       启动中，等 15 秒让它加载模型
timeout /t 15 >nul
curl -s -m 5 http://127.0.0.1:5179/detect >nul 2>&1
if errorlevel 1 (
  echo       [警告] 摄像头服务没响应，游戏仍可用「手动举物」玩
) else (
  echo       就绪
)
:cam_done

rem ---------------------------------------------- 3. Web 服务
echo [3/4] 启动 Web 服务（5178）...
netstat -ano | findstr "127.0.0.1:5178" | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
  echo       已经在跑了，跳过
  goto web_done
)
if "%NODE%"=="node" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo       [错误] 没找到 Node。请装 Node 22，或手动改脚本里的 NODE 路径
    pause
    exit /b 1
  )
)
start "web-server" /min "%NODE%" server.js
echo       等 4 秒
timeout /t 4 >nul
:web_done

rem ---------------------------------------------- 4. 打开浏览器
echo [4/4] 打开浏览器 ...
rem 带参数 game 只开游戏；agent 只开工作台；不带参数两个都开
if /i "%~1"=="game" (
  start "" http://127.0.0.1:5178/public/game.html
) else if /i "%~1"=="agent" (
  start "" http://127.0.0.1:5178/public/index.html
) else (
  start "" http://127.0.0.1:5178/public/game.html
  start "" http://127.0.0.1:5178/public/index.html
)

echo.
echo   ============================================
echo   两个页面都开了：
echo     /public/game.html    《拾物奇谭》游戏
echo     /public/index.html   华小牛 本地智能体工作台
echo.
echo   游戏：点「献祭此物」开始；没摄像头就点「手动举物」那一排。
echo   工作台：左边输入框直接使唤智能体，它会真的去调工具。
echo.
echo   想只开一个：start.bat game  或  start.bat agent
echo   关掉服务请运行 stop.bat
echo.
pause
