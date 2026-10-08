/**
 * 多周目与全局遗物
 *
 * 通关不是终点：周目 +1、解锁一件遗物、存一条配装进榜。
 * 遗物跨局生效，所以这份数据单独存 legacy.json，
 * 跟随时可被「重开一局」抹掉的局内存档分开。
 */

const { unlockSkill } = require('./skills');
const { PLAYER_HP } = require('./constants');

const RELICS = [
  {
    id: 'ember', name: '余烬', desc: '开局术力 +20',
    apply: (s) => { s.stats.mana = Math.min(100, (s.stats.mana || 0) + 20); },
  },
  {
    id: 'oldarmor', name: '旧甲', desc: '开局防御 +3',
    apply: (s) => { s.stats.def = (s.stats.def || 0) + 3; },
  },
  {
    id: 'swiftblade', name: '快刃', desc: '开局攻击 +3',
    apply: (s) => { s.stats.atk = (s.stats.atk || 0) + 3; },
  },
  {
    id: 'brightmirror', name: '明镜', desc: '开局暴击 +6%',
    apply: (s) => { s.stats.crit = Math.min(0.6, (s.stats.crit || 0) + 0.06); },
  },
  {
    id: 'revive', name: '回魂', desc: '每个夜晚开始时回复 15 体力',
    onLevel: (s) => { s.playerHp = Math.min(PLAYER_HP, s.playerHp + 15); },
  },
  {
    id: 'lorekeep', name: '拾遗', desc: '开局多带一道咒',
    apply: (s) => { unlockSkill(s); },
  },
];

/** 空的多周目存档 */

function newLegacy() {
  return {
    cycle: 1,        // 第几周目
    clears: 0,       // 通关次数
    bestTurns: null, // 最快通关用了多少回合
    relics: [],      // 已解锁遗物 id
    history: [],     // 通关配装榜：每次通关存一条
  };
}

/** 找还没解锁的下一件遗物 */

function nextRelic(legacy) {
  const owned = (legacy && legacy.relics) || [];
  return RELICS.find((r) => !owned.includes(r.id)) || null;
}

/**
 * 周目缩放：第 N 周目守阁灵更硬。
 * 血按 35% 递增，反击固定 +1/周目——只涨血会变成"打很久"，
 * 反击也涨才有"这一周目真的更凶"的体感。
 */

const HIDDEN_CYCLE = 3;

/* ══════════════════════════════════════════════════════════════
   元素反应连携
   ──────────────────────────────────────────────────────────────
   连着放两道**不同元素**的咒会起反应，额外炸一下。
   目的是让"我该先放哪一道"变成真的要算的问题——
   随便乱放只有基础伤害，凑对顺序能多打一半。
   key 用两种元素排序后拼，所以水→火和火→水是同一条。
   ══════════════════════════════════════════════════════════════ */

module.exports = {
  RELICS,
  newLegacy,
  nextRelic,
  HIDDEN_CYCLE,
};
