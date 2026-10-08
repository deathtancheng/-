/**
 * 随机房间迷宫 —— 肉鸽的主体
 * ------------------------------------------------------------------
 * 每天出门，走进一张新生成的 5×5 房间图（随深度变密）。
 * 房间被迷雾盖着，只看得见自己周围一圈；走到格子上才知道里面是什么。
 *
 * 这个文件只管**几何**：生成、视野、能不能走、看得见什么。
 * 房间里面发生了什么（遇妖、开箱、见商贩）在 rooms.js 里裁决。
 * 分开是因为地图要能被 UI 完整重放（迷雾、位置），
 * 而房间裁决会改血量/铜钱/精怪——两件事不该混在一个文件里。
 *
 * v4.1 补了三条规则，都是被玩家"钻空子"逼出来的：
 *   1. 陷阱伪装成空房 —— 看得见的陷阱不叫陷阱，玩家永远绕得开
 *   2. 歇脚处（rest）—— 回阁不再随时随地，得先走到能歇脚的地方
 *   3. roomBlocks —— 妖物/拾物/神龛这类房间没处理完，不许继续走
 */

const { MAZE_SIZE } = require('./constants');

/** 房间类型。stair 是唯一的出口，走到就能下潜 */
const ROOM_TYPES = ['empty', 'item', 'foe', 'trap', 'chest', 'shrine', 'shop', 'forge', 'mirror', 'guest', 'rest', 'doctor', 'bard', 'hermit'];

const ROOM_META = {
  start:  { icon: '门', label: '阁门', tone: 'gate' },
  empty:  { icon: '·',  label: '空房', tone: 'plain' },
  item:   { icon: '拾', label: '拾物处', tone: 'good' },
  foe:    { icon: '妖', label: '妖物', tone: 'bad' },
  trap:   { icon: '阱', label: '陷阱', tone: 'bad' },
  chest:  { icon: '箱', label: '箱笼', tone: 'good' },
  shrine: { icon: '龛', label: '神龛', tone: 'odd' },
  shop:   { icon: '贩', label: '行脚商', tone: 'odd' },
  forge:  { icon: '炉', label: '熔炉间', tone: 'gold' },
  mirror: { icon: '镜', label: '铜镜间', tone: 'odd' },
  guest:  { icon: '宿', label: '借宿', tone: 'good' },
  doctor: { icon: '医', label: '游方郎中', tone: 'odd' },
  bard:   { icon: '谈', label: '说书人', tone: 'odd' },
  hermit: { icon: '隐', label: '传功人', tone: 'gold' },
  rest:   { icon: '歇', label: '歇脚处', tone: 'good' },
  stair:  { icon: '梯', label: '下楼的梯', tone: 'gate' },
};

/** 房间里要不要玩家再出一次手——没有它就不能走（前端据此弹场景） */
const BLOCKING = ['foe', 'item', 'shrine', 'shop', 'forge', 'mirror', 'guest', 'doctor', 'bard', 'hermit'];

/**
 * 地标：不参与重掷、也不在地图上显示的三类格子。
 * 阁门和梯子固定在角落，玩家靠"东南角是来路、西北角是梯子"的方向感导航；
 * 歇脚处是回阁的唯一坐标，会动的话玩家就永远回不了家。
 */
const LANDMARK = new Set(['start', 'stair', 'rest']);

function idx(maze, x, y) {
  return y * maze.w + x;
}

function inBounds(maze, x, y) {
  return x >= 0 && y >= 0 && x < maze.w && y < maze.h;
}

function roomAt(maze, x, y) {
  return inBounds(maze, x, y) ? maze.rooms[idx(maze, x, y)] : null;
}

/**
 * 玩家站在门外时"看起来"是什么。
 * 陷阱一律伪装成空房：地图上看得见的陷阱，玩家永远绕得过去，
 * 那它就只是一个装饰品。踩进去才知道，这才叫陷阱。
 */
function surfaceType(room) {
  if (!room) return 'empty';
  return room.type === 'trap' ? 'empty' : room.type;
}

/**
 * 某一层的内容配比：每种房间放几个。
 * 生成和"重掷"共用这一张表——两处各写一份的话，走着走着地图的
 * 密度就会跟刚开局时不一样，重掷出来的房间也会不对劲。
 *
 * 歇脚处**不在这里**：它是地标，数量由 makeMaze 单独放（1~2 处），
 * 早先把它混进配比表，结果重掷一次就撒满一屏"歇"——回阁太容易，
 * 迷宫的探索也就没了（这是玩家实机反馈拍回来的）。
 */
