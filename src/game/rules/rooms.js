/**
 * 房间裁决 —— 迷宫里走进去之后发生什么
 * ------------------------------------------------------------------
 * 全部毫秒级纯规则，不走模型：一格十几秒的叙事会把肉鸽的节奏拖死。
 * 模型只在夜战叙事（那是它的舞台），白天这些流水账交给代码。
 *
 * 每个房间都会改 state（体力/饱食/精神/铜钱/仓库/心得），
 * 然后把一段「发生了什么」交回给调用方去渲染。
 */

const { ELEMENTS, elementOf } = require('./elements');
const { clamp, resolveOffering } = require('./offering');
const { spend, restore } = require('./survival');
const { makeEquipment, addEquipment, totalStats } = require('./stats');
const { gainInsight, grantDao } = require('./dao');
const { storeCap } = require('./facilities');
const { gainIncense, incenseMax } = require('./incense');
const { unlockSkill, SKILLS } = require('./skills');

/* ══════════════════════════════════════════════════════════════
   拾物：把现实里的东西收进仓库
   ──────────────────────────────────────────────────────────────
   这是摄像头玩法在肉鸽里的落点——你在迷宫里"看见什么就捡什么"。
   物件品质由识别置信度和当层深度决定：认得越准、走得越深，越值钱。
   ══════════════════════════════════════════════════════════════ */

function makeItem({ label, conf = 0.6, ratio = 0.2, depth = 1 } = {}) {
  const ele = elementOf(label);
  const c = clamp(Number(conf) || 0, 0, 1);
  const r = clamp(Number(ratio) || 0, 0, 1);
  // 品质 0~100：认得准 + 举得近 + 走得深
  const quality = Math.round(clamp(c * 45 + r * 60 + (depth - 1) * 6, 1, 100));
  return {
    id: `i${Date.now().toString(36)}${Math.floor(Math.random() * 99)}`,
    label,
    element: ele,
    elementName: ELEMENTS[ele].name,
    conf: Number(c.toFixed(2)),
    ratio: Number(r.toFixed(3)),
    quality,
    name: `${ELEMENTS[ele].name}·${label}`,
  };
}

/** 卖价。品质越高越值钱，深度加成 */
function sellPrice(item) {
  const q = Number(item && item.quality) || 10;
  return Math.max(3, Math.round(6 + q * 0.35));
}

/* ══════════════════════════════════════════════════════════════
   妖物：地图上的杂兵
   ──────────────────────────────────────────────────────────────
   和守阁灵共用同一套克制表和裁决公式——杂兵就是"迷你守阁灵"。
   ══════════════════════════════════════════════════════════════ */

const FOE_POOL = [
  { name: '纸灰蛾', element: 'fire' },
  { name: '井苔球', element: 'water' },
  { name: '断刃哨兵', element: 'metal' },
  { name: '漏电小傀', element: 'volt' },
  { name: '回声残页', element: 'lore' },
  { name: '腐叶小魅', element: 'wood' },
  { name: '陶俑童', element: 'earth' },
  { name: '旧袍门客', element: 'guard' },
  { name: '檐下雀奴', element: 'life' },
];

function makeFoe(depth, rng = Math.random) {
  const f = FOE_POOL[Math.floor(rng() * FOE_POOL.length)] || FOE_POOL[0];
  const d = Math.max(1, Number(depth) || 1);
  // v4.5：白天也压一点——一层三只妖，每只多磨一口气的工夫，
  // 白天那三分钟就真的不够用了（"先打还是先绕"成了决策）
  const hp = Math.max(10, Math.round((16 + d * 5) * (0.9 + rng() * 0.35)));
  return {
    ...f,
    hp,
    maxHp: hp,
    counter: 4 + Math.floor(d / 2),
  };
}

/* ══════════════════════════════════════════════════════════════
   行脚商：用铜钱换明天的命
   ══════════════════════════════════════════════════════════════ */

