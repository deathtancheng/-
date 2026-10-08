/**
 * 本局状态机 —— 肉鸽的骨架
 * ------------------------------------------------------------------
 * 一局（run）就是一个不断循环的白天：
 *
 *   迷宫  ──逐格探索、拾物、遇妖、下潜──▶ 随时可回阁
 *   阁楼  ──卖物换钱、盖房、炼精怪、吃饭睡觉──▶ 入夜
 *   夜袭  ──妖物上门夺宝，献祭对打──▶ 赢了就活到第二天，输了这一局就完了
 *
 * 这个文件不实现任何一条具体规则：迷宫几何在 maze.js、房间裁决在 rooms.js、
 * 生存在 survival.js、经营在 facilities.js、精怪在 spirits.js、妖物在 night.js。
 * 它只负责把它们串成一条能推进的时间线，并把局面整理好交给上层。
 */

const {
  PLAYER_HP, BASE_STATS, SATIETY_MAX, SANITY_MAX, START_COIN, START_INCENSE,
} = require('./constants');
const { newDao, gainInsight, describeDao, currentRealm, REALMS } = require('./dao');
const { applyRelics, onEnterLevel } = require('./stats');
const { rollStance, turnsLeft, isFrenzy } = require('./stance');
const {
  pickBeast, scaleGuardian, applyGrudge, beastById, GUARDIANS,
} = require('./night');
const {
  makeMaze, isRestSpot, mazeSnapshot, here, roomBlocks, walk,
} = require('./maze');
const {
  ensureSurvival, spend, restore, walkCost, describeSurvival,
} = require('./survival');
const {
  ensureIncense, incenseMax, gainIncense, buyIncense, buyQuota, incensePrice,
  describeIncense, NIGHT_REGEN,
} = require('./incense');
const {
  build: buildFacility, storeCap, spiritSlots, spiritMul, hallTitle,
  hallLevel, kitchenHeal, bedchamberHeal, studyTimes, nightlyIncome,
  describeHall, levelOf, FACILITIES,
  lampUpkeep, wardCut,
} = require('./facilities');
const {
  makeSpirit, feed, release, battleBonus, upkeep, describeSpirits,
} = require('./spirits');
const { sellPrice, roomPrompt } = require('./rooms');
const {
  newClock, clockLeft, clockRatio, clockExpired, startClock, lookOf, fmtClock, lenOf,
} = require('./clock');

/* ══════════════════════════════════════════════════════════════
   开新局
   ══════════════════════════════════════════════════════════════ */

/**
 * @param {{cycle?:number, relics?:string[]}} opts
 *   跨局继承：第几周目 + 已解锁的遗物（由 quest.js 从 legacy.json 读出来）
 */
function newRun(opts = {}) {
  const st = {
    /* —— 时间与阶段 —— */
    day: 1,
    phase: 'maze',            // maze | hall | night | over
    clock: newClock('day'),   // 时辰：白天拾物 / 黄昏经营 / 夜里守阁，走完自动翻页
    dark: false,              // 天黑了人还在旧宅里（摸黑：体力持续流失）
    darkAcc: 0,
    beastSlain: true,         // 上一夜的妖物死没死——没死它今夜还会来
    beastGrudge: 0,           // 衔恨层数：天亮没打死的它记仇，明晚更凶（v4.5.5）

    /* —— 生存两条线 —— */
    satiety: SATIETY_MAX,
    sanity: SANITY_MAX,

    /* —— 资源 —— */
    coin: START_COIN,
    incense: START_INCENSE,    // 香火：献祭一次烧一炷，只能靠经营攒
    store: [],                // 仓库：迷宫捡回来的物件
    spirits: [],              // 精怪：物件在祭坛上炼出来的

    /* —— 万物阁 —— */
    hall: { slots: {} },
    hallUsed: {},             // 今天已经用过的阁内动作（进食/歇息/参悟），换天才重置

    /* —— 迷宫 —— */
    maze: makeMaze(1),

    /* —— 夜袭 —— */
    beastId: null,
    guardianHp: 0,
    beastMaxHp: 0,
    bossTurns: 0,
    stance: null,
    combo: 0,
    lastSkillElement: null,
    frenzied: false,
    nightBonus: null,         // 开夜时算好的精怪加成快照
    nightUsed: null,          // 这一夜已经用过的精怪护主等一次性效果

    /* —— 战斗底子（沿用 v3.x 那一套）—— */
    playerHp: PLAYER_HP,
    stats: { ...BASE_STATS },
    equipment: [],
    skills: ['blaze', 'tide'],
    buffs: [],
    offerings: [],

    /* —— 成长与跨局 —— */
    dao: newDao(),
    cycle: Math.max(1, Number(opts.cycle) || 1),
    relics: Array.isArray(opts.relics) ? [...opts.relics] : [],
    ending: null,
    over: null,
    news: [],                 // 今天发生的事，前端滚动用
    startedAt: new Date().toISOString(),
  };
  applyRelics(st, st.relics);
  return st;
}

/** 新的一天：清掉「今天用过什么」，把日子往后翻一格 */
function nextDay(state) {
  state.day = (Number(state.day) || 1) + 1;
  state.hallUsed = {};
}