function roomPool(depth = 1) {
  const d = Math.max(1, Number(depth) || 1);
  const pool = [];
  const put = (t, n) => { for (let i = 0; i < n; i++) pool.push(t); };
  put('item', 3);
  put('foe', Math.min(4, 2 + Math.floor(d / 2)));
  put('trap', 2 + Math.floor(d / 3));
  put('chest', 1 + (d % 2));
  put('shrine', 1);
  put('shop', d % 2 === 1 ? 1 : 0);
  put('forge', 1);
  put('mirror', d >= 2 ? 1 : 0);
  put('guest', d % 3 === 2 ? 1 : 0);
  // v4.5.1：三个会跟你打交道的 NPC——郎中续命、说书人给心得、传功人教法术
  put('doctor', 1);
  put('bard', 1);
  put('hermit', d >= 2 ? 1 : 0);
  return pool;
}

/**
 * 生成一张迷宫图。
 * @param {number} depth 第几层迷宫（越深房间越多、妖物越凶）
 * @param {() => number} rng 抽随机数，测试时可注入
 */
function makeMaze(depth = 1, rng = Math.random) {
  const w = MAZE_SIZE;
  const h = MAZE_SIZE;
  const d = Math.max(1, Number(depth) || 1);
  const rooms = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      rooms.push({ x, y, type: 'empty', solved: false });
    }
  }

  const start = { x: 0, y: h - 1 };
  const stair = { x: w - 1, y: 0 };
  roomAt2(rooms, w, start.x, start.y).type = 'start';
  roomAt2(rooms, w, stair.x, stair.y).type = 'stair';
  roomAt2(rooms, w, start.x, start.y).solved = true;  // 站的地方不用再触发

  const pool = roomPool(d);
  // 歇脚处单独放：浅层一处，深层两处。绝不放进上面的配比池——
  // 放进去的话每次重掷都会重新撒一遍，满屏"歇"，回阁也就没了难度
  pool.push('rest');
  if (d >= 3) pool.push('rest');

  const free = [];
  for (const r of rooms) {
    if (r.type === 'empty' && !(r.x === start.x && r.y === start.y)) free.push(r);
  }
  shuffle(free, rng);
  for (let i = 0; i < free.length; i++) {
    if (i < pool.length) free[i].type = pool[i];
  }

  const maze = {
    depth: d,
    w, h,
    rooms,
    px: start.x,
    py: start.y,
    stair,
    seen: rooms.map(() => false),
    log: [],
  };
  reveal(maze, start.x, start.y);
  return maze;
}

/**
 * 走一步之后：视野重画 + 视野外重掷（v4.2 的「宅子在动」）
 * ------------------------------------------------------------------
 * 需求很明确：**只看十字，视野外看不见、而且每次都在变**。
 * 理由：只要走过的地方还留在图上，玩家就会背地图——「左下那间是箱笼」
 * 这种记忆会让随机性失效，迷雾也就白做了。
 *
 * 每一步之后做三件事：
 *   1. 以新位置为中心重画十字视野（只亮 5 格）
 *   2. 视野外的格子 seen 全部打回迷雾 —— 图上只留一个十字
 *   3. 视野外的格子重新掷内容（下一批东西在门后等着）
 *
 * 三个「地标」例外（LANDMARK）：阁门（起点，左下）、下楼的梯（右上）、
 * 歇脚处（回阁的落脚点）。它们不重掷，也不再显示，只能靠方向感记。
 * 歇脚处必须是地标：它是「今天到此为止」的坐标，会动就没法回家了。
 *
 * @returns {{changed:number, view:number}} 换了多少间、这次亮了几格
 */
