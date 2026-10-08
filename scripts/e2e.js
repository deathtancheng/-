/**
 * 端到端测试：走真实 HTTP，模拟浏览器的完整交互
 *   node harness/e2e.js
 * 验证：SSE 事件流、权限闸门往返、报告落盘、记忆沉淀
 */

const BASE = 'http://127.0.0.1:5178';

const GOALS = process.argv[2]
  ? [process.argv[2]]
  : ['查一下 2026 年今天是几月几号，然后算一下距离年底还有多少天，把这两个数字写进 notes/e2e.md。'];

async function runOne(goal) {
  console.log('\n╔═ 目标 ═══════════════════════════════════════════');
  console.log(goal);

  const res = await fetch(`${BASE}/api/harness/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }

      switch (evt.type) {
        case 'confirm_request':
          console.log(`  ⚠ 权限请求 #${evt.id}：${evt.name}（${evt.levelLabel}）`);
          const r = await fetch(`${BASE}/api/harness/confirm`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: evt.id, allow: true }),
          });
          const j = await r.json();
          console.log(`     → 自动放行，服务端回复 ${JSON.stringify(j)}`);
          break;
        case 'turn':
          if (evt.phase === 'start') console.log(`  ── 第 ${evt.turn} 轮 ──`);
          break;
        case 'tool':
          if (evt.phase === 'end') {
            const flag = evt.ok ? '✓' : evt.blocked ? '⊘' : '✗';
            console.log(`     ${flag} ${evt.name} ${evt.ms}ms`);
            console.log(`       ${String(evt.output || '').replace(/\s+/g, ' ').slice(0, 110)}`);
          }
          break;
        case 'compact':
          console.log(`  ⇲ 上下文压缩 → ${evt.tokens} tokens`);
          break;
        case 'error':
          console.log(`  ✗ ${evt.message}`);
          break;
        case 'final':
          result = evt;
          break;
        default:
          break;
      }
    }
  }

  if (result) {
    console.log('\n╚═ 结果 ═══════════════════════════════════════════');
    console.log(`轮次 ${result.turns} · 工具 ${result.toolCalls} 次 · 压缩 ${result.compactions} 次 · ${(result.ms / 1000).toFixed(1)}s`);
    console.log(`报告：${result.reportPath || '（无）'}`);
    console.log('\n' + (result.text || '（无文本）'));
  }
  return result;
}

(async () => {
  const s = await (await fetch(`${BASE}/api/harness/state`)).json();
  console.log(`Harness：${s.tools.length} 工具 · 扩展 [${s.extensions.map((e) => e.name).join(', ')}] · 记忆 ${s.memory.facts}事实/${s.memory.episodes}经历`);

  for (const g of GOALS) await runOne(g);

  const m = await (await fetch(`${BASE}/api/harness/memory`)).json();
  console.log(`\n记忆现状：${JSON.stringify(m).slice(0, 200)}`);
})().catch((e) => {
  console.error('E2E 失败：', e);
  process.exit(1);
});
