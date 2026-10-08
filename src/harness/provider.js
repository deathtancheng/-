/**
 * 模型 Provider 抽象层
 * ------------------------------------------------------------------
 * Harness 只认这一个接口，换模型 = 换 provider，工具调用逻辑一行都不用改。
 *
 *   for await (const chunk of provider.chat({ messages, tools })) { ... }
 *   chunk = { type: 'thinking' | 'content' | 'tool_call' | 'done', ... }
 */

async function* ndjsonLines(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try {
          yield JSON.parse(line);
        } catch {
          /* 半行，跳过 */
        }
      }
    }
  }
}

/**
 * Ollama 方言适配：历史消息里 assistant.tool_calls[].function.arguments
 * 必须是对象。传字符串会被它自己的 JSON 解析拒绝，报
 *   "Value looks like object, but can't find closing '}' symbol"
 * （OpenAI 兼容接口则相反，要字符串。）这类方言差异一律收在 provider 里，
 * 主循环只认一种内部格式。
 */
function normalizeForOllama(messages) {
  return (messages || []).map((m) => {
    if (!Array.isArray(m.tool_calls)) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map((tc) => {
        const fn = tc.function || {};
        let args = fn.arguments;
        if (typeof args === 'string') {
          try {
            args = args.trim() ? JSON.parse(args) : {};
          } catch {
            args = {};
          }
        }
        return { ...tc, function: { ...fn, arguments: args && typeof args === 'object' ? args : {} } };
      }),
    };
  });
}

function createOllamaProvider({ base = 'http://127.0.0.1:11434', model = 'qwen3:8b' } = {}) {
  // 单次模型调用的硬上限。Ollama 卡死（排队/换模型/上下文爆了）时
  // 流会永远不动——没有这个超时，游戏回合就永远结束不了。
  // 正常一次调用几秒到几十秒，3 分钟已经是极端宽限。
  const CALL_TIMEOUT = Number(process.env.OLLAMA_TIMEOUT || 180) * 1000;
  return {
    kind: 'ollama',
    label: `ollama:${model}`,
    model,
    async *chat({ messages, tools, temperature = 0.6, signal, think = false }) {
      // 外部 signal（玩家中止/重开）和超时哨兵合并，谁先触发都算
      const sig = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT)])
        : AbortSignal.timeout(CALL_TIMEOUT);
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: sig,
        body: JSON.stringify({
          model,
          messages: normalizeForOllama(messages),
          tools,
          stream: true,
          think,
          // 默认 4k 上下文装不下"系统提示+工具表+整局对话"，
          // 装满后 Ollama 要么截断要么极慢——游戏局必须给大一点
          options: { temperature, num_ctx: Number(process.env.OLLAMA_NUM_CTX || 8192) },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`ollama ${res.status}: ${detail.slice(0, 300)}`);
      }
      for await (const chunk of ndjsonLines(res.body)) {
        const m = chunk.message || {};
        if (m.thinking) yield { type: 'thinking', text: m.thinking };
        if (m.content) yield { type: 'content', text: m.content };
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
          for (const tc of m.tool_calls) yield { type: 'tool_call', call: tc };
        }
        if (chunk.done) {
          yield { type: 'done', usage: { eval_count: chunk.eval_count, prompt_eval_count: chunk.prompt_eval_count } };
        }
      }
    },
  };
}

function createOpenAIProvider({ base = 'https://api.openai.com/v1', model = 'gpt-4o-mini', apiKey } = {}) {
  return {
    kind: 'openai',
    label: `openai:${model}`,
    model,
    async *chat({ messages, tools, temperature = 0.6, signal }) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages, tools, stream: true, temperature }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);

      const pending = new Map(); // index → 累积中的 tool_call
      for await (const line of ndjsonLines(res.body)) {
        const delta = line.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) yield { type: 'content', text: delta.content };
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const cur = pending.get(tc.index) || { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            pending.set(tc.index, cur);
          }
        }
        if (line.choices?.[0]?.finish_reason) {
          for (const cur of pending.values()) {
            yield {
              type: 'tool_call',
              call: { id: cur.id, function: { name: cur.name, arguments: cur.args } },
            };
          }
          yield { type: 'done' };
        }
      }
    },
  };
}

function createProvider(opts = {}) {
  const type = opts.type || 'ollama';
  if (type === 'openai') return createOpenAIProvider(opts);
  return createOllamaProvider(opts);
}

module.exports = { createProvider, createOllamaProvider, createOpenAIProvider, normalizeForOllama };
