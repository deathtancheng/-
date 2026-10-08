/**
 * 静态资源：把 public/ 下的文件原样发出去
 */

const fsp = require('fs/promises');
const path = require('path');
const { PUBLIC_DIR } = require('../config');
const { MIME } = require('./util');

/**
 * 是否是静态资源请求（/ 或 /public/*）
 * @returns {Promise<boolean>}
 */
module.exports.handleStatic = async function handleStatic(req, res, url) {
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/public/'))) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/public\//, '');
    const target = path.join(PUBLIC_DIR, rel);
    if (!target.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return true;
    }
    try {
      const data = await fsp.readFile(target);
      // 别让浏览器缓存前端资源。本地开发时改了 js/css 一定要立刻生效——
      // ES 模块没有版本参数，被启发式缓存住的话"代码改了、页面没变"，
      // 排查起来会往错的方向找（找个半天的 bug 其实是缓存里的旧文件）。
      res.writeHead(200, {
        'content-type': MIME[path.extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store, must-revalidate',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    }
    return true;
  }
  return false;
};
