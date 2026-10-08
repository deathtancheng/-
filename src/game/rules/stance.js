/**
 * 守阁灵的架势与狂怒
 *
 * 架势每 3 回合换一次，每个架势只有一个破法：对上伤害 ×1.5，其余 ×0.5。
 * 狂怒是"打太久"的代价——超过 8 回合反击翻倍，旅人还持续掉血。
 */

const STANCES = [
  { id: 'flame', name: '焰姿', breaks: 'water', hint: '水能浇熄这一式', tint: 'fire' },
  { id: 'tide', name: '潮姿', breaks: 'earth', hint: '厚土能压住这一式', tint: 'water' },
  { id: 'iron', name: '铁姿', breaks: 'fire', hint: '烈火能熔这一式', tint: 'metal' },
  { id: 'thunder', name: '雷姿', breaks: 'metal', hint: '金铁能导走这一式', tint: 'volt' },
  { id: 'hollow', name: '虚姿', breaks: 'lore', hint: '书卷时序能解这一式', tint: 'lore' },
  { id: 'root', name: '根姿', breaks: 'wood', hint: '草木能缠住这一式', tint: 'wood' },
];

/** 每几回合换一次架势 */

const STANCE_EVERY = 3;

/** 换一个跟当前不一样的新架势 */

function rollStance(currentId) {
  const pool = STANCES.filter((s) => s.id !== currentId);
  return pool[Math.floor(Math.random() * pool.length)] || STANCES[0];
}

/**
 * 姿态对这一击的折减。
 * 破防（属性对上）×1.5，其余 ×0.5 —— 差距要拉得够大，
 * 否则玩家根本懒得看姿态，照旧无脑举克制的那个。
 */

function applyStance(damage, element, stance) {
  if (!stance || !stance.breaks) {
    return { damage: Math.max(1, Math.round(damage)), pierced: false, mult: 1 };
  }
  const pierced = element === stance.breaks;
  const mult = pierced ? 1.5 : 0.5;
  return { damage: Math.max(1, Math.round(damage * mult)), pierced, mult };
}

/** 破防的奖励：回血 + 回术力，并且逼它立刻换架势 */

const PIERCE_HEAL = 8;

const PIERCE_MANA = 12;

/* ══════════════════════════════════════════════════════════════
   限时 / 狂怒
   ──────────────────────────────────────────────────────────────
   每层 Boss 战有回合上限。超了守阁灵就"狂怒"：
   反击翻倍，并且每回合旅人自己还在掉血。
   这是给"稳扎稳打、慢慢磨"这条最安全的路线上一个代价——
   想稳，就得在时限内稳完。
   注意跟"狂暴"区分：狂暴是它血少（ENRAGE_AT），狂怒是你拖太久。
   ══════════════════════════════════════════════════════════════ */

const FRENZY_TURNS = 8;      // 每层 Boss 战超过这么多回合就狂怒

const FRENZY_MULT = 2;       // 狂怒反击倍率

const FRENZY_BLEED = 3;      // 狂怒后每回合旅人额外流失

/** 这一层还剩几个回合就狂怒（0 = 已经狂怒） */

function turnsLeft(state) {
  const used = Number(state && state.bossTurns) || 0;
  return Math.max(0, FRENZY_TURNS - used);
}

function isFrenzy(state) {
  return !!(state && state.bossTurns > FRENZY_TURNS);
}

/** 装备数值按属性定调：金/火偏攻，土/护偏防，电/知偏暴击 */

module.exports = {
  STANCES,
  STANCE_EVERY,
  rollStance,
  applyStance,
  PIERCE_HEAL,
  PIERCE_MANA,
  FRENZY_TURNS,
  FRENZY_MULT,
  FRENZY_BLEED,
  turnsLeft,
  isFrenzy,
};
