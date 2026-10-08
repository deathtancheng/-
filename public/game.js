/**
 * 《拾物奇谭》前端入口
 * ------------------------------------------------------------------
 * 这个文件什么都不做，只把组装入口挂上来。
 * 真正的装配在 ./js/main.js（绑事件 + 启动），
 * 规则和数据全在服务端（src/game/rules + src/harness）。
 *
 * 分层是单向的：
 *     game.js  →  js/main.js  →  js/ui/*（只画）  →  js/net/*（只收）
 *                                js/store.js（只存）
 * 没有任何一个前端模块会自己算伤害、判克制、决定该不该升级——
 * 那些全在后端算完，通过 REST 或 SSE 推过来。
 */

import { start } from './js/main.js';

start().catch((err) => {
  const box = document.getElementById('speech');
  if (box) box.textContent = '起不来：' + err.message + '（确认 server.js 与 camera_server.py 都在跑）';
  console.error('[game] 启动失败：', err);
});