const GOODS = [
  { id: 'food',    name: '干粮',   price: 12, kind: 'satiety', value: 30, desc: '回复 30 饱食' },
  { id: 'incense', name: '一束香', price: 10, kind: 'incense', value: 2,  desc: '香火 +2 炷（献祭要烧香）' },
  { id: 'torch',   name: '安神香', price: 14, kind: 'sanity',  value: 25, desc: '回复 25 精神' },
  { id: 'pill',    name: '补气散', price: 18, kind: 'hp',      value: 22, desc: '回复 22 体力' },
  { id: 'talis',   name: '符纸',   price: 26, kind: 'equip',   value: 0,  desc: '当场熔出一件护符' },
  { id: 'mana',    name: '术力丹', price: 20, kind: 'mana',    value: 25, desc: '回复 25 术力' },
  { id: 'map',     name: '这一层的地图', price: 15, kind: 'reveal', value: 0, desc: '揭开整层迷宫' },
];

function shopStock(depth, rng = Math.random) {
  // 深度越大越可能进到好东西
  const base = GOODS.filter((g) => g.kind !== 'equip');
  const stock = [];
  const n = 3;
  const pool = rng() < 0.35 + Math.min(0.3, depth * 0.05)
    ? [...base, GOODS.find((g) => g.kind === 'equip')]
    : base;
  const copy = [...pool];
  for (let i = 0; i < n && copy.length; i++) {
    const k = Math.floor(rng() * copy.length);
    stock.push(copy.splice(k, 1)[0]);
  }
  return stock;
}

/**
 * 买东西。
 * @returns {{ok:boolean, msg:string}}
 */
function buy(state, goodId) {
  const g = GOODS.find((x) => x.id === goodId);
  if (!g) return { ok: false, msg: '商贩没有这件货。' };
  if ((state.coin || 0) < g.price) {
    return { ok: false, msg: `铜钱不够：要 ${g.price}，你只有 ${state.coin || 0}。` };
  }
  state.coin -= g.price;
  switch (g.kind) {
    case 'satiety': restore(state, { satiety: g.value }); break;
    case 'sanity':  restore(state, { sanity: g.value }); break;
    case 'hp':      state.playerHp = Math.min(100, state.playerHp + g.value); break;
    case 'mana':    state.stats = { ...state.stats, mana: Math.min(100, (state.stats.mana || 0) + g.value) }; break;
    case 'incense': gainIncense(state, g.value); break;
    case 'equip': {
      const ele = ['metal', 'fire', 'water', 'earth', 'guard', 'wood', 'volt', 'lore'][
        Math.floor(Math.random() * 8)
      ];
      const eq = makeEquipment(g.name, ele);
      addEquipment(state, eq);
      break;
    }
    case 'reveal':
      if (state.maze) state.maze.seen = state.maze.seen.map(() => true);
      break;
    default: break;
  }
  return { ok: true, msg: `买下「${g.name}」——${g.desc}。` };
}

/* ══════════════════════════════════════════════════════════════
   房间门口的一句话
   ──────────────────────────────────────────────────────────────
   走进房间时要说，刷新页面后也要说（前端靠它把场景重建出来，
   不然玩家会站在妖物房里、场景却不弹，还被后端扣着走不了）。
   所以文案只写一份，两个入口共用。
   ══════════════════════════════════════════════════════════════ */

const PROMPT = {
  item: '屋里堆着些没人要的东西。举起你身边的物件，把它也收进来——或者干脆不捡。',
  shrine: '一座没名字的小龛，香灰还是温的。你可以拜一拜，也可以把它掀了。',
  shop: '一个挑着担子的行脚商停在这儿，看你要不要买点什么。',
  forge: '一间还热的熔炉，火舌舔着坩埚。旧物丢进去，能熔出一件护符——就是不知道熔出来的是什么属性。',
  mirror: '墙上嵌着一面铜镜，镜面发乌。你能在里头看见自己现在穿的这一身。',
  guest: '门里坐着个借宿的旅人，火堆压得很低。他说他也在这宅子里找东西。',
  doctor: '廊下坐着个游方郎中，药箱开着，艾草味飘了一地。「看病不要命，要钱。」',
  bard: '一个说书人盘腿坐在台阶上，醒木一拍：「客官，来一段？这宅子的旧事我知道些。」',
  hermit: '楼梯拐角坐着个闭目的传功人，身边的蒲团空着一个。「坐。想学，就留下点东西。」',
};

