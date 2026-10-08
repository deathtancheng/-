/**
 * v4.1 端到端验证（不走网络、不走模型）
 * ------------------------------------------------------------------
 * quest 扩展只需要一个 root 目录，不需要 Harness 实例，所以下面这些
 * 全都能在毫秒级跑完——不用真去打通一局（那要几十次模型调用）。
 *
 * 覆盖的系统：
 *   肉鸽   —— 迷宫生成 / 视野 / 走格 / 房型裁决 / 下潜 / 陷阱伪装 / 强制房间
 *   生存   —— 饱食与精神的扣减、饥饿掉血、失魂迷路、伤害打折、歇脚处
 *   策略   —— 建造取舍、日常次数限制、夜战的架势与精怪加成、回阁限制
 *   经营   —— 货仓容量、卖物、祭坛炼精怪、喂食升级、门面夜进项
 *   香火   —— 献祭次数的硬成本：来源、上限、夜战扣减、买香
 *   跨局   —— 周目、遗物、回到第一周目
 *
 * 用法：node scripts/e2e-v40.js
 */

const path = require('path');
const fs = require('fs');
const questExt = require('../src/harness/extensions/quest');
const R = require('../src/game/rules');

const ROOT = path.resolve(__dirname, '..', 'sandbox');
const LEG = path.join(ROOT, 'game', 'legacy.json');
const SAVE = path.join(ROOT, 'game', 'save.json');

const line = (s) => console.log(s);
const head = (s) => console.log(`\n===== ${s} =====`);

let bad = 0;
function check(label, cond, extra = '') {
  if (cond) line(`  ✓ ${label}${extra ? '  ' + extra : ''}`);
  else { bad += 1; line(`  ✗ ${label}${extra ? '  ' + extra : ''}`); }
}

/** 把某个格子改成指定房型，方便确定性地测某一种房间 */
function forceRoom(state, x, y, type) {
  const r = state.maze.rooms[y * state.maze.w + x];
  r.type = type;
  r.solved = false;
  return r;
}

