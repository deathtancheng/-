/**
 * 服务端上下文 —— 跨路由共享的可变状态
 * ------------------------------------------------------------------
 * Harness 实例是懒加载且全局唯一的（起一次要几秒，不能每个请求都起）。
 * 正在跑的回合也要记下来：同一时刻只允许一个，否则旧回合会变成没人管的孤儿。
 *
 * 集中放一份，是为了让 routes/ 下每个文件都是纯函数式的——
 * 它们只读写 ctx，不自己养全局变量。
 */

const { createHarness } = require('../harness');
const { SANDBOX_DIR } = require('../config');

/** 所有可变状态挂在这里 */
const ctx = {
  currentRun: null,   // { controller, pending, since } —— 智能体那一侧
  confirmSeq: 0,      // 权限闸门的自增编号
  gameRun: null,      // { controller, pending } —— 游戏那一侧
};

let harnessInstance = null;
let harnessLoading = null;

// 游戏单独开一个 Harness 实例：同样六个模块，不同的人格与扩展组合。
// 这正好验证一件事——换能力不用改内核，换的是外面这一圈怎么拼。
let gameInstance = null;
let gameLoading = null;

async function getGameHarness() {
  if (gameInstance) return gameInstance;
  if (gameLoading) return gameLoading;
  gameLoading = createHarness({
    root: SANDBOX_DIR,
    model: process.env.HARNESS_MODEL || 'qwen3:8b',
    extensions: ['quest', 'vision'],
    system: '你现在不是助手，你是「万物阁」里的一道关。旅人要靠手边的实物闯过去。',
    maxTurns: Number(process.env.GAME_TURNS || 5),
  }).then((h) => {
    gameInstance = h;
    console.log(`  游戏 Harness 就绪：扩展 [${h.extensions.list().map((e) => e.name).join(', ')}]`);
    return h;
  }).catch((err) => {
    // 加载失败必须把 gameLoading 清掉，否则之后每次请求都拿到同一个 rejected
    // promise，游戏永远 500——而且错误还不是新的
    gameLoading = null;
    throw err;
  });
  return gameLoading;
}

/** 取到 quest 扩展的把手，用来读局面、重开一局 */
function questDef(h) {
  const entry = h.extensions.get('quest');
  return entry ? entry.def : null;
}

async function getHarness() {
  if (harnessInstance) return harnessInstance;
  if (harnessLoading) return harnessLoading;
  harnessLoading = createHarness({
    root: SANDBOX_DIR,
    model: process.env.HARNESS_MODEL || 'qwen3:8b',
    maxTurns: Number(process.env.HARNESS_TURNS || 10),
  }).then((h) => {
    harnessInstance = h;
    console.log(
      `  Harness 就绪：${h.tools.list().length} 个工具，`
      + `扩展 [${h.extensions.list().map((e) => e.name).join(', ')}]`
    );
    return h;
  });
  return harnessLoading;
}

module.exports = { ctx, getHarness, getGameHarness, questDef };
