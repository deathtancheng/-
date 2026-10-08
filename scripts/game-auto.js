/**
 * 《拾物奇谭》自动守夜演示（v4）
 * ------------------------------------------------------------------
 *   node scripts/game-auto.js
 *
 * 人类只按一次启动键，剩下的交给 Harness：
 * 入夜 → 查局面 → 挑克制物件 → 献祭 → 读裁决 → 妖物退了换下一天 → 再入夜……
 * 直到力竭（旅人倒下，一局结束）或跑到天数上限。
 * 整个循环里没有一行游戏逻辑写在主流程里，全部通过 Harness 的工具与事件流完成。
 *
 * 这正是题目里那句"人类仅作启动子"的字面实现。
 * v4 的一局没有"通关"这个点——成绩是活了多少天，所以天数上限就是终点。
 */

const API = process.env.API || 'http://127.0.0.1:5178';
const MAX_DAYS = Number(process.env.DAYS || 3);   // 默认守 3 天，够看出节奏了

// 按妖物属性挑什么物件：查克制表挑出能压制它的那一个
const COUNTER_ITEM = {
  fire: { label: 'bottle', why: '水克火' },
  water: { label: 'chair', why: '土克水' },
  metal: { label: 'toaster', why: '火克金' },
  volt: { label: 'chair', why: '土克电' },
  lore: { label: 'toaster', why: '火克知' },
};

async function post(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json().catch(() => ({}));
}

async function actOnce(label, conf, area) {
  const res = await fetch(`${API}/api/game/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label, conf, area_ratio: area }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let final = null;
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
      if (e.type === 'content') text += e.text || '';
      if (e.type === 'confirm_request') {
        // 人类不在场，权限门一律放行——这是演示脚本，不是生产环境
        await post('/api/game/confirm', { id: e.id, allow: true });
      }
      if (e.type === 'final') final = e;
    }
  }
  return { text: text.trim(), final };
}

(async function main() {
  await post('/api/game/reset');
  console.log('阁门开启。人类按下启动键，接下来由 Harness 自己守。\n');

  const t0 = Date.now();
  let strikes = 0;
  let ended = false;

  for (let day = 1; day <= MAX_DAYS && !ended; day++) {
    // 入夜：抽出今晚的妖物
    const n = await post('/api/game/night');
    if (!n.ok || !n.beast) {
      console.log('入不了夜：' + (n.error || n.msg || '不知道为什么'));
      break;
    }
    const plan = COUNTER_ITEM[n.beast.element] || { label: 'cup', why: '没有克制的，随便举' };
    console.log(`— 第 ${day} 夜 · ${n.beast.name}（${n.beast.element}）· 献上 ${plan.label}（${plan.why}）`);

    // 一夜之内反复献祭，直到妖物倒下或旅人倒下
    for (let i = 1; i <= 24; i++) {
      const cur = await (await fetch(`${API}/api/game/state`)).json();
      if (cur.state.over) { ended = true; break; }
      if (cur.state.phase !== 'night') break;    // 妖物退了，天亮了

      const { text, final } = await actOnce(plan.label, 0.9, 55);
      strikes += 1;
      if (!final) { console.log('   （没有返回结果，停）'); ended = true; break; }

      const o = final.lastOffering;
      if (o) console.log(`   ${o.elementName} · ${o.verdict} · ${o.damage} 伤害 ${o.grade} 级`);
      console.log(`   「${text.replace(/\s+/g, ' ').slice(0, 78)}…」`);
      console.log(
        `   妖物 ${final.state.guardianHp}${final.guardian ? '/' + final.guardian.hp : ''}`
        + ` | 旅人 ${final.state.playerHp}/100`
        + ` | ${final.turns}轮 ${(final.ms / 1000).toFixed(1)}s`
      );

      if (final.state.over === 'lose') {
        console.log(`\n✗ 旅人倒在阁里。守到了第 ${final.state.day} 天。`);
        ended = true;
        break;
      }
      if (final.state.phase === 'maze') {
        console.log(`   ★ 妖物退了 → 第 ${final.state.day} 天\n`);
        break;
      }
    }
  }

  const st = await (await fetch(`${API}/api/game/state`)).json();
  console.log(
    `\n== 收工 == 守到第 ${st.state.day} 天 · 共 ${strikes} 发 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
    + ` · 旅人剩余体力 ${st.state.playerHp}`
  );
  if (st.state.lastWin) {
    console.log(`   结算：${st.state.lastWin.relic ? '解锁遗物 ' + st.state.lastWin.relic.name : '遗物已全部解锁'}`
      + ` · 下一局是第 ${st.state.lastWin.nextCycle} 周目`);
  }
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
