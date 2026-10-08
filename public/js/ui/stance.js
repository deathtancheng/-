/**
 * 架势 / 限时 / 周目 / 遗物 / 道行 / 心得
 * ------------------------------------------------------------------
 * 这一块全是「让玩家看得见的机制」。
 * 架势条要一眼告诉玩家「这一击该举什么属性的东西」，
 * 不然姿态机制就变成一个藏在 JSON 里的数字，玩家根本感知不到。
 *
 * 境界与门槛全部来自后端推来的 dao 快照——前端不抄规则表，
 * 抄了改平衡时两边会不一致。
 */

import { el } from '../dom.js';
import { S, set } from '../store.js';
import { getLegacy } from '../net/api.js';

const INSIGHT_NAMES = {
  'metal-edge': '铜铁之属', 'soft-step': '履险如夷', 'loud-voice': '声若洪钟',
  'keen-eye': '眼明手快', 'steady-hand': '心细如发', 'earth-root': '厚土生根',
};

/** 架势 + 还能忍几个回合。进了狂怒就换成红字倒计时 */
export function renderStance() {
  if (!el.stanceBar || !S.state) return;
  const show = S.state.phase === 'night' && !S.state.over;
  el.stanceBar.hidden = !show;
  if (!show) return;

  const st = S.state.stance;
  if (st) {
    el.stName.textContent = st.name;
    el.stHint.textContent = `${st.hint} —— 别的属性会被挡掉一半`;
    const e = S.elements[st.breaks] || null;
    if (e) el.stName.style.borderColor = e.color;
  } else {
    el.stName.textContent = '—';
    el.stHint.textContent = '';
  }

  const left = typeof S.state.night === 'object' && S.state.night
    ? Number(S.state.night.turnsLeft)
    : Math.max(0, 8 - (Number(S.state.bossTurns) || 0));
  const frenzied = !!(S.state.night && S.state.night.frenzy) || left <= 0;
  el.stTurns.textContent = frenzied ? '狂怒中 · 反击翻倍' : `还能忍 ${left} 回合`;
  el.stanceBar.classList.toggle('frenzy', frenzied);
  el.stanceBar.classList.toggle('urgent', !frenzied && left <= 3);
}

/**
 * 周目。
 * 第 1 周目也要显示——玩家得看得见自己现在在第几周目，
 * 而且这个按钮是「回到第一周目」的入口（点击由 main.js 绑）。
 */
export function renderCycle() {
  if (!el.cyclePill || !S.state) return;
  const cyc = Math.max(1, Number(S.state.cycle) || 1);
  el.cyclePill.hidden = false;
  el.cyclePill.textContent = `第 ${cyc} 周目`;
  el.cyclePill.title = cyc > 1
    ? `第 ${cyc} 周目 · 妖物比第一周目硬得多（点一下回到第一周目）`
    : '第 1 周目 · 初始难度（点一下可以重来）';
  el.cyclePill.classList.toggle('fresh', cyc <= 1);
}

/** 遗物栏：跨局保留的永久加成 */
export function renderRelics(list) {
  if (!el.relicWrap || !el.relicRow) return;
  const owned = list || [];
  el.relicWrap.hidden = !owned.length;
  el.relicRow.innerHTML = owned.length
    ? owned.map((r) => `<span class="relic" title="${r.desc}">${r.name}<small>${r.desc}</small></span>`).join('')
    : '';
}

/** 道行 / 境界 */
export function renderDao() {
  if (!el.daoWrap || !S.state) return;
  const dao = S.state.dao || {};
  el.daoWrap.hidden = false;
  el.daoRealm.textContent = dao.realmName || '见物';
  const from = 0;
  const to = dao.nextThreshold;
  const prevThreshold = thresholdBefore(dao);
  if (to != null && to > prevThreshold) {
    const pct = Math.min(100, Math.max(0, Math.round(((dao.xp - prevThreshold) / (to - prevThreshold)) * 100)));
    el.daoBar.style.width = pct + '%';
    el.daoMeta.textContent = `${dao.xp} / ${to} → ${dao.nextName} · ${dao.realmDesc || ''}`;
  } else {
    el.daoBar.style.width = '100%';
    el.daoMeta.textContent = `${dao.xp} 道行 · 已至${dao.realmName || '见物'} · ${dao.realmDesc || ''}`;
  }
  void from;
}

/** 上一个境界的门槛。后端只给了「下一个」，这里按固定节奏倒推 */
function thresholdBefore(dao) {
  const to = dao.nextThreshold;
  if (to == null) return 0;
  // 门槛序列 0 / 15 / 40 / 80 / 140：差分是 15、25、40、60
  const gates = [0, 15, 40, 80, 140];
  const i = gates.indexOf(to);
  return i > 0 ? gates[i - 1] : 0;
}

/** 心得列表 */
export function renderInsights() {
  if (!el.insightWrap || !S.state) return;
  const dao = S.state.dao || {};
  const ids = dao.insights || [];
  el.insightWrap.hidden = !ids.length;
  el.insightRow.innerHTML = ids.length
    ? ids.map((id) => `<span class="insight" title="${INSIGHT_NAMES[id] || id}">${INSIGHT_NAMES[id] || id}</span>`).join('')
    : '';
}

/**
 * 拉一次跨局存档，把遗物名补上（state 里只有 id）。
 * 拿不到就静默失败——遗物栏不显示不影响玩。
 */
export async function loadLegacy() {
  try {
    const j = await getLegacy();
    if (j.ok) {
      set({ relicCache: j }, 'legacy');
      renderRelics(j.owned || []);
    }
  } catch { /* 拿不到就不显示遗物栏 */ }
  return S.relicCache;
}
