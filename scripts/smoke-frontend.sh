#!/usr/bin/env bash
# 前端模块冒烟：起服务 → 逐个拉 js 模块和接口 → 关服务
# 后台进程会随会话结束被回收，所以「起服务 + 测试」必须在同一条命令里
cd "$(dirname "$0")/.." || exit 1

node server.js > /tmp/qs-server.log 2>&1 &
PID=$!
sleep 2

PORT=$(node -e "console.log(require('./src/config').PORT)")
BASE="http://127.0.0.1:${PORT}"

fail=0
check() {
  local url="$1" want="$2"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy "*" "${BASE}${url}")
  if [ "$code" = "$want" ]; then
    echo "  ok   $code  $url"
  else
    echo "  FAIL $code (want $want)  $url"
    fail=1
  fi
}

echo "— 静态 —"
check / 200
check /public/game.html 200
check /public/game.css 200
check /public/game.js 200
check /public/CHANGELOG.md 200

echo "— 前端模块（ESM 必须能取到，且 MIME 是 js）—"
for f in $(find public/js -name '*.js' | sort); do
  rel="/public/${f#public/}"
  check "$rel" 200
done

echo "— 接口 —"
check /api/game/state 200
check /api/game/legacy 200
check /api/models 200
check /api/nope 404

kill $PID 2>/dev/null
echo
if [ "$fail" = 0 ]; then echo "全部通过"; else echo "有失败项"; fi
exit $fail
