/**
 * 游戏门面 —— HTTP 层只跟这个文件打交道
 * ------------------------------------------------------------------
 * 规则本身住在 rules/ 下（纯函数，不知道 HTTP 的存在）。
 * 这里补上"今夜的妖物长什么样"这类组装逻辑，再把规则原样转出去。
 */

const { beastById, scaleGuardian } = require('./rules');

/**
 * 当前夜袭的妖物（已按天数缩放）。
 * 前端血条要按缩放后的总量画，所以这个值必须和规则层算出来的一致。
 */
function guardianFor(state) {
  if (!state) return null;
  const b = state.beastId ? beastById(state.beastId) : null;
  return b ? scaleGuardian(b, state.day || 1) : null;
}

module.exports = { guardianFor, rules: require('./rules') };
