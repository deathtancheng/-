/**
 * 生命周期：四层作用域 + 10 个钩子节点
 * ------------------------------------------------------------------
 * 这是 Harness 的骨架。所有"横切"关注点——输入校验、结果审核、压缩、
 * 审计、观测——都挂在钩子上，而不是写成主流程里的 if-else。
 *
 *   trace          一次完整会话（人给一个目标 → agent 干完）
 *   turn           一次模型调用 + 这次调用触发的所有工具执行
 *   model          单次模型调用（start / stream / end）
 *   tool           单次工具执行（start / run / end）
 *
 * 钩子 vs 事件：
 *   on(hook, fn)   可以读写 ctx、可以抛错阻断流程（干预）
 *   onEvent(fn)    只读观测，用于把进度推给 UI / 日志（订阅）
 */

const HOOKS = {
  TRACE_START: 'trace:start',
  TRACE_END: 'trace:end',
  TURN_START: 'turn:start',
  TURN_END: 'turn:end',
  MODEL_START: 'model:start',
  MODEL_STREAM: 'model:stream',
  MODEL_END: 'model:end',
  TOOL_START: 'tool:start',
  TOOL_RUN: 'tool:run',
  TOOL_END: 'tool:end',
};

const ALL_HOOKS = Object.values(HOOKS);

class Lifecycle {
  constructor() {
    this._hooks = new Map();
    this._listeners = new Set();
  }

  /** 注册干预钩子。fn(ctx) 可修改 ctx；抛错即阻断整个 trace */
  on(hook, fn, opts = {}) {
    if (!ALL_HOOKS.includes(hook)) throw new Error(`未知钩子：${hook}`);
    if (!this._hooks.has(hook)) this._hooks.set(hook, []);
    this._hooks.get(hook).push({ fn, name: opts.name || 'anon' });
    return () => this.off(hook, fn);
  }

  off(hook, fn) {
    const list = this._hooks.get(hook);
    if (!list) return;
    const i = list.findIndex((h) => h.fn === fn);
    if (i >= 0) list.splice(i, 1);
  }

  /** 订阅只读事件流 */
  onEvent(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** 广播事件（纯观测，不阻断） */
  emit(type, payload = {}) {
    const evt = { type, at: Date.now(), ...payload };
    for (const fn of this._listeners) {
      try {
        fn(evt);
      } catch {
        /* 观察者自己炸了不能拖垮 agent */
      }
    }
    return evt;
  }

  /** 依次跑某个节点上的钩子。ctx 会被就地修改，返回值即最终 ctx */
  async run(hook, ctx = {}) {
    const list = this._hooks.get(hook) || [];
    for (const h of list) {
      const out = await h.fn(ctx);
      // 钩子可以返回一个补丁对象，合并回 ctx
      if (out && typeof out === 'object' && out !== ctx) Object.assign(ctx, out);
    }
    return ctx;
  }

  /** 取出某节点上挂了几个钩子，用于调试面板展示 */
  count(hook) {
    return (this._hooks.get(hook) || []).length;
  }
}

module.exports = { HOOKS, ALL_HOOKS, Lifecycle };
