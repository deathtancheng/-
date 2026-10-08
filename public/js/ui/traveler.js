/**
 * 旅人面板：数值 / 装备 / 咒术 / 背景色调
 * ------------------------------------------------------------------
 * 攻击力必须从 state.stats 起算再叠装备——写死 10/4/0.05 会把「强攻」
 * 攒下来的加攻覆盖掉，这个坑踩过一次。
 */

import { el } from '../dom.js';
import { S } from '../store.js';
import { castFlow } from './cast.js';

/** 元素的形象图层：穿什么属性就叠哪一张画 */
const FIGURE_LAYER = {
  metal: 'assets/figure/eq-metal.png',
  fire:  'assets/figure/eq-fire.png',
  water: 'assets/figure/eq-water.png',
  earth: 'assets/figure/eq-earth.png',
  wood:  'assets/figure/eq-wood.png',
  volt:  'assets/figure/eq-volt.png',
  lore:  'assets/figure/eq-lore.png',
  guard: 'assets/figure/eq-guard.png',
  life:  'assets/figure/eq-life.png',
  unknown: 'assets/figure/eq-lore.png',
};
const LAYER_SLOTS = 3;   // 规则层 addEquipment 限三件

/**
 * 旅人形象：立绘 + 装备图层。
 * 换装时图层淡入一下（.wear 类），让"我变强了"看得见——
 * 光改数字，玩家感觉不到自己换了身行头。
 */
export function renderFigure() {
  if (!el.fcStage) return;
  const st = S.state;
  if (!st) return;
  const eq = (st.equipment || []).slice(0, LAYER_SLOTS);

  // 数值（和夜战面板同一套算法：从 state.stats 起算再叠装备）
  const b = st.stats || {};
  const n = { atk: b.atk ?? 10, def: b.def ?? 4, crit: b.crit ?? 0.05 };
  for (const e of eq) { n.atk += e.atk || 0; n.def += e.def || 0; n.crit += e.crit || 0; }
  n.crit = Math.min(0.6, n.crit);
  el.fcAtk.textContent = n.atk;
  el.fcDef.textContent = n.def;
  el.fcCrit.textContent = Math.round(n.crit * 100) + '%';
  el.fcRealm.textContent = `第 ${st.cycle || 1} 周目 · 第 ${st.day || 1} 天`;

  // 槽位：缩略图 + 名称（悬停看属性）
  el.fcSlots.innerHTML = Array.from({ length: LAYER_SLOTS }, (_, i) => {
    const e = eq[i];
    if (!e) return '<div class="fc-slot empty">空</div>';
    const src = FIGURE_LAYER[e.element] || FIGURE_LAYER.unknown;
    return `<div class="fc-slot" title="${e.name}（${e.elementName}）｜攻+${e.atk} 防+${e.def}`
      + `${e.crit ? ' 暴+' + Math.round(e.crit * 100) + '%' : ''}">`
      + `<img src="${src}" alt=""><i>${e.name}</i></div>`;
  }).join('');

  // 图层：签名变了才重挂，否则每帧重设 src 会闪
  const sig = eq.map((e) => e.element).join('|');
  if (sig === S.prev.wear) return;
  const first = S.prev.wear == null;
  S.prev.wear = sig;
  for (let i = 0; i < LAYER_SLOTS; i++) {
    const img = el.fcL[i];
    if (!img) continue;
    const e = eq[i];
    if (!e) { img.hidden = true; continue; }
    img.hidden = false;
    img.src = FIGURE_LAYER[e.element] || FIGURE_LAYER.unknown;
    img.title = e.name;
  }
  if (!first && el.fcStage) {
    el.fcStage.classList.remove('wear');
    void el.fcStage.offsetWidth;
    el.fcStage.classList.add('wear');
  }
}

/** 五道咒，跟服务端 SKILLS 表保持一致（前端只做展示和念咒匹配） */
export const SKILLS = [
  { id: 'blaze', name: '焚天', element: 'fire', cost: 40 },
  { id: 'tide', name: '涌泉', element: 'water', cost: 35, heal: 12 },
  { id: 'bolt', name: '裂空', element: 'volt', cost: 50 },
  { id: 'root', name: '缠根', element: 'wood', cost: 30 },
  { id: 'mirror', name: '镜返', element: 'guard', cost: 45, heal: 10 },
];

export function renderTraveler() {
  const { state } = S;
  if (!state) return;
  const eq = state.equipment || [];

  // 同样从玩家当前 stats 起算，别写死 10/4/0.05——那会把强攻攒的加攻抹掉
  const b = state.stats || {};
  const st = { atk: b.atk ?? 10, def: b.def ?? 4, crit: b.crit ?? 0.05 };
  for (const e of eq) { st.atk += e.atk || 0; st.def += e.def || 0; st.crit += e.crit || 0; }
  st.crit = Math.min(0.6, st.crit);

  el.stAtk.textContent = st.atk;
  el.stDef.textContent = st.def;
  el.stCrit.textContent = Math.round(st.crit * 100) + '%';
  // 攻击涨了就跳一下，玩家能感到「我在变强」
  if (S.prev.atk !== null && st.atk > S.prev.atk) {
    const box = el.stAtk.parentElement;
    box.classList.remove('up'); void box.offsetWidth; box.classList.add('up');
  }
  S.prev.atk = st.atk;

  const mana = (state.stats && state.stats.mana) || 0;
  el.manaBar.style.width = mana + '%';
  el.manaNum.textContent = mana;

  el.equipRow.innerHTML = eq.length
    ? eq.map((e) => `<div class="equip"><span class="en">${e.name}</span>`
        + `<span class="ev">攻+${e.atk} 防+${e.def}${e.crit ? ' 暴+' + Math.round(e.crit * 100) + '%' : ''}</span></div>`).join('')
    : '<span class="slot-title" style="margin:0">（还没有装备，试试「固守」）</span>';

  const known = state.skills || [];
  el.skillRow.innerHTML = '';
  SKILLS.filter((s) => known.includes(s.id)).forEach((s) => {
    const btn = document.createElement('button');
    const poor = mana < s.cost;
    btn.className = 'skill' + (poor ? ' poor' : '');
    btn.innerHTML = `${s.name}<small>${s.cost} 术力${s.heal ? ' · 回血' : ''}</small>`;
    btn.onclick = () => { if (!poor && !S.busy && state.phase === 'night') castFlow(s); };
    el.skillRow.appendChild(btn);
  });
  if (!known.length) {
    el.skillRow.innerHTML = '<span class="slot-title" style="margin:0">（还没学会任何咒）</span>';
  }
  renderFigure();   // 形象卡是常驻的：任何阶段换了装备都要立刻反映到立绘上
}

/** 夜战背景：按妖物的 art 铺对应色调 */
const ART_CLASS = { fire: 'fire', water: 'water', metal: 'metal', volt: 'volt', lore: 'lore' };

export function renderBossBg() {
  if (!el.bossBg || !S.state) return;
  const art = (S.guardian && S.guardian.art) || 'fire';
  el.bossBg.className = 'boss-bg ' + (ART_CLASS[art] || 'fire');
  el.bossBg.classList.toggle('on', S.state.phase === 'night' && !S.state.over);
}
