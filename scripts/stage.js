#!/usr/bin/env node
/**
 * 摆一个局面（调试与截图用）
 * ------------------------------------------------------------------
 * 直接调规则层造一个局面写进存档，绕过"走位踩房间"的过程。
 *
 * 为什么需要它：截图和无头验证要的是**稳定的入口状态**——
 * 比如"正站在妖物房上、场景已经弹出来"。这种状态靠 travel 撞是撞不出来的
 * （房间类型随机、路上还可能被别的房间扣住），所以干脆直接摆。
 *
 * 用法：
 *   node scripts/stage.js fresh   开局，站在阁门
 *   node scripts/stage.js empty   站在一间普通空房上（不弹场景）
 *   node scripts/stage.js foe     站在妖物房上（场景：必须打）
 *   node scripts/stage.js item    站在拾物处上（场景：等你举物）
 *   node scripts/stage.js shop    站在行脚商前
 *   node scripts/stage.js rest    站在歇脚处上（这里能回阁）
 *   node scripts/stage.js forge   站在熔炉间前（举物熔成护符）
 *   node scripts/stage.js mirror  站在铜镜间前
 *   node scripts/stage.js guest   站在借宿那家门前
 *   node scripts/stage.js dressed 穿着三件装备（看旅人形象卡的换装效果）
 *   node scripts/stage.js hall    在阁里，兜里有钱、仓里有货
 *   node scripts/stage.js night   已入夜，妖物已经上门
 */

const fs = require('fs');
const path = require('path');
const R = require('../src/game/rules');

const SAVE = path.join(__dirname, '..', 'sandbox', 'game', 'save.json');
const which = String(process.argv[2] || 'fresh');

const st = R.newRun();

/** 把旅人挪到第一个该类型的房间上，并揭开它周围一圈 */
function moveTo(type) {
  let r = st.maze.rooms.find((x) => x.type === type);
  // 有些房型只在特定深度出现（铜镜间 depth≥2、借宿 depth%3===2），
  // 当前这张图上没有就换张深一点的图重试，别让脚本直接崩掉
  if (!r) {
    for (const d of [2, 3, 4, 5, 6, 7, 8]) {
      st.maze = R.makeMaze(d);
      r = st.maze.rooms.find((x) => x.type === type);
      if (r) break;
    }
  }
  if (!r) throw new Error(`换到第 8 层还是没有 ${type} 房间`);
  st.maze.px = r.x;
  st.maze.py = r.y;
  R.reveal(st.maze, r.x, r.y);
  return r;
}

switch (which) {
  case 'empty': {
    // 避开阁门那一格（它是 start）
    const r = st.maze.rooms.find((x) => x.type === 'empty' && !(x.x === 0 && x.y === st.maze.h - 1));
    if (r) { st.maze.px = r.x; st.maze.py = r.y; R.reveal(st.maze, r.x, r.y); }
    break;
  }
  case 'foe':    moveTo('foe'); break;
  case 'item':   moveTo('item'); break;
  case 'rest':   moveTo('rest'); break;
  case 'shop':   moveTo('shop'); break;
  case 'shrine': moveTo('shrine'); break;
  case 'chest':  moveTo('chest'); break;
  case 'forge':  moveTo('forge'); break;
  case 'mirror': moveTo('mirror'); break;
  case 'guest':  moveTo('guest'); break;

  /** 穿着一身装备：旅人形象卡要看的就是这个 */
  case 'dressed': {
    st.equipment = [
      R.makeEquipment('scissors', 'metal'),
      R.makeEquipment('toaster', 'fire'),
      R.makeEquipment('umbrella', 'guard'),
    ];
    st.cycle = 2;
    st.day = 4;
    const r = st.maze.rooms.find((x) => x.type === 'empty' && !(x.x === 0 && x.y === st.maze.h - 1));
    if (r) { st.maze.px = r.x; st.maze.py = r.y; R.reveal(st.maze, r.x, r.y); }
    break;
  }

  case 'hall': {
    st.phase = 'hall';
    st.coin = 260;                       // 够盖一两间房，营造那栏才有得看
    st.incense = 4;
    st.satiety = 62;
    st.sanity = 74;
    st.store.push(R.makeItem({ label: 'cup', conf: 0.92, ratio: 0.3, depth: 1 }));
    st.store.push(R.makeItem({ label: 'book', conf: 0.71, ratio: 0.22, depth: 2 }));
    st.store.push(R.makeItem({ label: 'scissors', conf: 0.63, ratio: 0.18, depth: 3 }));
    break;
  }

  case 'night': {
    // 白天先攒点家底，夜里那屏才不会空着
    st.phase = 'maze';
    st.coin = 120;
    st.hall = { slots: { altar: 1, shopfront: 1 } };
    st.store.push(R.makeItem({ label: 'potted plant', conf: 0.88, ratio: 0.26, depth: 1 }));
    st.spirits.push(R.makeSpirit({ label: 'cup', element: 'water' }));
    R.beginNight(st);
    break;
  }

  default: break;   // fresh：原样开局
}

fs.mkdirSync(path.dirname(SAVE), { recursive: true });
fs.writeFileSync(SAVE, JSON.stringify(st, null, 2), 'utf8');

const at = st.maze ? `${st.maze.px},${st.maze.py}` : '—';
const there = st.maze && st.maze.rooms.find((r) => r.x === st.maze.px && r.y === st.maze.py);
console.log(`已摆好局面：${which} ｜ 第 ${st.day} 天 ｜ ${st.phase} ｜ 站在 ${at}（${there ? there.type : '?'}）`
  + ` ｜ 香火 ${st.incense} ｜ 铜钱 ${st.coin}`);
