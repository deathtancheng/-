/**
 * 局面订阅（SSE）
 * ------------------------------------------------------------------
 * 后端算完任何一步都会往 /api/game/stream 推一份完整局面。
 * 前端这边只做一件事：收到就把快照塞进 store，剩下的交给渲染。
 *
 * 用 SSE 而不是 WebSocket，因为这条路只有「服务端 → 客户端」一个方向，
 * 玩家的每个动作本来就是普通 POST。SSE 更轻，而且断线会自己重连。
 */

import { S, set } from '../store.js';

/**
 * 订阅局面推送。
 * @param {(snapshot:object)=>void} [onExtra] 除了写 store 之外还想做的事（比如播个提示）
 * @returns {()=>void} 关闭订阅
 */
export function subscribeState(onExtra) {
  // 无头截图测试时会带 ?no_sse=1，避免长连接让 headless 一直等
  if (new URLSearchParams(location.search).has('no_sse')) {
    return () => {};
  }
  const es = new EventSource('/api/game/stream');
  let wasDown = false;   // 断过线（服务重启 / 网络抖动），重连后的第一份快照要当"新局面"处理
  es.onmessage = (ev) => {
    let snap;
    try { snap = JSON.parse(ev.data); } catch { return; }
    if (!snap || !snap.state) return;
    // 阶段或脚下位置变了，本地留着的房间结果/过场就是过期纸——
    // 不清掉的话，服务重启（SSE 重连）后玩家还卡在旧的场景里出不来。
    const prev = S.state;
    const pos = (m) => (m ? `${m.depth}:${m.px},${m.py}` : '');
    const moved = wasDown || !prev
      || prev.phase !== snap.state.phase
      || pos(prev.maze) !== pos(snap.state.maze);
    wasDown = false;
    set({
      state: snap.state,
      guardian: snap.guardian || null,
      elements: snap.elements || {},
      ...(moved ? { room: null, sceneClosed: false } : {}),
    }, snap.reason || 'stream');
    if (onExtra) onExtra(snap);
  };
  // EventSource 断线会自己重连，这里不用做任何事，
  // 更不要在这里 close —— 服务重启阶段会疯狂重连刷屏，但连上就好了。
  es.onerror = () => { wasDown = true; };
  return () => es.close();
}
