/**
 * 后端 REST 接口
 * ------------------------------------------------------------------
 * 前端唯一的「发请求」出口。这个文件里只有 fetch 和流解析：
 *
 *   · 不做任何规则判断（伤害/克制/饱食/铜钱全在 src/game/rules 里算）
 *   · 不碰任何 DOM（渲染归 public/js/ui）
 *
 * 唯一的例外是 /api/game/act：它返回的是 ndjson 事件流，
 * 所以这里用 async generator 逐行产出，让 UI 那边能写成
 * `for await (const evt of streamAct(...))`，并在中途 await 用户点模态
 * （confirm_request 必须原地等，先把流收完再处理会死锁）。
 */

const JSON_HEAD = { 'content-type': 'application/json' };

/** 夜战总超时：模型再慢也不能把页面锁死，到点掐断 */
const ACT_TIMEOUT_MS = 180 * 1000;

/** 普通请求超时：到点必须失败，绝不能无限挂着。
 *  这一条是被真实事故逼出来的：服务半死不活时 fetch 一直 pending，
 *  await 永不返回 → 上层 finally 的 setBusy(false) 永远不执行 →
 *  S.busy 永久锁死，全页按钮（包括回阁、献祭）全灰而看不出为什么。
 *  超时抛错后走 catch/finally，锁自然解开，还能在流水里看到原因。 */
const REQ_TIMEOUT_MS = 30 * 1000;
/** 摄像头检测要跑 YOLO，给得宽些 */
const DETECT_TIMEOUT_MS = 60 * 1000;

async function getJson(url, init, timeoutMs = REQ_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, { ...(init || {}), signal: ctrl.signal });
    return res.json().catch(() => ({}));
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒没回）。服务可能卡住了——点右上角「重开一局」或刷新页面。`);
    }
    throw err;
  } finally {
    clearTimeout(killer);
  }
}

function postJson(url, body, timeoutMs) {
  return getJson(url, {
    method: 'POST',
    headers: JSON_HEAD,
    body: JSON.stringify(body || {}),
  }, timeoutMs);
}

/* ── 局面与跨局存档 ─────────────────────────────────────────── */

export function getState() { return getJson('/api/game/state'); }

/**
 * 重开一局。
 * @param {boolean} [hard] true = 连跨局进度一起清（回到第一周目）
 */
export function postReset(hard) { return postJson('/api/game/reset', hard ? { hard: true } : {}); }

export function getLegacy() { return getJson('/api/game/legacy'); }

/* ── 白天：迷宫 ─────────────────────────────────────────────── */

/** 走一格。dir 是 up / down / left / right */
export function postTravel(dir) { return postJson('/api/game/travel', { dir }); }

/** 结算脚下的房间：举物 / 抉择 / 买货 / 告辞（skip:true 表示"不捡了/不买了"） */
export function postRoom(payload) { return postJson('/api/game/room', payload); }

/** 顺着梯子下到更深一层 */
export function postDescend() { return postJson('/api/game/descend'); }

/** 收工回阁 */
export function postReturn() { return postJson('/api/game/return'); }

/** 又出门：从阁回到迷宫（不刷新地图） */
export function postLeave() { return postJson('/api/game/leave'); }

/* ── 白天：万物阁经营 ───────────────────────────────────────── */

/**
 * 阁内动作。
 * @param {'build'|'sell'|'melt'|'feed'|'release'|'eat'|'sleep'|'study'} action
 * @param {string} [id] 设施 id / 物件 id / 精怪 id
 */
export function postHall(action, id) { return postJson('/api/game/hall', { action, id }); }

/* ── 入夜与夜战 ─────────────────────────────────────────────── */

/** 入夜：抽今夜的妖物 */
export function postNight() { return postJson('/api/game/night'); }

/** 施放一道咒。后端算伤害、反应、破防、反击 */
export function postSkill(id) { return postJson('/api/game/skill', { id }); }

/** 权限闸门：准了 / 驳回。必须在读流循环里原地回，不能延后 */
export function postConfirm(id, allow) { return postJson('/api/game/confirm', { id, allow }); }

/** 摄像头实时检测（YOLO 的结果 + 画框坐标） */
export function getDetect() { return getJson('/api/camera/detect', null, DETECT_TIMEOUT_MS); }

/** 更新日志原文（markdown） */
export async function getChangelog() {
  const res = await fetch('/public/CHANGELOG.md');
  return res.text();
}

/**
 * 一次夜战出手：献祭 / 对话。返回 ndjson 流。
 *
 * 正常产出的是后端事件：tool / content / confirm_request / compact / final / error。
 * 如果后端没走流（比如没识别到东西、局面已结束），会产出一条 { type:'json' }，
 * UI 那边按普通提示处理即可。
 *
 * @param {{talk?:boolean, intent?:string, label?:string, conf?:number,
 *          area_ratio?:number, item_id?:string, prompt?:string}} body
 */
export async function* streamAct(body) {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(new Error('timeout')), ACT_TIMEOUT_MS);
  try {
    const res = await fetch('/api/game/act', {
      method: 'POST', headers: JSON_HEAD, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('ndjson')) {
      yield { type: 'json', payload: await res.json().catch(() => ({})) };
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        yield evt;
      }
    }
  } finally {
    clearTimeout(killer);
  }
}
