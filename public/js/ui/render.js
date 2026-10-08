/**
 * 渲染调度（v4：三屏制）
 * ------------------------------------------------------------------
 * 前端的「唯一一次全屏重画」入口。
 *
 * v4 把界面按**阶段**分成了三块，这个文件就是那块「谁在什么时候出现」的开关：
 *
 *   maze  ── 旧宅迷宫（走格、拾物、遇妖、下潜）
 *   hall  ── 万物阁（盖房、卖物、炼精怪、吃饭睡觉）
 *   night ── 夜袭（妖物上门，献祭对打——唯一会惊动模型的地方）
 *   over  ── 一局结束（结算弹窗）
 *
 * 面板显隐不在这里用 JS 一个个切 hidden，而是把阶段写进 <body class="phase-*">，
 * 让 CSS 去决定显示哪一屏。理由：显隐是纯样式问题，写在 CSS 里改起来只有一处，
 * 而且不会出现"JS 忘了切某个面板"这种漏网。
 *
 * 规则很简单：局面变了（后端推来的、或自己发请求拿回来的）就写进 store，
 * store 通知订阅者，订阅者就是这里的 renderAll。
 * 所以**任何 UI 模块都不应该自己判断什么时候该刷新**——那是这一层的事。
 *
 * 例外：'busy' 只改按钮可用状态，走 syncOfferButton 自己处理，不重画整屏。
 */

import { el } from '../dom.js';
import { S, remember, subscribe } from '../store.js';
import { renderSurvival, renderNews } from './survival.js';
import { renderMaze, renderScene, syncMazeLock } from './maze.js';
import { renderHall } from './hall.js';
import { renderNight } from './guardian.js';
import { renderOffering, syncOfferButton, renderManual } from './offering.js';
import { renderFigure } from './traveler.js';
import { renderCycle } from './stance.js';
import { setCam } from './hud.js';
import { addLog } from './fx.js';
import { showEnding } from './modal.js';
import { paintClock } from './clock.js';

/** 全屏重画一份局面 */
export function renderAll(reason = '') {
  if (reason === 'busy') {
    // 忙锁变化：不重画全屏，但**必须**重算受它影响的按钮——
    // 献祭按钮和回阁/方向键都归它管（漏掉就会出现"按钮一直灰着"）。
    syncOfferButton();
    syncMazeLock();
    return;
  }

  const st = S.state;
  if (!st) return;

  // 白天死亡（饿着赶路/踩陷阱/被反扑）没有夜战那种流式收尾事件，
  // 结算屏只能在这儿补弹：局面第一次变成"已结束"时，盖个章。
  // 夜战死亡会再触发一次——showEnding 自己幂等（同一章盖两遍无害）。
  if (st.over && S.prev.over !== st.over) {
    remember('over', st.over);
    setTimeout(() => showEnding(), 500);
  }

  // 先把阶段挂到 body 上：CSS 靠它决定显示哪一屏
  document.body.className = 'phase-' + (st.over ? 'over' : st.phase);

  // 夜战熬到天亮、妖物没死：它不是逃了，是"衔恨而去"（v4.5.5）。
  // 后端 pushNews 会长文进新闻栏，这里在战报里补一行短的，让守夜的人当场看到。
  if (reason === 'clock:dawn' && S.prev.phase === 'night' && st.phase === 'maze' && st.beastSlain === false) {
    const g = Math.max(1, Number(st.beastGrudge) || 1);
    addLog({
      idx: '晨',
      html: `<b>它没有倒下。</b>晨光把它逼回暗处——梁上的账它记下了（衔恨 ×${g}），今夜还会来，更凶。`,
      right: '',
      fresh: true,
    });
  }

  renderDayNight(st);
  paintClock();       // 时辰：秒表 + 背景光景（时间会自己走，这里只是照着画）
  renderFigure();     // 旅人形象卡：常驻右栏顶上，换装备立刻变脸
  renderSurvival();
  renderNews();
  renderCycle();
  renderManual();     // 手动举物的按钮按后端的属性表生成，属性不会走岔

  if (st.phase === 'maze') {
    renderMaze();     // 内部会按"这一格要不要举物"决定取景框开合
  } else if (st.phase === 'hall') {
    setCam(false);    // 经营时镜头不在场
    renderScene();
    renderHall();
  } else {
    setCam(true);     // 夜战：镜头必须在线，那是唯一的出手方式
    renderScene();
    renderNight();
  }

  renderOffering();

  // 舞台自检（v4.4.4）：舞台是 galgame 的主画面，不该被任何东西吞掉。
  // 旧样式缓存、未知的样式覆盖都可能把它压扁/藏起——渲染完量一次高度，
  // 异常就现场扶起来（min-height / flex / display 三管齐下），别让玩家干瞪眼。
  requestAnimationFrame(() => {
    if (!el.galStage || !S.state || S.state.over) return;
    const h = el.galStage.getBoundingClientRect().height;
    if (h < 120) {
      el.galStage.style.minHeight = '260px';
      el.galStage.style.flex = '1 1 0';
      el.galStage.style.display = 'block';
      console.warn('[stage] 舞台高度异常（' + Math.round(h) + 'px），已现场修复');
    }
  });
}

/** 把这一屏挂上 store 的订阅（整个前端只有这一处） */
export function bindRender() {
  return subscribe((_s, reason) => renderAll(reason));
}

/**
 * 顶栏的昼夜徽章：现在到底是白天还是夜里、在干什么。
 * 顶栏原来只写「第 N 天」，可"第 1 天"这句话白天夜里都成立——
 * 玩家点完入夜才发现自己换了个世界。现在直接把时辰摊开：
 *   白天 · 拾物 ｜ 入夜 · 守阁 ｜ 阁里 · 经营 ｜ 结束 · 力竭
 */
function renderDayNight(st) {
  if (!el.dayNight) return;
  const map = st.over
    ? { icon: '✕', text: '已结束', sub: '力竭' }
    : st.phase === 'night'
      ? { icon: '☾', text: '夜晚', sub: '守阁' }
      : st.phase === 'hall'
        ? { icon: '☀', text: '白天', sub: '在阁里' }
        : { icon: '☀', text: '白天', sub: '拾物' };
  el.dnIcon.textContent = map.icon;
  el.dnText.textContent = map.text;
  el.dnSub.textContent = map.sub;
  el.dayNight.className = 'daynight-chip ' + (st.over ? 'dn-over' : st.phase);
  el.dayNight.title = st.over
    ? '这一局已经结束了'
    : st.phase === 'night'
      ? `第 ${st.day} 夜 · 妖物在阁外，举东西砸它`
      : `第 ${st.day} 天 · ${map.sub}`;
}