/* 三个 NPC 的选项表：label 直接给前端渲染，id 回来走 choice 结算 */
function npcChoices(type, state) {
  if (type === 'doctor') {
    return [
      { id: 'treat', label: `求诊（${DOCTOR_TREAT_FEE} 文 · 回体力回精神）` },
      { id: 'salve', label: `买药囊（${DOCTOR_SALVE_FEE} 文 · 熔成一件装备）` },
    ];
  }
  if (type === 'bard') {
    return [
      { id: 'listen', label: '听一段（免费 · 静心 + 一点心得）' },
      { id: 'tip', label: `赏钱点唱（${BARD_TIP_FEE} 文 · 术力大涨 + 心得）` },
    ];
  }
  if (type === 'hermit') {
    const all = SKILLS.length <= ((state.skills || []).length);
    return [
      { id: 'learn', label: all ? '求教（-10 体力 · 参悟更深）' : '求教（-10 体力 · 学一道新法术）' },
      { id: 'spar', label: '跟他切磋（五五开：赢了有赏，输了挨揍）' },
    ];
  }
  return null;
}
const DOCTOR_TREAT_FEE = 15;
const DOCTOR_SALVE_FEE = 25;
const BARD_TIP_FEE = 20;

function foePrompt(foe) {
  return `「${foe.name}」（${ELEMENTS[foe.element].name}）堵在门口，退路已经没了。举起东西砸它。`;
}

/**
 * 站在一个还没处理的房间上，该对玩家说什么。
 * 顺带把房间内容物（妖物、货）补出来——它们本来就要在这一刻生成。
 */
function roomPrompt(state, room) {
  if (!room || room.solved) return [];
  const depth = state.maze ? state.maze.depth : 1;
  switch (room.type) {
    case 'item': return [PROMPT.item];
    case 'foe': {
      if (!room.foe) room.foe = makeFoe(depth);
      return [foePrompt(room.foe)];
    }
    case 'shrine': return [PROMPT.shrine];
    case 'shop': {
      if (!room.stock) room.stock = shopStock(depth);
      return [PROMPT.shop];
    }
    case 'forge':
    case 'mirror':
    case 'guest':
    case 'doctor':
    case 'bard':
    case 'hermit': {
      // NPC 的选项是按当前状态算的（学没学过法术、文案不同）
      if ((room.type === 'doctor' || room.type === 'bard' || room.type === 'hermit') && !room.choices) {
        room.choices = npcChoices(room.type, state);
      }
      return [PROMPT[room.type]];
    }
    default: return [];
  }
}

/* ══════════════════════════════════════════════════════════════
   空房：不再是「什么也没有」
   ──────────────────────────────────────────────────────────────
   v4.2：既然走过的路会重掷，"空房"就不能是纯粹的空白——
   否则玩家学会的策略是"只走有字的格子"，地图重掷反而成了筛子。
   现在空房每次走进去都有一点小事发生（可重复触发）：
   捡到零钱 / 翻出干粮 / 墙上的刻字 / 被什么惊了一下 / 什么都没有。
   ══════════════════════════════════════════════════════════════ */

/**
 * 空房里的小事件。强度刻意压在正式房间之下：这是路上的零碎，
 * 不是一场遭遇——不然玩家每走三步就要打一架，肉鸽会变成消耗战。
 */