function advance(maze, rng = Math.random) {
  const view = crossCells(maze, maze.px, maze.py);
  const inView = new Set(view);

  // 1+2：视野重画，视野外打回迷雾
  for (let i = 0; i < maze.seen.length; i++) {
    maze.seen[i] = inView.has(maze.rooms[i]);
  }

  // 3：视野外重掷内容
  const movable = maze.rooms.filter(
    (r) => !inView.has(r) && !LANDMARK.has(r.type)
  );
  shuffle(movable, rng);
  const bag = roomPool(maze.depth);
  let changed = 0;
  for (let i = 0; i < movable.length; i++) {
    const r = movable[i];
    const next = i < bag.length ? bag[i] : 'empty';
    if (r.type === next && !r.foe) continue;
    r.type = next;
    r.solved = next === 'empty' ? r.solved : false;
    delete r.foe;
    delete r.stock;
    changed++;
  }
  return { changed, view: view.length };
}

/** 内部用：按扁平数组取格子（生成阶段还没构造出 maze 对象） */
function roomAt2(rooms, w, x, y) {
  return rooms[y * w + x];
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 视野：只有**十字**（自己 + 上下左右）。
 *
 * 原来是 3×3 的方块视野，四个斜角也看得见——于是玩家能"隔着墙角"预判，
 * 迷雾只挡住两格之外，策略空间被压得很小。改成十字之后，
 * 看得见的只有正前方那一条，斜角永远是谜。
 */
function reveal(maze, x, y) {
  const dirs = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(maze, nx, ny)) maze.seen[idx(maze, nx, ny)] = true;
  }
}

/** 十字视野覆盖到的格子（含自己） */
function crossCells(maze, x, y) {
  const out = [];
  const dirs = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(maze, nx, ny)) out.push(roomAt(maze, nx, ny));
  }
  return out;
}

/** 四邻，只返回在界内的 */
function neighbors(maze, x, y) {
  const out = [];
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(maze, nx, ny)) out.push({ x: nx, y: ny, dir: dirName(dx, dy) });
  }
  return out;
}

function dirName(dx, dy) {
  if (dy === -1) return 'up';
  if (dy === 1) return 'down';
  if (dx === -1) return 'left';
  return 'right';
}

/**
 * 这一格处理完了没有。没处理完就不许走——
 * 否则玩家可以走进妖物房看一眼、转身出门，遇妖等于没遇。
 */
function roomBlocks(room) {
  if (!room) return false;
  if (!BLOCKING.includes(room.type)) return false;
  return !room.solved;
}

/** 现在能不能迈步 */
function canLeave(maze) {
  return !roomBlocks(here(maze));
}

/** 走不了时给玩家看的一句话 */
function blockHint(maze) {
  const r = here(maze);
  const t = BLOCKING.includes(r && r.type) ? r.type : null;
  if (t === 'foe') return '妖物还堵在门口——不把它打散，这一步迈不出去。';
  if (t === 'item') return '屋里的东西还没处理，先决定收不收。';
  if (t === 'shrine') return '香灰还是温的，先对这座龛做个决断。';
  if (t === 'shop') return '商贩还在等你答话，先跟他了结。';
  return '这一格还没处理完。';
}

/**
 * 走一格。只做「能不能走」和「走到哪」，房间内容交给 rooms.js。
 * 视野与重掷交给 advance —— 走完立刻生效，界面拿到的就是新地图。
 * @returns {{ok:boolean, msg?:string, room?:object, moved?:boolean, changed?:number}}
 */
function walk(maze, dir) {
  const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
  if (!delta) return { ok: false, msg: '不知道往哪走。' };
  if (!canLeave(maze)) return { ok: false, blocked: true, msg: blockHint(maze) };
  const nx = maze.px + delta[0];
  const ny = maze.py + delta[1];
  if (!inBounds(maze, nx, ny)) return { ok: false, msg: '那边是墙。' };
  maze.px = nx;
  maze.py = ny;
  // 视野重画 + 视野外重掷：这一步之前地图必须换，
  // 否则玩家会在旧地图上做决定，再被新内容打脸
  const adv = advance(maze);
  return { ok: true, moved: true, room: roomAt(maze, nx, ny), changed: adv.changed, view: adv.view };
}

/** 当前位置 */
function here(maze) {
  return roomAt(maze, maze.px, maze.py);
}

/**
 * 脚下是不是能回阁的地方。
 * 只认「歇脚处」——阁门不算：那一截走廊已经塌了，回不去。
 * 于是"今天就到这儿"变成地图上的一个坐标，玩家得先走到那儿。
 */
function isRestSpot(maze) {
  const r = here(maze);
  return !!r && r.type === 'rest';
}

/** 到最近的未探明区域还有没有路可走（给 UI 判断死路用，当前地图不会死路） */
function hasUnseen(maze) {
  return maze.seen.some((s) => !s);
}

