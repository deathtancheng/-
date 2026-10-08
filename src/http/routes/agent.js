/**
 * 智能体路由：/api/models、/api/chat、/api/harness/*
 * ------------------------------------------------------------------
 * 这一组是 Harness 的对外窗口：看状态、跑一轮、给权限表态、掐断、重开、读写长期记忆。
 * 权限闸门（confirm）必须等前端点完再继续，所以它是异步悬停的——
 * 正在跑的那一次存在 ctx.currentRun 里，同一时刻只允许一个。
 */

const { OLLAMA } = require('../../config');
const { sendJson, readBody } = require('../util');
const { runAgent } = require('../../agent/run');
const { getHarness } = require('../context');

module.exports = async function handle(req, res, url, ctx) {
  if (req.method === 'GET' && url.pathname === '/api/models') {
    try {
      const r = await fetch(`${OLLAMA}/api/tags`);
      const j = await r.json();
      sendJson(res, 200, { models: (j.models || []).map((m) => m.name) });
    } catch (err) {
      sendJson(res, 502, { error: '无法连接 Ollama：' + err.message });
    }
    return true;
  }

  // 对话（SSE 风格 NDJSON 流）

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return true;
    }

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const emit = (evt) => {
      if (!res.writableEnded) res.write(JSON.stringify(evt) + '\n');
    };

    try {
      await runAgent({
        messages: payload.messages || [],
        model: payload.model || 'qwen3:8b',
        temperature: payload.temperature ?? 0.6,
        useTools: payload.useTools !== false,
        onEvent: emit,
      });
      emit({ type: 'done' });
    } catch (err) {
      emit({ type: 'error', message: err.message });
    }
    res.end();
    return true;
  }

  // 单张图片检测（前端上传 / 拍照用）

  if (req.method === 'GET' && url.pathname === '/api/harness/state') {
    try {
      const h = await getHarness();
      sendJson(res, 200, { ok: true, ...h.describe() });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // 跑一次 trace，事件以 NDJSON 逐条推给前端

  if (req.method === 'POST' && url.pathname === '/api/harness/run') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return true;
    }
    const goal = String(payload.goal || '').trim();
    if (!goal) {
      sendJson(res, 400, { error: 'goal 不能为空' });
      return true;
    }

    const h = await getHarness();
    const controller = new AbortController();
    ctx.currentRun = { controller, pending: null, since: Date.now() };

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const emit = (evt) => {
      if (!res.writableEnded) res.write(JSON.stringify(evt) + '\n');
    };

    // 把 Harness 的只读事件流接到这条 SSE 上。注意是订阅（onEvent）不是钩子，
    // 观测者不会影响 agent 的判断，它炸了也不会拖垮 agent
    const off = h.lifecycle.onEvent(emit);

    try {
      const result = await h.agent.run(goal, {
        signal: controller.signal,
        // 写文件 / 执行命令前回来敲门。这里只负责"问"，答案由前端 POST 回来
        confirm: (info) =>
          new Promise((resolve) => {
            const id = `c${++ctx.confirmSeq}`;
            ctx.currentRun.pending = { id, resolve, info };
            emit({
              type: 'confirm_request',
              id,
              name: info.name,
              level: info.level,
              levelLabel: info.levelLabel,
              args: info.args,
            });
          }),
      });
      emit({ type: 'final', ...result, tree: undefined });
    } catch (err) {
      emit({ type: 'error', message: err.message });
    }
    off();
    ctx.currentRun = null;
    res.end();
    return true;
  }

  // 人类对权限请求的表态

  if (req.method === 'POST' && url.pathname === '/api/harness/confirm') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return true;
    }
    if (!ctx.currentRun || !ctx.currentRun.pending || ctx.currentRun.pending.id !== payload.id) {
      sendJson(res, 409, { error: '没有待确认的请求（可能已超时或已被处理）' });
      return true;
    }
    const { resolve } = ctx.currentRun.pending;
    ctx.currentRun.pending = null;
    resolve(payload.allow === true);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // 中断当前 trace

  if (req.method === 'POST' && url.pathname === '/api/harness/abort') {
    if (ctx.currentRun) {
      ctx.currentRun.controller.abort();
      if (ctx.currentRun.pending) {
        ctx.currentRun.pending.resolve(false);
        ctx.currentRun.pending = null;
      }
      sendJson(res, 200, { ok: true, message: '已请求中断' });
    } else {
      sendJson(res, 409, { error: '当前没有在跑的 trace' });
    }
    return true;
  }

  // 开新会话：清空短期上下文，长期记忆保留

  if (req.method === 'POST' && url.pathname === '/api/harness/reset') {
    const h = await getHarness();
    h.agent.session = new (require('./src/harness/context').SessionTree)();
    sendJson(res, 200, { ok: true, session: h.agent.session.stats() });
    return true;
  }

  // 记忆管理：查看 / 手动增删

  if (url.pathname === '/api/harness/memory') {
    const h = await getHarness();
    if (req.method === 'GET') {
      sendJson(res, 200, { ...h.memory.stats(), facts: h.memory.data.facts, episodes: h.memory.data.episodes.slice(-10) });
      return true;
    }
    if (req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: '请求体不是合法 JSON' });
        return true;
      }
      if (payload.action === 'forget') {
        h.memory.forget(payload.key);
      } else if (payload.action === 'remember') {
        h.memory.remember(payload.key, payload.value);
      } else if (payload.action === 'recall') {
        sendJson(res, 200, { hits: h.memory.recall(payload.query || '', 8) });
        return true;
      } else {
        sendJson(res, 400, { error: 'action 必须是 remember / forget / recall' });
        return true;
      }
      await h.memory.save();
      sendJson(res, 200, { ok: true, stats: h.memory.stats() });
      return true;
    }
  }

  // ================================================================ 第五部分：游戏
  // 《拾物奇谭》——摄像头是手柄，YOLO 是输入解析，大模型是主持人，
  // Harness 负责把这三样咬合成一个回合。规则在 game-rules.js 里锁死，模型只写剧情。

  return false;
};
