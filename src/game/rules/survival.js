/**
 * 生存：饱食与精神
 * ------------------------------------------------------------------
 * 两条线各管一头，逼玩家每天回答一次「今天还出不出去」：
 *
 *   饱食 satiety —— 走一格 -3，夜战一回合 -2。见底之后每走一步掉体力，
 *                   夜战里还会「手软」（伤害打折）。
 *   精神 sanity  —— 遇妖、踩陷阱、夜里被妖物盯着都会掉。
 *                   见底后「失魂」：迷宫里会迷路（多耗饱食），
 *                   夜战里会手不听使唤（随机丢一道咒）。
 *
 * 恢复只有两条路，都在阁里：丹房进食（补饱食）、卧房歇息（补精神）。
 * 于是「攒钱盖房」和「今天多走两格」变成同一个钱包里的取舍。
 *
 * 规则层只负责算数字，不讲故事——故事归模型。
 */

const { SATIETY_MAX, SANITY_MAX } = require('./constants');
const { clamp } = require('./offering');

/** 低于这条线就算「饿」，开始有惩罚 */
const HUNGRY_AT = 25;
const STARVE_DMG = 3;          // 饿着走一步掉的体力
const STARVE_WEAK = 0.75;      // 饿着打人，伤害打折

/** 低于这条线就算「失魂」 */
const MAD_AT = 20;
const WALK_COST = 3;           // 走一格的饱食消耗
const NIGHT_TURN_COST = 2;     // 夜战一回合的饱食消耗
const MAD_LOST_COST = 2;       // 失魂时迷路，额外多耗的饱食

function newSurvival() {
  return { satiety: SATIETY_MAX, sanity: SANITY_MAX };
}

/** 把局面里缺的字段补齐（读旧存档用） */
function ensureSurvival(state) {
  if (typeof state.satiety !== 'number') state.satiety = SATIETY_MAX;
  if (typeof state.sanity !== 'number') state.sanity = SANITY_MAX;
  return state;
}

function isStarving(state) {
  return (Number(state.satiety) || 0) <= HUNGRY_AT;
}

function isMad(state) {
  return (Number(state.sanity) || 0) <= MAD_AT;
}

/**
 * 扣饱食 / 精神。
 * @returns {{satiety:number, sanity:number, starveDmg:number, mad:boolean}}
 *   starveDmg > 0 表示这一下饿掉了体力，调用方要把这段写进事件文本。
 */
function spend(state, { satiety = 0, sanity = 0 } = {}) {
  ensureSurvival(state);
  state.satiety = clamp(state.satiety - satiety, 0, SATIETY_MAX);
  state.sanity = clamp(state.sanity - sanity, 0, SANITY_MAX);

  let starveDmg = 0;
  if (state.satiety <= 0) {
    starveDmg = STARVE_DMG;
    state.playerHp = Math.max(0, (state.playerHp || 0) - starveDmg);
  }
  return { satiety: state.satiety, sanity: state.sanity, starveDmg, mad: isMad(state) };
}

/** 补饱食 / 精神（进食、歇息、宝箱里的干粮都走这里） */
function restore(state, { satiety = 0, sanity = 0 } = {}) {
  ensureSurvival(state);
  state.satiety = clamp(state.satiety + satiety, 0, SATIETY_MAX);
  state.sanity = clamp(state.sanity + sanity, 0, SANITY_MAX);
  return { satiety: state.satiety, sanity: state.sanity };
}

/** 走一格的消耗，含「失魂迷路」的额外代价 */
function walkCost(state) {
  const lost = isMad(state) ? MAD_LOST_COST : 0;
  return { satiety: WALK_COST + lost, sanity: 0, lost };
}

/**
 * 饿着打人伤害打折；饿到 0 已经在掉血，这里不再二次惩罚。
 * 返回一个乘数，交给 resolveOffering 的外层乘上去。
 */
function damageMul(state) {
  return isStarving(state) ? STARVE_WEAK : 1;
}

/**
 * 失魂判定：精神见底时，夜战里有概率「手不听使唤」。
 * 越低越容易失控——不是必中，但每回合都得赌。
 * @returns {boolean} true 表示这一回合失控
 */
function madnessRoll(state, rng = Math.random) {
  if (!isMad(state)) return false;
  const ratio = (MAD_AT - state.sanity) / MAD_AT;   // 0 ~ 1
  return rng() < ratio * 0.5;
}

/** 给模型读的一段生存状态 */
function describeSurvival(state) {
  ensureSurvival(state);
  const lines = [
    `饱食 ${state.satiety}/${SATIETY_MAX}，精神 ${state.sanity}/${SANITY_MAX}`,
  ];
  if (isStarving(state)) lines.push('旅人已经很饿：每走一步都在掉体力，打人也手软。');
  if (isMad(state)) lines.push('旅人精神濒临崩溃：随时可能失魂——在迷宫里迷路，或在夜里失控。');
  if (state.satiety <= 0) lines.push('旅人已经断粮，正在被自己的身体拖垮。');
  if (state.sanity <= 0) lines.push('旅人的神智已经散了，眼前开始出现不该有的东西。');
  return lines.join('\n');
}

module.exports = {
  HUNGRY_AT,
  STARVE_DMG,
  STARVE_WEAK,
  MAD_AT,
  WALK_COST,
  NIGHT_TURN_COST,
  MAD_LOST_COST,
  newSurvival,
  ensureSurvival,
  isStarving,
  isMad,
  spend,
  restore,
  walkCost,
  damageMul,
  madnessRoll,
  describeSurvival,
};
