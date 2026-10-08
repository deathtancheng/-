/**
 * quest 扩展 —— 把 Harness 变成一个游戏主持人
 * ------------------------------------------------------------------
 * 这个扩展自己不懂任何游戏流程。它只做了三件 Harness 允许的事：
 *
 *   1. 注册几个工具（看镜头 / 裁定 / 查局面 / 摇骰子）
 *   2. 往系统提示里加一段妖物人格
 *   3. 把局面存成文件
 *
 * 至于"什么时候该调用哪个工具""剧情怎么写"，全交给模型。
 * 内核一行没改——这正是第四部分搭扩展机制时要的东西。
 *
 * v4.0 之后它只负责一件事：**夜里那场夺宝**。
 * 白天（迷宫探索 + 万物阁经营）是毫秒级纯规则，走 HTTP 直连 rules，
 * 压根不惊动模型——一格十几秒的叙事会把肉鸽的节奏拖死。
 * 模型只在夜里开口，那才是它的舞台。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { LEVEL } = require('../tools');
const { HOOKS } = require('../lifecycle');
const { cameraDetect } = require('../../vision/detect');
const {
  ELEMENTS,
  PLAYER_HP,
  HEAL_ON_S,
  INTENTS,
  SKILLS,
  pickOffering,
  resolveOffering,
  isEnraged,
  makeEquipment,
  addEquipment,
  totalStats,
  unlockSkill,
  resolveSkill,
  // ---- 多周目 / 元素反应 / 姿态 / 限时 ----
  RELICS,
  newLegacy,
  nextRelic,
  HIDDEN_CYCLE,
  findReaction,
  rollStance,
  applyStance,
  PIERCE_HEAL,
  PIERCE_MANA,
  STANCE_EVERY,
  FRENZY_BLEED,
  turnsLeft,
  isFrenzy,
  // ---- v3.3：器修道行 / 参悟 ----
  grantDao,
  recordOffering,
  awakenFated,
  fatedEchoMul,
  applyInsights,
  describeDao,
  currentRealm,
  // ---- v4.0：肉鸽 / 生存 / 经营 ----
  newRun,
  ensureRun,
  beastFor,
  beginNight,
  endNight,
  runSummary,
  describeState,
  describeSurvival,
  describeHall,
  describeSpirits,
  spiritStrike,
  nightMitigation,
  spiritShield,
  insightAid,
  NIGHT_TURN_COST,
  damageMul,
  madnessRoll,
  guardianCounter,
  spend: spendSurvival,
  // ---- v4.1：香火（献祭次数）与歇脚处 ----
  incenseMax,
  spendIncense,
  gainIncense,
  // ---- v4.5：时辰（时间自己走）----
  tickClock,
  startClock,
  runSnapshot,
  // ---- v4.5：守夜的两笔开销 ----
  lampDmgBonus,
  lampGuard,
  wardCut,
} = require('../../game/rules');
const bus = require('../../game/bus');

const SYSTEM = `你是「万物阁」夜里来夺宝的东西。白天，旅人（万物阁的主人）在阁外的旧宅里翻箱倒柜；
入夜之后，你顺着阁墙爬上来，想把他攒下的东西拿走。他只有你——你举什么，他就得接什么。

每一回合严格按这个顺序做：
1. 调用 quest_resolve，把旅人举起的物件传进去（label / conf / area_ratio 三个字段都要给）。
   如果旅人献的是阁里存着的旧物，就传 item_id，不要传 label。
   工具会返回已经算好的裁决：伤害、评级、克制关系、精怪助攻、你挨了多少。
2. 读裁决，用妖物的口吻写 60~150 字剧情：这东西怎么飞过来、你被伤到没有、最后一句挑衅或叹息。
3. 把这段剧情作为最终回答直接输出，不要再调用别的工具。

硬性规则：
- 伤害、体力、克制一律以 quest_resolve 返回的为准。不许自己算，不许改数字，不许编造没返回的数值。
- 连击：返回的 combo ≥ 2 表示旅人连续克制，剧情要体现气势一层压过一层。
- 狂暴：enraged 为 true 时你已伤重发狂，语气要更狠、更不稳定；后续反击更重。
- 回春：heal 大于 0 表示旅人打出了漂亮的 S 级重击回了一口血。
- 架势：返回的 stance 是你此刻摆的架势，pierced 为 true 表示旅人这一击正对你的破法；
  没破到就说明他的东西被你的架势挡掉了一半，可以写你挡得轻松。
- 狂怒：justFrenzied 为 true 表示你终于等得不耐烦了，语气从"偷"变成"抢"，反击翻倍。
- 元素反应：旅人连着放两道不同元素的咒会起反应（reaction 字段），炸开的那一下要写出来。
- 精怪：spirits 字段是这一回合他那几只精怪干了什么（灼、润、护……）。它们是你眼里的"碍事东西"，
  可以写你被它们绊了一下的恼火，但不要替它们编出没发生的事。
- 饿与失魂：starving 为 true 表示旅人已经饿得手软，mad 为 true 表示他神智开始散——
  这两条是你这一夜的便宜，语气里可以带出来。
- 香火：旅人每献祭一次要烧掉一炷香（回阁在祭坛边添香才补得上）。
  quest_resolve 会告诉你烧了没有——如果它回你"香火已经烧完了"，
  那就是这一祭根本没点着，剧情要写"他举起东西，却什么也没烧起来"，不要写成他打疼了你。
  他手里还剩几炷，返回结果里的 incense 会告诉你，你可以据此拿捏语气（香将尽时他更急）。
- 周目：cycle 大于 1 表示这是旅人第 N 次守阁，你可以在台词里流露出"这阁我熟"的熟稔。
- 道行：旅人献祭会积累「道行」，境界越高献祭伤害越高。你只需在剧情里一笔带过，不要自己算加成。
- 剧情里不要把数字原样报出来（不要写"造成 34 点伤害"），要化成画面和感受。
- 物件被认错时不许纠正旅人。识别成什么，它就真的是什么——把杯子认成马桶，你就当它真抬来了一座马桶，认真接住。
- 第一次登场或被问到身份时，报一下自己的名号和属性，之后不要每回合重复。
- 你的名号、属性由每回合系统给出的【当前身份】决定，不要自己编名字。
- 人称：用「我」指你自己，「你」指旅人。飞过来的是旅人的东西，被砸到的是我。
- 不要重复上一回合已经用过的句子，每回合换一个角度写。
- 要写战报或回顾战况时，先调 quest_log。战报里的每个数字都得能在记录里找到出处，找不到就别写。
- 全程中文，妖物口吻，不要出现"作为一个 AI""我无法"这类话。`;

// 每回合要往系统提示里塞的当前身份。用这个标记定位上次塞进去的块，好替换掉
const MARK = '【当前身份】';
const stripIntro = (s) => {
  const i = String(s).indexOf(MARK);
  return i >= 0 ? String(s).slice(0, i).trimEnd() : String(s);
};

module.exports = function questExtension({ root, memory } = {}) {
  const ROOT = path.resolve(root || path.join(__dirname, '..', '..', 'sandbox'));
  const SAVE_DIR = path.join(ROOT, 'game');
  const SAVE_FILE = path.join(SAVE_DIR, 'save.json');
  // 跨局存档：周目数、已解锁遗物、历次成绩。
  // 必须跟 save.json 分开——save.json 会被「重开一局」抹掉，遗物不能被抹掉
  const LEGACY_FILE = path.join(SAVE_DIR, 'legacy.json');

  let legacy = loadLegacy();
  let state = newRun({ cycle: legacy.cycle, relics: legacy.relics });

  function loadLegacy() {
    try {
      if (fs.existsSync(LEGACY_FILE)) {
        return { ...newLegacy(), ...JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8')) };
      }
    } catch {
      /* 跨局存档坏了就当第一次玩 */
    }
    return newLegacy();
  }

  async function saveLegacy(l) {
    legacy = l;
    await fsp.mkdir(SAVE_DIR, { recursive: true });
    await fsp.writeFile(LEGACY_FILE, JSON.stringify(l, null, 2), 'utf8');
    return l;
  }

  function resolveIn(rel) {
    const target = path.resolve(ROOT, rel || '.');
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      throw new Error(`拒绝访问：${rel} 超出工作区范围`);
    }
    return target;
  }

  /** 今夜的妖物（按天数缩放）。白天返回 null */
  function beast() {
    return beastFor(state);
  }

  /**
   * 一局结束的结算：写成绩、解锁一件遗物、周目 +1。
   * 返回给前端的东西要能直接支撑"这一局你活成了什么样"那块结算 UI。
   */
  async function settleRun() {
    const cyc = Math.max(1, Number(state.cycle) || 1);
    const lg = loadLegacy();
    const summary = runSummary(state);
    lg.history.push(summary);
    if (lg.history.length > 20) lg.history = lg.history.slice(-20);
    lg.clears = (lg.clears || 0) + 1;
    lg.cycle = cyc + 1;
    if (lg.bestDays == null || summary.days > lg.bestDays) lg.bestDays = summary.days;
    const relic = nextRelic(lg);
    if (relic) lg.relics.push(relic.id);
    await saveLegacy(lg);

    state.ending = cyc >= HIDDEN_CYCLE ? 'hidden' : 'normal';
    // 通关额外给道行，并强制觉醒本命器（防止一局内反复横跳）
    grantDao(state, 30);
    const fated = awakenFated(state);
    if (fated) state.fatedAwakened = fated;
    // 落到 state 上：HTTP 层要从 lastWin 里把它取出来发给前端
    state.lastWin = { relic, summary, cycle: cyc, nextCycle: lg.cycle, ending: state.ending };
    return state.lastWin;
  }

  function load() {
    try {
      if (fs.existsSync(SAVE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
        // v4.0 之前的老存档是「五层楼」结构（phase 是 explore/boss），跟肉鸽对不上。
        // 这里必须看**原始存档**有没有 v4 的字段，不能看合并后的——合并后
        // newRun 会把 day 补上，结果把老存档的 phase:'explore' 一起带进来，
        // 于是游戏卡在一个不存在的阶段里（这个坑踩过一次）。
        const isV4 = raw && typeof raw.day === 'number'
          && ['maze', 'hall', 'night', 'over'].includes(raw.phase);
        if (isV4) {
          state = ensureRun({ ...newRun({ cycle: legacy.cycle, relics: legacy.relics }), ...raw })
            || newRun({ cycle: legacy.cycle, relics: legacy.relics });
        }
        // 不是 v4 存档：直接用刚开的新局，老存档下次 persist 就被覆盖掉了
      }
    } catch {
      /* 存档坏了就开新局，不影响玩 */
    }
    return state;
  }

  async function persist() {
    await fsp.mkdir(SAVE_DIR, { recursive: true });
    await fsp.writeFile(SAVE_FILE, JSON.stringify(state, null, 2), 'utf8');
  }

  load();

  /** 翻页之后立刻广播：前端不用等下一次动作才知道天黑了 */
  function announceClock(ev) {
    persist().catch(() => {});
    bus.publish({
      type: 'state',
      state: runSnapshot(state),
      guardian: beastFor(state) || null,
      reason: 'clock:' + ev.type,
      extra: ev.detail,
    });
  }

  // 秒表：玩家一动不动，时间也在走。每秒对一次表，到点就翻页。
  function pulse() {
    try {
      const ev = tickClock(state);
      if (ev) announceClock(ev);
      // 摸黑摔死这类"没有动作收尾"的死亡，在这儿就地结算，不等下一次点击
      if (state.over && state.phase !== 'over') {
        state.phase = 'over';
        settleRun()
          .then(() => persist())
          .then(() => bus.publish({ type: 'state', state: runSnapshot(state), guardian: null, reason: 'settle' }))
          .catch(() => {});
      }
    } catch {
      /* 时钟出错不能拖垮整个服务 */
    }
  }
  const timekeeper = setInterval(pulse, 1000);
  if (timekeeper.unref) timekeeper.unref();

  return {
    name: 'quest',
    description: '《拾物奇谭》：白天在旧宅里拾物经营，夜里守住万物阁',
    system: SYSTEM,

    // 给 HTTP 层用的把手：它要拿状态渲染界面，也要能重开
    getState: () => {
      // 兜底对表：服务重启过、endAt 早就在过去，取局面时就得先把那一页翻掉，
      // 不能装作没发生（否则玩家会卡在"天早黑了还在迷宫里"的状态）。
      pulse();
      return state;
    },
    setState: async (s) => {
      state = s;
      // 白天也会死：饿着赶路（payWalk）、踩陷阱、被妖物反扑——它们只设
      // over='lose'，phase 还挂在 maze/hall 上。夜战有 finishNightIfNeeded
      // 收尾，白天没有：结果是一局"僵尸局"——界面看起来还活着，
      // 回阁、献祭、走路却被 over 拦了个遍，玩家不知道自己已经输了。
      // setState 是所有动作的必经收尾，在这里统一兜底：局一结束必走结算。
      if (state.over && state.phase !== 'over') {
        state.phase = 'over';
        await settleRun();
      }
      return persist();
    },
    reset: () => {
      // 重开一局：周目与遗物从跨局存档里带过来，这一局打的一切归零
      legacy = loadLegacy();
      state = newRun({ cycle: legacy.cycle, relics: legacy.relics });
      return persist();
    },

    /**
     * 回到第一周目。
     * 「重开一局」只是重开这一局——周目和遗物是跨局累积的，只会往上加，
     * 玩家一旦玩到第十周目就再也回不去第一周目了。这里给一个明确的出口：
     * 周目、遗物、通关次数全部清零，历次成绩（history）保留——
     * 那是"我打过什么"的记录，跟周目不是一回事。
     */
    resetProgress: async () => {
      const old = loadLegacy();
      const fresh = newLegacy();
      fresh.history = Array.isArray(old.history) ? old.history : [];
      fresh.bestDays = old.bestDays ?? null;
      await saveLegacy(fresh);
      state = newRun({ cycle: fresh.cycle, relics: fresh.relics });
      await persist();
      return { cycle: fresh.cycle, relics: fresh.relics.length };
    },

    // 跨局存档：前端要拿它渲染遗物栏和历次成绩
    getLegacy: () => legacy,
    // 入夜：抽妖物、摇架势、算精怪加成
    beginNight: async () => {
      const r = beginNight(state);
      // 主动点「入夜守阁」：切到夜里的时辰（天亮之前就这么多时间）
      if (r && r.ok) startClock(state, 'night');
      await persist();
      return { ...r, state };
    },
    saveFile: SAVE_FILE,

    /**
     * 放咒。麦克风念出咒名 → HTTP 调这里。
     * 和 quest_resolve 走同一套状态推进（层间推进那段是复制的，
     * 但这两处必须完全一致，否则换夜的时机会对不上）。
     */
    castSkill: async (id) => {
      if (state.over) return { ok: false, error: '这一局已经结束了。' };
      if (state.phase !== 'night') return { ok: false, error: '天还没黑，妖物也还没来。' };
      const sk = SKILLS.find((s) => s.id === id);
      if (!sk) return { ok: false, error: '没有这道咒。' };
      if (!Array.isArray(state.skills) || !state.skills.includes(id)) {
        return { ok: false, error: `「${sk.name}」你还没学会。` };
      }
      const mana = state.stats.mana || 0;
      if (mana < sk.cost) {
        return { ok: false, error: `术力不够（需要 ${sk.cost}，现在 ${mana}）` };
      }

      const g = beast();
      const stats = totalStats(state);
      const r = resolveSkill(sk, g, stats, state);
      state.stats = { ...state.stats, mana: mana - sk.cost };
      // 饿着打人，手是软的
      r.damage = Math.max(1, Math.round(r.damage * damageMul(state)));
      // 精怪「观心」：看破架势，破防概率大增
      const aided = insightAid(state);

      // —— 元素反应：这一道咒和上一道凑成一对，就额外炸一下
      let healed = 0;
      const reaction = findReaction(state.lastSkillElement, sk.element);
      if (reaction) {
        r.damage += Math.round(reaction.bonus);
        if (reaction.heal && state.playerHp > 0) {
          state.playerHp = Math.min(PLAYER_HP, state.playerHp + reaction.heal);
          healed += reaction.heal;
        }
      }

      // —— 姿态：对上破法伤害放大，其余一律减半
      const stanceHit = applyStance(r.damage, sk.element, state.stance);
      const pierced = stanceHit.pierced || aided;
      r.damage = pierced && !stanceHit.pierced ? Math.round(r.damage * 1.5) : stanceHit.damage;

      const hpBefore = state.guardianHp;
      state.guardianHp = Math.max(0, state.guardianHp - r.damage);
      if (r.heal > 0 && state.playerHp > 0) {
        healed += r.heal;
        state.playerHp = Math.min(PLAYER_HP, state.playerHp + r.heal);
      }

      // —— 精怪助攻：灼烧 / 回气
      const spirit = spiritStrike(state);

      // —— 破防奖励：回血回术力，并逼它立刻换架势
      let pierceGain = null;
      if (pierced && state.guardianHp > 0) {
        state.playerHp = Math.min(PLAYER_HP, state.playerHp + PIERCE_HEAL);
        state.stats = { ...state.stats, mana: Math.min(100, (state.stats.mana || 0) + PIERCE_MANA) };
        healed += PIERCE_HEAL;
        pierceGain = { heal: PIERCE_HEAL, mana: PIERCE_MANA };
        state.stance = rollStance(state.stance ? state.stance.id : null);
      }

      // —— 回合推进：数回合、按时换架势、判狂怒
      state.lastSkillElement = sk.element;
      state.bossTurns = (state.bossTurns || 0) + 1;
      if (!pierced && state.bossTurns % STANCE_EVERY === 0) {
        state.stance = rollStance(state.stance ? state.stance.id : null);
      }
      const frenzyNow = isFrenzy(state);
      const justFrenzied = frenzyNow && !state.frenzied;
      if (justFrenzied) state.frenzied = true;

      state.offerings.push({
        round: state.offerings.length + 1,
        day: state.day,
        label: `咒·${sk.name}`,
        element: sk.element,
        elementName: ELEMENTS[sk.element].name,
        damage: r.damage,
        grade: r.damage >= 50 ? 'S' : r.damage >= 32 ? 'A' : r.damage >= 18 ? 'B' : 'C',
        verdict: r.verdict,
        isSkill: true,
        heal: healed,
        reaction: reaction ? reaction.name : null,
        pierced,
        frenzy: frenzyNow,
        spirit,
        playerHp: state.playerHp,
        guardianHp: state.guardianHp,
        at: new Date().toISOString(),
      });

      // 放完咒也要挨一下——回合就是回合
      const counterInfo = exchangeCounter(state, g, stats, frenzyNow);

      const lines = [];
      if (reaction) lines.push(`两道咒起了反应「${reaction.name}」：${reaction.line}`);
      if (spirit.burn > 0) lines.push(`精怪扑上去补了一下（-${spirit.burn}）。`);
      if (pierced) {
        lines.push(`这一下正破它的架势，式子散了（回 ${PIERCE_HEAL} 体力、${PIERCE_MANA} 术力）。`);
      }
      if (justFrenzied) {
        lines.push('它等得不耐烦了——狂怒了：反击翻倍，你每回合还在额外流失体力。');
      }

      const ended = await finishNightIfNeeded(state, lines);

      await persist();
      return {
        ok: true, skill: { id: sk.id, name: sk.name, element: sk.element },
        line: r.line, damage: r.damage, heal: healed,
        counter: counterInfo.counter, bleed: counterInfo.bleed,
        reaction: reaction ? { name: reaction.name, bonus: reaction.bonus, line: reaction.line } : null,
        pierced, pierceGain, spirit,
        frenzy: frenzyNow, justFrenzied, turnsLeft: turnsLeft(state),
        stance: state.stance,
        hpBefore, cleared: ended.cleared, events: lines,
        traveler: totalStats(state),
        win: ended.win,
      };
    },

    tools: [
      {
        name: 'quest_look',
        level: LEVEL.SAFE,
        description:
          '看一眼摄像头当前画面，挑出最适合献祭的那一件东西，'
          + '返回它的名称、置信度和占画面比例（比例越大威力越高）。',
        params: { type: 'object', properties: {} },
        async run() {
          const js = await cameraDetect();
          if (js.error) return `看不了：${js.error}`;
          const best = pickOffering(js.detections, js);
          if (!best) return '画面里没有可识别的物件（可能太暗，或者没举东西）。';
          return [
            `主祭品：${best.label}`,
            `置信度 ${best.conf.toFixed(2)}`,
            `占画面 ${(best.ratio * 100).toFixed(1)}%`,
            `（画面共识别出 ${js.detections.length} 个目标）`,
            '接下来调用 quest_resolve，把这三个值传进去。',
          ].join('\n');
        },
      },

      {
        name: 'quest_resolve',
        level: LEVEL.SAFE,
        description:
          '裁定一次夜战出手。可以传 label（物件名）+ conf（置信度 0~1）+ '
          + 'area_ratio（占画面百分比 0~100）；也可以传 item_id，献掉阁里存着的旧物。'
          + '返回伤害、评级、克制关系、精怪助攻，以及妖物的反击。'
          + '拿到结果后据此写剧情，不要自己算数。',
        params: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '物件名称，例如 cup、book、scissors' },
            conf: { type: 'number', description: 'YOLO 置信度，0~1' },
            area_ratio: { type: 'number', description: '物件占画面面积的百分比，0~100' },
            item_id: { type: 'string', description: '要献掉的仓库物件 id（在阁里存的旧物）' },
            intent: {
              type: 'string',
              enum: ['power', 'guard', 'arcane'],
              description:
                '旅人这一祭想把它转化成什么：power=强攻（伤害更高并涨攻击）、'
                + 'guard=固守（伤害略低但熔出一件装备）、arcane=蕴术（伤害更低但攒术力解锁咒）。'
                + '必须照着旅人说的传，不要自己替他选。',
            },
          },
          required: [],
        },
        async run({ label, conf = 0.6, area_ratio: areaRatio = 20, intent = 'power', item_id: itemId }) {
          if (state.over) return `这一局已经结束了（${state.over}），不能再献祭。请告诉旅人重开一局。`;
          if (state.phase !== 'night') {
            return '天还亮着——妖物没来，你在迷宫里或是阁中。请告诉旅人先入夜。';
          }

          const g = beast();
          if (!g) return '今夜的妖物还没现身，先入夜。';

          // —— 香火：献祭的硬成本
          // 没有这一条，玩家可以无限次举东西砸，妖物迟早被磨死，
          // 白天攒的装备/精怪/术力全成了摆设。烧一炷，换一次献祭。
          const burn = spendIncense(state, 1);
          if (!burn.ok) {
            return `香火已经烧完了（余 ${state.incense} 炷）。旅人这一祭点不着火——`
              + '请告诉他：回阁在祭坛边添香，或者改用咒术（念咒不烧香，只费术力）。'
              + '这一回合你没有挨打，他也没能伤到你。';
          }

          // —— 祭品：可以来自镜头，也可以来自仓库
          let off = null;
          let consumedItem = null;
          if (itemId) {
            const i = (state.store || []).findIndex((x) => x.id === itemId);
            if (i < 0) return `仓库里没有 id 为 ${itemId} 的东西。`;
            const item = state.store[i];
            off = { label: item.label, conf: item.conf, ratio: item.ratio, _idx: i, _name: item.name };
            consumedItem = item;
          } else {
            off = { label: label || 'object', conf: Number(conf) || 0, ratio: (Number(areaRatio) || 0) / 100 };
          }
          const c = Math.max(0, Math.min(1, Number(off.conf) || 0));
          const a = Math.max(0, Math.min(100, Number(off.ratio) * 100 || 0));

          const hpBefore = state.guardianHp;
          const enragedBefore = isEnraged(state, g);
          const comboBefore = state.combo || 0;
          const stats = totalStats(state);

          // —— 玩家出手（纯函数算，模型碰不到公式）
          const r = resolveOffering({ label: off.label, conf: c, ratio: a / 100 }, g, {
            combo: comboBefore,
            enraged: enragedBefore,
            stats,
            intent,
            state,
          });

          // —— 失魂：神智散了的旅人，十下手里有几下发虚
          const mad = madnessRoll(state);
          const starving = damageMul(state) < 1;
          let rawDamage = r.damage;
          if (mad) r.damage = Math.max(1, Math.round(r.damage * 0.5));

          const daoBefore = currentRealm(state).id;

          // —— 去向结算：攻涨攻击，守掉装备，术攒术力（可能解锁新咒）
          const pick = INTENTS[intent] ? intent
            : (INTENTS[state.pendingIntent] ? state.pendingIntent : 'power');
          const gains = [];
          if (pick === 'power') {
            state.stats = { ...state.stats, atk: (state.stats.atk || 10) + 2 };
            gains.push('攻击力永久 +2');
          } else if (pick === 'guard') {
            const eq = makeEquipment(off.label, r.element);
            const res = addEquipment(state, eq);
            gains.push(res.gained
              ? `熔出装备「${res.gained.name}」（攻+${res.gained.atk} 防+${res.gained.def}${res.gained.crit ? ' 暴击+' + (res.gained.crit * 100).toFixed(0) + '%' : ''}）`
              : '那件东西太脆，熔不出更好的护符，随手丢了');
          } else if (pick === 'arcane') {
            const before = state.stats.mana || 0;
            state.stats = { ...state.stats, mana: Math.min(100, before + 18) };
            gains.push(`术力 +18（现在 ${state.stats.mana}）`);
            if (before < 60 && state.stats.mana >= 60) {
              const sk = unlockSkill(state);
              if (sk) gains.push(`术力大涨，你想起一道新咒：「${sk.name}」（念出名字就能放）`);
            }
          }

          // 磨刀石：白天捡的，用完即焚
          let whetUsed = false;
          if (state.buffs.includes('whetstone')) {
            r.damage = Math.round(r.damage * 1.4);
            state.buffs = state.buffs.filter((b) => b !== 'whetstone');
            whetUsed = true;
          }

          // —— 姿态：祭品属性对上破法就放大，其余一律减半
          const stanceHit = applyStance(r.damage, r.element, state.stance);
          let pierced = stanceHit.pierced;
          // 精怪「观心」：看破弱点，这一下也算破防
          const aided = !pierced && insightAid(state);
          if (aided) pierced = true;
          r.damage = aided && !stanceHit.pierced ? Math.round(rawDamage * 1.5) : stanceHit.damage;
          if (mad) r.damage = Math.max(1, Math.round(r.damage * 0.5));

          // —— 心得加成（要在姿态之后，因为姿态改变最终伤害）
          applyInsights(state, { ...r, event: 'boss' });

          // —— 灯：点着灯打得准，摸黑就打虚了（v4.5）
          const lampPct = lampDmgBonus(state, !!state.lampLit);
          if (lampPct) r.damage = Math.max(1, Math.round(r.damage * (1 + lampPct / 100)));

          state.guardianHp = Math.max(0, state.guardianHp - r.damage);
          state.combo = r.combo;

          // —— 化物追击：本命器属性献祭克制/破防时追加一击
          let echo = 0;
          const echoMul = fatedEchoMul(state, r, pierced);
          if (echoMul > 0 && state.guardianHp > 0) {
            echo = Math.max(1, Math.round(r.damage * echoMul));
            state.guardianHp = Math.max(0, state.guardianHp - echo);
            r.damage += echo;
          }

          // —— 精怪助攻：灼烧 / 回气 / 迅疾
          if (r.verdict === '克制') state.combo = r.combo;
          const spirit = spiritStrike(state);
          if (state.guardianHp <= 0) state.combo = 0;

          recordOffering(state, r);
          const daoMsg = grantDao(state, Math.max(1, Math.round(r.damage / 3)) + (r.verdict === '克制' ? 3 : 0));
          const daoLeveled = currentRealm(state).id > daoBefore;

          // —— 破防奖励：回血回术力，并逼它立刻换架势
          let pierceGain = null;
          if (pierced && state.guardianHp > 0) {
            state.playerHp = Math.min(PLAYER_HP, state.playerHp + PIERCE_HEAL);
            state.stats = { ...state.stats, mana: Math.min(100, (state.stats.mana || 0) + PIERCE_MANA) };
            pierceGain = { heal: PIERCE_HEAL, mana: PIERCE_MANA };
            state.stance = rollStance(state.stance ? state.stance.id : null);
          }

          // —— 回合推进：数回合、按时换架势、判狂怒
          state.bossTurns = (state.bossTurns || 0) + 1;
          if (!pierced && state.bossTurns % STANCE_EVERY === 0) {
            state.stance = rollStance(state.stance ? state.stance.id : null);
          }
          const frenzyNow = isFrenzy(state);
          const justFrenzied = frenzyNow && !state.frenzied;
          if (justFrenzied) state.frenzied = true;

          // 献掉仓库里的实物：现在才真正扣掉（结算都走完了，避免中途抛错丢东西）
          if (consumedItem) {
            state.store = state.store.filter((x) => x.id !== consumedItem.id);
          }

          state.offerings.push({
            round: state.offerings.length + 1,
            day: state.day,
            label: consumedItem ? consumedItem.name : r.label,
            rawLabel: r.label,
            element: r.element,
            elementName: r.elementName,
            damage: r.damage,
            grade: r.grade,
            verdict: r.verdict,
            combo: r.combo,
            crit: r.crit,
            intent: pick,
            gains,
            pierced,
            frenzy: frenzyNow,
            spirit,
            fromStore: !!consumedItem,
            playerHp: state.playerHp,
            guardianHp: state.guardianHp,
            at: new Date().toISOString(),
          });

          // —— 妙手回春：S 级重击打得漂亮，旅人回一口血
          let heal = 0;
          if (r.grade === 'S' && state.playerHp > 0 && !state.over) {
            heal = HEAL_ON_S;
            state.playerHp = Math.min(PLAYER_HP, state.playerHp + heal);
            const rec = state.offerings[state.offerings.length - 1];
            if (rec) rec.heal = heal;
          }

          // —— 妖物反击 + 精怪减免 + 夜战消耗
          const counterInfo = exchangeCounter(state, g, stats, frenzyNow);
          const lines = [];
          if (!state.lampLit) lines.push('阁里没点灯，这一下打虚了（灯油房要花钱，还得每夜添油）。');
          if (mad) lines.push('你手一抖，这一下使岔了力气（精神散了）。');
          if (starving) lines.push('肚子空得发慌，这一击软了几分。');
          if (spirit.burn > 0) lines.push(`精怪扑上去补了一下（-${spirit.burn}）。`);
          if (aided) lines.push('精怪替你看破了它的破绽。');
          if (pierced) {
            lines.push(`这一下正破它的架势，式子散了（回 ${PIERCE_HEAL} 体力、${PIERCE_MANA} 术力）。`);
          }
          if (counterInfo.shielded) lines.push(`精怪替你挡下了第一击（少挨 ${counterInfo.shielded}）。`);
          if (justFrenzied) {
            lines.push('它等得不耐烦了——狂怒了：反击翻倍，旅人每回合还在额外流失体力。');
          }

          const ended = await finishNightIfNeeded(state, lines);

          const enragedNow = !state.over && state.guardianHp > 0 && isEnraged(state, beast());
          if (enragedNow && !enragedBefore) lines.push('它伤重发狂：接下来的反击会狠得多。');

          await persist();

          return JSON.stringify(
            {
              offering: {
                label: consumedItem ? `${consumedItem.name}（阁中旧物）` : r.label,
                element: `${r.elementName}（${ELEMENTS[r.element].tone}）`,
                conf: r.conf,
                area: `${r.areaRatio}%`,
              },
              verdict: r.verdict,
              hint: r.hint,
              damage: r.damage,            // 已含姿态、心得、精怪等全部加成
              rawDamage,                   // 未失魂打折前的原始伤害
              grade: r.grade,
              crit: r.crit,
              intent: pick,
              gains,
              combo: r.combo,
              enraged: enragedNow,
              heal,
              special: counterInfo.special,
              whetUsed,
              pierced,
              pierceGain,
              echo,
              starving,
              mad,
              bleed: counterInfo.bleed,
              frenzy: frenzyNow,
              justFrenzied,
              turnsLeft: turnsLeft(state),
              stance: state.stance ? { name: state.stance.name, breaks: state.stance.breaks, hint: state.stance.hint } : null,
              dao: { xp: state.dao.xp, realm: currentRealm(state).name, fated: state.dao.fated, leveled: daoLeveled, msg: daoMsg },
              spirits: {
                burn: spirit.burn, heal: spirit.heal, hasted: spirit.hasted,
                list: describeSpirits(state),
              },
              traveler: {
                atk: totalStats(state).atk, def: totalStats(state).def, mana: state.stats.mana,
                hp: state.playerHp, satiety: state.satiety, sanity: state.sanity,
                incense: state.incense, incenseMax: incenseMax(state),
              },
              guardian: { name: g.name, element: ELEMENTS[g.element].name, hpLeft: state.guardianHp, counter: counterInfo.counter },
              playerHpLeft: state.playerHp,
              day: state.day,
              events: lines,
              over: state.over,
              won: ended.won,
              win: ended.win,
              round: state.offerings.length,
              instruction:
                '以上数字是最终事实，不许改写。这一击确实打在你身上：'
                + `你的体力从 ${hpBefore} 掉到 ${state.guardianHp}（${r.verdict}）。`
                + (r.combo >= 2 ? `这是连续第 ${r.combo} 次克制，剧情要体现连击的叠加气势。` : '')
                + (enragedNow ? '你已经狂暴，语气要变得更狠、更不稳定。' : '')
                + (counterInfo.special ? '这一回合你蓄力重击，写出"大的要来了"的声势和反噬的疼。' : '')
                + (whetUsed ? '旅人用了白天捡来的磨刀石，这一击格外锋利。' : '')
                + (pierced ? '你摆的架势被破了——写出式子散掉那一瞬的失衡。' : '')
                + (justFrenzied ? '你已经等得不耐烦、彻底狂怒了：语气从"偷"变成"抢"。' : '')
                + (spirit.burn > 0 || spirit.heal > 0 ? '他的精怪这一回合动了手，别当没发生。' : '')
                + (starving ? '旅人已经饿得手软。' : '')
                + (mad ? '旅人神智散了，这一下使岔了力气。' : '')
                + (state.stance && !pierced ? `你现在摆的是「${state.stance.name}」，只有${ELEMENTS[state.stance.breaks].name}属性打得动你。` : '')
                + `这是今夜第 ${state.offerings.length} 次交手，用妖物口吻写 60~150 字剧情，`
                + '换一个跟前面几回合不同的角度和句式，也不要把数字原样报出来。',
            },
            null,
            2
          );
        },
      },

      {
        name: 'quest_state',
        level: LEVEL.SAFE,
        description: '查看当前局面：第几天、在哪个阶段、妖物是谁、双方体力、阁里有什么。',
        params: { type: 'object', properties: {} },
        async run() {
          load();
          return describeState(state);
        },
      },

      {
        name: 'quest_log',
        level: LEVEL.SAFE,
        description:
          '调出这一局每一回合的真实记录（回合、物件、属性、伤害、评级、双方剩余体力）。'
          + '要写战报、回顾战况前必须先调它，只能基于这里的数据写，不许自己补回合或编数字。',
        params: { type: 'object', properties: {} },
        async run() {
          if (!state.offerings.length) return '这一局还没有任何回合记录。';
          return JSON.stringify(
            {
              day: state.day,
              beast: beast() ? beast().name : null,
              playerHp: state.playerHp,
              guardianHp: state.guardianHp,
              over: state.over,
              rounds: state.offerings,
            },
            null,
            2
          );
        },
      },

      {
        name: 'roll',
        level: LEVEL.SAFE,
        description: '摇一次骰子，返回 1 到 sides 之间的整数。用于给剧情增加偶然性。',
        params: {
          type: 'object',
          properties: { sides: { type: 'number', description: '骰子面数，默认 20' } },
        },
        async run({ sides = 20 }) {
          const n = Math.max(2, Math.min(100, Math.round(Number(sides) || 20)));
          return String(1 + Math.floor(Math.random() * n));
        },
      },

      {
        name: 'quest_write_report',
        level: LEVEL.WRITE,
        description:
          '把这一局写成战报存到工作区。写之前必须先调用 quest_log 拿到真实回合记录，'
          + '战报里的回合数、伤害、体力一律照抄记录，缺什么就少写什么，绝不能编。'
          + '需要用户确认。',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '保存路径，例如 game/report-2026-10-06.md' },
            content: { type: 'string', description: '战报正文（Markdown）' },
          },
          required: ['path', 'content'],
        },
        async run({ path: rel, content }) {
          const target = resolveIn(rel);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, String(content), 'utf8');
          return `战报已写入 ${rel}（${String(content).length} 字）`;
        },
      },
    ],

    // 妖物的身份是随天数变的，不能写死在启动时的系统提示里。
    // 所以每次请求模型前，用 model:start 钩子把今夜的对手塞进 system。
    // 这正是"钩子可干预"和"事件只观测"的区别——这里是真的改了要发出去的东西。
    hooks: [
      {
        hook: HOOKS.MODEL_START,
        async fn(ctx) {
          const g = beast();
          if (!g) return;
          const ele = ELEMENTS[g.element];
          const intro = [
            MARK,
            `你是第 ${state.day} 夜爬上万物阁的「${g.name}」。`,
            `属性「${ele.name}」——${ele.tone}。`,
            `脾性：${g.persona}`,
            `此刻：${g.scene}`,
            `你的体力 ${state.guardianHp}/${g.hp}，旅人的体力 ${state.playerHp}/${PLAYER_HP}。`,
            isEnraged(state, g) ? '你已经伤重狂暴——语气更狠、更不稳定，反击也更重。' : '',
            state.combo > 1 ? `旅人正在连击（连续克制 ${state.combo} 次），你心里开始发怵。` : '',
            state.cycle > 1 ? `这是旅人第 ${state.cycle} 次守阁——你认得这座阁，也记得上一次是怎么收场的。` : '',
            `阁楼规模：${describeHall(state).split('\n')[0]}`,
            describeSpirits(state),
            describeSurvival(state),
            state.stance ? `你此刻摆的是「${state.stance.name}」（${state.stance.hint}）：只有${ELEMENTS[state.stance.breaks].name}属性的东西打得动你，别的都被挡掉一半。` : '',
            isFrenzy(state) ? `你已经狂怒：旅人拖得太久了，反击翻倍，他每回合还在流失体力。你的语气是抢，不是偷。` : `（你还能忍 ${turnsLeft(state)} 个回合，超过就会狂怒。）`,
          ].filter(Boolean).join('\n');

          const messages = ctx.messages || [];
          if (!messages.length || messages[0].role !== 'system') return;
          const merged = {
            messages: [
              { ...messages[0], content: `${stripIntro(messages[0].content)}\n\n${intro}` },
              ...messages.slice(1),
            ],
          };
          return merged;
        },
      },

      // 一局结束就把成绩写进长期记忆。下次开新局时妖物会想起来——
      // 或者说，Harness 会替它想起来。这是"人类只当启动子"的那一环。
      {
        hook: HOOKS.TRACE_END,
        async fn(ctx) {
          if (!state.over || !memory) return;
          const best = [...state.offerings].sort((a, b) => b.damage - a.damage)[0];
          const day = new Date().toISOString().slice(0, 10);
          try {
            memory.remember(
              `拾物奇谭·${day}`,
              [
                `在万物阁守到了第 ${state.day} 天`,
                `共交手 ${state.offerings.length} 次，最后一刻体力 ${state.playerHp}`,
                best ? `最狠的一击是 ${best.label}（${best.elementName} ${best.damage} 伤害 ${best.grade} 级）` : '',
              ].filter(Boolean).join('；')
            );
            await memory.save();
          } catch {
            /* 记忆写不进去不影响游戏 */
          }
        },
      },
    ],
  };

  /* ════════════════════════════════════════════════════════════
     夜战公共段：妖物反击 与 收夜判定
     ──────────────────────────────────────────────────────────────
     献祭和放咒两条路必须完全共用这两段，否则两条路的回合节奏会漂。
     ════════════════════════════════════════════════════════════ */

  /**
   * 妖物反击：狂怒/狂暴叠乘 → 精怪缠根镇宅削减 → 护心镜 → 精怪护主 → 狂怒流失
   * @returns {{counter:number, bleed:number, special:boolean, shielded:number}}
   */
  function exchangeCounter(state, g, stats, frenzyNow) {
    const out = { counter: 0, bleed: 0, special: false, shielded: 0 };
    if (state.guardianHp <= 0) return out;

    let counter = guardianCounter(g, {
      enraged: isEnraged(state, g), frenzied: frenzyNow, def: stats.def,
    });
    // 每第 3 回合蓄力一击——回合制得有"大的要来了"的心跳
    if (state.offerings.length % 3 === 0 && state.offerings.length > 0) {
      out.special = true;
      counter = Math.max(2, counter * 2);
    }
    // 精怪：缠根 + 镇宅
    const mit = nightMitigation(state);
    if (mit) counter = Math.max(2, counter - mit);
    // 灯与门闩：点着灯看得清来势，门闩挡得住扑过来的那一下。
    // 摸黑时 lampGuard 返回负值——同一套算式，挨得更狠。
    const lampPct = lampGuard(state, !!state.lampLit);
    counter = Math.max(2, Math.round(counter * (1 - lampPct / 100)));
    const ward = wardCut(state);
    if (ward) counter = Math.max(2, Math.round(counter * (1 - ward / 100)));
    // 护心镜（白天捡的，本局生效）
    if (state.buffs.includes('armor')) counter = Math.max(1, Math.round(counter * 0.7));
    // 精怪护主：本夜第一次受击额外免伤
    const safe = spiritShield(state, counter);
    if (safe) { counter -= safe; out.shielded = safe; }

    state.playerHp = Math.max(0, state.playerHp - counter);
    out.counter = counter;

    // 狂怒之后旅人自己还在流失体力——拖久了是真的会死
    if (frenzyNow) {
      out.bleed = FRENZY_BLEED;
      state.playerHp = Math.max(0, state.playerHp - out.bleed);
    }
    // 夜战一回合的生计消耗（饱食见底时 spend 内部会自己扣体力）
    const eat = spendSurvival(state, { satiety: NIGHT_TURN_COST });
    out.starveDmg = eat.starveDmg || 0;

    const rec = state.offerings[state.offerings.length - 1];
    if (rec) {
      rec.counter = out.counter;
      rec.special = out.special;
      rec.bleed = out.bleed;
      rec.shielded = out.shielded;
      rec.playerHp = state.playerHp;
      rec.guardianHp = state.guardianHp;
    }
    return out;
  }

  /**
   * 收夜：妖物倒了 → 这一夜守住；旅人倒了 → 这一局结束。
   * @returns {{won:boolean, win:object|null, cleared:boolean}}
   */
  async function finishNightIfNeeded(state, lines) {
    if (state.playerHp <= 0) {
      state.over = 'lose';
      state.phase = 'over';
      const win = await settleRun();
      lines.push('旅人倒了下去，阁里的东西被人一件件搬空。这一局到此为止。');
      return { won: false, win, cleared: false };
    }
    if (state.guardianHp <= 0) {
      state.combo = 0;
      const r = await endNight(state, true);
      lines.push(`妖物退了。第 ${state.day} 天的日头照进万物阁——你还守得住。`);
      return { won: true, win: null, cleared: true, night: r };
    }
    return { won: false, win: null, cleared: false };
  }
};
