/**
 * 时辰（前端只负责画）
 * ------------------------------------------------------------------
 * 后端每秒走一次表，走完就翻页（天黑回阁 / 夜幕落下 / 天亮回原格），
 * 翻页的结果由 SSE 推过来。前端这边要做的只有三件事：
 *
 *   1. 把"还剩多少"画成秒表——endAt 是绝对时刻，本地每半秒自己算一次，
 *      不必为了看时间就去烦后端
 *   2. 按光景给 body 挂 data-tod（day / dusk / night）——背景自己会变
 *   3. 时辰快走完时给个提醒，别让玩家莫名其妙被撵回阁里
 */

import { el } from '../dom.js';
import { S } from '../store.js';
import { addLog } from './fx.js';

const LOOK = {
  day:   { icon: '☀', text: '白天', sub: '拾物' },
  dusk:  { icon: '☾', text: '黄昏', sub: '经营' },
  night: { icon: '☽', text: '夜里', sub: '守阁' },
};

const KIND_NOTE = {
  day: '天黑之前得摸回歇脚处',
  dusk: '夜幕落下的工夫，够办一件事',
  night: '天亮之前打不退它，东西就没了',
};

let timer = null;
let warned = '';      // 同一个时辰只提醒一次

/** 本地算剩余毫秒：快照里的 leftMs 会随时间变老，得按 endAt 自己算 */
function leftMs() {
  const c = S.state && S.state.clock;
  if (!c || !c.endAt) return 0;
  return Math.max(0, c.endAt - Date.now());
}

function fmt(ms) {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 画一次时辰：chip 文案 / 秒表 / 进度条 / 背景光景 */
export function paintClock() {
  const st = S.state;
  if (!st || !el.dnTime) return;
  const c = st.clock;
  if (!c) return;

  // 一局结束了：这一屏交给 renderDayNight 的"已结束"，秒表别再抢话
  if (st.over) {
    if (el.dnTime) el.dnTime.textContent = '--:--';
    if (el.dnFill) el.dnFill.style.width = '0%';
    document.body.dataset.tod = 'night';
    return;
  }

  const look = c.look || 'day';
  const meta = LOOK[look] || LOOK.day;
  if (el.dnIcon) el.dnIcon.textContent = meta.icon;
  if (el.dnText) el.dnText.textContent = meta.text;
  if (el.dnSub) {
    // 夜战里直接写"守阁"，其余时候写这一段还剩多久能干什么
    el.dnSub.textContent = st.phase === 'night' ? '守阁' : (KIND_NOTE[c.kind] || meta.sub);
  }

  const left = leftMs();
  el.dnTime.textContent = fmt(left);
  // 进度条：走掉的那一截
  const ratio = c.len ? Math.min(1, Math.max(0, 1 - left / c.len)) : 0;
  if (el.dnFill) el.dnFill.style.width = `${(ratio * 100).toFixed(1)}%`;
  el.dnTime.classList.toggle('urgent', left <= 20000);
  el.dnTime.title = `${meta.text}还剩 ${fmt(left)}——${
    c.kind === 'day' ? '到点天就黑了，会被撵回阁里' : c.kind === 'dusk' ? '到点妖物自己上门' : '到点天亮，没打退它东西就没了'
  }`;

  document.body.dataset.tod = look;

  // 剩 15 秒提醒一次：让玩家来得及做决定，而不是被突然翻页
  if (left > 0 && left <= 15000 && warned !== c.kind + c.endAt) {
    warned = c.kind + c.endAt;
    addLog({
      idx: '⏳',
      html: c.kind === 'day'
        ? '<b>天要黑了</b>——还没摸到歇脚处的话，会被夜色撵回阁里（要付代价）。'
        : c.kind === 'dusk' ? '<b>夜幕要落了</b>——妖物快上门了。' : '<b>快天亮了</b>——它还没倒下，东西就要被搬走。',
      right: '', fresh: true,
    });
  }
}

/** 起秒表。整个前端只有这一处 setInterval 跟时辰有关 */
export function startClockTicker() {
  if (timer) return;
  timer = setInterval(paintClock, 500);
  paintClock();
}
