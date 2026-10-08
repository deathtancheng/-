/**
 * 模态层：权限闸门 / 更新日志 / 一局结算
 * ------------------------------------------------------------------
 * 三个用途共用同一个 .modal 壳，但排版类名不同（changelog / report），
 * 所以 close() 里一定要把这两个类摘掉——否则结算表格的宽表布局
 * 会留给下一个弹层，这是踩过的坑。
 *
 * v4 的结算换了主题：肉鸽里「通关」不是一个点，而是一条长度不同的线。
 * 所以结算说的是「你在万物阁活了几天」，以及跟上一局比是长了还是短了。
 */

import { el } from '../dom.js';
import { S } from '../store.js';
import { getChangelog } from '../net/api.js';
import { flash } from './fx.js';

/** 把 markdown 转成极简 HTML：只要标题、列表和正文行 */
export function mdToHtml(md) {
  const out = [];
  let inList = false;
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^###\s+/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h3>${line.replace(/^###\s+/, '')}</h3>`);
    } else if (/^##\s+/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h3>${line.replace(/^##\s+/, '').replace(/^#+\s*/, '')}</h3>`);
    } else if (/^#\s+/.test(line)) {
      continue;   // 大标题跳过，卡片自己有标题
    } else if (/^---+$/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${line.replace(/^[-*]\s+/, '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`);
    } else if (line.trim()) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p>${line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

/** 更新日志 */
export async function showChangelog(version) {
  el.mTitle.textContent = `更新日志（当前 v${version}）`;
  el.mBody.textContent = '读取中……';
  el.mPre.style.display = 'none';
  el.mActs.innerHTML = '';
  const ok = document.createElement('button');
  ok.className = 'yes';
  ok.textContent = '知道了';
  ok.onclick = () => close();
  el.mActs.append(ok);
  el.modal.querySelector('.card').classList.add('changelog');
  el.modal.classList.add('show');
  try {
    el.mBody.innerHTML = mdToHtml(await getChangelog());
  } catch {
    el.mBody.textContent = '读不到 CHANGELOG.md。';
  }
}

/**
 * 权限闸门：弹一个模态，返回用户是否同意。
 * 会挂起读流循环——这是必须的：妖物要写战报时就是在这儿等人表态，
 * 先把整个流收完再处理会死锁。
 */
export function askConfirm(info) {
  return new Promise((resolve) => {
    el.mTitle.textContent = '妖物想动笔';
    el.mBody.textContent = `它请求执行「${info.name}」（${info.levelLabel}）。同意吗？`;
    el.mPre.style.display = 'block';
    el.mPre.textContent = JSON.stringify(info.args || {}, null, 2).slice(0, 600);
    el.mActs.innerHTML = '';
    const yes = document.createElement('button');
    yes.className = 'yes';
    yes.textContent = '准了';
    const no = document.createElement('button');
    no.className = 'no';
    no.textContent = '驳回';
    yes.onclick = () => { close(); resolve(true); };
    no.onclick = () => { close(); resolve(false); };
    el.mActs.append(yes, no);
    el.modal.classList.add('show');
  });
}

/**
 * 通用确认框：返回 Promise<boolean>。
 * 跟权限闸门 askConfirm 长得像，但那个要把结果回传给正在读的模型流，
 * 语义完全不同——不合并，免得哪天改了一处把另一处改坏。
 */
export function confirmDialog({ title, body, yes = '确定', no = '算了' }) {
  return new Promise((resolve) => {
    el.mTitle.textContent = title;
    el.mBody.textContent = body || '';
    el.mPre.style.display = 'none';
    el.mActs.innerHTML = '';
    const y = document.createElement('button');
    y.className = 'yes';
    y.textContent = yes;
    const n = document.createElement('button');
    n.className = 'no';
    n.textContent = no;
    y.onclick = () => { close(); resolve(true); };
    n.onclick = () => { close(); resolve(false); };
    el.mActs.append(y, n);
    el.modal.classList.add('show');
  });
}

/* ══════════════════════════════════════════════════════════════
   一局结算
   ══════════════════════════════════════════════════════════════ */

/** 上一局的成绩：legacy.history 的最后一条刚好是这一局，所以要往前取一条 */
function previousRun(w) {
  const hist = (S.relicCache && S.relicCache.legacy && S.relicCache.legacy.history) || [];
  if (!Array.isArray(hist) || !hist.length) return null;
  const sameRun = w && w.summary && hist[hist.length - 1]
    && hist[hist.length - 1].at === w.summary.at;
  const prev = sameRun ? hist[hist.length - 2] : hist[hist.length - 1];
  return prev || null;
}

/** 结算表格：这一局 vs 上一局。表格是纯 HTML，不用 markdown */
export function buildRunHtml(w) {
  const s = (w && w.summary) || {};
  const prev = previousRun(w);
  const col = (title, x, isNow) => {
    const sp = (x.spirits || []).map((y) => `${y.name}(${y.lv})`).join('、') || '（空）';
    const st = x.stats || {};
    return `<div class="bc-col${isNow ? ' now' : ''}"><h4>${title}</h4>`
      + `<div class="bc-row"><span>活了多少天</span><b>${x.days ?? '—'}</b></div>`
      + `<div class="bc-row"><span>最深下到</span><b>第 ${x.depth ?? '—'} 层</b></div>`
      + `<div class="bc-row"><span>交手</span><b>${x.rounds ?? '—'} 次</b></div>`
      + `<div class="bc-row"><span>铜钱</span><b>${x.coin ?? '—'} 文</b></div>`
      + `<div class="bc-row"><span>阁楼</span><b>${x.hallTitle || '一间空阁'}</b></div>`
      + `<div class="bc-row"><span>精怪</span><b>${sp}</b></div>`
      + `<div class="bc-row"><span>攻 / 防</span><b>${st.atk ?? '—'} / ${st.def ?? '—'}</b></div>`
      + `</div>`;
  };

  let html = `<p>你在万物阁活了 <b>${s.days ?? '—'}</b> 天`
    + `，最深下到第 <b>${s.depth ?? '—'}</b> 层，跟妖物交手 <b>${s.rounds ?? 0}</b> 次。</p>`;
  html += w && w.relic
    ? `<p>解锁遗物 <b>${w.relic.name}</b> —— ${w.relic.desc}。下一局开局就生效。</p>`
    : '<p>遗物已经全部解锁了。</p>';
  html += `<p>下一局是第 <b>${(w && w.nextCycle) || 1}</b> 周目，妖物会更硬。</p>`;
  html += '<div class="build-cmp">'
    + col('这一局', s, true)
    + (prev ? col(`上一局（第 ${prev.cycle} 周目）`, prev, false)
      : '<div class="bc-col"><h4>上一局</h4><div class="bc-row"><span>（这是第一局，没有可比的）</span></div></div>')
    + '</div>';
  const best = S.relicCache && S.relicCache.best;
  if (best && s.days != null && s.days >= best.days) {
    html += `<p class="bc-best">★ 新纪录：活了 ${s.days} 天，是目前最长的一次。</p>`;
  }
  return html;
}

/**
 * 一局结束：水墨从四角晕开 + 印。
 * 章先盖下去，1.4 秒后再出结算——让情绪有个落点。
 */
export function showEnding() {
  const st = S.state || {};
  const w = st.lastWin || S.winReport || null;
  const hidden = !!(w && w.ending === 'hidden');

  el.endingFx.className = 'ending-fx show lose';
  el.endSeal.textContent = hidden ? '继任守阁灵' : '力竭于此';
  el.endSeal.classList.add('stamp');
  if (hidden) flash('gold');

  setTimeout(() => {
    el.mTitle.textContent = hidden ? '隐藏结局 · 继任' : '这一局到此为止';
    const card = el.modal.querySelector('.card');
    if (w && w.summary) {
      card.classList.add('report');
      el.mBody.innerHTML = buildRunHtml(w);
    } else {
      card.classList.remove('report');
      el.mBody.textContent = '旅人倒在阁里。妖物把货仓一件件搬空，天没再亮。';
    }
    el.mPre.style.display = 'none';
    el.mActs.innerHTML = '';
    const again = document.createElement('button');
    again.className = 'yes';
    again.textContent = '再守一局';
    again.onclick = async () => {
      close();
      const { resetGame } = await import('./session.js');
      resetGame();
    };
    el.mActs.append(again);
    el.modal.classList.add('show');
  }, 1400);
}

/** 关模态，并清掉特殊排版类 */
export function close() {
  el.modal.classList.remove('show');
  const card = el.modal.querySelector('.card');
  if (card) card.classList.remove('changelog', 'report');
}
