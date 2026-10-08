/**
 * 工具注册表
 * ------------------------------------------------------------------
 * 三条原则：
 *   1. 极简内核 —— 内置只放真正原子的工具，业务能力一律走扩展热插拔
 *   2. 错误即消息 —— 工具炸了不抛异常，把报错原文喂回模型让它自己判断怎么绕
 *   3. 权限分级 —— safe 直接跑，write / danger 要过人类的闸门
 */

const LEVEL = { SAFE: 'safe', WRITE: 'write', DANGER: 'danger' };

const LEVEL_LABEL = {
  safe: '只读',
  write: '会写文件',
  danger: '会执行外部命令',
};

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool || !tool.name) throw new Error('工具必须有 name');
    if (!tool.description) throw new Error(`工具 ${tool.name} 缺 description`);
    if (typeof tool.run !== 'function') throw new Error(`工具 ${tool.name} 缺 run()`);
    this.tools.set(tool.name, {
      level: LEVEL.SAFE,
      params: { type: 'object', properties: {}, required: [] },
      ...tool,
    });
    return this;
  }

  /** 一次性注册多个（扩展用） */
  registerAll(list) {
    for (const t of list) this.register(t);
    return this;
  }

  unregister(name) {
    return this.tools.delete(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  list() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      level: t.level,
      description: t.description,
    }));
  }

  /** 转成模型认识的 tools schema */
  schema() {
    return [...this.tools.values()].map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.params,
      },
    }));
  }

  /**
   * 执行一个工具调用。返回 { name, ok, output, ms, blocked }
   * 永不抛出——失败也当成一条普通结果交回给模型。
   */
  async invoke(name, rawArgs, ctx = {}) {
    const started = Date.now();
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        name,
        ok: false,
        blocked: false,
        output: `没有叫「${name}」的工具。可用：${[...this.tools.keys()].join(', ')}`,
        ms: 0,
      };
    }

    // 参数归一化：模型有时给字符串，有时给对象
    let args = rawArgs;
    if (typeof args === 'string') {
      try {
        args = args.trim() ? JSON.parse(args) : {};
      } catch {
        args = {};
      }
    }
    args = args || {};

    // 必填校验
    const missing = (tool.params.required || []).filter((k) => args[k] === undefined);
    if (missing.length) {
      return { name, ok: false, blocked: false, output: `缺少必填参数：${missing.join(', ')}`, ms: 0 };
    }

    // 权限闸门：write / danger 需要人类点头
    if (tool.level !== LEVEL.SAFE) {
      if (typeof ctx.confirm !== 'function') {
        return {
          name,
          ok: false,
          blocked: true,
          output: `工具 ${name} 属于「${LEVEL_LABEL[tool.level]}」操作，但当前没有配置确认回调，已拒绝执行。`,
          ms: 0,
        };
      }
      let allowed = false;
      try {
        allowed = await ctx.confirm({
          name,
          level: tool.level,
          levelLabel: LEVEL_LABEL[tool.level],
          args,
        });
      } catch (err) {
        allowed = false;
      }
      if (!allowed) {
        return { name, ok: false, blocked: true, output: `用户拒绝执行 ${name}。`, ms: Date.now() - started };
      }
    }

    // 真正执行
    try {
      const output = await tool.run(args, ctx);
      return { name, ok: true, blocked: false, output: String(output ?? ''), ms: Date.now() - started };
    } catch (err) {
      return {
        name,
        ok: false,
        blocked: false,
        output: `工具 ${name} 执行失败：${err && err.message ? err.message : String(err)}`,
        ms: Date.now() - started,
      };
    }
  }
}

module.exports = { ToolRegistry, LEVEL, LEVEL_LABEL };