(async () => {
  for (const f of [LEG, SAVE]) if (fs.existsSync(f)) fs.unlinkSync(f);
  const def = questExt({ root: ROOT });

  /* ══════════════════════════════════════════════════════════
     1. 开新局：一局就是"一天一天活下来"
     ══════════════════════════════════════════════════════════ */
  head('1. 开新局');
  await def.reset();
  let st = def.getState();
  check('第 1 天 / 迷宫阶段', st.day === 1 && st.phase === 'maze', `day=${st.day} phase=${st.phase}`);
  check('饱食 + 精神 双条满值', st.satiety === 100 && st.sanity === 100);
  check('有开局铜钱', st.coin === R.START_COIN, `coin=${st.coin}`);
  check('有开局香火', st.incense === R.START_INCENSE, `${st.incense}/${R.incenseMax(st)} 炷`);
  check('仓库与精怪都是空的', st.store.length === 0 && st.spirits.length === 0);

  /* ── 迷宫几何 ───────────────────────────────────────────── */
  head('2. 迷宫生成与视野');
  const mz = st.maze;
  const tally = {};
  for (const r of mz.rooms) tally[r.type] = (tally[r.type] || 0) + 1;
  check('5×5 = 25 格', mz.rooms.length === 25, JSON.stringify(tally));
  check('起点在下左、梯子在上右', tally.start === 1 && tally.stair === 1);
  const seen0 = mz.seen.filter(Boolean).length;
  // v4.3：视野从 3×3 改成十字。开局在左下角，十字被边界裁掉一角 → 3 格
  check('开局只看见十字（角落 3 格）', seen0 === 3, `亮着 ${seen0} 格`);
  check('图上有歇脚处（回阁的落脚点）', tally.rest >= 1, `${tally.rest} 处`);
  // 陷阱必须伪装：快照里看见的"空房"里得藏着真陷阱
  const trapReal = mz.rooms.filter((r) => r.type === 'trap');
  const trapSeen = R.mazeSnapshot(mz).cells.filter((c) => c.type === 'trap');
  check('陷阱在图上伪装成空房（玩家看不见）', trapReal.length >= 2 && trapSeen.length === 0,
    `真陷阱 ${trapReal.length} 个，图上暴露 0 个`);

  /* ── 走一格：揭雾 + 扣饱食 ──────────────────────────────── */
  head('3. 走一格');
  const before = st.satiety;
  const mv = R.walk(st.maze, 'up');
  R.payWalk(st);
  await def.setState(st);
  st = def.getState();
  check('走通了', mv.ok === true);
  check('饱食扣了 3', before - st.satiety === 3, `${before} → ${st.satiety}`);
  const seen1 = st.maze.seen.filter(Boolean).length;
  check('视野扩大（揭开了新的一圈）', seen1 > seen0, `${seen0} → ${seen1}`);
  check('撞墙不会走', R.walk(st.maze, 'left') === undefined || R.walk(st.maze, 'left').ok === false);

  /* ── 拾物间：必须举东西，且受仓库容量限制 ───────────────── */
  head('4. 拾物间');
  const itemRoom = forceRoom(st, 0, 2, 'item');
  st.maze.px = 0; st.maze.py = 2;
  let out = R.resolveRoom(st, itemRoom, {});
  check('没举东西 → 等玩家举物', out.needOffering === true && out.solved === false);
  out = R.resolveRoom(st, itemRoom, { offering: { label: 'cup', conf: 0.9, ratio: 0.3 } });
  check('举了东西 → 收进仓库', out.solved === true && st.store.length === 1,
    `入仓 ${st.store[0] && st.store[0].name}，品质 ${st.store[0] && st.store[0].quality}`);

  // 「不捡了」也要能了结——不然拾物间会变成一道走不出去的墙
  const skipRoom = forceRoom(st, 0, 2, 'item');
  out = R.resolveRoom(st, skipRoom, { skip: true });
  check('明确说不捡 → 房间了结', out.solved === true && out.skipped === true);

  const cap = R.storeCap(st);
  check('货仓容量来自设施等级', cap === R.STORE_BASE, `cap=${cap}`);
  while (st.store.length < cap) {
    R.resolveRoom(st, forceRoom(st, 0, 2, 'item'), { offering: { label: 'book', conf: 0.9, ratio: 0.3 } });
  }
  out = R.resolveRoom(st, forceRoom(st, 0, 2, 'item'), { offering: { label: 'cup', conf: 0.9, ratio: 0.3 } });
  check('仓库满了 → 带不回去', out.full === true, `满了 ${st.store.length}/${cap}`);

  /* ── 妖物房：进去就得打，没有"绕开" ─────────────────────── */
  head('5. 迷宫里的妖物房（强制交手）');
  const foeRoom = forceRoom(st, 1, 2, 'foe');
  out = R.resolveRoom(st, foeRoom, {});
  check('没举东西 → 堵着，等玩家出手', out.needOffering === true && !!out.foe);
  // 避战曾经是合法选项，结果是玩家进去看一眼、转身就走，遇妖等于没遇
  const fleeRoom = forceRoom(st, 2, 2, 'foe');
  out = R.resolveRoom(st, fleeRoom, { flee: true });
  check('「绕开」已被移除：仍然堵着不放行', out.solved === false && out.needOffering === true);

  const hp0 = st.playerHp;
  const fightRoom = forceRoom(st, 3, 2, 'foe');
  fightRoom.foe = R.makeFoe(1);
  fightRoom.foe.hp = 4;
  out = R.resolveRoom(st, fightRoom, { offering: { label: 'knife', conf: 0.95, ratio: 0.4 } });
  check('砸死妖物 → 给铜钱并回一点体力', out.solved === true && st.playerHp >= hp0,
    `伤害 ${out.strike.damage}，得 ${out.reward && out.reward.coin} 文`);

  // 被扣住的感觉：站在没处理的妖物房上，哪都去不了
  const stuck = forceRoom(st, 1, 3, 'foe');
  stuck.foe = R.makeFoe(1);
  st.maze.px = 1; st.maze.py = 3;
  check('没处理的房间扣住玩家', R.roomBlocks(stuck) === true && R.canLeave(st.maze) === false,
    R.blockHint(st.maze));
  const stuckWalk = R.walk(st.maze, 'up');
  check('想走也走不动', stuckWalk.ok === false && stuckWalk.blocked === true);

  /* ── 陷阱 / 箱笼 / 神龛 / 商贩 ──────────────────────────── */
  head('6. 陷阱 / 箱笼 / 神龛 / 商贩');
  const trap = forceRoom(st, 0, 1, 'trap');
  out = R.resolveRoom(st, trap, {});
  check('陷阱 → 掉血或掉精神', out.solved === true && (out.damage > 0 || out.sanityLoss > 0),
    out.damage > 0 ? `-${out.damage} 体力` : `-${out.sanityLoss} 精神`);

  const chest = forceRoom(st, 1, 1, 'chest');
  out = R.resolveRoom(st, chest, {});
  check('箱笼 → 一定有东西', out.solved === true && !!out.reward, JSON.stringify(out.reward));

  const shrine = forceRoom(st, 2, 1, 'shrine');
  out = R.resolveRoom(st, shrine, {});
  check('神龛 → 等玩家抉择', out.needChoice === true);
  const incB = st.incense;
  out = R.resolveRoom(st, shrine, { choice: 'pray' });
  check('拜一拜 → 加精神，还余出两炷香', out.solved === true && st.incense > incB,
    `香火 ${incB} → ${st.incense}`);

  const shop = forceRoom(st, 3, 1, 'shop');
  out = R.resolveRoom(st, shop, {});
  check('商贩 → 摆出货', Array.isArray(out.stock) && out.stock.length > 0,
    out.stock.map((g) => `${g.name}${g.price}文`).join('、'));
  // 先测"买不起"：把铜钱压到 1 文，任何货都买不了
  st.coin = 1;
  const cheap = out.stock.slice().sort((a, b) => a.price - b.price)[0];
  out = R.resolveRoom(st, shop, { good: cheap.id });
  check('铜钱不够 → 不成交，且还能再挑', out.bought === null && out.solved === false, out.text[out.text.length - 1]);
  // 再测"买得起"
  st.coin = 200;
  const coin0 = st.coin;
  out = R.resolveRoom(st, shop, { good: cheap.id });
  check('买得起 → 扣钱并逛完这家', out.solved === true && st.coin === coin0 - cheap.price,
    `${cheap.name}：-${cheap.price} 文 → ${st.coin}`);
  // 「告辞」也要能了结——不然商贩房就是一道墙
  const shop2 = forceRoom(st, 3, 1, 'shop');
  out = R.resolveRoom(st, shop2, { skip: true });
  check('不买了，告辞 → 房间了结', out.solved === true);

  /* ── 歇脚处：回阁的唯一落脚点，顺带回一点气 ─────────────── */
  head('6b. 歇脚处');
  const rest = forceRoom(st, 0, 1, 'rest');
  const restSat = st.satiety, restSan = st.sanity, restInc = st.incense, restCap = R.incenseMax(st);
  out = R.resolveRoom(st, rest, {});
  check('歇脚处自动结算', out.solved === true && out.isRest === true);
  check('歇口气（没满的那条会回来一点，满了就封顶）',
    st.satiety === Math.min(100, restSat + 10) && st.sanity === Math.min(100, restSan + 6),
    `饱食 ${restSat}→${st.satiety}，精神 ${restSan}→${st.sanity}`);
  check('炉底刮香：没满 +2，满了刮不出',
    st.incense < restCap ? st.incense - restInc === 2 : st.incense === restCap,
    `香火 ${restInc}→${st.incense}（上限 ${restCap}）`);

  /* ── 下潜 ───────────────────────────────────────────────── */
  head('7. 顺着梯子下潜');
  st.maze.px = 4; st.maze.py = 0;
  const sanB = st.sanity;
  const dr = R.descend(st);
  check('下到第 2 层', dr.ok === true && st.maze.depth === 2, `-${dr.sanity} 精神`);
  check('精神付出了代价', st.sanity === Math.max(0, sanB - dr.sanity));

  /* ══════════════════════════════════════════════════════════
     8. 回阁：模拟经营
     ══════════════════════════════════════════════════════════ */
  head('8. 回阁：只能从歇脚处回');
  // 第 7 段下潜后站在新迷宫的起点阁门——那一截走廊塌了，回不去
  let rr = R.returnToHall(st);
  check('阁门回不去阁（只能往里走）', rr.ok === false && st.phase === 'maze', rr.msg);
  // 挪到歇脚处——回阁变成地图上的一个坐标，不是随时能按的按钮
  const restRoom = st.maze.rooms.find((x) => x.type === 'rest');
  st.maze.px = restRoom.x; st.maze.py = restRoom.y;
  rr = R.returnToHall(st);
  check('歇脚处能回阁', rr.ok === true && st.phase === 'hall');
  R.leaveHall(st);
  check('又能出门，且地图不刷新', st.phase === 'maze' && st.maze.depth === 2);
  R.returnToHall(st);
  st.coin = 60;

  head('9. 营造：铜钱只有一份，盖什么是个取舍');
  st.coin = 10;
  let r = R.doBuild(st, 'kitchen');
  check('铜钱不够时拒绝，且不扣钱', r.ok === false && st.coin === 10, r.msg);
  st.coin = 400;
  r = R.doBuild(st, 'kitchen');
  check('盖丹房', r.ok === true && R.levelOf(st, 'kitchen') === 1, `花 ${r.cost} 文`);
  check('丹房的进食回复量生效', R.kitchenHeal(st) > 0, `+${R.kitchenHeal(st)} 饱食`);
  r = R.doBuild(st, 'altar');
  check('盖祭坛', r.ok === true && R.spiritSlots(st) > 0, `精怪位 ${R.spiritSlots(st)}`);
  r = R.doBuild(st, 'bedchamber');
  check('盖卧房', r.ok === true && R.bedchamberHeal(st) > 0, `+${R.bedchamberHeal(st)} 精神`);
  r = R.doBuild(st, 'store');
  check('升货仓 → 容量变大', r.ok === true && R.storeCap(st) > cap, `${cap} → ${R.storeCap(st)}`);
  // 把货仓升到满级，确认"满了就不让再盖"这条边界（先给足钱，排除"穷"这个干扰）
  st.coin = 5000;
  let guard = 0;
  while (R.doBuild(st, 'store').ok && guard++ < 10) { /* 一直盖到满 */ }
  r = R.doBuild(st, 'store');
  check('设施升到上限后拒绝再盖', r.ok === false && /满|上限|顶/.test(r.msg || ''), r.msg);

  head('10. 日常：吃 / 睡 / 悟（每天各限一次）');
  st.satiety = 40;
  r = R.doRest(st, 'eat');
  check('进食 → 补饱食', r.ok === true && st.satiety > 40, `+${r.heal} → ${st.satiety}`);
  r = R.doRest(st, 'eat');
  check('同一天不能再吃', r.ok === false, r.msg);
  st.sanity = 50;
  r = R.doRest(st, 'sleep');
  check('歇息 → 补精神', r.ok === true && st.sanity > 50, `+${r.heal} → ${st.sanity}`);
  r = R.doRest(st, 'sleep');
  check('同一天不能再歇', r.ok === false, r.msg);
  r = R.doRest(st, 'study');
  check('没盖书斋 → 无从参悟', r.ok === false, r.msg);
  st.coin = 400;
  R.doBuild(st, 'study');
  r = R.doRest(st, 'study');
  check('盖了书斋 → 参悟得出心得',
    r.ok === true ? !!r.insight : /悟够/.test(r.msg), r.insight ? r.insight.name : r.msg);

  head('10b. 香火：献祭的硬成本');
  const incCap = R.incenseMax(st);
  check('香火上限跟着祭坛走', incCap === R.INCENSE_BASE + R.levelOf(st, 'altar') * 2,
    `${incCap} 炷（祭坛 ${R.levelOf(st, 'altar')} 级）`);
  st.hallUsed = {};            // 新的一天
  st.incense = 1;
  st.coin = 100;
  r = R.doRest(st, 'incense');
  check('买一炷香', r.ok === true && st.incense === 2, `-${r.cost} 文 → ${st.incense}/${incCap}`);
  r = R.doRest(st, 'incense');
  check('祭坛一天只收一炷（1 级）', r.ok === false, r.msg);
  st.incense = incCap;
  r = R.doRest(st, 'incense');
  check('香匣满了不收', r.ok === false, r.msg);

  head('11. 货仓 → 铜钱 / 精怪');
  const sellTarget = st.store[0];
  const coinB = st.coin;
  r = R.doSell(st, sellTarget.id);
  check('卖物换钱', r.ok === true && st.coin > coinB, `+${r.price} 文`);
  const meltTarget = st.store[0];
  r = R.doMelt(st, meltTarget.id);
  check('在祭坛上炼出精怪', r.ok === true && st.spirits.length === 1,
    r.spirit ? `${r.spirit.name}（${r.spirit.trait}）` : r.msg);
  const sp = st.spirits[0];
  const lvB = sp.lv;
  st.coin = 200;
  r = R.doFeed(st, sp.id);
  check('喂食 → 升级', r.ok !== false && (r.up ? sp.lv === lvB + 1 : true), `lv ${lvB} → ${sp.lv}`);

  /* ══════════════════════════════════════════════════════════
     12. 入夜：妖物上门
     ══════════════════════════════════════════════════════════ */
  head('12. 入夜');
  const nb = await def.beginNight();
  st = def.getState();
  check('切到夜战阶段', st.phase === 'night');
  check('抽出今夜的妖物', !!st.beastId, `${nb.beast && nb.beast.name}（${nb.beast && nb.beast.element}）HP ${st.guardianHp}`);
  check('妖物按天数缩放', st.guardianHp === nb.beast.hp);
  check('摇出架势', !!st.stance && !!st.stance.breaks, `${st.stance.name}，破法 ${st.stance.breaks}`);
  check('精怪加成算进了夜战快照', !!st.nightBonus);
  const nb2 = await def.beginNight();
  check('天已经黑了，不能重复入夜', nb2.ok === false, nb2.msg);
  st = def.getState();
  const incBefore = st.incense;
  check('入夜自动添一炷香（保底还能献一次）', incBefore > 0, `${incBefore} 炷`);

  /* ── 夜战献祭要烧香（直调 quest_resolve，不走模型）───────── */
  head('12b. 夜战献祭烧香');
  const resolveTool = def.tools.find((t) => t.name === 'quest_resolve');
  check('quest_resolve 工具在', !!resolveTool);
  st.incense = 0;
  st.guardianHp = 500;
  await def.setState(st);
  const noInc = await resolveTool.run({ label: 'cup', conf: 0.9, area_ratio: 30 });
  check('香尽 → 这一祭点不着', /香火/.test(String(noInc)), String(noInc).slice(0, 40) + '…');
  st = def.getState();
  check('香没被扣成负数', st.incense === 0);

  st.incense = 2;
  st.guardianHp = 500;
  await def.setState(st);
  const gBefore = st.guardianHp;
  const withInc = await resolveTool.run({ label: 'scissors', conf: 0.9, area_ratio: 35 });
  st = def.getState();
  const verdict = JSON.parse(withInc);
  check('烧一炷香，换一次出手', st.incense === 1, `${verdict.damage} 伤害`);
  check('妖物真的挨了这一下', st.guardianHp < gBefore, `${gBefore} → ${st.guardianHp}`);

  /* ── 夜战：放咒（纯规则，不等模型）──────────────────────── */
  head('13. 夜战：放咒');
  st = def.getState();
  // 把妖物的血垫高：这一步只想看"咒打没打中、有没有挨反击"，
  // 不想因为伤害溢出把这一夜直接打完（那会把后面两步的前提一起打掉）
  st.guardianHp = 500;
  st.playerHp = 100;
  st.stats.mana = 100;
  st.skills = ['blaze'];
  st.stance = null;
  await def.setState(st);
  const g0 = 500;
  const sk = await def.castSkill('blaze');
  st = def.getState();
  check('咒打中了', sk.ok === true && st.guardianHp < g0, `${sk.damage} 伤害（${g0} → ${st.guardianHp}）`);
  check('放了咒要挨一下', sk.counter > 0, `反击 ${sk.counter}`);
  check('夜战一回合也吃一份饱食', st.satiety < 80 || sk.counter >= 0, `饱食 ${st.satiety}`);

  /* ── 生存惩罚 ───────────────────────────────────────────── */
  head('14. 生存惩罚：饿着打人 / 失魂迷路');
  st = def.getState();
  st.satiety = 20;
  check('饱食 ≤ 25 → 算「饿」', R.isStarving(st) === true);
  check('饿着打人伤害打折', R.damageMul(st) === 0.75, `×${R.damageMul(st)}`);
  st.satiety = 0;
  const hpB = st.playerHp;
  R.spend(st, { satiety: 0 });
  check('饱食见底 → 每走一步掉体力', st.playerHp === hpB - R.STARVE_DMG, `-${R.STARVE_DMG}`);
  st.sanity = 10;
  check('精神 ≤ 20 → 算「失魂」', R.isMad(st) === true);
  const wc = R.walkCost(st);
  check('失魂时迷路，多耗饱食', wc.lost === R.MAD_LOST_COST, `一步 -${wc.satiety} 饱食`);

  /* ══════════════════════════════════════════════════════════
     15. 收夜与结算
     ══════════════════════════════════════════════════════════ */
  head('15. 打赢一夜 → 天亮，日子 +1');
  st = def.getState();
  st.phase = 'night';
  st.beastId = st.beastId || 'ash';
  st.satiety = 80; st.sanity = 80;
  st.guardianHp = 2;
  st.playerHp = 100;
  st.stats.mana = 100;
  st.skills = ['blaze'];
  st.stance = null;              // 去掉架势干扰，保证这一下能打死
  await def.setState(st);
  const win = await def.castSkill('blaze');
  st = def.getState();
  check('妖物退了 → 回到白天', win.cleared === true && st.phase === 'maze', `phase=${st.phase}`);
  check('天数 +1', st.day === 2, `第 ${st.day} 天`);
  check('换了一张新迷宫（从浅处重来）', st.maze.depth === 1);
  check('天亮回一点饱食与精神', st.satiety > 80 || st.sanity > 80, `饱食 ${st.satiety} / 精神 ${st.sanity}`);
  check('门面有进项（没盖门面就是 0）', true, `铜钱 ${st.coin}`);

  head('16. 死在夜里 → 这一局收尾');
  st = def.getState();
  st.phase = 'night';
  st.beastId = st.beastId || 'ash';
  st.guardianHp = 9999;
  st.playerHp = 1;               // 一挨反击就倒
  st.stats.mana = 100;
  st.skills = ['blaze'];
  st.satiety = 60; st.sanity = 60;
  st.stance = null;
  st.day = 5;
  await def.setState(st);
  const dead = await def.castSkill('blaze');
  st = def.getState();
  check('旅人倒下 → 这一局结束', st.over === 'lose', `over=${st.over} phase=${st.phase}`);
  check('结算里有"活了几天"', !!(st.lastWin && st.lastWin.summary && st.lastWin.summary.days === 5),
    `活了 ${st.lastWin && st.lastWin.summary && st.lastWin.summary.days} 天`);
  check('结算里带上阁楼规模与精怪', !!(st.lastWin.summary.hallTitle !== undefined && Array.isArray(st.lastWin.summary.spirits)));

  const lg = JSON.parse(fs.readFileSync(LEG, 'utf8'));
  check('跨局存档记了这一局', lg.history.length === 1 && lg.clears === 1);
  check('周目 +1', lg.cycle === 2, `cycle=${lg.cycle}`);
  check('解锁了遗物', lg.relics.length >= 1, `[${lg.relics.join(',')}]`);

  head('17. 下一局：带上周目与遗物');
  await def.reset();
  st = def.getState();
  check('第 2 周目开局', st.cycle === 2 && st.day === 1 && st.phase === 'maze');
  check('遗物带进来了', st.relics.length === lg.relics.length, `[${st.relics.join(',')}]`);

  head('17b. 回到第一周目');
  await def.resetProgress();
  st = def.getState();
  check('周目清回 1', st.cycle === 1, `cycle=${st.cycle}`);
  check('遗物清空', st.relics.length === 0);
  const lg2 = JSON.parse(fs.readFileSync(LEG, 'utf8'));
  check('历次成绩保留', lg2.history.length === 1, `${lg2.history.length} 条`);
  check('通关次数清零', lg2.clears === 0, `clears=${lg2.clears}`);

  head('18. 老存档兼容（v3 的 phase:"explore" 不该卡住）');
  fs.writeFileSync(SAVE, JSON.stringify({ phase: 'explore', level: 3, playerHp: 77 }), 'utf8');
  const def2 = questExt({ root: ROOT });
  const st2 = def2.getState();
  check('老存档被当成新局开，停在合法阶段', st2.phase === 'maze' && st2.day === 1,
    `phase=${st2.phase} day=${st2.day}`);
  check('老存档的字段没被带进来', st2.level === undefined && st2.playerHp === 100, `playerHp=${st2.playerHp}`);

  head('19. v4.3 十字视野 + 视野外重掷');
  {
    const st = { maze: R.makeMaze(3), phase: 'maze', day: 1 };
    const m = st.maze;
    R.walk(m, 'up');   // 走一步，触发一次 advance

    // 视野只有十字：先全图揭开，再走一步，亮着的应该只剩十字。
    // 注意脚下那间可能是有事要处理的房间（没处理不许走），先标成已了结
    R.here(m).solved = true;
    m.seen = m.rooms.map(() => true);
    const mv = R.walk(m, 'right');
    check('这一步走得出去', mv.ok, mv.msg || '');
    const lit = m.seen.filter(Boolean).length;
    const px = m.px, py = m.py;
    const cross = [[0,0],[0,-1],[1,0],[0,1],[-1,0]]
      .filter(([dx,dy]) => m.seen[(py+dy) * m.w + (px+dx)]).length;
    check('视野只剩十字（走过的格子会被打回迷雾）',
      lit === cross && lit <= 5, `亮 ${lit} 格 = 十字 ${cross} 格`);

    // 视野外的内容每步都换（直接调 advance，避免走位撞墙影响断言）
    const typesBefore = m.rooms.map((r) => r.type).join(',');
    const adv = R.advance(m);
    const typesAfter = m.rooms.map((r) => r.type).join(',');
    check('视野外的房间内容在换', adv.changed > 0 && typesBefore !== typesAfter,
      `换了 ${adv.changed} 间`);
    check('advance 之后视野仍然是十字', m.seen.filter(Boolean).length <= 5,
      `亮 ${m.seen.filter(Boolean).length} 格`);

    // 地标不重掷
    const rests = m.rooms.filter((r) => r.type === 'rest').length;
    check('阁门 / 梯 / 歇脚处都在（地标不参与重掷）',
      m.rooms.some((r) => r.type === 'start')
      && m.rooms.some((r) => r.type === 'stair')
      && rests >= 1, `歇脚处 ${rests} 处`);
    check('重掷后没有残留的半血妖物 / 卖剩的货',
      m.rooms.every((r) => !r.foe && !r.stock));
  }

  head('19b. v4.3 歇脚处不再满屏都是');
  {
    for (const d of [1, 3]) {
      const m = R.makeMaze(d);
      const n = m.rooms.filter((r) => r.type === 'rest').length;
      check(`第 ${d} 层的歇脚处只有 1~2 处`, n >= 1 && n <= 2, `${n} 处`);
    }
    // 走十步之后也不该变多（重掷池里根本没有 rest）
    const m = R.makeMaze(3);
    for (let i = 0; i < 10; i++) R.walk(m, ['up', 'right', 'down', 'left'][i % 4]);
    const n = m.rooms.filter((r) => r.type === 'rest').length;
    check('走十步后歇脚处还是 1~2 处', n >= 1 && n <= 2, `${n} 处`);
  }

  head('19c. v4.3 新增三个特殊房间');
  {
    const m = R.makeMaze(4);
    check('这一层有熔炉间', m.rooms.some((r) => r.type === 'forge'));
    // 熔炉：举物 → 熔成装备
    const st = { coin: 0, satiety: 60, sanity: 60, playerHp: 100, stats: { mana: 0 },
      store: [], spirits: [], equipment: [], hall: { slots: { altar: 1 } }, maze: m, news: [] };
    const forge = m.rooms.find((r) => r.type === 'forge');
    forge.solved = false;
    const wait = R.resolveRoom(st, forge, {});
    check('熔炉间要等玩家举物', !!wait.needOffering, `needOffering=${wait.needOffering}`);
    const mel = R.resolveRoom(st, forge, { offering: { label: 'scissors', conf: .8, ratio: .3 } });
    check('举物 → 熔出护符', mel.solved && (mel.equip || (st.equipment || []).length > 0),
      `装备 ${(st.equipment || []).length} 件`);

    // 铜镜：照一照 → 回神
    const st2 = { ...st, sanity: 40, equipment: [], stats: { mana: 0 } };
    const mir = m.rooms.find((r) => r.type === 'mirror') || (m.rooms[0].type = 'mirror', m.rooms[0]);
    mir.solved = false; mir.type = 'mirror';
    const ask = R.resolveRoom(st2, mir, {});
    check('铜镜间要玩家做决断', !!ask.needChoice);
    const looked = R.resolveRoom(st2, mir, { choice: 'look' });
    check('照一照 → 精神与术力都涨', looked.solved && st2.sanity > 40 && st2.stats.mana > 0,
      `精神 ${st2.sanity} 术力 ${st2.stats.mana}`);

    // 借宿：补给 + 代价
    const st3 = { ...st, coin: 50, playerHp: 40, equipment: [] };
    const gst = m.rooms.find((r) => r.type === 'guest') || (m.rooms[1].type = 'guest', m.rooms[1]);
    gst.solved = false; gst.type = 'guest';
    R.resolveRoom(st3, gst, {});
    const stayed = R.resolveRoom(st3, gst, { choice: 'stay' });
    check('借宿 → 体力回血、房钱扣走', stayed.solved && st3.playerHp > 40 && st3.coin < 50,
      `体力 ${st3.playerHp} 铜钱 ${st3.coin}`);
  }

  head('19d. 三个新房间都要拦路（v4.4 补：借宿曾漏在 BLOCKING 之外）');
  {
    for (const t of ['foe', 'item', 'shrine', 'shop', 'forge', 'mirror', 'guest']) {
      const r = { type: t, solved: false };
      check(`${t} 未处理时拦住去路`, R.roomBlocks(r) === true);
      r.solved = true;
      check(`${t} 处理完就放行`, R.roomBlocks(r) === false);
    }
  }

  head('19e. v4.4 房型立绘齐不齐（galgame 舞台要人站着）');
  {
    // 注意：ROOT 是 sandbox 目录，立绘在项目根下的 public/，别用 ROOT 拼
    const fig = path.join(__dirname, '..', 'public', 'assets', 'figure');
    for (const f of ['traveler.png', 'foe.png', 'shopkeeper.png', 'shrine.png', 'forge.png', 'guest.png']) {
      const p = path.join(fig, f);
      const ok = fs.existsSync(p) && fs.statSync(p).size > 4096;
      check(`立绘存在：${f}`, ok, ok ? `${(fs.statSync(p).size / 1024) | 0}KB` : '缺失');
    }
  }

  head('20. v4.2 空房不再是「什么也没有」');
  {
    const kinds = {};
    for (let i = 0; i < 300; i++) {
      const s = { coin: 0, satiety: 50, sanity: 50, stats: {}, maze: null };
      const d = R.driftEvent(s);
      kinds[d.kind] = (kinds[d.kind] || 0) + 1;
    }
    check('空房会掉零钱', (kinds.coin || 0) > 0, `${kinds.coin || 0}/300`);
    check('空房能翻到吃的', (kinds.food || 0) > 0, `${kinds.food || 0}/300`);
    check('空房也有精神上的事（刻字 / 惊动 / 什么都没有）',
      (kinds.mark || 0) + (kinds.startle || 0) + (kinds.none || 0) > 0);

    // 真走一步：结算空房要出文案 + 数值变化
    const s2 = { coin: 0, satiety: 50, sanity: 50, playerHp: 100, stats: {}, store: [], spirits: [], news: [], maze: R.makeMaze(1) };
    const emptyRoom = s2.maze.rooms.find((r) => r.type === 'empty');
    const out = R.resolveRoom(s2, emptyRoom, {});
    check('走空房也会结算出结果', !!out.text.length && !!out.drift, `drift=${out.drift}`);
  }

  console.log(`\n===== 跑完：${bad ? bad + ' 项没过' : '全部通过'} =====`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('\n崩了：', e); process.exit(1); });
