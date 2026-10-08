/**
 * 局面推送（Server-Sent Events）
 * ------------------------------------------------------------------
 * 前端打开 /api/game/stream 就挂上一条长连接，之后后端每算完一次
 * 就把新局面推下去。前端因此不需要轮询，也不需要自己算任何东西——
 * 它只订阅，然后照着局面渲染。
 *
 * 为什么用 SSE 而不是 WebSocket：
 *   这个游戏只有"服务端 → 客户端"这一个方向的持续数据，
 *   玩家的每个动作本来就是一次普通 POST。SSE 更轻，且天然自动重连。
 */

const { subscribe } = require('../../game/bus');
const { ctx, getGameHarness, questDef } = require('../context');
const { guardianFor } = require('../../game');
const { runSnapshot } = require('../../game/rules');

/**
 * GET /api/game/stream —— 挂一条长连接，等后端推局面
 * @returns {Promise<boolean>}
 */
module.exports = async function handleStream(req, res, url) {
  if (req.method !== 'GET' || url.pathname !== '/api/game/stream') return false;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (evt) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  // 先把当前局面发一次，前端不用再单独拉 /api/game/state
  try {
    const h = await getGameHarness();
    const def = questDef(h);
    const st = def.getState();
    send({ type: 'state', state: runSnapshot(st), guardian: guardianFor(st) });
  } catch {
    send({ type: 'error', message: '游戏内核还没起来' });
  }

  const off = subscribe(send);
  // 心跳：中间设备（代理/网关）常会掐掉长时间没有数据的连接
  const beat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(beat);
    off();
  });
  return true;
};
