/**
 * HTTP 服务 —— 建 server、分路由、兜底 404
 * ------------------------------------------------------------------
 * 这一层不知道任何业务：请求进来 → 找人处理 → 没人认领就 404。
 */

const http = require('http');
const route = require('./router');
const { handleStatic } = require('./static');

/**
 * @param {object} ctx 服务端共享状态（src/http/context.js）
 */
function createServer(ctx) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (await handleStatic(req, res, url)) return;
      if (await route(req, res, url, ctx)) return;
    } catch (err) {
      // 任何路由抛出来的异常都在这里兜住，绝不能让连接吊死
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (!res.writableEnded) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    }
  });
}

module.exports = { createServer };
