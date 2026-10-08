/**
 * 前端唯一的状态源
 * ------------------------------------------------------------------
 * 前端不做任何规则计算，也不判断"什么时候该刷新"。
 * 它只有两件事：
 *
 *   1. 存一份后端给的局面（subscribe 推来的，或本动作的响应）
 *   2. 局面变了就通知所有订阅者去重新渲染
 *
 * 所以这里的状态全是**后端算完的结果**，没有一个是前端自己推出来的。
 * 唯一的例外是「纯界面态」那一组（正在举哪个东西、房间卡片开没开），
 * 它们不参与任何数值判断。
 */

/** @typedef {object} Snapshot 后端推来的一份完整局面 */

const listeners = new Set();

/**
 * 全局状态。改它请用 set()，直接改字段不会触发渲染。
 */
export const S = {
  // —— 后端推来的 ——
  state: null,        // 局面（天数、阶段、饱食、精神、铜钱、迷宫、阁楼、夜战……）
  guardian: null,     // 今夜的妖物（已按天数缩放），白天是 null
  elements: {},       // 属性表（名称/颜色/调性）
  labelElement: {},   // 物件名 → 属性。后端推来，手动举物靠它标属性
  legacy: null,       // 跨局存档

  // —— 纯前端的界面态 ——
  busy: false,        // 正在等后端，按钮要锁住
  busySince: 0,       // 什么时候开始忙的，看门狗拿它判断是否卡死
  round: 0,           // 战报行号
  intent: 'power',    // 这一祭想转化成什么：power / guard / arcane
  offering: null,     // 当前祭品（摄像头认出来的，或手动选的）
  detect: null,       // 最近一次 YOLO 检测结果（画框用）
  manual: null,       // 手动举物
  relicCache: null,   // 遗物详情（state 里只有 id）
  winReport: null,    // 上一次一局的结算
  room: null,         // 脚下房间的结果 / 待办（举物、抉择、买货）
  sceneAt: null,      // 场景层正在演的是哪一格（"x,y"）
  sceneClosed: false, // 这一格的场景被玩家合上了（自动结算的房间才有）

  // —— 渲染用的"上一次"快照，用来判断该不该播动画 ——
  prev: { gHp: null, pHp: null, phase: null, atk: null, portraitLv: null, label: null, day: null },
};

/** 订阅状态变化。返回取消订阅的函数 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 更新状态并通知订阅者。
 * @param {Partial<typeof S>} patch 只传要改的字段
 * @param {string} [reason] 这次变化的原因，方便调试
 */
export function set(patch, reason = '') {
  Object.assign(S, patch);
  for (const fn of listeners) {
    try {
      fn(S, reason);
    } catch (err) {
      console.error('[store] 订阅者出错：', err);
    }
  }
}

/**
 * 静默写入：改字段但不触发渲染。
 * 摄像头 1.2 秒一轮的轮询用它——那种频率下不该重画整屏。
 */
export function assign(patch) {
  Object.assign(S, patch);
}

/** 只改 prev 里的某一项（动画判重用，不需要触发整轮渲染） */
export function remember(key, value) {
  S.prev[key] = value;
}

/** 当前是否在夜战里 */
export function inNight() {
  return !!S.state && S.state.phase === 'night' && !S.state.over;
}
