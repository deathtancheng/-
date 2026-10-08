#!/usr/bin/env bash
# ============================================================
#  《拾物奇谭》一键启动（macOS / Linux；Windows 用 start.bat）
#  三件事按顺序做完：
#    1. 确认 Ollama 在跑（没跑就拉起来，没装就跳过）
#    2. 启动摄像头 YOLO 服务（5179）
#    3. 启动 Web 服务（5178）
#
#  摄像头起不来也没关系 —— 游戏页上有「手动举物」按钮，
#  没有摄像头一样能完整玩完五层。
# ============================================================

set -u
cd "$(dirname "$0")"

PORT=5178
CAM_PORT=5179

# 有的环境设了代理，访问本机要绕开
CURL="curl -s --noproxy *"

# ---- 找 Python ----
# 优先用环境变量 YOLO_PY（本机 Windows 上跑这个脚本时可以这样指定：
#   YOLO_PY="D:/yolo-venv/Scripts/python.exe" bash start.sh）
PY="${YOLO_PY:-}"
if [ -z "$PY" ]; then
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi

# ---------------------------------------------- 1. Ollama
echo "[1/3] 检查 Ollama ..."
if curl -s --noproxy '*' -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "      已经在跑"
elif command -v ollama >/dev/null 2>&1; then
  echo "      启动 ollama serve ..."
  nohup ollama serve >/dev/null 2>&1 &
  sleep 5
else
  echo "      [跳过] 没装 ollama —— 游戏照常能玩，只是守阁灵不出台词"
fi

# ---------------------------------------------- 2. 摄像头服务
echo "[2/3] 启动摄像头 YOLO 服务（$CAM_PORT）..."
if curl -s --noproxy '*' -m 2 "http://127.0.0.1:$CAM_PORT/detect" >/dev/null 2>&1; then
  echo "      已经在跑，跳过"
elif [ -z "$PY" ]; then
  echo "      [跳过] 没找到 python，游戏可用「手动举物」玩"
else
  ( cd yolo && nohup "$PY" camera_server.py >/dev/null 2>&1 & )
  echo "      启动中，等 10 秒让它加载模型"
  sleep 10
  if curl -s --noproxy '*' -m 5 "http://127.0.0.1:$CAM_PORT/detect" >/dev/null 2>&1; then
    echo "      就绪"
  else
    echo "      [警告] 摄像头服务没响应，游戏仍可用「手动举物」玩"
  fi
fi

# ---------------------------------------------- 3. Web 服务
echo "[3/3] 启动 Web 服务（$PORT）..."
if curl -s --noproxy '*' -m 2 "http://127.0.0.1:$PORT/api/game/state" >/dev/null 2>&1; then
  echo "      已经在跑，跳过"
else
  nohup node server.js >server.log 2>&1 &
  echo "      等 3 秒"
  sleep 3
  if curl -s --noproxy '*' -m 3 "http://127.0.0.1:$PORT/api/game/state" >/dev/null 2>&1; then
    echo "      就绪"
  else
    echo "      [错误] Web 服务没起来，看 server.log"
  fi
fi

echo
echo "  ============================================"
echo "   游戏页   http://127.0.0.1:$PORT/public/game.html"
echo "   工作台   http://127.0.0.1:$PORT/"
echo
echo "   游戏：点「献祭此物」开始；没摄像头就点「手动举物」那一排。"
echo "   关掉服务请运行：bash stop.sh"
echo
