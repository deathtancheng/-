/**
 * 万物阁 —— 模拟经营的那一半
 * ------------------------------------------------------------------
 * 一局里你攒下的铜钱只有一个去处：把这座阁楼盖起来。
 * 每间设施都是「白天的一次决策」换成「此后每天的被动」：
 *
 *   货仓   —— 决定你能带多少件东西回家（容量）
 *   丹房   —— 每晚进食，补饱食（还能把生食做成熟食，补得更多）
 *   书斋   —— 每晚参悟，白得一条心得
 *   祭坛   —— 决定你能养几只精怪，并让精怪更强
 *   卧房   —— 每晚歇息，补精神
 *   门面   —— 精怪替你卖货，每晚净进铜钱
 *
 * 全部是纯函数：能不能建、要多少钱、建完什么效果，都在这儿算死。
 */

const { STORE_BASE } = require('./constants');

/**
 * 设施表。
 *   cost(lv)  —— 从 lv 升到 lv+1 要多少铜钱（lv 是「已建到几级」）
 *   max       —— 上限
 *   effect(lv)—— 该等级下的效果数值，供 UI 与其它规则读
 */
const FACILITIES = [
  {
    id: 'store', name: '货仓', icon: '仓', max: 4,
    cost: (lv) => 30 + lv * 25,
    effect: (lv) => STORE_BASE + lv * 4,
    desc: (lv) => `仓库容量 ${STORE_BASE + lv * 4} 格（下一级 +4）`,
  },
  {
    id: 'kitchen', name: '丹房', icon: '丹', max: 3,
    cost: (lv) => 40 + lv * 30,
    effect: (lv) => 18 + lv * 8,
    desc: (lv) => `每晚可进食，回复 ${18 + lv * 8} 饱食（下一级 +8）`,
  },
  {
    id: 'bedchamber', name: '卧房', icon: '榻', max: 3,
    cost: (lv) => 40 + lv * 30,
    effect: (lv) => 16 + lv * 8,
    desc: (lv) => `每晚可歇息，回复 ${16 + lv * 8} 精神（下一级 +8）`,
  },
  {
    id: 'study', name: '书斋', icon: '书', max: 3,
    cost: (lv) => 45 + lv * 35,
    effect: (lv) => lv,           // 每晚参悟次数
    desc: (lv) => `每晚参悟 ${lv} 次，白得心得（下一级 +1 次）`,
  },
  {
    id: 'altar', name: '祭坛', icon: '坛', max: 3,
    cost: (lv) => 60 + lv * 40,
    effect: (lv) => lv,           // 精怪位
    desc: (lv) => `可养 ${lv} 只精怪，且精怪夜战加成 ×${(1 + lv * 0.25).toFixed(2)}（下一级 +1 位）`,
  },
  {
    id: 'shopfront', name: '门面', icon: '幌', max: 3,
    cost: (lv) => 35 + lv * 25,
    effect: (lv) => lv * 6,
    desc: (lv) => `精怪替你卖货，每晚净进 ${lv * 6} 铜钱（下一级 +6）`,
  },
  /* ── v4.5：守夜的两笔开销 ──────────────────────────────────
     灯油：每夜要花钱点。点着，夜里打得准、挨得轻；点不着（没钱、或压根没盖）
           就得摸黑——输出打折、反击加重。于是"今晚要不要留够灯油钱"成了决策。
     门闩：一次性投入，永久减伤，还让妖物搬不走那么多。 */
  {
    id: 'lamp', name: '灯油', icon: '灯', max: 3,
    cost: (lv) => 35 + lv * 30,
    effect: (lv) => [0, 8, 14, 20][lv] || 0,      // 点着时夜战伤害 +x%
    desc: (lv) => (lv === 0
      ? '还没点过灯——夜里摸黑，伤害 -18%、挨的打 +40%'
      : `每夜点灯耗 ${[0, 8, 12, 16][lv]} 文：夜战伤害 +${[0, 8, 14, 20][lv]}%、挨的打 -${[0, 10, 18, 25][lv]}%（下一级更亮）`),
  },
  {
    id: 'ward', name: '门闩', icon: '闩', max: 3,
    cost: (lv) => 40 + lv * 35,
    effect: (lv) => [0, 8, 15, 22][lv] || 0,      // 反击 -x%
    desc: (lv) => (lv === 0
      ? '门是虚掩的——它的反击一分不少'
      : `夜战反击 -${[0, 8, 15, 22][lv]}%，被搬走的东西也少 ${[0, 8, 15, 22][lv]}%（下一级更牢）`),
  },
];

function facilityDef(id) {
  return FACILITIES.find((f) => f.id === id) || null;
}

/** 某设施已建到几级（0 = 还没盖） */
function levelOf(state, id) {
  return Math.max(0, Number(state.hall && state.hall.slots && state.hall.slots[id]) || 0);
}

/** 盖下一级要多少钱。已经满级返回 null */
function buildCost(state, id) {
  const def = facilityDef(id);
  if (!def) return null;
  const lv = levelOf(state, id);
  if (lv >= def.max) return null;
  return def.cost(lv);
}

function isMaxed(state, id) {
  const def = facilityDef(id);
  return !!def && levelOf(state, id) >= def.max;
}

/** 阁楼的「规模」：所有设施等级之和。用来算夜袭难度和展示等级 */
function hallLevel(state) {
  return FACILITIES.reduce((sum, f) => sum + levelOf(state, f.id), 0);
}

