/**
 * 生存资源栏：体力 / 饱食 / 精神 / 香火 / 铜钱 + 存活天数
 * ------------------------------------------------------------------
 * 这一条是肉鸽的「压力表」。数字本身由后端算，这里只负责：
 *   · 把三条命线画成条
 *   · 见底时变色（饿 = 黄，失魂 = 紫），让玩家在数字变小之前先「看见」
 *   · 香火单列一条 —— 它是"还能献几次"的直接读数，比什么都重要
 *   · 把天数的增长画成一排点，让"我撑了几天"变成一个看得见的成绩
 */

import { el } from '../dom.js';
import { S } from '../store.js';

/** 低于这个值就该警告了（跟 survival.js 的阈值保持一致，前端只做展示） */
const HUNGRY_AT = 25;
const MAD_AT = 20;

export function renderSurvival() {
  const st = S.state;
  if (!st) return;

  const hp = Math.max(0, Math.round(Number(st.playerHp) || 0));
  const sat = Math.max(0, Math.round(Number(st.satiety) || 0));
  const san = Math.max(0, Math.round(Number(st.sanity) || 0));
  const coin = Math.round(Number(st.coin) || 0);
  const inc = Math.max(0, Math.round(Number(st.incense) || 0));
  const incMax = Math.max(1, Math.round(Number(st.incenseMax) || 1));

  el.hpFill.style.width = Math.min(100, hp) + '%';
  el.satFill.style.width = Math.min(100, sat) + '%';
  el.sanFill.style.width = Math.min(100, san) + '%';
  el.incFill.style.width = Math.min(100, Math.round((inc / incMax) * 100)) + '%';
  el.hpNum.textContent = hp;
  el.satNum.textContent = sat;
  el.sanNum.textContent = san;
  el.incNum.textContent = inc;
  el.coinNum.textContent = coin;

  el.resBar.classList.toggle('hungry', sat <= HUNGRY_AT);
  el.resBar.classList.toggle('mad', san <= MAD_AT);
  el.resBar.classList.toggle('ash', inc <= 0);   // 香烧完了：下一祭点不着

  renderDayTrack(st.day, st.over);
}

/** 存活天数：一排点，第 13 天起折叠成 +N */
export function renderDayTrack(day, over) {
  if (!el.dayTrack) return;
  const d = Math.max(1, Math.round(Number(day) || 1));
  const CAP = 12;
  let html = '';
  for (let i = 1; i <= Math.min(d, CAP); i++) {
    html += `<i class="${i < d || over ? 'done' : 'now'}"></i>`;
  }
  if (d > CAP) html += `<span class="day-more">+${d - CAP}</span>`;
  html += `<span class="day-label">第 ${d} 天</span>`;
  el.dayTrack.innerHTML = html;
}

/**
 * 「这一局」流水：迷宫、阁楼、夜战发生的事都往里写。
 * 后端每次推局面都带 news 数组，这里整段重画——
 * 条目很少（最多 30 条），整段重画比做 diff 简单得多，也不会错。
 */
export function renderNews() {
  if (!el.newsList) return;
  const st = S.state;
  const news = (st && st.news) || [];
  if (!news.length) {
    el.newsList.innerHTML = '<div class="news-empty">还没有发生什么。推门出去看看。</div>';
    return;
  }
  el.newsList.innerHTML = news
    .slice()
    .reverse()
    .map((n) => `<div class="news-row"><span class="nd">D${n.day}</span><span class="nt">${n.text}</span></div>`)
    .join('');
}
