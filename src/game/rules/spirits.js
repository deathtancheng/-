/**
 * 精怪 —— 物件养久了，自己会动
 * ------------------------------------------------------------------
 * 这是「模拟经营」和「肉鸽战斗」之间的桥：
 * 你在迷宫里捡回来的物件，除了卖钱，还能在祭坛上炼成精怪。
 * 精怪住在阁里，每晚替你守摊（门面进账），夜战时替你出手。
 *
 * 每只精怪的本事由它的属性定死（和献祭/咒术共用同一张属性表），
 * 等级只放大数值。所以「养什么属性」= 你在构筑什么流派。
 *
 * 代价：每只精怪每晚要吃 2 点饱食。养得多，白天就得多跑两格。
 * 规则归代码，叙事归模型——这里只算数。
 */

const { ELEMENTS } = require('./elements');
const { LABEL_CN } = require('./stats');

/** 每只精怪每晚的伙食（点数，从饱食里扣） */
const SPIRIT_UPKEEP = 2;
const SPIRIT_MAX_LV = 5;

/** 属性前缀，用来拼精怪的名字 */
const PREFIX = {
  metal: '锋', fire: '燃', water: '润', earth: '镇', guard: '护',
  wood: '生', volt: '闪', lore: '知', life: '息', unknown: '野',
};

/**
 * 精怪的本事表。kind 是给夜战规则读的开关，数值由等级决定。
 * 一只精怪 = 一个属性 + 一个等级，本事就定了，不做随机词条——
 * 随机词条会让"我该养哪只"变成掷骰子，而不是做决定。
 */
const TRAITS = {
  fire:    { name: '自燃',    kind: 'burn',    desc: '每回合替你对妖物添一把火' },
  water:   { name: '回润',    kind: 'heal',    desc: '每回合替旅人润一口伤' },
  wood:    { name: '缠根',    kind: 'bind',    desc: '缠住妖物，削弱它的反击' },
  earth:   { name: '镇宅',    kind: 'ward',    desc: '挡在旅人身前，减免所受伤害' },
  metal:   { name: '锋锐',    kind: 'edge',    desc: '替你打磨祭品，献祭伤害更高' },
  volt:    { name: '迅疾',    kind: 'haste',   desc: '偶尔抢在你前面再补一下' },
  guard:   { name: '护主',    kind: 'shield',  desc: '夜里替你挡下第一击' },
  lore:    { name: '观心',    kind: 'insight', desc: '看破妖物的架势，弱点更易命中' },
  life:    { name: '生气',    kind: 'vigor',   desc: '夜里替你养回一点精神' },
  unknown: { name: '杂学',    kind: 'misc',    desc: '来路不明，什么都沾一点' },
};

function traitOf(element) {
  return TRAITS[element] || TRAITS.unknown;
}

/** 等级 → 数值。1 级就有用，5 级翻倍 */
function magnitude(spirit) {
  const lv = Math.max(1, Number(spirit.lv) || 1);
  return 1 + (lv - 1) * 0.5;
}

function makeSpirit({ label, element } = {}) {
  const ele = ELEMENTS[element] ? element : 'unknown';
  const raw = String(label || '').toLowerCase().trim();
  const cn = LABEL_CN[raw] || LABEL_CN[raw.replace(/_/g, ' ')] || '物';
  return {
    id: `s${Date.now().toString(36)}${Math.floor(Math.random() * 99)}`,
    from: label || '？',
    element: ele,
    name: `${PREFIX[ele] || ''}${cn}灵`,
    trait: traitOf(ele).kind,
    lv: 1,
  };
}

/** 喂一次要多少钱 */
function feedCost(spirit) {
  return 10 + (Number(spirit.lv) || 1) * 8;
}

/**
 * 喂精怪。吃得越饱越强，但一局里喂不满——钱永远有更急的用处。
 * @returns {{ok:boolean, msg:string, cost?:number, level?:number}}
 */
function feed(state, id) {
  const list = state.spirits || [];
  const sp = list.find((s) => s.id === id);
  if (!sp) return { ok: false, msg: '阁里没有这只精怪。' };
  if ((Number(sp.lv) || 1) >= SPIRIT_MAX_LV) {
    return { ok: false, msg: `「${sp.name}」已经养到极处了。` };
  }
  const cost = feedCost(sp);
  if ((state.coin || 0) < cost) {
    return { ok: false, msg: `铜钱不够：喂一次要 ${cost}，你只有 ${state.coin || 0}。` };
  }
  state.coin -= cost;
  sp.lv = (Number(sp.lv) || 1) + 1;
  return { ok: true, cost, level: sp.lv, msg: `「${sp.name}」长了一岁，现在是 ${sp.lv} 级。` };
}

/** 打发走一只精怪（给新来的腾位子），退回一点铜钱 */
function release(state, id) {
  const list = state.spirits || [];
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return { ok: false, msg: '阁里没有这只精怪。' };
  const [sp] = list.splice(i, 1);
  const back = Math.round((Number(sp.lv) || 1) * 6);
  state.coin = (state.coin || 0) + back;
  return { ok: true, msg: `你把「${sp.name}」送走了，它留下 ${back} 枚铜钱。`, refund: back };
}

/**
 * 精怪夜战加成总表。开战时算一次，各字段含义见 TRAITS。
 * @param {number} mul 祭坛给的倍率（见 facilities.spiritMul）
 */
function battleBonus(spirits, mul = 1) {
  const b = { burn: 0, heal: 0, bind: 0, ward: 0, edgePct: 0, hastePct: 0, shield: 0, insightPct: 0, vigor: 0 };
  for (const sp of Array.isArray(spirits) ? spirits : []) {
    const m = magnitude(sp) * mul;
    switch (traitOf(sp.element).kind) {
      case 'burn':    b.burn += Math.round(3 * m); break;
      case 'heal':    b.heal += Math.round(3 * m); break;
      case 'bind':    b.bind += Math.round(1 * m); break;
      case 'ward':    b.ward += Math.round(1 * m); break;
      case 'edge':    b.edgePct += Math.round(12 * m); break;
      case 'haste':   b.hastePct += Math.round(10 * m); break;
      case 'shield':  b.shield += Math.round(5 * m); break;
      case 'insight': b.insightPct += Math.round(15 * m); break;
      case 'vigor':   b.vigor += Math.round(3 * m); break;
      default:        b.burn += 1; b.heal += 1;
    }
  }
  return b;
}

/** 每晚精怪的口粮总消耗 */
function upkeep(spirits) {
  return (Array.isArray(spirits) ? spirits.length : 0) * SPIRIT_UPKEEP;
}

/** 给模型读的一段精怪现状 */
function describeSpirits(state) {
  const list = state.spirits || [];
  if (!list.length) return '阁里还没有精怪。';
  return '阁中精怪：' + list
    .map((s) => `${s.name}（${ELEMENTS[s.element] ? ELEMENTS[s.element].name : '?'} ${s.lv}级·${traitOf(s.element).name}）`)
    .join('、');
}

module.exports = {
  SPIRIT_UPKEEP,
  SPIRIT_MAX_LV,
  TRAITS,
  traitOf,
  magnitude,
  makeSpirit,
  feedCost,
  feed,
  release,
  battleBonus,
  upkeep,
  describeSpirits,
};
