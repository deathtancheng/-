/**
 * 夜战面板：妖物 + 架势 + 旅人
 * ------------------------------------------------------------------
 * 只在 phase === 'night' 时被 render.js 叫起来。
 * 立绘、名号、属性色、血条、狂暴、连击、道具栏、背景色调。
 *
 * 立绘只有五张（fire/water/metal/volt/lore），十只妖物按 art 字段
 * 映射过去——加新妖物只要在规则层写 art，前端一行都不用改。
 */

import { el } from '../dom.js';
import { S } from '../store.js';
import { bump, heroFlinch } from './fx.js';
import { renderTraveler, renderBossBg } from './traveler.js';
import { renderStance, renderRelics, renderDao, renderInsights } from './stance.js';

const BUFF_NAMES = {
  armor: '护心镜·反伤-30%',
  whetstone: '磨刀石·下次+40%',
};

export function renderNight() {
  const { state, guardian, elements } = S;
  if (!state) return;

  const beast = guardian || (state.night ? state.night : null);
  if (!beast) {
    // 白天没人上门：把夜战面板留成一段安静的旁白
    el.speech.textContent = '天还亮着，阁里静得很。';
    renderTraveler();
    renderBossBg();
    renderDao();
    renderInsights();
    renderRelics(S.relicCache && S.relicCache.owned ? S.relicCache.owned : null);
    return;
  }

  el.gName.textContent = beast.name;
  const e = elements[beast.element] || { name: '?', color: '#999' };
  el.gEle.textContent = e.name;
  el.gEle.style.background = e.color;
  el.gTone.textContent = beast.persona || '';
  el.gScene.textContent = beast.scene || '';
  if (el.guardianBox) el.guardianBox.style.setProperty('--ele-color', e.color);

  const maxHp = beast.hp || (state.night && state.night.maxHp) || 1;
  const hp = Number(state.night ? state.night.hp : state.guardianHp) || 0;
  const gp = Math.max(0, Math.round((hp / maxHp) * 100));
  el.gBar.style.width = gp + '%';
  el.gHp.textContent = `妖物 ${hp} / ${maxHp}`;

  const pp = Math.max(0, Math.min(100, Math.round((Number(state.playerHp) || 0))));
  el.pBar.style.width = pp + '%';
  el.pHp.textContent = `旅人 ${state.playerHp} / 100`;

  // 血量掉了就抖一下，让「挨打」有触感。第一次画（prev 为 null）不抖。
  // 夜战里的反伤走了 enemyAttack 的整套演出（墨弹落地才 heroFlinch），
  // 这里只兜夜战之外的掉体力——摸黑赶路、陷阱之类的暗扣（v4.5.3）。
  if (S.prev.gHp !== null && hp < S.prev.gHp) bump(el.gBarWrap, 'hit');
  if (S.prev.pHp !== null && state.playerHp < S.prev.pHp) {
    bump(el.pBarWrap, 'hit');
    if (state.phase !== 'night') heroFlinch();
  }
  S.prev.gHp = hp;
  S.prev.pHp = state.playerHp;

  // 立绘：换了对手才换图，带一次呼吸淡入。
  // 十只妖只有五张底图——同一张图的不同妖物按名字染不同的色相，
  // 不然"换了个 boss 还是上一张脸"（v4.5.1 实玩反馈）。
  if (el.gPortrait && beast.id !== S.prev.portraitLv) {
    S.prev.portraitLv = beast.id;
    el.gPortrait.src = artOf(beast);
    let h = 0;
    for (const ch of String(beast.id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    el.gPortrait.style.filter = `hue-rotate(${h - 180}deg) saturate(1.12)`;
    el.gPortrait.classList.remove('swap');
    void el.gPortrait.offsetWidth;
    el.gPortrait.classList.add('swap');
    bump(el.gName, 'pop', 550);
  }

  // 狂暴：体力低于三成半，立绘发烫、角标亮起
  const enraged = maxHp > 0 && (hp / maxHp) < 0.35 && !state.over;
  if (el.guardianBox) el.guardianBox.classList.toggle('enraged', enraged);
  if (el.gRage) el.gRage.hidden = !enraged;

  // 连击章：连续克制 ≥2 次才亮
  if (el.gCombo) {
    const combo = state.combo || 0;
    if (combo >= 2 && !state.over) {
      if (el.gCombo.hidden) {
        el.gCombo.hidden = false;
        el.gCombo.classList.remove('bump');
        void el.gCombo.offsetWidth;
        el.gCombo.classList.add('bump');
      }
      el.gCombo.textContent = `连击 ×${combo}`;
    } else {
      el.gCombo.hidden = true;
    }
  }

  // 道具栏
  if (el.buffRow) {
    const buffs = state.buffs || [];
    el.buffRow.hidden = !buffs.length;
    el.buffRow.innerHTML = buffs.map((b) => `<span class="buff">${BUFF_NAMES[b] || b}</span>`).join('');
  }

  renderTraveler();
  renderBossBg();
  renderStance();
  renderRelics(S.relicCache && S.relicCache.owned ? S.relicCache.owned : null);
  renderDao();
  renderInsights();
}

/** 妖物立绘：art 决定用哪一张，五张图轮着来 */
const ART_N = { fire: 1, water: 2, metal: 3, volt: 4, lore: 5 };
export function artOf(beast) {
  const art = (beast && beast.art) || 'fire';
  const n = ART_N[art] || 1;
  return `/public/img/guardian-${n}-${art}.jpg`;
}
