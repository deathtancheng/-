/**
 * 局面事件总线
 * ------------------------------------------------------------------
 * 后端算完之后，不主动告诉前端，前端就只能不停轮询——
 * 那既不实时，也让"谁掌握状态"变得含糊。
 *
 * 有了这条总线：
 *   后端：算完 → publish 一次局面
 *   前端：订阅 → 收到就渲染
 *
 * 前端因此彻底不用知道"什么时候该刷新"，也不再做任何规则计算。
 */

/** @type {Set<(evt:object)=>void>} */
const listeners = new Set();

/** 订阅。返回取消订阅的函数 */
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 广播一次局面变化。
 * @param {{type:string, state?:object, guardian?:object, extra?:object}} evt
 */
function publish(evt) {
  for (const fn of listeners) {
    try {
      fn(evt);
    } catch {
      /* 某一个订阅者出错不能拖累其它人 */
    }
  }
}

/** 当前有几个订阅者（健康检查用） */
function subscriberCount() {
  return listeners.size;
}

module.exports = { subscribe, publish, subscriberCount };