/**
 * 读档时补齐字段。v4.0 之前的老存档没有 day 字段，
 * 结构对不上——直接当新局开，不硬迁（旧局是"五层楼"，跟肉鸽不是一回事）。
 */
function ensureRun(state) {
  if (!state || typeof state.day !== 'number') return null;
  ensureSurvival(state);
  ensureIncense(state);
  if (!state.hall || !state.hall.slots) state.hall = { slots: {} };
  if (!state.hallUsed) state.hallUsed = {};
  if (!Array.isArray(state.store)) state.store = [];
  if (!Array.isArray(state.spirits)) state.spirits = [];
  if (!Array.isArray(state.news)) state.news = [];
  if (!state.dao) state.dao = newDao();
  if (typeof state.dark !== 'boolean') state.dark = false;
  if (typeof state.beastSlain !== 'boolean') state.beastSlain = true;
  if (typeof state.beastGrudge !== 'number') state.beastGrudge = 0;
  if (!state.clock || !state.clock.endAt) {
    // 老存档没有时钟：按当时的阶段补一个，免得一进来就"超时"
    state.clock = newClock(
      state.phase === 'night' ? 'night' : state.phase === 'hall' ? 'dusk' : 'day',
    );
  }
  if (!state.maze) state.maze = makeMaze(1);
  // v4.1 起地图里必须有歇脚处（回阁的唯一落脚点）。
  // v4.0 的老存档没有这一类房间——不重建的话玩家会被永远关在迷宫里。
  else if (!state.maze.rooms.some((r) => r.type === 'rest')) {
    state.maze = makeMaze(state.maze.depth || 1);
  }
  // 白天死亡收尾曾经缺失（v4.1.1 前的 bug）：over 已设、phase 却留在
  // maze/hall 上，存档就卡在"人死了界面还活着"的僵尸态里。
  // 老僵尸档在这儿修掉——成绩补不了录，但至少能正常看到结算屏重开。
  if (state.over && state.phase !== 'over') state.phase = 'over';
  return state;
}

/* ══════════════════════════════════════════════════════════════
   迷宫阶段
   ══════════════════════════════════════════════════════════════ */

/** 记一笔"今天发生了什么"，前端在右侧滚成一条流水 */
function pushNews(state, text) {
  if (!text) return;
  state.news.push({ day: state.day, text, at: Date.now() });
  if (state.news.length > 60) state.news = state.news.slice(-60);
}

/**
 * 走一格之后扣生存成本。
 * 失魂（精神见底）时会在迷宫里多绕路，多掉饱食。
 */
function payWalk(state) {
  const cost = walkCost(state);
  const r = spend(state, { satiety: cost.satiety });
  if (r.starveDmg) pushNews(state, `饿得眼冒金星，掉了 ${r.starveDmg} 点体力。`);
  if (cost.lost) pushNews(state, '神智有点散，你在原地绕了半圈。');
  if (state.playerHp <= 0) state.over = 'lose';
  return r;
}

/**
 * 走一步（v4.2）
 * ------------------------------------------------------------------
 * 地图不再是"走过就记住"的静态图：**只看十字**，视野外的格子
 * 每次移动都回到迷雾并重新掷内容。脚下、阁门、下楼的梯、歇脚处是
 * 四处地标，不参与重掷——玩家仍有方向感，但"我记得那间是箱笼"
 * 这种捷径没了，每一步都得重新判断。
 */
function step(state, dir) {
  const move = walk(state.maze, dir);   // walk 内部已含 advance（视野+重掷）
  if (!move.ok) return { ...move, rerolled: 0 };
  if (move.changed > 0) {
    pushNews(state, `宅子在动——视野外的屋子又换了 ${move.changed} 间。`);
  }
  return { ...move, rerolled: move.changed || 0 };
}

/** 下潜：往迷宫的更深处走一层。越深越阴，精神要付出代价 */
function descend(state) {
  if (state.over) return { ok: false, msg: '这一局已经结束了。' };
  if (state.phase !== 'maze') return { ok: false, msg: '现在不在迷宫里。' };
  const depth = (state.maze ? state.maze.depth : 1) + 1;
  state.maze = makeMaze(depth);
  const sanity = Math.min(10, 3 + depth);
  spend(state, { sanity });
  pushNews(state, `你顺着梯子下到第 ${depth} 层（-${sanity} 精神）。`);
  return { ok: true, depth, sanity };
}

/**
 * 回阁：从迷宫退回来，进经营阶段。
 * v4.1 起不再"随时能回"——只有在歇脚处才走得回去。
 * 否则玩家可以走两步就回阁把饱食补满，生存压力荡然无存。
 */
function returnToHall(state) {
  if (state.over) return { ok: false, msg: '这一局已经结束了。' };
  if (state.phase !== 'maze') return { ok: false, msg: '你现在不在迷宫里。' };
  if (!isRestSpot(state.maze)) {
    return { ok: false, msg: '这一带回不去阁。先在地图上找到一处「歇脚处」。' };
  }
  state.phase = 'hall';
  // 摸黑摸回来的：妖物已经在阁外等着了——没有黄昏给你收拾，
  // 推进门就得直接面对它（这就是"早点回家"的价值）。
  if (state.dark) {
    state.dark = false;
    const r = nightFalls(state);
    pushNews(state, '你刚跨进阁门，它就跟了进来——这一夜来得比想的早。');
    return { ok: true, night: r };
  }
  startClock(state, 'dusk');   // 回阁 = 黄昏：这一段是经营的时间，走完就入夜
  pushNews(state, '你带着这一趟的收获回到了阁里。');
  return { ok: true };
}

