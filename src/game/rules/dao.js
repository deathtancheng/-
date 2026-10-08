/**
 * 器修道行
 * ------------------------------------------------------------------
 * 不是直白修仙，而是宋代志怪里「物久成精」那个路子：
 * 旅人一次次把物件献给守阁灵，物件里的灵反过来养人，
 * 养久了就能「见物」「辨气」「通灵」「驭物」「化物」五重境界。
 *
 * 规则层只负责算：给多少道行、升不升境界、本命器觉醒没有、
 * 这一击该加多少加成。文本叙事归模型。
 */

const { elementOf } = require('./elements');

/** 五重境界：门槛、献祭伤害加成、特殊效果 */
const REALMS = [
  { id: 0, name: '见物', threshold: 0, bonus: 0, desc: '只看得见物件的形' },
  { id: 1, name: '辨气', threshold: 15, bonus: 0.05, desc: '看见物件属性的气，献祭伤害 +5%' },
  { id: 2, name: '通灵', threshold: 40, bonus: 0.05, lingxi: 0.20, desc: '20% 概率灵犀一动，克制判定升一级' },
  { id: 3, name: '驭物', threshold: 80, bonus: 0.05, opener: 0.15, desc: '每层 Boss 战首次献祭 +15% 伤害' },
  { id: 4, name: '化物', threshold: 140, bonus: 0.05, echo: 0.25, desc: '本命器属性献祭克制/破防时追加 25% 化物追击' },
];

/** 参悟可得的心得。每条都是跨层永久生效的小加成 */
const INSIGHTS = [
  { id: 'metal-edge', name: '铜铁之属', desc: '献祭金/火属性物件额外 +3 伤害', applies: (r) => ['metal', 'fire'].includes(r.element), add: 3 },
  { id: 'soft-step', name: '履险如夷', desc: '探索陷阱伤害减半', applies: (r) => r.event === 'trap', reduce: 0.5 },
  { id: 'loud-voice', name: '声若洪钟', desc: '咒术伤害 +10%', applies: (r) => r.skill, mul: 1.1 },
  { id: 'keen-eye', name: '眼明手快', desc: '探索伏兵首击伤害 +20%', applies: (r) => r.event === 'ambush' && r.strike, mul: 1.2 },
  { id: 'steady-hand', name: '心细如发', desc: '破解机关时即使属性不对，也只受 2 点反噬', applies: (r) => r.event === 'puzzle' && r.wrong, floor: 2 },
  { id: 'earth-root', name: '厚土生根', desc: '土/护属性献祭回血 +5', applies: (r) => ['earth', 'guard'].includes(r.element) && r.heal, heal: 5 },
];

const INSIGHT_NODES = [
  '楼梯转角有一面残镜，镜中映出的不是你，而是上一批旅人的影子。',
  '书架上有一卷无人翻开的手抄，墨迹里藏着前人闯关的笔记。',
  '墙角香炉只剩半截，袅袅青烟里似乎有人在低声点拨。',
  '一只旧灯笼无风自动，光晕在地上画出一道你不认识的符。',
];

function newDao() {
  return {
    xp: 0,
    realm: 0,
    fated: null,          // 本命器属性（觉醒后）
    fatedCount: 0,        // 本命器候选属性的献祭次数
    fatedDamage: 0,       // 本命器候选属性的累计伤害
    insights: [],         // 已获得的心得 id
    history: [],          // 献祭元素计数，用于判定本命器
  };
}

function currentRealm(state) {
  const dao = state.dao || newDao();
  let r = REALMS[0];
  for (const x of REALMS) if (dao.xp >= x.threshold && x.id >= r.id) r = x;
  return r;
}

/** 增加道行，必要时升级境界。返回文本摘要 */
function grantDao(state, amount) {
  const dao = state.dao || newDao();
  const before = currentRealm(state).id;
  dao.xp = Math.max(0, (dao.xp || 0) + Math.round(amount));
  const after = currentRealm(state).id;
  state.dao = dao;
  if (after > before) return `境界突破：${REALMS[before].name} → ${REALMS[after].name}`;
  return null;
}

/** 献祭结束后记一笔，用于觉醒本命器。当前这次的结果 damage 也要传进来 */
function recordOffering(state, result) {
  const dao = state.dao || newDao();
  const ele = result.element;
  dao.history.push(ele);
  if (dao.fated) { state.dao = dao; return; }
  // 取最近 8 次献祭里次数最多的元素作为候选
  const recent = dao.history.slice(-8);
  const counts = {};
  for (const e of recent) counts[e] = (counts[e] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top) {
    dao.fatedCount = top[1];
    // 累计伤害 = 当前这发 + 之前 7 发同属性伤害
    const prev = (state.offerings || []).slice(-7)
      .filter((o) => o.element === top[0])
      .reduce((a, b) => a + (b.damage || 0), 0);
    dao.fatedDamage = prev + (result.damage || 0);
    if (dao.fatedCount >= 5 && dao.fatedDamage >= 60) {
      dao.fated = top[0];
    }
  }
  state.dao = dao;
}

