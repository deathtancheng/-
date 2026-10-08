/**
 * 妖物池 —— 夜里来偷宝的那些东西
 * ------------------------------------------------------------------
 * v4.0 之前这是「五层楼的五位主人」，一层一个，顺序固定。
 * 改成肉鸽之后，它们变成**池子**：每一夜按天数和运气抽一只，
 * 血与反击随天数整体放大。同一只妖物你这一局可能遇上好几次，
 * 但每次它都更凶——这是肉鸽的"同一个敌人，不同的题"。
 *
 * 狂热（残血反噬）和狂怒（打太久）是两回事，都在这里判定。
 */

const { PLAYER_HP, BASE_STATS } = require('./constants');
const { FRENZY_MULT } = require('./stance');

/**
 * tier 决定它最早第几夜可能出现：
 *  1 —— 开局几夜（好打，教会玩家克制关系）
 *  2 —— 第 4 夜起
 *  3 —— 第 7 夜起（守阁级）
 */
const GUARDIANS = [
  {
    id: 'ash', tier: 1, name: '灰烬书童', element: 'fire', art: 'fire', hp: 50, counter: 4,
    persona: '话不多，说话带火星。最怕水，也怕被看穿心思。',
    scene: '它蹲在一堆烧了一半的家书旁，抬头看你一眼，灰烬落在睫毛上。',
    flee: '火头被晨风一压，它把手里的半封家书按进灰里，人化成一蓬烟，顺窗缝走了。',
  },
  {
    id: 'well', tier: 1, name: '苔痕守井', element: 'water', art: 'water', hp: 62, counter: 5,
    persona: '慢声慢气，什么都往怀里吞。厚重的东西也能压住它。',
    scene: '井口的青苔一直长到它肩膀上，它说话时水面跟着一圈圈荡开。',
    flee: '它把身子沉回井底，青苔缓缓合拢，只留一汪水皮还在微微地动。',
  },
  {
    id: 'paperjudge', tier: 1, name: '纸札判官', element: 'lore', art: 'lore', hp: 56, counter: 5,
    persona: '一身官样文章，句句要讲道理。最烦别人打断它的话。',
    scene: '它把一卷判词抖开，纸边锋利得像刀，念一句，屋里就冷一分。',
    flee: '它把没念完的判词卷好收进袖中，撂下一句「择日再判」——纸声一响，人已经没了。',
  },
  {
    id: 'lampman', tier: 2, name: '灯下人', element: 'guard', art: 'metal', hp: 84, counter: 6,
    persona: '提着一盏不亮的灯，从不走进光里。怕火，也怕比自己更硬的东西。',
    scene: '灯影里站着个人形，你挪一步，灯影也跟着挪一步。',
    flee: '它提着那盏不亮的灯退进灯影里，灯影一熄，就再也分不清哪是影、哪是它。',
  },
  {
    id: 'qinnu', tier: 2, name: '焦尾琴奴', element: 'wood', art: 'water', hp: 74, counter: 6,
    persona: '手指一动就有声，声里有旧事。最怕火，和锋利的铁器。',
    scene: '断了一根弦的焦尾琴自己响起来，弦上还挂着没干的血。',
    flee: '琴声戛然断在一半，它抱着琴退进暗处，断弦还在嗡嗡地颤。',
  },
  {
    id: 'saltfrog', tier: 2, name: '盐井蛙母', element: 'water', art: 'water', hp: 88, counter: 6,
    persona: '嗓子眼里全是咸水，说话咕噜咕噜。怕土，怕重物压。',
    scene: '盐井里爬出个鼓鼓囊囊的东西，身上的盐壳一路往下掉。',
    flee: '它鼓着腮帮子咕噜了两声，拖着满身盐壳爬回井里，地上只留一道湿痕。',
  },
  {
    id: 'rustblade', tier: 2, name: '锈刃将军', element: 'metal', art: 'metal', hp: 96, counter: 7,
    persona: '一身旧甲，脾气硬。见不得活气，也见不得比它更利的刃。',
    scene: '它把插在地上的长刀拔出来，锈屑簌簌往下掉，刀锋却还是亮的。',
    flee: '它收刀入鞘，锈甲在晨光里退成一地斑驳的影子——明日再战。',
  },
  {
    id: 'bonegranny', tier: 3, name: '拾骨老妪', element: 'earth', art: 'metal', hp: 118, counter: 8,
    persona: '背着一筐东西，走一步响一声。厌火，也厌流水。',
    scene: '她从筐里翻出一节指骨，对着光看了看，又扔回筐里。',
    flee: '她背起筐，筐里指骨哗啦响了一声，人顺着墙根一步一响地远了。',
  },
  {
    id: 'boltman', tier: 3, name: '雷纹傀儡', element: 'volt', art: 'volt', hp: 126, counter: 8,
    persona: '关节里走电，吐字一顿一顿。湿的东西和铁器都能让它短路。',
    scene: '它每走一步，身上的雷纹就亮一次，把整层楼照得忽明忽暗。',
    flee: '它身上的雷纹一节节暗下去，最后咔的一声僵在原地——再抬头，人已散成一股青烟。',
  },
  {
    id: 'shadow', tier: 3, name: '万物之影', element: 'lore', art: 'lore', hp: 150, counter: 9,
    persona: '没有固定形状，你举什么它就变成什么。只有火能把它烧出原形。',
    scene: '它站在阁楼最高处，轮廓不停变换，最后停成你自己的样子。',
    flee: '晨光一照，它的轮廓散了架——你还没看清，它已经躲进了你自己的影子里。',
  },
];

