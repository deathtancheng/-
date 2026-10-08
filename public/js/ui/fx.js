/**
 * 打击感小工具
 * ------------------------------------------------------------------
 * 飘字、闪屏、抖动、角标 chip、右侧战报行。
 * 这一层全是「往屏幕上加一个临时元素然后让它自己消失」，
 * 不读任何游戏状态——要不要播、播什么，由调用方决定。
 */

import { el } from '../dom.js';

/** 伤害/治疗数字飘出。x/y 是屏幕坐标 */
export function floatDamage(text, x, y, kind = '') {
  const d = document.createElement('div');
  d.className = 'dmg-float' + (kind ? ' ' + kind : '');
  d.textContent = text;
  d.style.left = x + 'px';
  d.style.top = y + 'px';
  el.fxLayer.appendChild(d);
  setTimeout(() => d.remove(), 1600);
}

/** 闪屏：red = 旅人挨打，gold = 大事（升级/通关） */
export function flash(kind) {
  el.flash.className = 'flash';
  void el.flash.offsetWidth;      // 强制重排，让动画能重播
  if (kind) el.flash.classList.add(kind);
}

/** 某个元素在屏幕上的中心点 */
export function centerOf(node) {
  const r = node.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** 给元素加一个一次性动画类 */
export function bump(node, cls, ms = 600) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
  setTimeout(() => node.classList.remove(cls), ms);
}

/**
 * 主角受击：舞台立绘 + 右栏形象卡一起晃一下、泛一层红。
 * v4.5.3 之前"旅人掉体力"只闪血条——玩家看到的是右侧妖物扑过来、
 * 自己却毫无动静，还以为扣血的是妖物。现在挨打的人自己得有反应。
 * 舞台上的 gs-hero 在左、形象卡 fc-stage 在右，两处都动才不会漏看。
 */
export function heroFlinch() {
  for (const node of [el.gsHero, el.fcStage]) {
    if (!node) continue;
    node.classList.remove('hero-hit');
    void node.offsetWidth;
    node.classList.add('hero-hit');
    setTimeout(() => node.classList.remove('hero-hit'), 620);
  }
}

/** 妖物动作角标。最多留 8 个 */
export function chip(text, cls) {
  const s = document.createElement('span');
  s.className = 'chip' + (cls ? ' ' + cls : '');
  s.textContent = text;
  el.chips.appendChild(s);
  while (el.chips.children.length > 8) el.chips.removeChild(el.chips.firstChild);
  return s;
}

/** 右侧战报加一行 */
export function addLog(item) {
  const row = document.createElement('div');
  row.className = 'row' + (item.fresh ? ' new' : '');
  row.innerHTML = `<span class="idx">${item.idx}</span>`
    + `<span class="what">${item.html}</span>`
    + `<span class="dmg">${item.right || ''}</span>`;
  el.log.appendChild(row);
  el.log.scrollTop = el.log.scrollHeight;
}

/**
 * 连接类报错专用（v4.5.4）：同样的文案 10 秒内只记一次。
 * 服务没起来时每个动作的 catch 都会喊一嗓子，战报瞬间刷成
 * 一排一模一样的"连不上后端"——吵且没信息量。折叠掉。
 */
let lastConnLog = { text: '', at: 0 };
export function logConnError(message) {
  const now = Date.now();
  if (message === lastConnLog.text && now - lastConnLog.at < 10_000) return;
  lastConnLog = { text: message, at: now };
  addLog({ idx: '×', html: '连不上后端：' + message, right: '' });
}
