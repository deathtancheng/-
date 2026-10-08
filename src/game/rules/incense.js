/**
 * 香火 —— 「献祭」这一次数的硬约束
 * ------------------------------------------------------------------
 * 之前的玩法有个致命漏洞：只要一直举东西往妖物身上砸，总能把它磨死。
 * 物件是无限的（摄像头前有什么就献什么），所以「献祭」变成没有成本的动作，
 * 白天攒的装备、精怪、术力也就都没了意义。
 *
 * 修法很直白：给献祭加一个只能靠经营攒出来的资源——**香火**。
 *   献祭一次，烧掉一炷香。香尽，就只能靠咒术和精怪撑着。
 *
 * 香火从哪来（全部是「白天做的选择」）：
 *   · 开局自带 3 炷，之后每晚入夜 +1（月光下的余烬）
 *   · 神龛拜一拜（+2），掀香案则抢钱但拿不到香
 *   · 歇脚处拾香（+2）
 *   · 箱笼里偶尔压着半束香（+2）
 *   · 阁楼里掏钱买：祭坛每高一级，每天能多买一炷（也要多花一份钱）
 *
 * 上限也跟着祭坛走——祭坛既是养精怪的地方，也是存香的地方。
 * 于是「要不要先盖祭坛」从一个可选项变成了活过第五天的分水岭。
 */

const { START_INCENSE, INCENSE_BASE } = require('./constants');
const { levelOf } = require('./facilities');

/** 祭坛每升一级，香火上库存多放这么多炷 */
const ALTAR_BONUS = 2;
/** 每晚入夜自动回一炷（下限：每天至少能献一次） */
const NIGHT_REGEN = 1;
/** 阁里买香的价格与每日上限（上限随祭坛等级涨） */
const BUY_PRICE = 9;
const BUY_PER_DAY = 1;

function newIncense() {
  // 上限不落到 state 里——它是祭坛等级的函数，存下来就会跟设施脱节
  return { incense: START_INCENSE };
}

/** 补齐字段（读旧存档用）。老存档没有 incense，按开局量给 */
function ensureIncense(state) {
  if (typeof state.incense !== 'number' || !Number.isFinite(state.incense)) {
    state.incense = START_INCENSE;
  }
  return state;
}

/** 香火上限：基础 + 祭坛等级 × 2 */
function incenseMax(state) {
  return INCENSE_BASE + levelOf(state, 'altar') * ALTAR_BONUS;
}

/** 今天还能买几炷香（祭坛每级 +1，没祭坛就买不了——香得有地方供） */
function buyQuota(state) {
  const lv = levelOf(state, 'altar');
  if (!lv) return 0;
  return BUY_PER_DAY * lv;
}

/** 一炷香多少钱（祭坛越高，进的香越好也越贵一点） */
function incensePrice(state) {
  return BUY_PRICE + levelOf(state, 'altar') * 2;
}

/**
 * 烧掉 n 炷香，够才扣。
 * @returns {{ok:boolean, incense:number, msg?:string}}
 */
function spendIncense(state, n = 1) {
  ensureIncense(state);
  const need = Math.max(0, Math.round(n));
  if (state.incense < need) {
    return {
      ok: false,
      incense: state.incense,
      msg: `香火不够了（还余 ${state.incense} 炷，这一祭要 ${need} 炷）。回阁里添香，或改用咒术。`,
    };
  }
  state.incense -= need;
  return { ok: true, incense: state.incense };
}

/** 添香，不超过上限 */
function gainIncense(state, n = 1, why = '') {
  ensureIncense(state);
  const cap = incenseMax(state);
  const before = state.incense;
  state.incense = Math.min(cap, state.incense + Math.max(0, Math.round(n)));
  return { incense: state.incense, gained: state.incense - before, cap, why };
}

/**
 * 阁里买香。每天的次数上限由祭坛等级决定，写进 hallUsed.incense。
 * @returns {{ok:boolean, msg:string, cost?:number, incense?:number}}
 */
function buyIncense(state) {
  ensureIncense(state);
  const quota = buyQuota(state);
  if (!quota) return { ok: false, msg: '还没有祭坛，没处供香。' };
  const used = state.hallUsed || (state.hallUsed = {});
  used.incense = Number(used.incense) || 0;
  if (used.incense >= quota) {
    return { ok: false, msg: `祭坛今天已经收了 ${quota} 炷香，多了不灵。` };
  }
  if (state.incense >= incenseMax(state)) {
    return { ok: false, msg: `香匣已经满了（${incenseMax(state)} 炷）。` };
  }
  const cost = incensePrice(state);
  if ((state.coin || 0) < cost) {
    return { ok: false, msg: `铜钱不够：一炷香要 ${cost}，你只有 ${state.coin || 0}。` };
  }
  state.coin -= cost;
  used.incense += 1;
  gainIncense(state, 1);
  return {
    ok: true,
    cost,
    incense: state.incense,
    msg: `买了一炷香（-${cost} 文，现在 ${state.incense}/${incenseMax(state)} 炷）。`,
  };
}

/** 给模型读的一段香火现状 */
function describeIncense(state) {
  ensureIncense(state);
  const cap = incenseMax(state);
  const lines = [`香火 ${state.incense}/${cap} 炷（每献祭一次烧掉一炷）`];
  if (state.incense <= 0) lines.push('旅人的香已经烧尽了——他再举东西也烧不出火，只能靠咒术。');
  else if (state.incense <= 1) lines.push('旅人手里只剩最后一炷香，他献得会很谨慎。');
  return lines.join('\n');
}

module.exports = {
  ALTAR_BONUS,
  NIGHT_REGEN,
  BUY_PRICE,
  BUY_PER_DAY,
  newIncense,
  ensureIncense,
  incenseMax,
  buyQuota,
  incensePrice,
  spendIncense,
  gainIncense,
  buyIncense,
  describeIncense,
};
