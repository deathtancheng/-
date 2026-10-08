/**
 * 一次提问的完整循环：问模型 → 它要调工具 → 执行 → 再问，直到说完
 * ------------------------------------------------------------------
 * 这是 Harness 之外的另一条简易通路，给 /api/chat 这种"只想要个答案"的场景用。
 * 真正的多轮、带权限闸门和可观测事件的版本在 src/harness/agent.js。
 */

const { OLLAMA, MAX_AGENT_STEPS } = require('../config');
const { TOOLS, dispatchTool, ndjson } = require('./tools');

async function runAgent({ messages, model, temperature, useTools, onEvent }) {
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));
  const tools = useTools ? TOOLS : undefined;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const upstream = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: convo,
        tools,
        stream: true,
        think: false,
        options: { temperature: Number(temperature) || 0.6 },
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      throw new Error(`Ollama 返回 ${upstream.status}: ${detail.slice(0, 300)}`);
    }

    let content = '';
    let thinking = '';
    const toolCalls = [];

    for await (const chunk of ndjson(upstream.body)) {
      const msg = chunk.message || {};
      if (msg.thinking) {
        thinking += msg.thinking;
        onEvent({ type: 'thinking', text: msg.thinking });
      }
      if (msg.content) {
        content += msg.content;
        onEvent({ type: 'token', text: msg.content });
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        for (const tc of msg.tool_calls) toolCalls.push(tc);
      }
      if (chunk.done) break;
    }

    if (toolCalls.length === 0) {
      // 没有工具调用 —— 本轮即最终答案
      convo.push({ role: 'assistant', content });
      return content;
    }

    // 有工具调用：把 assistant 消息（含 tool_calls）放回上下文，再执行工具
    convo.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = tc.function?.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      onEvent({ type: 'tool_start', name, args: args || {} });
      let result;
      try {
        result = await dispatchTool(name, args);
      } catch (err) {
        result = `工具执行失败：${err.message}`;
      }
      onEvent({ type: 'tool_end', name, result: String(result) });
      convo.push({ role: 'tool', content: String(result) });
    }
    onEvent({ type: 'step' });
  }

  throw new Error(`智能体达到最大步数（${MAX_AGENT_STEPS}），已停止`);
}

// ---------------------------------------------------------------- HTTP 服务

module.exports = { runAgent };