/**
 * 又出门：从阁回到迷宫。
 * 不再刷新地图——同一层返回还是那一张图，玩家刚记住的路不该白记。
 */
function leaveHall(state) {
  if (state.over) return { ok: false, msg: '这一局已经结束了。' };
  if (state.phase !== 'hall') return { ok: false, msg: '你现在不在阁里。' };
  state.phase = 'maze';
  pushNews(state, '你又推门出去了。');
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════
   阁楼阶段（模拟经营）
   ══════════════════════════════════════════════════════════════ */

/** 盖房 / 升房 */
function doBuild(state, id) {
  const r = buildFacility(state, id);
  if (r.ok) pushNews(state, r.msg);
  return r;
}

/** 卖仓库里的物件 */
function doSell(state, itemId) {
  const i = (state.store || []).findIndex((x) => x.id === itemId);
  if (i < 0) return { ok: false, msg: '仓库里没有这件东西。' };
  const [item] = state.store.splice(i, 1);
  const price = sellPrice(item);
  state.coin = (state.coin || 0) + price;
  pushNews(state, `卖掉了「${item.name}」，得 ${price} 文。`);
  return { ok: true, price, item, msg: `「${item.name}」卖了 ${price} 文。` };
}

/** 在祭坛上把一件物件炼成精怪 */
function doMelt(state, itemId) {
  const slots = spiritSlots(state);
  if (slots <= 0) return { ok: false, msg: '还没有祭坛，炼不出精怪。先盖一座。' };
  if ((state.spirits || []).length >= slots) {
    return { ok: false, msg: `祭坛只放得下 ${slots} 只精怪，先送走一只。` };
  }
  const i = (state.store || []).findIndex((x) => x.id === itemId);
  if (i < 0) return { ok: false, msg: '仓库里没有这件东西。' };
  const [item] = state.store.splice(i, 1);
  const sp = makeSpirit({ label: item.label, element: item.element });
  state.spirits.push(sp);
  pushNews(state, `祭坛上一炷香烧尽，「${item.name}」化成了精怪「${sp.name}」。`);
  return { ok: true, spirit: sp, msg: `「${item.name}」化成了精怪「${sp.name}」。` };
}

/** 喂精怪 */
function doFeed(state, spiritId) {
  const r = feed(state, spiritId);
  if (r.ok) pushNews(state, r.msg);
  return r;
}

/** 送走精怪 */
function doRelease(state, spiritId) {
  const r = release(state, spiritId);
  if (r.ok) pushNews(state, r.msg);
  return r;
}

/**
 * 阁内的日常动作：进食 / 歇息 / 参悟。
 * 每天各有次数限制——否则玩家会一直点"吃饭"把饱食刷满，
 * 生存就变成没有代价的赘余。
 */
function doRest(state, action) {
  if (state.over) return { ok: false, msg: '这一局已经结束了。' };
  if (state.phase !== 'hall') {
    return { ok: false, msg: action === 'incense' ? '得先回阁才能添香。' : '得先回阁才能歇。' };
  }
  const used = state.hallUsed || (state.hallUsed = {});

  if (action === 'eat') {
    const heal = kitchenHeal(state);
    if (!heal) return { ok: false, msg: '还没有丹房，做不出热食。' };
    if (used.eat) return { ok: false, msg: '今天已经吃过一顿了。' };
    if (state.satiety >= SATIETY_MAX) return { ok: false, msg: '肚子是满的，吃不下了。' };
    used.eat = true;
    restore(state, { satiety: heal });
    pushNews(state, `丹房升了火，一顿热食下肚（+${heal} 饱食）。`);
    return { ok: true, heal, msg: `吃了顿热食，饱食 +${heal}。` };
  }
  if (action === 'sleep') {
    const heal = bedchamberHeal(state);
    if (!heal) return { ok: false, msg: '还没有卧房，只能靠着墙打盹。' };
    if (used.sleep) return { ok: false, msg: '今天已经歇过了。' };
    if (state.sanity >= SANITY_MAX) return { ok: false, msg: '心里是静的，躺下也睡不着。' };
    used.sleep = true;
    restore(state, { sanity: heal });
    pushNews(state, `在卧房里合了一会儿眼（+${heal} 精神）。`);
    return { ok: true, heal, msg: `睡了一觉，精神 +${heal}。` };
  }
  if (action === 'study') {
    const times = studyTimes(state);
    if (!times) return { ok: false, msg: '还没有书斋，无从参悟。' };
    used.study = Number(used.study) || 0;
    if (used.study >= times) return { ok: false, msg: '今天已经悟够多了。' };
    const ins = gainInsight(state);
    used.study += 1;
    if (!ins) return { ok: false, msg: '翻遍了书，没有新东西可悟。' };
    pushNews(state, `书斋一夜，悟出「${ins.name}」（${ins.desc}）。`);
    return { ok: true, insight: ins, msg: `悟出「${ins.name}」——${ins.desc}。` };
  }
  if (action === 'incense') {
    // 添香：把铜钱换成今晚能献几次。祭坛越高，一天能多添几炷
    const r = buyIncense(state);
    if (r.ok) pushNews(state, r.msg);
    return r;
  }
  return { ok: false, msg: '不知道要做什么。' };
}

/* ══════════════════════════════════════════════════════════════
   夜袭
   ══════════════════════════════════════════════════════════════ */

/** 当前夜袭的妖物（已按天数缩放 + 衔恨加成）。不在夜里就返回 null */
function beastFor(state) {
  const b = state.beastId ? beastById(state.beastId) : null;
  if (!b) return null;
  return applyGrudge(scaleGuardian(b, state.day), state.beastGrudge);
}

/* ══════════════════════════════════════════════════════════════
   时辰 —— 时间会自己走完，玩家得在它走完之前拿主意
   ══════════════════════════════════════════════════════════════ */

/**
 * 天黑了，人还在外面。
 * v4.5.1：不再把人拽回阁——时钟只换光景，出入阁始终自己决定。
 * 代价是真正的生存压力：摸黑期间体力**持续流失**，
 * 直到摸回歇脚处回阁（或熬到天亮，天亮时阁里没人守，东西被搬）。
 */
function darkFalls(state, now = Date.now()) {
  state.dark = true;
  state.darkAcc = 0;
  startClock(state, 'dark', now);
  pushNews(state, '天黑透了。旧宅里没了光，磕磕绊绊，体力在一直往下掉——'
    + '赶紧找图上「歇」的那间回阁，或者找个安全的地方熬到天亮。');
  return { ok: true, dark: true, msg: '天黑透了，你还在旧宅里。' };
}

/** 摸黑的每一秒都在疼。由秒表每秒调一次，每两秒掉 1 点体力 */
function drainDark(state) {
  if (!state.dark || state.phase !== 'maze' || state.over) return null;
  state.darkAcc = (state.darkAcc || 0) + 1;
  if (state.darkAcc % 2 !== 0) return null;
  state.playerHp = Math.max(0, (state.playerHp || 0) - 1);
  if (state.playerHp <= 0) state.over = 'lose';   // 饿死之外又多一种死法：黑夜里摔死的
  return { drained: 1 };
}

/** 黄昏走完：夜幕落下，妖物自己上门（不点「入夜守阁」它也会来） */
function nightFalls(state, now = Date.now()) {
  const r = beginNight(state);
  state.dark = false;
  startClock(state, 'night', now);
  return { ...r, fell: true };
}

/**
 * 天亮。
 * 妖物还没倒：它不会客气——搬走一批东西再走。被打退了：门面进账、日子 +1。
 * 无论哪种，白天都回到**原来那一格**接着逛（地图不再每天推倒重来，
 * 玩家昨天记住的路、挖到一半的层都还在——这也让"要不要再深挖一层"
 * 变成一个真的要掂量的决定）。
 */
function dawnBreaks(state, now = Date.now()) {
  const out = { ok: true, robbed: null, msg: '' };
  const wasNight = state.phase === 'night';
  const killed = wasNight && Number(state.guardianHp) <= 0;
  const alive = wasNight && !killed;
  // 天亮时人不在夜战里（还在迷宫里逛，或在阁里磨蹭）——等于没守夜，搬得更狠
  const unguarded = !wasNight;
  const heavy = unguarded;

  if (alive || unguarded) {
    const ward = (wardCut(state) || 0) / 100;      // 门闩：能少被搬走一些
    const coinLoss = Math.round((state.coin || 0) * (heavy ? 0.5 : 0.3) * (1 - ward));
    state.coin = Math.max(0, (state.coin || 0) - coinLoss);
    const lost = [];
    let take = heavy ? 2 : 1;
    if (ward >= 0.15) take = Math.max(0, take - 1);
    for (let i = 0; i < take; i += 1) {
      if (Array.isArray(state.store) && state.store.length) {
        lost.push(state.store.splice(Math.floor(Math.random() * state.store.length), 1)[0].name);
      }
    }
    spend(state, { sanity: heavy ? 12 : 8 });
    out.robbed = { coin: coinLoss, items: lost, unguarded: heavy };
    const who = (beastFor(state) || {});
    // v4.5.5 衔恨：没打死的它记了一笔账，明晚带着伤回来更凶
    if (alive) state.beastGrudge = Math.min(5, (Number(state.beastGrudge) || 0) + 1);
    out.msg = unguarded
      ? `天亮了，你却没在阁里守着——「${who.name}」推门进来搬走了 ${coinLoss} 文`
        + `${lost.length ? `、「${lost.join('」「')}」` : ''}（-12 精神）。阁里空了一片。`
      : `天亮了。「${who.name}」没有倒下——${who.flee || '它遁进晨雾里不见了。'}`
        + `趁乱叼走了 ${coinLoss} 文${lost.length ? `、「${lost.join('」「')}」` : ''}（-8 精神）。`
        + `梁上的账它记下了（衔恨 ×${state.beastGrudge}），明晚还会来。`;
    pushNews(state, out.msg);
  } else if (killed) {
    state.beastGrudge = 0;    // 打死了，梁上的账就一笔勾销
    const income = nightlyIncome(state, (state.spirits || []).length);
    if (income.coin > 0) pushNews(state, `门面净进 ${income.coin} 文。`);
    out.msg = '天亮了，它散在晨光里。';
  }

  // 收夜：清妖物、翻页到第二天
  state.guardianHp = 0;
  state.stance = null;
  state.frenzied = false;
  state.combo = 0;
  state.bossTurns = 0;
  state.nightBonus = null;
  state.dark = false;
  state.beastSlain = !!killed;   // 死了的换新的来，跑了的今夜还会回来
  state.phase = 'maze';
  nextDay(state);
  // 天亮回一点气：比打赢妖物的那份少——没守住就该疼一点
  restore(state, { satiety: alive || unguarded ? 10 : 25, sanity: alive || unguarded ? 8 : 20 });
  spend(state, {});
  if (!out.msg) out.msg = `天亮了。这是你在万物阁的第 ${state.day} 天。`;
  pushNews(state, `天亮了。这是你在万物阁的第 ${state.day} 天——回到旧宅，接着昨天的路走。`);
  startClock(state, 'day', now);
  return out;
}

/** 现在这个时刻该叫什么时段（给时钟初始化/对表用） */
function kindFor(state) {
  if (state.phase === 'night') return 'night';
  if (state.phase === 'hall') return (state.clock && state.clock.kind === 'night') ? 'night' : 'dusk';
  if (state.dark) return 'dark';
  return 'day';
}

/**
 * 时钟推进。每个时段走完自动翻页。
 * 由后端的秒表每秒调一次（玩家不动也会走），也在每次取局面时兜底调一遍
 * ——服务重启过、endAt 早就在过去，进来就得先结算，不能装作没发生。
 *
 * v4.5.1：时钟不再搬运玩家。白天到期只是"天黑了"——人在旧宅就摸黑
 * （持续掉血），在阁里就等妖物上门；出入阁永远是自己走，不是被翻页翻走。
 * @returns {null|{type:string, detail:object}} 没到点返回 null
 */
function tickClock(state, now = Date.now()) {
  if (!state || state.over || state.phase === 'over') return null;
  if (!state.clock || !state.clock.endAt) {
    state.clock = newClock(kindFor(state), now);
    return null;
  }

  // 摸黑的代价按秒结：不等到点才疼
  const dr = drainDark(state);
  if (state.over) return { type: 'drain-fall', detail: { hp: 0 } };
  if (!clockExpired(state, now)) {
    if (dr) return { type: 'drain', detail: dr };
    return null;
  }

  const kind = state.clock.kind;
  if (kind === 'day') {
    if (state.phase === 'maze') return { type: 'dark', detail: darkFalls(state, now) };
    if (state.phase === 'hall') return { type: 'night', detail: nightFalls(state, now) };
    startClock(state, 'night', now);   // 夜战进行中——重新对表，别再翻这一页
    return null;
  }
  if (kind === 'dark') {
    // 在外面熬过了一整夜：天亮了，阁里没人守，东西被搬
    return { type: 'dawn', detail: dawnBreaks(state, now) };
  }
  if (kind === 'dusk') {
    if (state.phase === 'hall') return { type: 'night', detail: nightFalls(state, now) };
    startClock(state, state.phase === 'night' ? 'night' : 'day', now);
    return null;
  }
  // kind === 'night'：天亮。不管人这会儿在迷宫里逛还是在阁里磨蹭，
  // 只要没在夜战里把妖物打退，阁里的东西就保不住。
  return { type: 'dawn', detail: dawnBreaks(state, now) };
}

/**
 * 入夜。抽妖物、摇架势、算精怪加成，并把「回魂」这类每晚触发的遗物结掉。
 * @returns {{ok:boolean, beast?:object, msg?:string}}
 */
function beginNight(state) {
  if (state.over) return { ok: false, msg: '这一局已经结束了。' };
  if (state.phase === 'night') return { ok: false, msg: '天已经黑了。' };
  // v4.5.1：上一夜没被打死的它，今夜还会来——逃跑的妖物不换人。
  // 这样"计时到了把它拖到天亮"就不再是BUG：它走了，但它还会回来。
  // v4.5.5：它还记仇——每逃走一夜，血更厚、反击更狠（封顶 5 层）。
  const escaped = state.beastId && !state.beastSlain;
  const grudge = escaped ? Math.max(1, Number(state.beastGrudge) || 1) : 0;
  if (!escaped) state.beastGrudge = 0;
  const beast = escaped
    ? beastById(state.beastId)
    : pickBeast(state.day, { excludeId: state.beastId });
  state.beastSlain = false;
  const scaled = applyGrudge(scaleGuardian(beast, state.day), grudge);

  state.beastId = beast.id;
  state.tmpBeast = null;
  state.guardianHp = scaled.hp;
  state.beastMaxHp = scaled.hp;
  state.bossTurns = 0;
  state.frenzied = false;
  state.stance = rollStance(null);
  state.combo = 0;
  state.lastSkillElement = null;
  state.phase = 'night';
  state.nightBonus = battleBonus(state.spirits, spiritMul(state));
  state.nightUsed = { shield: false };

  // —— 灯油：今夜点不点得起灯？点不起就得摸黑（打得虚、挨得实）
  const lampFee = lampUpkeep(state);
  if (lampFee > 0 && (state.coin || 0) >= lampFee) {
    state.coin = (state.coin || 0) - lampFee;
    state.lampLit = true;
    pushNews(state, `灯点上了（-${lampFee} 文）。今夜看得清它的来势。`);
  } else {
    state.lampLit = false;
    pushNews(state, lampFee > 0
      ? '灯油钱不够，这一夜只能摸黑守阁——打得虚，挨得实。'
      : '阁里连盏灯都没有，这一夜摸黑。');
  }

  // 每晚触发一次的遗物（回魂：回 15 体力）
  onEnterLevel(state, state.relics);
  // 夜里添一炷香：保证每天都还能献上至少一次，不至于被彻底锁死
  ensureIncense(state);
  const regen = gainIncense(state, NIGHT_REGEN);
  if (regen.gained) pushNews(state, `月光下添了 ${regen.gained} 炷香（${state.incense}/${incenseMax(state)}）。`);
  // 精怪的口粮
  const food = upkeep(state.spirits);
  if (food > 0) {
    spend(state, { satiety: food });
    pushNews(state, `夜里精怪要吃东西（-${food} 饱食）。`);
  }
  pushNews(state, escaped
    ? `入夜了。「${scaled.name}」带着上夜的伤又顺着阁墙爬了上来——它记着你的脸（衔恨 ×${grudge}，更凶了）。`
    : `入夜了。「${scaled.name}」顺着阁墙爬了上来。`);
  if (state.playerHp <= 0) state.over = 'lose';
  return { ok: true, beast: scaled };
}

/**
 * 一夜结束后的结算。
 * 赢了：门面进账、日子 +1、换一张新迷宫。
 * 输了：这一局到此为止，交给 settleRun 收尾。
 */
async function endNight(state, won) {
  if (!won) {
    state.over = 'lose';
    state.phase = 'over';
    return { over: true, win: false };
  }
  state.beastSlain = true;      // 它死了——明晚才会换新的来
  state.beastGrudge = 0;        // 这笔仇没机会报了
  state.dark = false;
  const income = nightlyIncome(state, (state.spirits || []).length);
  if (income.coin > 0) pushNews(state, `门面净进 ${income.coin} 文。`);

  state.phase = 'maze';
  nextDay(state);
  // v4.5：地图不再每天推倒重来——天亮回到**昨天离开的那一格**接着走。
  // 记住的路、挖到一半的层都还在，于是"今天要不要再往下深挖一层"
  // 变成真的要掂量的决定（深处更肥，也更容易回不来）。
  state.beastId = state.beastId;  // 记住昨夜是谁，今夜尽量不重复
  state.guardianHp = 0;
  state.stance = null;
  state.frenzied = false;
  state.combo = 0;
  state.bossTurns = 0;
  state.nightBonus = null;
  // 天亮回一点气——v4.5 调低了：白天有时限、夜里要结账，
  // 恢复给太足就又变成"躺着也能过关"（真顶不住还有丹房/卧房两间房可盖）
  restore(state, { satiety: 16, sanity: 12 });
  spend(state, {});               // 同步一次 starve 判定
  startClock(state, 'day');       // 打赢了：天亮，一整个白天重新开始计时
  pushNews(state, `天亮了。这是你在万物阁的第 ${state.day} 天——回到旧宅，接着昨天的路走。`);
  return { over: false, win: true, income };
}

/* ══════════════════════════════════════════════════════════════
   一局结束
   ══════════════════════════════════════════════════════════════ */

/**
 * 收尾结算：把这一局的成绩编成一条记录，交给 quest.js 写进跨局存档。
 * 规则层只产数据，不碰文件。
 */
function runSummary(state) {
  return {
    at: new Date().toISOString(),
    cycle: Math.max(1, Number(state.cycle) || 1),
    days: state.day,
    depth: state.maze ? state.maze.depth : 1,
    rounds: (state.offerings || []).length,
    playerHp: state.playerHp,
    coin: state.coin,
    satiety: state.satiety,
    sanity: state.sanity,
    hall: hallLevel(state),
    hallTitle: hallTitle(state),
    spirits: (state.spirits || []).map((s) => ({ name: s.name, lv: s.lv, element: s.element })),
    equipment: (state.equipment || []).map((e) => ({ name: e.name, atk: e.atk, def: e.def, crit: e.crit })),
    stats: { atk: state.stats.atk, def: state.stats.def, crit: state.stats.crit },
    ending: state.over === 'win' ? 'hidden' : 'fall',
  };
}

/* ══════════════════════════════════════════════════════════════
   给模型读的一段局面
   ══════════════════════════════════════════════════════════════ */

function describeState(state) {
  const beast = beastFor(state);
  const left = turnsLeft(state);
  const frenzied = isFrenzy(state);
  const st = state.stance;
  const phaseWord = { maze: '正在迷宫里', hall: '正在阁中', night: '夜里守阁', over: '这一局结束了' };
  return [
    `第 ${state.day} 天，${phaseWord[state.phase] || state.phase}`,
    state.cycle > 1 ? `（第 ${state.cycle} 周目：妖物比上一周目更硬）` : '',
    beast ? `今夜来犯：${beast.name}（属性 ${beast.element}，体力 ${state.guardianHp}/${beast.hp}）` : '',
    beast && isEnragedSafe(state, beast) ? '它已经狂暴：带伤反噬，每一次反击都比平时狠一半。' : '',
    st ? `它当前架势：${st.name}——${st.hint}（用${st.breaks}属性的祭品或咒术打中它，伤害大增；别的属性会被挡掉一半。）` : '',
    frenzied
      ? '它已经狂怒：反击翻倍，旅人每回合还在额外流失体力。'
      : beast ? `还剩 ${left} 个回合就到它忍耐的极限。` : '',
    `旅人体力 ${state.playerHp}/${PLAYER_HP}`,
    state.combo > 1 ? `旅人正在连击：已连续克制 ${state.combo} 次。` : '',
    describeSurvival(state),
    describeIncense(state),
    describeHall(state),
    describeSpirits(state),
    describeDao(state),
    `已献祭 ${(state.offerings || []).length} 件`,
    (state.offerings || []).length
      ? `近期祭品：${state.offerings.slice(-5).map((o) => `${o.label}(${o.elementName} ${o.damage}dmg ${o.grade})`).join('、')}`
      : '（还没献上任何东西）',
    state.over ? `（本局结束：${state.over}）` : '',
  ].filter(Boolean).join('\n');
}

/** 小工具：避免 describeState 里 import 太多 */
function isEnragedSafe(state, beast) {
  return beast.hp > 0 && (state.guardianHp / beast.hp) < 0.35;
}

/* ══════════════════════════════════════════════════════════════
   给前端的一份渲染快照（不含函数、不含随机）
   ══════════════════════════════════════════════════════════════ */

/**
 * 道行快照。境界表本来就在 dao.js 里，前端不该再抄一份——
 * 抄了改平衡时会两边不一致，这种 bug 最难查（表现是 UI 显示的进度条和
 * 实际加成对不上）。所以这里把「当前境界 / 下一个境界 / 门槛」一并算出来。
 */
function daoSnapshot(state) {
  const d = state.dao || newDao();
  const realm = currentRealm(state);
  const next = REALMS[realm.id + 1] || null;
  return {
    xp: d.xp || 0,
    realm: d.realm || 0,
    fated: d.fated || null,
    insights: d.insights || [],
    realmName: realm.name,
    realmDesc: realm.desc,
    nextName: next ? next.name : null,
    nextThreshold: next ? next.threshold : null,
  };
}

/**
 * 脚下这一格还没处理完的"待办"。
 * 前端靠它重建场景——没有它，玩家一刷新页面就站在妖物房里看不见场景，
 * 却又被"没处理完不许走"扣着，直接卡死。
 */
function roomHere(state) {
  const m = state.maze;
  if (!m) return null;
  const r = here(m);
  if (!r) return null;
  const blocking = roomBlocks(r);
  // 顺序要紧：roomPrompt 会在补内容物（妖物的 hp、货单），
  // 必须先跑它，再读 r.foe / r.stock。反过来写，刷新进来的玩家
  // 拿到的永远是 foe:null —— 舞台上升不起对手立绘。
  const text = blocking ? roomPrompt(state, r) : [];
  return {
    x: r.x, y: r.y,
    type: r.type,
    solved: !!r.solved,
    blocking,
    needOffering: blocking && (r.type === 'item' || r.type === 'foe' || r.type === 'forge'),
    needChoice: blocking && ['shrine', 'mirror', 'guest', 'doctor', 'bard', 'hermit'].includes(r.type),
    choices: blocking && Array.isArray(r.choices) ? r.choices : null,
    stock: r.type === 'shop' ? (r.stock || null) : null,
    foe: r.foe || null,
    text,
  };
}

function runSnapshot(state) {
  const beast = beastFor(state);
  const mz = mazeSnapshot(state.maze);
  if (mz) mz.here = roomHere(state);
  return {
    /* 时间线 */
    day: state.day,
    phase: state.phase,
    over: state.over,
    dark: !!state.dark,
    /* 时辰：剩多少、走了多少、现在该是什么光景（前端照着画，不自己算） */
    clock: {
      kind: (state.clock || {}).kind || 'day',
      len: (state.clock || {}).len || lenOf((state.clock || {}).kind || 'day'),
      endAt: (state.clock || {}).endAt || 0,
      leftMs: clockLeft(state),
      ratio: clockRatio(state),
      look: lookOf(state),
      leftText: fmtClock(clockLeft(state)),
    },
    /* 生存 */
    satiety: state.satiety,
    sanity: state.sanity,
    playerHp: state.playerHp,
    /* 资源 */
    coin: state.coin,
    incense: Number(state.incense) || 0,
    incenseMax: incenseMax(state),
    /* 阁楼 */
    hall: {
      slots: { ...(state.hall && state.hall.slots ? state.hall.slots : {}) },
      level: hallLevel(state),
      title: hallTitle(state),
      used: { ...(state.hallUsed || {}) },
      /* 设施表带上"当前等级 / 下一级要多少钱 / 建完什么效果"，
         前端就不用把 cost 公式抄一遍——抄了迟早会跟规则层对不上 */
      facilities: FACILITIES.map((f) => {
        const lv = levelOf(state, f.id);
        const maxed = lv >= f.max;
        return {
          id: f.id, name: f.name, icon: f.icon,
          lv, max: f.max, maxed,
          cost: maxed ? null : f.cost(lv),
          desc: f.desc(lv),
        };
      }),
      kitchenHeal: kitchenHeal(state),
      bedchamberHeal: bedchamberHeal(state),
      studyTimes: studyTimes(state),
      incensePrice: incensePrice(state),
      incenseQuota: Math.max(0, buyQuota(state) - (Number((state.hallUsed || {}).incense) || 0)),
      incenseQuotaMax: buyQuota(state),
    },
    /* 迷宫（格子视图统一由 maze.js 出，前端不再自己判陷阱/迷雾） */
    maze: mz,
    /* 夜袭 */
    night: beast
      ? {
        id: beast.id, name: beast.name, element: beast.element,
        hp: state.guardianHp, maxHp: beast.hp,
        stance: state.stance, turnsLeft: turnsLeft(state), frenzy: isFrenzy(state),
      }
      : null,
    beastId: state.beastId,
    beastSlain: !!state.beastSlain,
    beastGrudge: Math.max(0, Number(state.beastGrudge) || 0),
    bossTurns: state.bossTurns,
    stance: state.stance,
    combo: state.combo,
    /* 旅人 */
    stats: state.stats,
    equipment: state.equipment,
    skills: state.skills,
    buffs: state.buffs,
    offerings: (state.offerings || []).slice(-40),
    dao: daoSnapshot(state),
    /* 柜台 */
    store: (state.store || []).map((it) => ({ ...it, price: sellPrice(it) })),
    storeCap: storeCap(state),
    spirits: state.spirits || [],
    spiritSlots: spiritSlots(state),
    nightBonus: state.nightBonus,
    /* 跨局 */
    cycle: state.cycle,
    relics: state.relics,
    news: (state.news || []).slice(-30),
    lastWin: state.lastWin || null,
  };
}

/* ══════════════════════════════════════════════════════════════
   精怪在夜战里的作用
   ──────────────────────────────────────────────────────────────
   精怪不是"多一个血条"，而是把你白天养的东西换成夜里的被动：
   灼烧、回气、缠住妖物、挡下第一击。全部走同一张 nightBonus 快照。
   ══════════════════════════════════════════════════════════════ */

/**
 * 精怪这一回合替你做的事（在玩家出手之后、妖物反击之前结算）。
 * 迅疾（haste）有概率追加一次——加在灼烧上，因为它本来就是"抢一下"。
 */
function spiritStrike(state) {
  const b = state.nightBonus || battleBonus(state.spirits, spiritMul(state));
  if (!b) return { burn: 0, heal: 0, vigor: 0 };
  let burn = b.burn || 0;
  let hasted = false;
  if (b.hastePct && Math.random() * 100 < b.hastePct) {
    hasted = true;
    burn += Math.max(2, Math.round(burn * 0.5));
  }
  if (burn > 0 && state.guardianHp > 0) {
    state.guardianHp = Math.max(0, state.guardianHp - burn);
  }
  let heal = b.heal || 0;
  if (heal > 0 && state.playerHp > 0) {
    state.playerHp = Math.min(PLAYER_HP, state.playerHp + heal);
  }
  if (b.vigor > 0) restore(state, { sanity: b.vigor });
  return { burn, heal, vigor: b.vigor || 0, hasted };
}

/** 精怪对妖物反击的削减（缠根 + 镇宅），反击最低也要留 2 点 */
function nightMitigation(state) {
  const b = state.nightBonus || {};
  return (b.bind || 0) + (b.ward || 0);
}

/**
 * 精怪护主：本夜的第一次受击额外免伤，用完即止。
 * @returns {number} 这一次实际减免掉的伤害
 */
function spiritShield(state, incoming) {
  const b = state.nightBonus || {};
  const total = b.shield || 0;
  if (!total || !state.nightUsed || state.nightUsed.shield) return 0;
  state.nightUsed.shield = true;
  return Math.min(total, Math.max(0, incoming - 1));
}

/** 观心：精怪看破妖物架势，本回合破防概率大增 */
function insightAid(state) {
  const b = state.nightBonus || {};
  if (!b.insightPct) return false;
  return Math.random() * 100 < b.insightPct;
}

module.exports = {
  newRun,
  ensureRun,
  nextDay,
  pushNews,
  payWalk,
  descend,
  returnToHall,
  step,
  leaveHall,
  doBuild,
  doSell,
  doMelt,
  doFeed,
  doRelease,
  doRest,
  beastFor,
  beginNight,
  endNight,
  // —— 时辰 ——
  tickClock, darkFalls, drainDark, nightFalls, dawnBreaks, kindFor,
  runSummary,
  describeState,
  runSnapshot,
  spiritStrike,
  nightMitigation,
  spiritShield,
  insightAid,
  // 转出去给上层用，免得它们各自 require 一堆子模块
  FACILITIES,
  levelOf,
  storeCap,
  spiritSlots,
  hallLevel,
  hallTitle,
  GUARDIANS,
  beastById,
};
