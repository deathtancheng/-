/**
 * 《拾物奇谭》命令行试玩
 * ------------------------------------------------------------------
 *   node harness/game-play.js                    # 从摄像头取当前物件献祭
 *   node harness/game-play.js cup 0.9 30         # 指定物件 / 置信度 / 占画面%
 *   node harness/game-play.js --talk 你是谁      # 只搭话，不献祭
 *   node harness/game-play.js --reset            # 重开一局
 *
 * 存在的意义：浏览器之外也要能验证规则对不对。
 * 规则是纯函数，命令行跑一遍就能看出克制关系有没有生效。
 */

const API = process.env.API || 'http://127.0.0.1:5178';

async function sse(path, body, onEvent) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('ndjson')) {
    const j = await res.json().catch(() => ({}));
    console.log(j.message || j.error || '（无响应体）');
    return null;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'confirm_request') {
        console.log(`\n⚠ 妖物请求执行 ${e.name}（${e.levelLabel}），自动放行`);
        await fetch(`${API}/api/game/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: e.id, allow: true }),
        });
        continue;
      }
      if (onEvent) onEvent(e);
      if (e.type === 'final') return e;
    }
  }
  return null;
}

(async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '--reset') {
    await fetch(`${API}/api/game/reset`, { method: 'POST' });
    console.log('已重开一局。');
    return;
  }

  const before = await (await fetch(`${API}/api/game/state`)).json();
  if (!before.ok) {
    console.error('取不到局面：', before.error);
    process.exit(1);
  }

  // v4：入夜是个显式动作。想直接开打就先 --night
  if (argv[0] === '--night') {
    const n = await fetch(`${API}/api/game/night`, { method: 'POST' });
    const j = await n.json();
    if (!j.ok) { console.log('入夜失败：' + (j.error || j.msg)); return; }
    console.log(`入夜。今晚来的是「${j.beast.name}」（${j.beast.element}）HP ${j.state.guardianHp}`);
    return;
  }

  if (before.state.phase !== 'night' && argv[0] !== '--talk') {
    console.log(`现在是白天（第 ${before.state.day} 天，${before.state.phase === 'hall' ? '在阁里' : '在迷宫'}）。`
      + `夜里才能献祭——先跑一次 --night。`);
    return;
  }

  const g0 = before.guardian;
  if (argv[0] !== '--talk') {
    console.log(`第 ${before.state.day} 夜 · 妖物「${g0.name}」属性${before.elements[g0.element].name} · ${before.state.guardianHp}/${g0.hp}`);
    console.log(`旅人 ${before.state.playerHp}/100 | 饱食 ${Math.round(before.state.satiety)} | 精神 ${Math.round(before.state.sanity)}\n`);
  }

  const intentArg = argv.find((a) => a.startsWith('--intent='));
  let body;
  if (argv[0] === '--talk') {
    body = { talk: true, prompt: argv.slice(1).join(' ') };
  } else if (argv[0] === '--skill') {
    // 放咒（不走模型，规则裁决）
    const r = await fetch(`${API}/api/game/skill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: argv[1] }),
    });
    const j = await r.json();
    if (!j.ok) { console.log('放咒失败：' + j.error); return; }
    console.log(`${j.line}`);
    console.log(`\n咒·${j.skill.name}：${j.damage} 伤害${j.heal ? `，回血 ${j.heal}` : ''}${j.counter ? `，妖物反击 ${j.counter}` : ''}`);
    console.log(`旅人 ${j.state.playerHp}/100 | 术力 ${j.state.stats.mana}`);
    if (j.cleared) console.log('★ 妖物退了，天亮了');
    if (j.state.over) console.log('× 力竭，这一局到此为止');
    return;
  } else if (argv[0]) {
    body = {
      label: argv[0],
      conf: Number(argv[1] || 0.85),
      area_ratio: Number(argv[2] || 25),
      intent: intentArg ? intentArg.split('=')[1] : 'power',
    };
  } else {
    body = {}; // 让服务端自己去摄像头取
  }

  let text = '';
  const tools = [];
  const final = await sse('/api/game/act', body, (e) => {
    if (e.type === 'content') text += e.text;
    if (e.type === 'tool' && e.phase === 'start') tools.push(e.name);
    if (e.type === 'offering' && e.label) {
      console.log(`祭品：${e.label}（置信度 ${e.conf}，占画面 ${e.areaRatio}%）`);
    }
  });

  if (!final) return;

  console.log('\n── 妖物 ──');
  console.log(text.trim());

  if (final.lastOffering) {
    const o = final.lastOffering;
    console.log(`\n裁决：${o.elementName || ''} · ${o.verdict} · ${o.damage} 伤害 · 评级 ${o.grade}`);
  }
  console.log(
    `\n第 ${final.state.day} 夜 | 妖物 ${final.state.guardianHp}${final.guardian ? '/' + final.guardian.hp : ''}`
    + ` | 旅人 ${final.state.playerHp}/100`
    + ` | ${final.turns} 轮 ${final.toolCalls} 工具 ${(final.ms / 1000).toFixed(1)}s`
  );
  if (tools.length) console.log(`调用：${tools.join(' → ')}`);
  if (final.state.phase === 'maze') console.log('★ 妖物退了，天亮了');
  if (final.state.over) console.log('× 力竭，这一局到此为止');
})();