/**
 * 抽今夜的妖物。
 * 第 1 夜固定给最弱的那只——第一夜不该是赌运气，该是教学关。
 * @param {number} day 第几天
 * @param {{excludeId?:string, rng?:() => number, hard?:boolean}} opts
 */
function pickBeast(day, opts = {}) {
  const rng = opts.rng || Math.random;
  const d = Math.max(1, Number(day) || 1);
  if (d === 1) return GUARDIANS[0];
  const maxTier = d >= 7 ? 3 : d >= 4 ? 2 : 1;
  let pool = GUARDIANS.filter((g) => g.tier <= maxTier);
  if (opts.excludeId) {
    const filtered = pool.filter((g) => g.id !== opts.excludeId);
    if (filtered.length) pool = filtered;
  }
  let pick = pool[Math.floor(rng() * pool.length)] || GUARDIANS[0];
  // 深度越大越可能撞上硬茬：三成概率换成当时池子里最凶的那只
  if (!opts.hard && d >= 5 && rng() < 0.3) {
    pick = pool.reduce((a, b) => (b.hp > a.hp ? b : a), pool[0]);
  }
  return pick;
}

function beastById(id) {
  return GUARDIANS.find((g) => g.id === id) || null;
}

/** 狂暴阈值：妖物体力低于这个比例就翻脸 */
const ENRAGE_AT = 0.35;

/** S 级妙手回春：打得漂亮旅人回一口血。数值锁死在规则层 */
const HEAL_ON_S = 6;

function isEnraged(state, beast) {
  return !!beast && beast.hp > 0 && (state.guardianHp / beast.hp) < ENRAGE_AT;
}

/** 妖物的反击。狂暴（血少）与狂怒（拖太久）叠乘，防御按 1/3 折减但至少留 2 */
function guardianCounter(beast, { enraged = false, frenzied = false, def = BASE_STATS.def } = {}) {
  const base = beast.counter + Math.round((Math.random() * 4 - 2));
  const mult = (enraged ? 1.5 : 1) * (frenzied ? FRENZY_MULT : 1);
  return Math.max(2, Math.round(base * mult) - Math.floor((def || 0) / 3));
}

/**
 * 按天数缩放：天数越往后，妖物越厚、反击越狠。
 * 只涨血会变成"打很久"，反击也涨才有"这一夜真的更凶"的体感。
 */
function scaleGuardian(beast, day) {
  const d = Math.max(1, Number(day) || 1);
  if (d === 1) return beast;
  // v4.5：原来 0.22 的血量增长配"想逛多久逛多久"的日子，等于能一路平推。
  // 现在白天有限时，成长也得更陡——第 4 天起就得靠阁里的经营顶着。
  return {
    ...beast,
    hp: Math.round(beast.hp * (1 + 0.34 * (d - 1))),
    counter: beast.counter + Math.floor((d - 1) * 0.8),
  };
}

/**
 * 衔恨缩放（v4.5.5）：天亮没打死的妖物会记仇——它带着上夜的伤回来，
 * 每记一夜仇血更厚一分、反击更狠一分（封顶 5 层，不然第 4 夜起没法玩）。
 * 设定上它不是怕了才走：晨光是旧宅生者的规矩，它必须避；但梁上的账它记着。
 */
function applyGrudge(scaled, grudge) {
  const n = Math.max(0, Math.min(5, Number(grudge) || 0));
  if (!n) return scaled;
  return {
    ...scaled,
    hp: Math.round(scaled.hp * (1 + 0.12 * n)),
    counter: scaled.counter + n,
  };
}

module.exports = {
  GUARDIANS,
  PLAYER_HP,
  ENRAGE_AT,
  HEAL_ON_S,
  isEnraged,
  guardianCounter,
  scaleGuardian,
  pickBeast,
  beastById,
  applyGrudge,
};