/** 觉醒本命器（仅在通关结算时按全局历史强制觉醒，防止一局内反复横跳） */
function awakenFated(state) {
  const dao = state.dao || newDao();
  if (dao.fated) return null;
  const counts = {};
  for (const e of dao.history || []) counts[e] = (counts[e] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const damage = (state.offerings || [])
    .filter((o) => o.element === top[0])
    .reduce((a, b) => a + (b.damage || 0), 0);
  if (top[1] >= 5 && damage >= 60) {
    dao.fated = top[0];
    state.dao = dao;
    return top[0];
  }
  return null;
}

/**
 * 灵犀：低境界时克制判定升一级。
 * 返回值是调整后的 verdict：weak→normal，normal→strong。
 * 不强求命中，所以只改 verdict 不改元素。
 */
function maybeLingxi(state, verdict) {
  const dao = state.dao || newDao();
  const realm = currentRealm(state);
  if (!realm.lingxi || verdict === '克制') return verdict;
  if (Math.random() >= realm.lingxi) return verdict;
  if (verdict === '被压制') return '无克制';
  if (verdict === '无克制') return '克制';
  return verdict;
}

/** 境界给的永久献祭伤害倍率 */
function realmDamageMul(state) {
  const r = currentRealm(state);
  return 1 + r.bonus;
}

/** 驭物：每层 Boss 战第一次献祭加伤 */
function openerMul(state, bossTurns) {
  const r = currentRealm(state);
  if (!r.opener || bossTurns !== 0) return 1;
  return 1 + r.opener;
}

/** 化物：本命器属性献祭克制/破防时追加伤害比例 */
function fatedEchoMul(state, result, pierced) {
  const dao = state.dao || newDao();
  const r = currentRealm(state);
  if (!r.echo || !dao.fated || result.element !== dao.fated) return 0;
  if (result.verdict === '克制' || pierced) return r.echo;
  return 0;
}

/** 本命器属性基础加伤 */
function fatedBaseMul(state, result) {
  const dao = state.dao || newDao();
  if (!dao.fated || result.element !== dao.fated) return 1;
  return 1.2;
}

/** 把心得效果应用到一次裁决结果。result 会被直接修改 */
function applyInsights(state, result) {
  const dao = state.dao || newDao();
  const owned = INSIGHTS.filter((i) => dao.insights.includes(i.id));
  for (const ins of owned) {
    if (!ins.applies(result)) continue;
    if (ins.add && result.damage != null) result.damage += ins.add;
    if (ins.mul && result.damage != null) result.damage = Math.max(1, Math.round(result.damage * ins.mul));
    if (ins.reduce && result.damage != null) result.damage = Math.max(1, Math.round(result.damage * (1 - ins.reduce)));
    if (ins.floor && result.damage != null) result.damage = Math.min(result.damage, ins.floor);
    if (ins.heal && result.heal != null) result.heal += ins.heal;
  }
}

/** 生成一个参悟节点 */
function makeInsightNode(level) {
  const text = INSIGHT_NODES[(level - 1) % INSIGHT_NODES.length]
    + ' 停下来看一看，能悟到一点心得。';
  return { type: 'insight', text, solved: false };
}

/** 参悟：随机获得一条未拥有的心得 */
function gainInsight(state) {
  const dao = state.dao || newDao();
  const pool = INSIGHTS.filter((i) => !dao.insights.includes(i.id));
  if (!pool.length) return null;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  dao.insights.push(picked.id);
  state.dao = dao;
  return picked;
}

/** 探索节点文案 */
function insightText(level) {
  return INSIGHT_NODES[(level - 1) % INSIGHT_NODES.length];
}

/** 境界、本命器、心得的状态摘要，给模型读 */
function describeDao(state) {
  const dao = state.dao || newDao();
  const r = currentRealm(state);
  const lines = [`当前境界：${r.name}（道行 ${dao.xp}）`, r.desc];
  if (dao.fated) lines.push(`本命器：${dao.fated} 属性——同属性献祭伤害 +20%。`);
  if (dao.insights.length) {
    lines.push('已悟心得：' + dao.insights
      .map((id) => INSIGHTS.find((i) => i.id === id)?.name || id)
      .join('、'));
  }
  return lines.join('\n');
}

module.exports = {
  REALMS,
  INSIGHTS,
  newDao,
  currentRealm,
  grantDao,
  recordOffering,
  awakenFated,
  maybeLingxi,
  realmDamageMul,
  openerMul,
  fatedEchoMul,
  fatedBaseMul,
  applyInsights,
  makeInsightNode,
  gainInsight,
  insightText,
  describeDao,
};
