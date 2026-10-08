/**
 * 献祭裁决
 *
 * 这里是整个游戏最要紧的纯函数：威力、命中、克制、连击、暴击、去向，
 * 全部锁死在这里。模型拿到的只有算好的数字，它的活儿是编故事。
 */

const { ELEMENTS, COUNTERS, elementOf } = require('./elements');
const { BASE_STATS, INTENTS } = require('./stats');
const { realmDamageMul, openerMul, fatedBaseMul, maybeLingxi } = require('./dao');

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 从一帧检测结果里挑"主祭品"。
 * 只看置信度会选到远处的小物件；只看面积会选到糊成一团的背景。
 * 所以两个一起算：置信度 × 面积的平方根——既要求看得准，也要求是主角。
 */

function pickOffering(detections, { width = 640, height = 480 } = {}) {
  const list = Array.isArray(detections) ? detections : [];
  if (!list.length) return null;
  const W = width || 640;
  const H = height || 480;
  let best = null;
  for (const d of list) {
    const box = d.box || d.bbox || null;
    const conf = Number(d.conf ?? d.confidence ?? 0);
    let ratio = 0;
    if (Array.isArray(box) && box.length >= 4) {
      const w = Math.abs(box[2] - box[0]);
      const h = Math.abs(box[3] - box[1]);
      ratio = clamp((w * h) / (W * H), 0, 1);
    }
    const score = conf * Math.sqrt(ratio + 0.0001);
    if (!best || score > best.score) {
      best = { label: d.label || d.name || 'object', conf, ratio, box, score };
    }
  }
  return best;
}

/**
 * 核心裁决。纯函数，同样的输入永远同样的输出（除了那一点骰子抖动）。
 * @param {{label:string, conf:number, ratio:number}} offering 祭品
 * @param {object} guardian 当前守阁灵
 * @param {{combo?:number, enraged?:boolean}} opts
 *   - combo：进入这一击之前已连续"克制"的次数（0 = 上一发不是克制）
 *   - enraged：守阁灵是否已进入狂暴（体力低于阈值）。狂暴不挡伤害，但守阁灵会还手更狠
 * @returns 一份结构化裁决，直接喂给模型让它叙事
 */

function resolveOffering({ label, conf = 0, ratio = 0 }, guardian, opts = {}) {
  const opts2 = opts || {};
  const ele = elementOf(label);
  const gEle = guardian.element;

  // 威力：物件占画面比例越大（举得越近）越猛。
  // 曲线是调过的：摄像头前正常举起大约占 20%，克制时约 33 伤害，
  // 打完五层要十四五发——刚好卡在"策略对就能险胜、乱举必输"的位置。
  const power = 8 + 30 * clamp(ratio * 1.2, 0, 1);
  // 命中：认得越准，物件越"实"
  const acc = conf >= 0.75 ? 1.2 : conf >= 0.5 ? 1.0 : conf >= 0.35 ? 0.75 : 0.5;
  // 克制（可能被境界「通灵」提升一级）
  const strongOrig = (COUNTERS[ele] || []).includes(gEle);
  const weakOrig = (COUNTERS[gEle] || []).includes(ele);
  const verdictOrig = strongOrig ? '克制' : weakOrig ? '被压制' : '无克制';
  const verdict = opts2.state ? maybeLingxi(opts2.state, verdictOrig) : verdictOrig;
  const strong = verdict === '克制';
  const weak = verdict === '被压制';
  let mult = strong ? 1.8 : weak ? 0.5 : 1.0;

  // 连击：同一层里连续克制，越连越痛。连击从第二发克制开始加成——
  // 没有它，"找到克制属性之后无脑重复"和"第一发"没有区别，策略深度差一层。
  const prevCombo = Math.max(0, Math.round(Number(opts.combo) || 0));
  let comboUsed = 0;
  if (strong && prevCombo >= 1) {
    comboUsed = Math.min(prevCombo, 4);           // 1→×1.25, 2→×1.5, 3+→×1.75 封顶
    mult *= 1 + 0.25 * comboUsed;
  }
  // 骰子：±15% 抖动，让每回合有点悬念，但不至于盖过策略
  const roll = 0.85 + Math.random() * 0.3;
  // 数值面板：攻击力按比例放大伤害（atk 10 = 不增不减），暴击独立判定
  const stats = opts2.stats || BASE_STATS;
  const atkMul = 1 + (((stats.atk || BASE_STATS.atk) - BASE_STATS.atk) / 50);
  const critHit = Math.random() < (stats.crit || BASE_STATS.crit);
  // 没传去向时按"强攻"算——不能出现"没乘任何系数"的第三种结果
  const intent = INTENTS[opts2.intent] || INTENTS.power;

  let dmg = power * acc * mult * roll * atkMul;
  if (intent) dmg *= intent.dmg;
  if (critHit) dmg *= 1.6;
  // v3.3：境界加伤 / 驭物首击 / 本命器属性加伤
  if (opts2.state) {
    dmg *= realmDamageMul(opts2.state);
    dmg *= openerMul(opts2.state, opts2.state.bossTurns || 0);
    dmg *= fatedBaseMul(opts2.state, { element: ele });
  }
  dmg = Math.max(1, Math.round(dmg));
  const grade =
    dmg >= 50 ? 'S' : dmg >= 32 ? 'A' : dmg >= 18 ? 'B' : dmg >= 9 ? 'C' : 'D';

  return {
    label,
    element: ele,
    elementName: ELEMENTS[ele].name,
    elementTone: ELEMENTS[ele].tone,
    conf: Number(conf.toFixed(2)),
    areaRatio: Number((ratio * 100).toFixed(1)),
    guardianElement: gEle,
    guardianElementName: ELEMENTS[gEle].name,
    verdict,
    damage: dmg,
    grade,
    crit: critHit,
    intent: opts2.intent || 'power',
    combo: strong ? prevCombo + 1 : 0,   // 打完这一击之后的连击数
    comboUsed,
    lingxi: verdict !== verdictOrig ? true : undefined,
    // 剩下的交给模型读，它照着这些数字编故事就行
    hint:
      strong
        ? comboUsed > 0
          ? `${ELEMENTS[ele].name} 连续第 ${prevCombo + 1} 次压住 ${ELEMENTS[gEle].name}，气势叠加，越打越狠。`
          : `${ELEMENTS[ele].name} 正好压住 ${ELEMENTS[gEle].name}，这一记打得极狠。`
        : weak
          ? `${ELEMENTS[gEle].name} 反过来压住了 ${ELEMENTS[ele].name}，物件像是被什么东西顶了回来。`
          : `${ELEMENTS[ele].name} 与 ${ELEMENTS[gEle].name} 互不相干，只能凭分量硬砸。`,
  };
}

/** 守阁灵的反击。同样留一点随机，但幅度比玩家小，避免运气盖过策略。
 *  玩家防御力（装备堆出来的）按一半折减 */

module.exports = {
  clamp,
  pickOffering,
  resolveOffering,
};
