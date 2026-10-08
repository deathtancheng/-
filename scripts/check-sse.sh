#!/usr/bin/env bash
# 验证后端 SSE 推送：挂一条长连接，然后在另一条连接里触发一次探索，看是否收到推送
cd "C:/Users/Admin（无密码）/WorkBuddy/2026-09-29-22-32-37/local-ai-lab" || exit 1

node server.js > sandbox/sse.log 2>&1 &
SRVPID=$!
for i in $(seq 1 40); do
  if curl -s --noproxy "*" --max-time 3 http://127.0.0.1:5178/api/game/state >/dev/null 2>&1; then
    echo "ready"; break
  fi
  sleep 1
done

# 后台挂 SSE，最多收 6 秒
curl -sN --noproxy "*" --max-time 6 http://127.0.0.1:5178/api/game/stream > sandbox/sse-out.txt &
SSEPID=$!
sleep 1

echo "触发一次 reset（应推一次 state）"
curl -s --noproxy "*" -X POST http://127.0.0.1:5178/api/game/reset > /dev/null
sleep 1
echo "触发一次 explore（应再推一次）"
curl -s --noproxy "*" -X POST http://127.0.0.1:5178/api/game/explore \
  -H 'content-type: application/json' -d '{"label":"bottle","conf":0.8,"area_ratio":30}' > /dev/null
sleep 1

wait $SSEPID 2>/dev/null
echo ""
echo "===== SSE 收到的事件 ====="
grep -c "^data:" sandbox/sse-out.txt | xargs echo "  data 行数:"
node -e "
const fs=require('fs');
const txt=fs.readFileSync('sandbox/sse-out.txt','utf8');
for(const line of txt.split('\n')){
  if(!line.startsWith('data:')) continue;
  try{
    const e=JSON.parse(line.slice(5).trim());
    console.log('  ·', e.type, '| reason=' + (e.reason||'-'), '| 层' + (e.state?e.state.level:'-'), '| phase=' + (e.state?e.state.phase:'-'));
  }catch{ console.log('  · (解析失败)', line.slice(0,80)); }
}
"
kill $SRVPID 2>/dev/null
echo "== done =="
