/**
 * 时辰 —— 时间会自己走
 * ------------------------------------------------------------------
 * v4.5 之前，白天想逛多久就逛多久、夜里想磨多久就磨多久：
 * 没有时间压力，玩家自然"随便就能过关"。
 *
 * 现在每个时段都有一段长度，走完就自动翻页：
 *
 *   白天（在迷宫里拾物）→ 天黑了，必须回阁（没走到歇脚处要付代价）
 *   黄昏（在阁里经营）  → 夜幕落下，妖物自己上门（不点入夜也会来）
 *   夜里（守阁 / 夜战）→ 天亮，回到迷宫里原来那一格接着逛
 *
 * 时钟只有三个字段，全部存在存档里：
 *   kind  当前时段（day / dark / dusk / night）
 *   endAt 这一时段结束的时刻（毫秒时间戳）
 *   len   这一时段的总长度（毫秒）—— 前端拿它算进度条
 *
 * 规则层负责"到点了改什么"，前端只负责把剩多少秒画出来。
 * 时钟不搬运玩家：到点只换光景、扣血、让妖物上门——
 * 出不入阁、什么时候回，始终是玩家自己的决定。
 */

/** 各时段长度（毫秒）。想调难度改这里就行 */
const LEN = {
  day:   3 * 60 * 1000,    // 白天：3 分钟，够摸五六间屋子，不够把整层走遍
  dark:  2.5 * 60 * 1000,  // 摸黑：天黑了人还在外面——血一直在掉，这是真正的夜
  dusk:  60 * 1000,        // 黄昏：1 分钟经营 —— 盖房、卖货、喂精怪，得取舍
  night: 3.5 * 60 * 1000,  // 夜里：3 分半（v4.5.1 延长了半分钟，打完一套连招得够）
};

/** 白天过了大半之后，光线开始沉下去（前端据此换背景） */
const DUSK_TURN = 0.45;

function lenOf(kind) {
  return LEN[kind] || LEN.day;
}

/** 开一个时段。now 可以注入，方便测试 */
function newClock(kind = 'day', now = Date.now()) {
  const len = lenOf(kind);
  return { kind, len, endAt: now + len };
}

/** 这一时段还剩多少毫秒（不会小于 0） */
function clockLeft(state, now = Date.now()) {
  const c = state && state.clock;
  if (!c || !c.endAt) return 0;
  return Math.max(0, c.endAt - now);
}

/** 这一时段走了多少（0~1）。前端拿它画进度条和换背景 */
function clockRatio(state, now = Date.now()) {
  const c = state && state.clock;
  if (!c || !c.endAt) return 0;
  const len = c.len || lenOf(c.kind);
  const passed = len - Math.max(0, c.endAt - now);
  return Math.min(1, Math.max(0, passed / len));
}

/** 到点了吗 */
function clockExpired(state, now = Date.now()) {
  return clockLeft(state, now) <= 0;
}

/** 把时钟切到下一个时段 */
function startClock(state, kind, now = Date.now()) {
  state.clock = newClock(kind, now);
  return state.clock;
}

/**
 * 现在是什么光景。前端据此换背景（day / dusk / night）。
 * 摸黑（dark）也是夜里——人在旧宅，天已经黑透了。
 */
function lookOf(state, now = Date.now()) {
  const phase = state && state.phase;
  if (phase === 'night' || (state && state.dark)) return 'night';
  const c = state && state.clock;
  if (!c) return phase === 'hall' ? 'dusk' : 'day';
  if (c.kind === 'night' || c.kind === 'dark') return 'night';
  if (c.kind === 'dusk') return 'dusk';
  // 白天：过了大半就染上暮色
  return clockRatio(state, now) >= DUSK_TURN ? 'dusk' : 'day';
}

/** 秒表样式：01:23 */
function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

module.exports = {
  LEN, DUSK_TURN,
  lenOf, newClock, clockLeft, clockRatio, clockExpired, startClock, lookOf, fmtClock,
};