function driftEvent(state, rng = Math.random) {
  const depth = state.maze ? state.maze.depth : 1;
  const roll = rng();

  if (roll < 0.30) {
    const coin = 2 + Math.floor(rng() * (3 + depth));
    state.coin = (state.coin || 0) + coin;
    return { kind: 'coin', coin, text: `砖缝里卡着几枚旧钱，你用簪子抠了出来（+${coin} 文）。` };
  }
  if (roll < 0.50) {
    const s = 6 + Math.floor(rng() * (6 + depth));
    restore(state, { satiety: s });
    return { kind: 'food', satiety: s, text: `前一个旅人落下的半包干粮，还没长霉（+${s} 饱食）。` };
  }
  if (roll < 0.66) {
    const s = 4 + Math.floor(rng() * 5);
    restore(state, { sanity: s });
    return { kind: 'mark', sanity: s, text: `墙上刻着一行字，你看了一会儿，心里静了些（+${s} 精神）。` };
  }
  if (roll < 0.80) {
    const s = 3 + Math.floor(rng() * 4);
    spend(state, { sanity: s });
    return { kind: 'startle', sanity: s, text: `墙角有东西窸窣了一声，你后背一凉（-${s} 精神）。` };
  }
  // v4.5.1：空房也能捡到大件——法术残页、半件旧装备。稀有，但值得绕路
  if (roll < 0.88) {
    const sk = unlockSkill(state);
    if (sk) {
      return { kind: 'scroll', skill: sk.id, text: `抽屉夹层里藏着半页残卷，咒名还认得清——「${sk.name}」。你对着空屋子念了一遍，居然应了（学会新法术）。` };
    }
    const coin = 6 + Math.floor(rng() * (4 + depth));
    state.coin = (state.coin || 0) + coin;
    return { kind: 'coin', coin, text: `夹层里是一包旧钱（+${coin} 文）。` };
  }
  if (roll < 0.94) {
    const eq = makeEquipment(`旧物·${['铜铃', '断簪', '镇纸', '护腕'][Math.floor(rng() * 4)]}`, ['metal', 'guard', 'earth', 'lore'][Math.floor(rng() * 4)]);
    const res = addEquipment(state, eq);
    if (res.gained) {
      return { kind: 'gear', item: res.gained.name, text: `梁上掉下来一件旧物，擦掉灰还能戴——「${res.gained.name}」（攻+${res.gained.atk} 防+${res.gained.def}）。` };
    }
    return { kind: 'none', text: '梁上掉下来一件旧物，一碰就散了灰。' };
  }
  return { kind: 'none', text: '空落落一间，只有灰尘——但你还是把它的位置记了下来，因为这片宅子会动。' };
}

/* ══════════════════════════════════════════════════════════════
   房间裁决总入口
   ══════════════════════════════════════════════════════════════ */

/**
 * 走进一个房间，把它结算掉。
 * @param {object} state 本局状态（会被直接改）
 * @param {object} room  迷宫格子
 * @param {object} [payload] 玩家这次带进来的东西
 *   - offering {label, conf, ratio}：拾物间/妖物房需要它
 *   - choice  'pray' | 'smash'：神龛的抉择
 *   - good    id：商贩买货
 *   - flee    true：妖物房避战
 * @returns {{type:string, text:string[], ...}} 结果，交给前端渲染
 */
