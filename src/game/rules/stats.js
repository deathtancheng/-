/**
 * 旅人数值 —— 攻击 / 防御 / 暴击 / 术力，以及装备
 *
 * 献祭不是打一下就完了：每次都要先决定把它转化成什么（INTENTS）。
 * 装备由祭品熔成，数值按祭品属性定调，最多带三件。
 */

const { BASE_STATS } = require('./constants');
const { ELEMENTS } = require('./elements');
const { RELICS } = require('./legacy');
const { unlockSkill } = require('./skills');


/** 献祭去向。三选一，每次都要决策——这是玩法不再单一的支点 */

const INTENTS = {
  power:  { name: '强攻', dmg: 1.35, atkGain: 2, note: '这一击更痛，并永久 +2 攻击' },
  guard:  { name: '固守', dmg: 0.8,  equip: true, note: '这一击轻些，但会掉落一件装备' },
  arcane: { name: '蕴术', dmg: 0.7,  manaGain: 18, note: '这一击轻些，但攒 18 点术力' },
};

/** 咒术表。释放要麦克风念出名字（chant），念对了才响 */

const EQUIP_BIAS = {
  metal: { atk: 3, def: 1, crit: 0 },
  fire:  { atk: 3, def: 0, crit: 0.01 },
  water: { atk: 2, def: 2, crit: 0 },
  earth: { atk: 1, def: 3, crit: 0 },
  guard: { atk: 0, def: 3, crit: 0.01 },
  wood:  { atk: 1, def: 2, crit: 0.01 },
  volt:  { atk: 2, def: 0, crit: 0.04 },
  lore:  { atk: 2, def: 0, crit: 0.03 },
  life:  { atk: 1, def: 1, crit: 0.03 },
  unknown: { atk: 1, def: 1, crit: 0.01 },
};

const EQUIP_PREFIX = {
  metal: '锋', fire: '燃', water: '润', earth: '镇', guard: '护',
  wood: '生', volt: '闪', lore: '知', life: '息', unknown: '野',
};

/** 装备名要用中文——「润cup符」这种中英混排很跳戏 */

const LABEL_CN = {
  cup: '杯', bottle: '瓶', 'wine glass': '盏', bowl: '碗', vase: '瓶', sink: '槽',
  book: '书', clock: '钟', knife: '刃', fork: '叉', spoon: '勺', scissors: '剪',
  laptop: '笔电', 'cell phone': '手机', keyboard: '键', mouse: '鼠', remote: '遥控', tv: '屏',
  chair: '椅', couch: '榻', bed: '床', bench: '凳', 'dining table': '案', suitcase: '箱',
  oven: '炉', toaster: '烤器', microwave: '炉', 'potted plant': '盆栽',
  banana: '蕉', apple: '果', orange: '橘', sandwich: '饼', pizza: '饼', cake: '糕', donut: '环',
  backpack: '囊', umbrella: '伞', handbag: '袋', tie: '带',
  person: '人影', cat: '猫', dog: '犬', bird: '雀', horse: '马',
};

/** 把一件祭品熔成装备。名字带原物件的味道——你献的杯子，就变成杯盏做的护符 */

function makeEquipment(label, element) {
  const b = EQUIP_BIAS[element] || EQUIP_BIAS.unknown;
  const roll = 0.8 + Math.random() * 0.5;
  const raw = String(label || '').toLowerCase().trim();
  const cn = LABEL_CN[raw] || LABEL_CN[raw.replace(/_/g, ' ')] || '物';
  return {
    id: `e${Date.now()}${Math.floor(Math.random() * 99)}`,
    name: `${EQUIP_PREFIX[element] || ''}${cn}符`,
    from: label,
    element,
    elementName: ELEMENTS[element] ? ELEMENTS[element].name : '?',
    atk: Math.max(1, Math.round(b.atk * roll)),
    def: Math.max(0, Math.round(b.def * roll)),
    crit: Number((b.crit * roll).toFixed(3)),
  };
}

/** 汇总面板数值：基础 + 所有装备 */

function addEquipment(state, item) {
  if (!Array.isArray(state.equipment)) state.equipment = [];
  const score = (e) => (e.atk || 0) + (e.def || 0) * 2;
  let dropped = null;
  if (state.equipment.length < 3) {
    state.equipment.push(item);
  } else {
    let weakest = 0;
    state.equipment.forEach((e, i) => { if (score(e) < score(state.equipment[weakest])) weakest = i; });
    if (score(item) > score(state.equipment[weakest])) {
      dropped = state.equipment[weakest];
      state.equipment[weakest] = item;
    } else {
      dropped = item; // 新东西更差，直接丢掉
    }
  }
  return { gained: dropped !== item ? item : null, dropped };
}

/** 咒术裁决：伤害按技能威力 + 攻击力，克制关系照旧 */

function totalStats(state) {
  const eq = Array.isArray(state.equipment) ? state.equipment : [];
  // 基准必须是玩家当前的 stats，不是 BASE_STATS——否则「强攻」攒的永久加攻
  // 会被装备加成整体盖掉，玩家白打
  const base = (state && state.stats) || BASE_STATS;
  const s = {
    atk: base.atk ?? BASE_STATS.atk,
    def: base.def ?? BASE_STATS.def,
    crit: base.crit ?? BASE_STATS.crit,
  };
  for (const e of eq) { s.atk += e.atk || 0; s.def += e.def || 0; s.crit += e.crit || 0; }
  s.crit = Math.min(0.6, s.crit);
  return s;
}

/** 装备最多带三件，满了就换掉最弱的那件（按 atk+def*2 估分） */

function applyRelics(state, relicIds) {
  const ids = Array.isArray(relicIds) ? relicIds : [];
  for (const id of ids) {
    const r = RELICS.find((x) => x.id === id);
    if (r && typeof r.apply === 'function') r.apply(state);
  }
  return state;
}

/** 换层时结算"每层触发一次"的遗物（回魂：回 15 血） */

function onEnterLevel(state, relicIds) {
  const ids = Array.isArray(relicIds) ? relicIds : (state.relics || []);
  for (const id of ids) {
    const r = RELICS.find((x) => x.id === id);
    if (r && typeof r.onLevel === 'function') r.onLevel(state);
  }
  return state;
}

/** 进入 Boss 战：摇架势、回合数归零。探索走完才调这个 */

module.exports = {
  BASE_STATS,
  INTENTS,
  EQUIP_BIAS,
  EQUIP_PREFIX,
  LABEL_CN,
  makeEquipment,
  addEquipment,
  totalStats,
  applyRelics,
  onEnterLevel,
};