/** 给模型/日志读的一段地图描述（陷阱同样按表面类型说，别漏嘴） */
function describeMaze(maze) {
  if (!maze) return '（没有迷宫）';
  const cur = here(maze);
  const around = neighbors(maze, maze.px, maze.py)
    .map((n) => {
      const r = roomAt(maze, n.x, n.y);
      const meta = ROOM_META[surfaceType(r)] || ROOM_META.empty;
      return `${n.dir === 'up' ? '上' : n.dir === 'down' ? '下' : n.dir === 'left' ? '左' : '右'}：${meta.label}`;
    })
    .join('，');
  return [
    `迷宫第 ${maze.depth} 层，${maze.w}×${maze.h}，你站在 ${cur.x},${cur.y}（${(ROOM_META[cur.type] || {}).label || '空房'}）`,
    `四周：${around}`,
    isRestSpot(maze) ? '这里可以歇脚，也可以就此回阁。' : '这一带回不去阁——得先在地图上找到一处歇脚的地方。',
    hasUnseen(maze) ? '还有没探明的房间。' : '这一层已经走遍了。',
  ].join('\n');
}

/**
 * 给前端用的一份可渲染格子视图：迷雾未揭的不给类型，陷阱给"空房"。
 * 这是**唯一**的地图出口，run.js 的快照也走它，免得两边各写一套走岔。
 */
function cellViews(maze) {
  if (!maze) return [];
  return maze.rooms.map((r, i) => {
    const seen = maze.seen[i];
    const t = seen ? surfaceType(r) : null;
    return {
      x: r.x,
      y: r.y,
      seen,
      solved: r.solved,
      // 没看见的格子不暴露类型——不然迷雾就白做了
      type: t,
      icon: seen ? (ROOM_META[t] || ROOM_META.empty).icon : '',
      // 站上去就必须处理完的房间（前端据此判断"还被扣着"）
      blocking: seen && roomBlocks(r),
      rest: seen && r.type === 'rest',
      foeHp: r.foe && !r.solved ? r.foe.hp : null,
    };
  });
}

/**
 * 地标方位：视野只剩十字之后，得给玩家一点方向感。
 * 不给坐标、只给"东南·不远"这种粗粒度提示——
 * 够玩家决定往哪走，又不至于把迷雾变���小地图。
 * @returns {{stair?:string, rest?:string, gate?:string}}
 */
function landmarks(maze) {
  const dirs = [
    [0, -1, '正北'], [1, -1, '东北'], [1, 0, '正东'], [1, 1, '东南'],
    [0, 1, '正南'], [-1, 1, '西南'], [-1, 0, '正西'], [-1, -1, '西北'],
  ];
  const near = (d) => (d <= 2 ? '不远' : d <= 4 ? '还有些路' : '还远');
  const where = (t) => {
    const target = maze.rooms.find((r) => r.type === t);
    if (!target) return null;
    const dx = target.x - maze.px;
    const dy = target.y - maze.py;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist === 0) return '就在脚下';
    const best = dirs.reduce((a, b) => (
      Math.abs(b[0] - dx) + Math.abs(b[1] - dy) < Math.abs(a[0] - dx) + Math.abs(a[1] - dy) ? b : a
    ));
    return `${best[2]}·${near(dist)}`;
  };
  return { stair: where('stair'), rest: where('rest'), gate: where('start') };
}

function mazeSnapshot(maze) {
  if (!maze) return null;
  return {
    depth: maze.depth,
    w: maze.w,
    h: maze.h,
    px: maze.px,
    py: maze.py,
    stair: maze.stair,
    onRest: isRestSpot(maze),
    canLeave: canLeave(maze),
    landmarks: landmarks(maze),
    cells: cellViews(maze),
  };
}

module.exports = {
  ROOM_TYPES,
  ROOM_META,
  BLOCKING,
  LANDMARK,
  inBounds,
  roomAt,
  makeMaze,
  roomPool,
  advance,
  crossCells,
  reveal,
  neighbors,
  walk,
  here,
  isRestSpot,
  hasUnseen,
  roomBlocks,
  canLeave,
  blockHint,
  surfaceType,
  landmarks,
  describeMaze,
  cellViews,
  mazeSnapshot,
  shuffle,
};