/** 从阁楼规模折算一个称号，纯展示 */
function hallTitle(state) {
  const l = hallLevel(state);
  if (l >= 14) return '万家灯火';
  if (l >= 10) return '声名远播';
  if (l >= 6) return '初具规模';
  if (l >= 3) return '略成气象';
  return '一间空阁';
}

/** 仓库容量 */
function storeCap(state) {
  return STORE_BASE + levelOf(state, 'store') * 4;
}

/** 能养几只精怪 */
function spiritSlots(state) {
  return levelOf(state, 'altar');
}

/** 精怪加成倍率（祭坛越高越强） */
function spiritMul(state) {
  return 1 + levelOf(state, 'altar') * 0.25;
}

/** 每晚进食/歇息能回复多少（没盖丹房/卧房就是 0） */
/* ══════════════════════════════════════════════════════════════
   守夜的两笔开销（v4.5）
   ────────────────────────────────────────────────────────────────
   以前夜里只有"举什么"一个决策，攒够装备就能一路平推。
   现在每晚先要结账：灯还点不点得起？门闩够不够牢？
   ══════════════════════════════════════════════════════════════ */

/** 今夜点灯要多少钱；没盖灯油房返回 0（因为根本点不着） */
function lampUpkeep(state) {
  return [0, 8, 12, 16][levelOf(state, 'lamp')] || 0;
}

/** 点着灯时夜战伤害 +百分之几 */
function lampDmgBonus(state, lit) {
  const lv = levelOf(state, 'lamp');
  if (!lv) return lit ? 0 : -18;      // 没灯：摸黑，输出打折
  return lit ? ([0, 8, 14, 20][lv] || 0) : -18;
}

/** 点着灯时反击少挨百分之几；摸黑返回负值（挨得更狠） */
function lampGuard(state, lit) {
  const lv = levelOf(state, 'lamp');
  if (!lv) return -40;
  return lit ? ([0, 10, 18, 25][lv] || 0) : -40;
}

/** 门闩：反击 -百分之几，被搬走的东西也按这个比例少一点 */
function wardCut(state) {
  return [0, 8, 15, 22][levelOf(state, 'ward')] || 0;
}

function kitchenHeal(state) {
  const lv = levelOf(state, 'kitchen');
  return lv ? 18 + lv * 8 : 0;
}
function bedchamberHeal(state) {
  const lv = levelOf(state, 'bedchamber');
  return lv ? 16 + lv * 8 : 0;
}
function studyTimes(state) {
  return levelOf(state, 'study');
}

/**
 * 建 / 升一级设施。
 * @returns {{ok:boolean, msg:string, cost?:number, level?:number}}
 */
function build(state, id) {
  const def = facilityDef(id);
  if (!def) return { ok: false, msg: '没有这间屋子。' };
  const lv = levelOf(state, id);
  if (lv >= def.max) return { ok: false, msg: `「${def.name}」已经盖到顶了。` };
  const cost = def.cost(lv);
  if ((state.coin || 0) < cost) {
    return { ok: false, msg: `铜钱不够：要 ${cost}，你只有 ${state.coin || 0}。` };
  }
  state.coin -= cost;
  if (!state.hall) state.hall = { slots: {} };
  if (!state.hall.slots) state.hall.slots = {};
  state.hall.slots[id] = lv + 1;
  return {
    ok: true,
    cost,
    level: lv + 1,
    msg: lv === 0
      ? `「${def.name}」落成了。`
      : `「${def.name}」升到 ${lv + 1} 级。`,
  };
}

/**
 * 每晚结算：门面进账（精怪替你卖货）。
 * 与精怪数量挂钩——没有精怪，门面就是个空幌子。
 * @returns {{coin:number, from:string[]}}
 */
function nightlyIncome(state, spiritCount) {
  const lv = levelOf(state, 'shopfront');
  if (!lv) return { coin: 0, from: [] };
  const per = lv * 6;
  const busy = Math.max(1, spiritCount);      // 精怪越多越忙得过来
  const coin = per * busy;
  state.coin = (state.coin || 0) + coin;
  return { coin, from: [`门面 ${lv} 级 × ${busy} 只精怪看摊`] };
}

/** 给模型读的一段阁楼现状 */
function describeHall(state) {
  const parts = FACILITIES
    .map((f) => (levelOf(state, f.id) ? `${f.name}${levelOf(state, f.id)}级` : null))
    .filter(Boolean);
  return [
    `万物阁：${hallTitle(state)}（铜钱 ${state.coin || 0}）`,
    parts.length ? `已建成：${parts.join('、')}` : '（还只是一间空阁）',
    `仓库 ${(state.store || []).length}/${storeCap(state)}，精怪 ${(state.spirits || []).length}/${spiritSlots(state)}`,
  ].join('\n');
}

module.exports = {
  FACILITIES,
  facilityDef,
  levelOf,
  buildCost,
  isMaxed,
  hallLevel,
  hallTitle,
  storeCap,
  spiritSlots,
  spiritMul,
  // ---- v4.5：守夜的两笔开销 ----
  lampUpkeep,
  lampDmgBonus,
  lampGuard,
  wardCut,
  kitchenHeal,
  bedchamberHeal,
  studyTimes,
  build,
  nightlyIncome,
  describeHall,
};
