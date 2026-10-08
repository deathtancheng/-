#!/usr/bin/env bash
# 无头截图：确认前端 ESM 真的能跑起来（白屏 / 报错一眼看出来）
#
# 五个坑：
#   1. 原生 exe 吃不了中文路径，截图落到英文目录
#   2. 无头截图带 ?no_sse=1：SSE 长连接会让 headless 的虚拟时间推进不完，
#      所以测试时把 SSE 关掉，页面也能正常渲染。
#   3. --screenshot 返回时文件可能还没写完，紧跟的 stat 会读到 0，要等一下
#   4. 局面不再靠"走位"摆（房间随机、路上还会被别的房间扣住），
#      改用 scripts/stage.js 直接写存档，每次起服务前摆好，稳定可复现。
#   5. 存档只在服务启动时读一次，所以**每摆一次局面都要重启服务**。
cd "$(dirname "$0")/.." || exit 1

PORT=$(node -e "console.log(require('./src/config').PORT)")
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
OUT="C:/temp/qs-shots"
BASE="http://127.0.0.1:${PORT}"
mkdir -p "$OUT" /c/temp

SRV=""
start_server() {
  node server.js > /tmp/qs-shot.log 2>&1 &
  SRV=$!
  for i in $(seq 1 60); do
    curl -s --noproxy "*" --max-time 2 "${BASE}/api/game/state" > /dev/null 2>&1 && return 0
    sleep 1
  done
  echo "  ！服务没起来，看 /tmp/qs-shot.log"
}
stop_server() {
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  wait "$SRV" 2>/dev/null
  SRV=""
}

shot() {
  rm -f "$OUT/$1" 2>/dev/null
  "$EDGE" --headless=new --disable-gpu --no-sandbox --no-proxy-server --hide-scrollbars \
    --window-size=1440,1080 --virtual-time-budget=14000 --force-prefers-reduced-motion \
    --user-data-dir=/c/temp/qsedge"$2" \
    --screenshot="$OUT/$1" "$3" > /dev/null 2>&1
  sleep 3
  echo "  → $1  $(stat -c%s "$OUT/$1" 2>/dev/null || echo 0) bytes"
}

# ── 1. 迷宫：站在一间普通空房上（不该弹场景）────────────────
node scripts/stage.js empty
start_server
shot "v41-maze.png" A "${BASE}/public/game.html?no_sse=1"
stop_server

# ── 2. 场景：妖物堵门（该弹出场景，且方向键被扣住）──────────
node scripts/stage.js foe
start_server
shot "v41-scene.png" B "${BASE}/public/game.html?no_sse=1"
stop_server

# ── 2b. 场景图：夜晚的黑市（v4.1.1 起每房一张场景画）────────
node scripts/stage.js shop
start_server
shot "v411-shop.png" F "${BASE}/public/game.html?no_sse=1"
stop_server

# ── 2c. 站在歇脚处：「就此回阁」必须是亮的（v4.1.3 修的锁死）──
node scripts/stage.js rest
start_server
shot "v412-rest.png" G "${BASE}/public/game.html?no_sse=1"
stop_server

# ── 3. 阁楼：兜里有钱、仓里有货，营造那栏才有得看 ────────────
node scripts/stage.js hall
start_server
shot "v41-hall.png" C "${BASE}/public/game.html?no_sse=1"
stop_server

# ── 4. 夜战：妖物上门（取景框该抬起来）──────────────────────
node scripts/stage.js night
start_server
shot "v41-night.png" D "${BASE}/public/game.html?no_sse=1"
stop_server

# ── 5. 更新日志（顺带确认版本号有没有跟上）──────────────────
start_server
shot "v41-changelog.png" E "${BASE}/public/game.html?no_sse=1#changelog"
stop_server

echo "== done =="
