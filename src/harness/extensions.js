/**
 * 扩展管理器 —— 内核不长大，能力靠插
 * ------------------------------------------------------------------
 * 一个扩展 = 一组工具 + 若干钩子 + 一段附加系统提示。
 * 它不知道内核怎么跑循环，内核也不知道扩展具体干什么，
 * 两边只通过 ToolRegistry 和 Lifecycle 这两个接口打交道。
 *
 * 这就是为什么内核能一直保持在几百行：
 *   做视觉 → 插 vision；做科研 → 插 research；将来接单片机 → 插 mcu。
 *   每次新增专业方向，改的不是内核，是这一层。
 */

const fs = require('fs');
const path = require('path');

class ExtensionManager {
  constructor({ tools, lifecycle, dir } = {}) {
    this.tools = tools;
    this.lifecycle = lifecycle;
    this.dir = dir || path.join(__dirname, 'extensions');
    this.loaded = new Map(); // name → { def, toolNames, unhook[] }
  }

  /**
   * 装一个扩展。同名重复装载会先卸载旧的，方便热更新。
   * def 可以是对象，也可以是 (ctx) => def 的工厂函数——
   * 后者用于扩展需要拿到工作区根目录、记忆实例等外部资源的情况。
   */
  load(def, ctx = {}) {
    const resolved = typeof def === 'function' ? def(ctx) : def;
    if (!resolved || !resolved.name) throw new Error('扩展必须有 name');
    if (this.loaded.has(resolved.name)) this.unload(resolved.name);

    const toolNames = [];
    for (const t of resolved.tools || []) {
      this.tools.register(t);
      toolNames.push(t.name);
    }

    const unhook = [];
    for (const h of resolved.hooks || []) {
      if (typeof h.fn !== 'function') continue;
      unhook.push(this.lifecycle.on(h.hook, h.fn, { name: `${resolved.name}:${h.hook}` }));
    }

    this.loaded.set(resolved.name, { def: resolved, toolNames, unhook, ctx });
    return this;
  }

  unload(name) {
    const entry = this.loaded.get(name);
    if (!entry) return false;
    for (const n of entry.toolNames) this.tools.unregister(n);
    for (const off of entry.unhook) {
      try {
        off();
      } catch {
        /* 钩子已经摘了就算了 */
      }
    }
    this.loaded.delete(name);
    return true;
  }

  /** 扫描 extensions/ 目录，把每个 .js 都当成一个扩展装载 */
  loadDir(dir = this.dir, ctx = {}) {
    if (!fs.existsSync(dir)) return this;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      try {
        // 每次都清缓存，这样改完扩展文件重启即生效，不用清 require 缓存
        const full = path.join(dir, f);
        delete require.cache[require.resolve(full)];
        const mod = require(full);
        const def = mod.default || mod.extension || mod;
        if (def && (typeof def === 'function' || def.name)) this.load(def, ctx);
      } catch (err) {
        console.error(`[extensions] 装载 ${f} 失败：`, err.message);
      }
    }
    return this;
  }

  /** 已装载扩展各自的 ctx，用于调试面板展示 */
  get(name) {
    return this.loaded.get(name) || null;
  }

  /** 所有已装载扩展的附加系统提示，拼成一段 */
  systemPrompt() {
    const parts = [];
    for (const { def } of this.loaded.values()) {
      if (def.system) parts.push(def.system);
    }
    return parts.filter(Boolean).join('\n\n');
  }

  list() {
    return [...this.loaded.values()].map(({ def, toolNames }) => ({
      name: def.name,
      description: def.description || '',
      tools: toolNames,
      hooks: (def.hooks || []).map((h) => h.hook),
    }));
  }
}

module.exports = { ExtensionManager };
