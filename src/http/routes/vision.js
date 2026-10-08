/**
 * 视觉相关路由：/api/detect（手动传图跑 YOLO）、/api/camera/*（摄像头服务代理）
 * ------------------------------------------------------------------
 * 这里只做转发和拼装，真正的推理在 src/vision/detect.js。
 */

const { Readable } = require('stream');
const { sendJson, readBody } = require('../util');
const { cameraDetect, cameraSnapshot, runYolo, resolveInSandbox } = require('../../agent/tools');
// CAMERA_URL 在 src/config.js，这里必须显式导入——
// 漏了的话 catch 会把 ReferenceError 包装成"摄像头服务未启动"，极难排查。
const { CAMERA_URL } = require('../../config');

module.exports = async function handle(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/detect') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return true;
    }
    if (!payload.image) {
      sendJson(res, 400, { error: '缺少 image(base64) 字段' });
      return true;
    }
    try {
      const r = await runYolo(String(payload.image).replace(/^data:image\/\w+;base64,/, ''));
      sendJson(res, 200, r);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // 摄像头服务代理（统一端口，前端不用记两个地址）

  if (req.method === 'GET' && url.pathname.startsWith('/api/camera/')) {
    const tail = url.pathname.replace('/api/camera/', '');
    if (!['detect', 'stats', 'snapshot', 'video'].includes(tail)) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    try {
      const r = await fetch(`${CAMERA_URL}/${tail}`, { signal: AbortSignal.timeout(10000) });
      if (tail === 'snapshot') {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length });
        res.end(buf);
      } else if (tail === 'video') {
        // MJPEG 流：直接把 Python 那边的字节流透传给浏览器
        res.writeHead(200, {
          'content-type': r.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=--frame',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        Readable.fromWeb(r.body).pipe(res);
      } else {
        sendJson(res, 200, await r.json());
      }
    } catch (err) {
      // 连不上才是"没启动"（ECONNREFUSED / fetch failed / timeout）；
      // 其它异常（比如漏导入变量抛 ReferenceError）不能说成"没启动"，
      // 否则排查方向会被彻底带偏——这次就是被这句误导了很久。
      const offline = /ECONNREFUSED|fetch failed|timeout|ENOTFOUND|EAI_AGAIN/i.test(err.message || '');
      sendJson(res, offline ? 503 : 500, {
        error: offline
          ? `摄像头服务未启动：${err.message}（先跑 python yolo/camera_server.py）`
          : `摄像头代理内部错误：${err.message}`,
      });
    }
    return true;
  }

  // ================================================================ Harness
  //
  // 第四部分的入口。和上面 /api/chat 那个"一次性 ReAct 循环"的区别：
  // 这里跑的是完整 Harness——有生命周期钩子、会话树、上下文预算、长期记忆、
  // 可插拔扩展、以及写操作前的人类闸门。前端能实时看到每一层的事件。

  return false;
};
