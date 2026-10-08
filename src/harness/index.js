/**
 * Harness 组装入口
 * ------------------------------------------------------------------
 * 一句话讲清 Harness 是什么：
 *
 *   Agent = 大模型 + Harness
 *
 * 模型负责"想"，Harness 负责让它想得下去——
 * 给它工具、管住上下文、记住上次的事、在危险动作前拦一道、
 * 把每一步都摊开给人看。模型换个版本只是换 provider，
 * 真正决定这个 Agent 能干什么的，是外面这一圈。
 *
 *   createHarness() 就是把这一圈拼起来的地方。
 */

const path = require('path');
const { Lifecycle, HOOKS } = require('./lifecycle');
const { ToolRegistry } = require('./tools');
const { SessionTree, ContextManager } = require('./context');
const { Memory } = require('./memory');
const { createBuiltinTools } = require('./builtin');
const { ExtensionManager } = require('./extensions');
const { Agent, DEFAULT_SYSTEM } = require('./agent');
const { createProvider } = require('./provider');

const MAX_TOOL_OUTPUT = 4000;

/**
 * @param {object} opts
 * @param {string} opts.model        模型名，默认 qwen3:8b
 * @param {string} opts.root         工作区根目录，默认 ../sandbox
 * @param {string[]} opts.extensions 要装载的扩展名，默认全装
 * @param {Function} opts.confirm    权限闸门 (info) => Promise<boolean>
 * @param {number} opts.maxTurns     单 trace 最大轮次
 */
async function createHarness({
  model = process.env.HARNESS_MODEL || 'qwen3:8b',
  provider: injectedProvider = null,
  root = path.join(__dirname, '..', 'sandbox'),
  extensions = null,
  confirm = null,
  maxTurns = 10,
  maxTokens = 6000,
  memory: enableMemory = true,
  system = null,
  onEvent = null,
} = {}) {
  // ---------------------------------------------------------------- 六件套
  const lifecycle = new Lifecycle();
  const tools = new ToolRegistry();
  const session = new SessionTree();
  const context = new ContextManager({ maxTokens, keepRecent: 8 });

  const memory = enableMemory ? new Memory({ dir: path.join(root, 'memory') }) : null;
  if (memory) await memory.load();

  const provider =
    injectedProvider ||
    createProvider({ type: 'ollama', model, base: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434' });

  // ---------------------------------------------------------------- 内核工具
  tools.registerAll(createBuiltinTools({ root }));

  // ---------------------------------------------------------------- 默认钩子
  // 工具输出超长会直接把上下文撑爆，这里统一截断。
  // 注意：是截断成"前 4000 字 + 提示"，而不是丢掉——模型需要知道被截了。
  lifecycle.on(
    HOOKS.TOOL_END,
    async (ctx) => {
      const r = ctx.result;
      if (!r || typeof r.output !== 'string' || r.output.length <= MAX_TOOL_OUTPUT) return;
      const head = r.output.slice(0, MAX_TOOL_OUTPUT);
      ctx.result = {
        ...r,
        output: `${head}\n\n…（输出共 ${r.output.length} 字符，已截断到 ${MAX_TOOL_OUTPUT}；如需看更多请分段读取）`,
      };
      return ctx;
    },
    { name: 'core:truncate-output' }
  );

  // 连续三次同一工具同参数失败 = 模型卡死了，明确告诉它换个思路
  const failTally = new Map();
  lifecycle.on(
    HOOKS.TOOL_END,
    async (ctx) => {
      const key = `${ctx.name}:${JSON.stringify(ctx.args)}`;
      if (ctx.result && !ctx.result.ok && !ctx.result.blocked) {
        const n = (failTally.get(key) || 0) + 1;
        failTally.set(key, n);
        if (n >= 3) {
          ctx.result = {
            ...ctx.result,
            output:
              `${ctx.result.output}\n\n（这个调用已经用同样的参数失败 ${n} 次了，`
              + '请换参数、换工具，或者直接用已有信息给出结论，不要原样重试。）',
          };
          return ctx;
        }
      } else {
        failTally.delete(key);
      }
    },
    { name: 'core:loop-guard' }
  );

  // ---------------------------------------------------------------- 扩展
  const extensionManager = new ExtensionManager({ tools, lifecycle });
  const wanted = extensions || ['vision', 'research'];
  const ctxForExt = { root, memory, tools, lifecycle };
  for (const name of wanted) {
    try {
      const file = path.join(__dirname, 'extensions', `${name}.js`);
      delete require.cache[require.resolve(file)];
      extensionManager.load(require(file), ctxForExt);
    } catch (err) {
      console.error(`[harness] 扩展 ${name} 装载失败：`, err.message);
    }
  }

  // ---------------------------------------------------------------- 系统提示
  let systemPrompt = system || DEFAULT_SYSTEM;
  const extPrompt = extensionManager.systemPrompt();
  if (extPrompt) systemPrompt += `\n\n${extPrompt}`;

  // ---------------------------------------------------------------- Agent
  const agent = new Agent({
    provider,
    tools,
    lifecycle,
    memory,
    system: systemPrompt,
    maxTurns,
    confirm,
    context,
    session,
  });

  if (onEvent) lifecycle.onEvent(onEvent);

  return {
    agent,
    lifecycle,
    tools,
    memory,
    session,
    context,
    extensions: extensionManager,
    provider,
    // 方便调试面板展示全貌
    describe: () => ({
      model,
      root,
      tools: tools.list(),
      extensions: extensionManager.list(),
      memory: memory ? memory.stats() : null,
      session: session.stats(),
      hooks: Object.values(HOOKS).map((h) => ({ hook: h, count: lifecycle.count(h) })),
    }),
  };
}

module.exports = { createHarness, DEFAULT_SYSTEM };
