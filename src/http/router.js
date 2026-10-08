/**
 * 路由组装 —— 主程序只需要认识这一个文件
 * ------------------------------------------------------------------
 * 每个路由模块导出的是同一个签名的函数：
 *
 *     async handle(req, res, url, ctx) -> boolean
 *
 * 返回 true 表示"我处理了"，false 表示"不是我的"，交给下一个。
 * 加新路由 = 往数组里加一项，主程序不用改。
 */

const handleVision = require('./routes/vision');
const handleAgent = require('./routes/agent');
const handleGame = require('./routes/game');
const handleStream = require('./routes/stream');

const ROUTES = [handleGame, handleVision, handleAgent, handleStream];

/** @returns {Promise<boolean>} 是否被处理；false 时主程序回 404 */
module.exports = async function route(req, res, url, ctx) {
  for (const handle of ROUTES) {
    // 路由内部会自己 writeHead；处理过就不要再往下传，否则会出现双写
    if (await handle(req, res, url, ctx)) return true;
  }
  return false;
};