function resolveRoom(state, room, payload = {}) {
  if (!room) return { type: 'none', text: ['这一格什么也没有。'] };
  const out = { type: room.type, text: [], solved: false };

  switch (room.type) {
    /* ── 空房：没有大事，但也不是空无一物（v4.2 起每次进来都有小事）─ */
    case 'empty': {
      out.solved = true;
      const drift = driftEvent(state);
      out.drift = drift.kind;
      if (drift.coin) out.reward = { ...(out.reward || {}), coin: drift.coin };
      if (drift.satiety) out.reward = { ...(out.reward || {}), satiety: drift.satiety };
      if (drift.sanity > 0) out.reward = { ...(out.reward || {}), sanity: drift.sanity };
      out.text.push(drift.text);
      break;
    }
    case 'start':
      out.solved = true;
      out.text.push('阁门在你身后。');
      break;

    /* ── 拾物：把镜头前的东西收进仓库 ──────────────────────── */
    case 'item': {
      // 走进来就得做个决断（收，或者明确不收），不能看一眼就走
      if (payload.skip) {
        out.solved = true;
        out.skipped = true;
        out.text.push('你翻了翻，没什么合用的，空手退了出来。');
        break;
      }
      if (!payload.offering) {
        out.needOffering = true;
        out.text.push(PROMPT.item);
        return out;   // 不推进，等玩家举物
      }
      const item = makeItem({ ...payload.offering, depth: state.maze ? state.maze.depth : 1 });
      const cap = storeCap(state);
      if ((state.store || []).length >= cap) {
        out.full = true;
        out.text.push(`仓库满了（${cap} 格）——「${item.name}」带不回去，只能扔下。回阁腾出地方再来。`);
        out.solved = true;
        break;
      }
      state.store.push(item);
      out.item = item;
      out.solved = true;
      out.text.push(`你把「${item.name}」收进背囊（品质 ${item.quality}，可卖 ${sellPrice(item)} 文）。`);
      break;
    }

    /* ── 妖物：堵在门口，跑不掉 ─────────────────────────────── */
    case 'foe': {
      if (!room.foe) room.foe = makeFoe(state.maze ? state.maze.depth : 1);
      const foe = room.foe;

      // 这里曾经有「避战绕开」：结果是玩家进去看一眼、转身就走，
      // 遇妖等于没遇，地图上的妖物全变成纸老虎。现在只留下"打"这一条路。
      if (!payload.offering) {
        out.needOffering = true;
        out.foe = foe;
        out.text.push(foePrompt(foe));
        return out;
      }

      const r = resolveOffering(payload.offering, foe, {
        combo: 0,
        // 装备在这里也要生效——不然白天捡的护符到迷宫里就是摆设
        stats: totalStats(state),
        state,
        intent: payload.intent,
      });
      foe.hp = Math.max(0, foe.hp - r.damage);
      out.strike = r;
      out.text.push(`你用「${payload.offering.label}」砸向 ${foe.name}：${r.verdict}，${r.damage} 点伤害。`);

      if (foe.hp <= 0) {
        const bonus = Math.max(1, Math.round(r.damage / 5));
        state.playerHp = Math.min(100, state.playerHp + bonus);
        const coin = 4 + Math.floor((state.maze ? state.maze.depth : 1) * 2);
        state.coin = (state.coin || 0) + coin;
        out.solved = true;
        out.reward = { coin };
        out.text.push(`它散了，留下 ${coin} 枚铜钱和一点余温（+${bonus} 体力）。`);
      } else {
        const c = Math.max(1, Math.round(foe.counter * (0.85 + Math.random() * 0.3)));
        state.playerHp = Math.max(0, state.playerHp - c);
        spend(state, { sanity: 3 });
        out.counter = c;
        // 它没倒：这一格还得继续打。必须把 foe（最新血量）和 needOffering
        // 一起带回去——少了 needOffering，前端会把场景合上（只给一个"继续"），
        // 而妖物还堵着门：走走不动、回阁回不去、场景里也没有再打的入口，
        // 玩家就死锁在这一格了（v4.4.5 实玩踩中的）。
        out.foe = foe;
        out.needOffering = true;
        out.text.push(`${foe.name} 反扑，-${c} 体力、-3 精神。它还没倒——接着打。`);
      }
      break;
    }

    /* ── 陷阱：来得突然，掉血或掉魂 ─────────────────────────── */
    case 'trap': {
      const roll = Math.random();
      if (roll < 0.5) {
        const dmg = Math.max(3, Math.round(6 + (state.maze ? state.maze.depth : 1) * 1.5));
        state.playerHp = Math.max(0, state.playerHp - dmg);
        out.damage = dmg;
        out.text.push(`一脚踩空，摔进了夹层（-${dmg} 体力）。`);
      } else {
        const s = Math.max(4, Math.round(6 + (state.maze ? state.maze.depth : 1)));
        spend(state, { sanity: s });
        out.sanityLoss = s;
        out.text.push(`墙角有东西在你耳边说了句话，回头看却什么也没有（-${s} 精神）。`);
      }
      out.solved = true;
      break;
    }

    /* ── 箱笼：开出来是什么全看运气 ─────────────────────────── */
    case 'chest': {
      const roll = Math.random();
      if (roll < 0.34) {
        const coin = 12 + Math.floor(Math.random() * 20) + (state.maze ? state.maze.depth : 1) * 3;
        state.coin = (state.coin || 0) + coin;
        out.reward = { coin };
        out.text.push(`箱底压着一把铜钱（+${coin} 文）。`);
      } else if (roll < 0.62) {
        restore(state, { satiety: 25, sanity: 10 });
        const ins = gainIncense(state, 2);
        out.reward = { satiety: 25, sanity: 10, incense: ins.gained };
        out.text.push(`箱里是一包没坏的干粮，还有半束没受潮的香（+25 饱食、+10 精神、+${ins.gained} 香火）。`);
      } else if (roll < 0.86) {
        const ele = ['metal', 'fire', 'water', 'earth', 'guard', 'wood', 'volt', 'lore'][
          Math.floor(Math.random() * 8)
        ];
        const eq = makeEquipment('chest', ele);
        const res = addEquipment(state, eq);
        out.reward = { equip: res.gained || null };
        out.text.push(res.gained
          ? `箱里躺着一件旧护符「${res.gained.name}」（攻+${res.gained.atk} 防+${res.gained.def}）。`
          : '箱里那件护符还不如你身上的，随手丢了。');
      } else {
        const ins = gainInsight(state);
        out.reward = { insight: ins || null };
        out.text.push(ins
          ? `箱里是一页没写完的手抄，你读着读着悟出「${ins.name}」——${ins.desc}。`
          : '箱里是一页手抄，可惜你早就会了。');
      }
      out.solved = true;
      break;
    }

    /* ── 神龛：拜它，还是砸它 ───────────────────────────────── */
    case 'shrine': {
      if (!payload.choice) {
        out.needChoice = true;
        out.text.push(PROMPT.shrine);
        return out;
      }
      if (payload.choice === 'pray') {
        restore(state, { sanity: 18 });
        spend(state, { satiety: 10 });
        const ins = gainIncense(state, 2);
        out.reward = { sanity: 18, incense: ins.gained };
        out.text.push(`你跪下去磕了个头。心里忽然静了些，香炉边还余着两炷没烧完的（+18 精神、-10 饱食、+${ins.gained} 香火）。`);
      } else {
        const coin = 20 + Math.floor(Math.random() * 15);
        state.coin = (state.coin || 0) + coin;
        spend(state, { sanity: 22 });
        out.reward = { coin };
        out.text.push(`你掀了香案，底下果然压着钱（+${coin} 文）。风一下子冷了（-22 精神）。`);
      }
      out.solved = true;
      break;
    }

    /* ── 行脚商：带着货走江湖的那种 ─────────────────────────── */
    case 'shop': {
      if (!room.stock) room.stock = shopStock(state.maze ? state.maze.depth : 1);
      // 「告辞」：不买也能了结。否则商贩房会变成一道走不出去的墙
      // （货单不放进结果里——不然前端场景会永远停在货摊上）
      if (payload.skip) {
        out.solved = true;
        out.text.push('你摆摆手，挑着担子的商贩也不勉强，让开了路。');
        break;
      }
      out.stock = room.stock;
      if (payload.good) {
        const res = buy(state, payload.good);
        out.bought = res.ok ? payload.good : null;
        out.text.push(res.msg);
        // 买成才算逛完；没买成就还站在这儿，可以再挑
        if (!res.ok) return out;
        out.solved = true;
        break;
      }
      out.text.push(PROMPT.shop);
      break;   // 不买就不算解决，回头还能再来
    }

    /* ── 熔炉间：把旧物熔成护符（装备的主要来路）────────── */
    case 'forge': {
      if (payload.skip) {
        out.solved = true;
        out.text.push('你把炉门掩上，火光在缝里挤了一下。');
        break;
      }
      if (!payload.offering) {
        out.needOffering = true;
        out.text.push(PROMPT.forge);
        return out;
      }
      const ele = ['metal', 'fire', 'water', 'earth', 'guard', 'wood', 'volt', 'lore'][
        Math.floor(Math.random() * 8)
      ];
      const eq = makeEquipment(payload.offering.label, ele);
      const res = addEquipment(state, eq);
      out.solved = true;
      if (res.gained) {
        out.equip = res.gained;
        out.text.push(`你把「${payload.offering.label}」丢进坩埚。火一舔就卷走了标签，凝出「${res.gained.name}」（攻+${res.gained.atk} 防+${res.gained.def}）。`);
        if (res.dropped) out.text.push(`原先那件「${res.dropped.name}」在高温里软了——熔了。`);
      } else {
        out.text.push('你把东西丢进去，它在火里散了，没凝成任何东西。手上只剩一身汗。');
      }
      break;
    }

    /* ── 铜镜间：照一照，看清自己这身（顺带回神）──────────── */
    case 'mirror': {
      if (!payload.choice) {
        out.needChoice = true;
        out.text.push(PROMPT.mirror);
        return out;
      }
      if (payload.choice === 'look') {
        const eq = (state.equipment || []).length;
        const san = 10 + eq * 2;
        restore(state, { sanity: san });
        state.stats = { ...state.stats, mana: Math.min(100, (state.stats.mana || 0) + 12) };
        out.solved = true;
        out.reward = { sanity: san, mana: 12 };
        out.text.push(`你在镜前站了一会儿。镜子里的人穿着${eq ? `你身上那 ${eq} 件` : '一身旧布'}，眼神倒比刚进门时稳（+${san} 精神、+12 术力）。`);
      } else {
        out.solved = true;
        out.text.push('你把镜面扣过去，继续往前走。');
      }
      break;
    }

    /* ── 借宿：有补给，也有代价（v4.2 新增）───────────────── */
    case 'guest': {
      if (!payload.choice) {
        out.needChoice = true;
        out.text.push(PROMPT.guest);
        return out;
      }
      if (payload.choice === 'stay') {
        const coin = Math.min(state.coin || 0, 8);
        state.coin = (state.coin || 0) - coin;
        const hp = Math.min(100, state.playerHp + 15);
        state.playerHp = hp;
        const ins = gainIncense(state, 1);
        restore(state, { sanity: 8 });
        spend(state, { satiety: 5 });
        out.solved = true;
        out.stayed = true;
        out.reward = { hp: 15, sanity: 8, incense: ins.gained, coin };
        out.text.push(`你们分了他一半干粮。他讲了些这宅子的规矩，你没全记住（+15 体力、+8 精神、+${ins.gained} 香火、-5 饱食${coin ? `、-${coin} 文房钱` : ''}）。`);
      } else {
        out.solved = true;
        out.text.push('你谢绝了。火堆那边没再抬头。');
      }
      break;
    }

    /* ── 游方郎中：花钱续命，还是花大钱置装（v4.5.1 新增）───── */
    case 'doctor': {
      if (!payload.choice) {
        out.needChoice = true;
        out.choices = room.choices || npcChoices('doctor', state);
        out.text.push(PROMPT.doctor);
        return out;
      }
      if (payload.choice === 'treat') {
        if ((state.coin || 0) < DOCTOR_TREAT_FEE) {
          out.needChoice = true;
          out.choices = room.choices || npcChoices('doctor', state);
          out.text.push(`诊金 ${DOCTOR_TREAT_FEE} 文——你摸遍全身也凑不齐。郎中摆摆手：「凑够了再来。」`);
          return out;
        }
        state.coin -= DOCTOR_TREAT_FEE;
        state.playerHp = Math.min(100, (state.playerHp || 0) + 20);
        restore(state, { sanity: 10 });
        out.solved = true;
        out.reward = { hp: 20, sanity: 10, coin: -DOCTOR_TREAT_FEE };
        out.text.push(`三根手指搭腕，一贴膏药下背（+20 体力、+10 精神，-${DOCTOR_TREAT_FEE} 文）。他叮嘱你早点歇——你说不急。`);
      } else if (payload.choice === 'salve') {
        if ((state.coin || 0) < DOCTOR_SALVE_FEE) {
          out.needChoice = true;
          out.choices = room.choices || npcChoices('doctor', state);
          out.text.push(`药囊 ${DOCTOR_SALVE_FEE} 文——你的钱袋先一步告了饶。`);
          return out;
        }
        state.coin -= DOCTOR_SALVE_FEE;
        const eq = makeEquipment('药王囊', ['life', 'wood', 'earth'][Math.floor(Math.random() * 3)]);
        const res = addEquipment(state, eq);
        out.solved = true;
        out.reward = { coin: -DOCTOR_SALVE_FEE };
        out.text.push(res.gained
          ? `他把一只绣线药囊塞给你，针脚里全是苦香——熔成了「${res.gained.name}」（攻+${res.gained.atk} 防+${res.gained.def}）。`
          : `药囊到手就化成了苦水，你的装备没给它留位置（-${DOCTOR_SALVE_FEE} 文，钱照收）。`);
      } else {
        out.solved = true;
        out.text.push('你抱拳告辞。艾草味在你身后散了。');
      }
      break;
    }

    /* ── 说书人：免费的静心，花钱的热闹（v4.5.1 新增）───────── */
    case 'bard': {
      if (!payload.choice) {
        out.needChoice = true;
        out.choices = room.choices || npcChoices('bard', state);
        out.text.push(PROMPT.bard);
        return out;
      }
      if (payload.choice === 'listen') {
        restore(state, { sanity: 8 });
        grantDao(state, 3);
        out.solved = true;
        out.reward = { sanity: 8 };
        out.text.push('他说的是三十年前守阁人退敌的那一夜。你听得入神，心里静了些，手上倒记了两招（+8 精神、+心得）。');
      } else if (payload.choice === 'tip') {
        if ((state.coin || 0) < BARD_TIP_FEE) {
          out.needChoice = true;
          out.choices = room.choices || npcChoices('bard', state);
          out.text.push(`赏钱 ${BARD_TIP_FEE} 文——你的钱袋比兴致先瘪了下去。`);
          return out;
        }
        state.coin -= BARD_TIP_FEE;
        const before = state.stats.mana || 0;
        state.stats = { ...state.stats, mana: Math.min(100, before + 15) };
        grantDao(state, 6);
        out.solved = true;
        out.reward = { mana: state.stats.mana - before, coin: -BARD_TIP_FEE };
        out.text.push(`醒木三响，满堂皆惊——他压低嗓子讲了段夜里的禁忌，你听得后背发麻，术力涨了 ${state.stats.mana - before}（+心得）。`);
      } else {
        out.solved = true;
        out.text.push('你摆摆手走了。醒木声追出来半条廊子。');
      }
      break;
    }

    /* ── 传功人：学法术，或者赌一把切磋（v4.5.1 新增）───────── */
    case 'hermit': {
      if (!payload.choice) {
        out.needChoice = true;
        out.choices = room.choices || npcChoices('hermit', state);
        out.text.push(PROMPT.hermit);
        return out;
      }
      if (payload.choice === 'learn') {
        state.playerHp = Math.max(1, (state.playerHp || 0) - 10);
        const sk = unlockSkill(state);
        if (sk) {
          out.solved = true;
          out.reward = { skill: sk.id, hp: -10 };
          out.text.push(`他只说了一遍咒名「${sk.name}」，你跟着念了一遍，喉咙里像咽下了一块烧红的炭——学会了（-10 体力）。`);
        } else {
          grantDao(state, 10);
          out.solved = true;
          out.reward = { hp: -10 };
          out.text.push('他摇头：「你会的比我多。」但提点了你两句行功的岔路——参悟更深了（+心得，-10 体力）。');
        }
      } else if (payload.choice === 'spar') {
        const win = Math.random() < 0.5;
        if (win) {
          const coin = 30;
          state.coin = (state.coin || 0) + coin;
          grantDao(state, 8);
          out.solved = true;
          out.reward = { coin };
          out.text.push(`你们拆了三招，他忽然收手笑了：「可以。」蒲团底下摸出 ${coin} 文拍在你手里（+心得）。`);
        } else {
          state.playerHp = Math.max(0, (state.playerHp || 0) - 12);
          spend(state, { sanity: 4 });
          if (state.playerHp <= 0) state.over = 'lose';
          out.solved = true;
          out.reward = { hp: -12 };
          out.text.push('你只看清了他抬手，人就坐在地上了（-12 体力、-4 精神）。他扶你起来：「胆子好，路子歪。」');
        }
      } else {
        out.solved = true;
        out.text.push('你绕开那个空蒲团走了。背后没有声音。');
      }
      break;
    }

    /* ── 歇脚处：回阁的唯一落脚点 ───────────────────────────── */
    case 'rest': {
      restore(state, { satiety: 10, sanity: 6 });
      const ins = gainIncense(state, 2);
      out.solved = true;
      out.isRest = true;
      out.reward = { satiety: 10, sanity: 6, incense: ins.gained };
      out.text.push('一截没塌的廊檐，底下有半张旧席，还有个早先旅人留下的香炉底子。');
      out.text.push(`你靠着柱子歇了口气（+10 饱食、+6 精神），顺手从炉底刮出 ${ins.gained} 炷残香。`);
      out.text.push('这里能回阁——想收工就从这儿走。');
      break;
    }

    /* ── 下楼的梯 ───────────────────────────────────────────── */
    case 'stair':
      out.onStair = true;
      out.solved = true;
      out.text.push('梯子往下伸，看不见底。走不走，你说了算。');
      break;

    default:
      out.solved = true;
      out.text.push('一间说不清用途的屋子。');
  }

  if (out.solved) room.solved = true;
  if (state.playerHp <= 0) {
    state.over = 'lose';
    out.text.push('你倒在了这一层，没能走出去。');
  }
  return out;
}

module.exports = {
  FOE_POOL,
  GOODS,
  PROMPT,
  makeItem,
  sellPrice,
  makeFoe,
  shopStock,
  buy,
  driftEvent,
  roomPrompt,
  resolveRoom,
};
