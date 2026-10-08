/**
 * 咒术与元素反应
 *
 * 咒要麦克风念出来才响。连着放两道不同元素的咒会起反应，
 * 顺序无关（水→火 和 火→水 是同一条），同元素不起反应。
 */

const { COUNTERS } = require('./elements');

const { realmDamageMul, applyInsights } = require('./dao');

const SKILLS = [
  { id: 'blaze', name: '焚天', element: 'fire',  power: 26, cost: 40, chant: '焚天',
    line: '你念出「焚天」，火舌从地缝里窜起来，一路烧到它脚边。' },
  { id: 'tide',  name: '涌泉', element: 'water', power: 22, cost: 35, chant: '涌泉', heal: 12,
    line: '「涌泉」二字落地，井水倒涌上来，把你身上的伤冲淡了些。' },
  { id: 'bolt',  name: '裂空', element: 'volt',  power: 30, cost: 50, chant: '裂空',
    line: '「裂空」出口的一瞬，一道白光劈过整层楼。' },
  { id: 'root',  name: '缠根', element: 'wood',  power: 20, cost: 30, chant: '缠根',
    line: '「缠根」——草木从砖缝里疯长，把它半边身子缠住。' },
  { id: 'mirror', name: '镜返', element: 'guard', power: 24, cost: 45, chant: '镜返', heal: 10,
    line: '「镜返」照出它的影子，那一击原样奉还。' },
  // ── v4.5.1：咒 pool 扩到九道——地上捡残页、跟传功人学、攒术力自悟，都能拿到
  { id: 'quake', name: '镇岳', element: 'earth', power: 34, cost: 55, chant: '镇岳',
    line: '「镇岳」落地，整层楼的灰尘都跳了一下，它脚下塌出半寸。' },
  { id: 'shear', name: '剪春', element: 'metal', power: 28, cost: 42, chant: '剪春',
    line: '「剪春」二字像一把张开的小剪，寒光贴着它的皮掠过去。' },
  { id: 'strange', name: '志异', element: 'lore', power: 26, cost: 38, chant: '志异',
    line: '你念出「志异」——它自己的故事从你嘴里说出来，它竟停住了。' },
  { id: 'bloom', name: '落英', element: 'life', power: 20, cost: 32, chant: '落英', heal: 14,
    line: '「落英」缤纷而下，落在伤口上就成了新肉。' },
];

/* ══════════════════════════════════════════════════════════════
   多周目 / 全局遗物
   ──────────────────────────────────────────────────────────────
   通关不是终点。重开一局时，上一局挣来的东西要留下来——
   否则"再来一次"就是从零开始，没有累积感。
   跨局数据单独存 legacy.json，跟局内存档 save.json 分开：
   局内存档随时可以被 reset 抹掉，遗物不能被抹掉。
   ══════════════════════════════════════════════════════════════ */

/** 遗物表。通关一次解锁一件，按顺序发。开局自动生效 */

const REACTIONS = {
  'fire|water': { name: '蒸腾', bonus: 22, line: '水火相激，白雾腾地而起，烫得它一缩。' },
  'fire|wood': { name: '燎原', bonus: 18, line: '火舌顺着木气一路烧过去，连成一片。' },
  'fire|lore': { name: '焚书', bonus: 24, line: '字纸见火就着，烧掉的像是它的一段记性。' },
  'metal|volt': { name: '引雷', bonus: 20, line: '铁器把雷引了过去，整层楼亮了一瞬。' },
  'volt|water': { name: '导电', bonus: 20, line: '水渍把电导了一圈，它浑身一麻。' },
  'earth|water': { name: '淤陷', bonus: 14, line: '水土和成泥浆，它半只脚陷了进去。' },
  'earth|wood': { name: '破土', bonus: 14, line: '根须顶开硬土，从它脚下钻出来。' },
  'guard|metal': { name: '折锋', bonus: 16, line: '那一击被卸了力，反手磕在它自己刃上。' },
  'guard|fire': { name: '熄火', bonus: 16, line: '风一兜，火头被压了回去，反燎到它身上。' },
  'life|earth': { name: '沃壤', bonus: 12, line: '活气渗进土里，草木疯长缠住它的脚。' },
  'life|volt': { name: '惊蛰', bonus: 18, line: '一声春雷，蛰伏的东西全醒了。' },
  'lore|volt': { name: '断章', bonus: 18, line: '句子被打断，它连自己要说什么都忘了。' },
  'life|water': { name: '涵养生机', bonus: 12, heal: 8, line: '水汽养着活气，你的伤也跟着缓了缓。' },
  'guard|water': { name: '涵容', bonus: 12, heal: 10, line: '水被兜住，慢慢渗回来，伤口合上一些。' },
};

function reactionKey(a, b) {
  return [String(a || ''), String(b || '')].sort().join('|');
}

/** 上一条咒的元素 + 这一条的元素 → 反应（没有就 null） */

function findReaction(prevElement, element) {
  if (!prevElement || !element) return null;
  return REACTIONS[reactionKey(prevElement, element)] || null;
}

/* ══════════════════════════════════════════════════════════════
   Boss 姿态
   ──────────────────────────────────────────────────────────────
   守阁灵每 N 个回合换一次架势。每个架势有且只有一个"破法"：
   对上破法的属性伤害放大，其余一律减半。
   这样"举什么"不再是查一次克制表就完事——
   克制表是长期的，姿态是每几回合就变的短期决策。
   ══════════════════════════════════════════════════════════════ */

function resolveSkill(skill, guardian, stats, state) {
  const strong = (COUNTERS[skill.element] || []).includes(guardian.element);
  const weak = (COUNTERS[guardian.element] || []).includes(skill.element);
  const mult = strong ? 1.8 : weak ? 0.5 : 1;
  const roll = 0.85 + Math.random() * 0.3;
  let dmg = (skill.power + (stats.atk || 0)) * mult * roll;
  // v3.3：境界给咒术也加伤害；心得「声若洪钟」在 applyInsights 里再乘
  if (state) dmg *= realmDamageMul(state);
  dmg = Math.max(1, Math.round(dmg));
  if (state) applyInsights(state, { skill: true, element: skill.element, damage: dmg });
  return {
    skill: skill.id,
    name: skill.name,
    element: skill.element,
    verdict: strong ? '克制' : weak ? '被压制' : '无克制',
    damage: dmg,
    heal: skill.heal || 0,
    line: skill.line,
  };
}

/** 术力满了能请出新咒。返回解锁的技能或 null */

function unlockSkill(state) {
  const known = Array.isArray(state.skills) ? state.skills : [];
  const locked = SKILLS.filter((s) => !known.includes(s.id));
  if (!locked.length) return null;
  const s = locked[Math.floor(Math.random() * locked.length)];
  known.push(s.id);
  state.skills = known;
  return s;
}

// ------------------------------------------------------------------ 裁决

module.exports = {
  SKILLS,
  REACTIONS,
  reactionKey,
  findReaction,
  resolveSkill,
  unlockSkill,
};
