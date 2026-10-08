#!/usr/bin/env bash
#  停掉游戏用的两个服务：Web（5178）和摄像头（5179）
#  不会动 Ollama —— 那个留着跑，下次启动快

set -u

KILLED=0

kill_port() {
  local port="$1" pids=""
  # lsof 最快；没有就退回 ss
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti "tcp:${port}" 2>/dev/null)
  elif command -v ss >/dev/null 2>&1; then
    pids=$(ss -lptn "sport = :${port}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
  fi
  if [ -n "$pids" ]; then
    for p in $pids; do
      echo "  停 ${port} 端口进程 $p"
      kill -9 "$p" 2>/dev/null
      KILLED=1
    done
  fi
}

kill_port 5178
kill_port 5179

if [ "$KILLED" = "0" ]; then
  echo
  echo "  两个服务都没在跑，没什么可停的"
else
  echo
  echo "  已停止。Ollama 保留着没动。"
fi
echo
