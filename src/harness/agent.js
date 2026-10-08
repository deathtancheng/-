/**
 * Agent —— Harness 的心脏
 * ------------------------------------------------------------------
 * 整个文件只做一件事：把"模型说话"和"工具执行"咬合成一个循环，
 * 并在循环的每一个可观测点上敲一下钩子。
 *
 *   trace:start
 *     └─ turn:start                                  ← 每轮开始
 *          ├─ model:start → model:stream* → model:end
 *          ├─ tool:start → tool:run → tool:end       ← 每个工具调用
 *          └─ turn:end
 *   trace:end
 *
 * 三条设计纪律（从 Pi 那里学来，也踩过坑）：
 *
 *   1. 主循环里不许有 if (某某业务)。要加能力就挂钩子或加扩展。
 *      这是"极简内核"能不能维持住的唯一保证。
 *   2. 错误即消息。工具返回 ok:false 也照常塞回上下文，让模型自己
 *      判断是换个参数重试还是换条路走。小模型在这种反馈下反而更稳。
 *   3. 有状态在外，无状态在内。turn 循环只认传进来的 messages，
 *      会话树和记忆都在外层——所以单轮可以重放、可以回退、可以并行。
 */

const { HOOKS } = require('./lifecycle');
const { SessionTree, ContextManager } = require('./context');

const DEFAULT_SYSTEM = `你是运行在用户本机上的智能体。你有一组工具，可以读写工作区里的文件、执行命令、做计算。

工作原则：
- 需要精确数值就用 calculator，不要心算。
- 改文件优先用 edit（精确替换），只有新建或整体重写才用 write。
- 工具报错不要慌，读报错信息，换参数或换方法再试一次；连续失败两次就换思路，并向用户说明卡在哪。
- 不要编造文件内容。不知道文件里有什么，就先 read。
- 回答用中文，简洁，不啰嗦。`;

class Agent {
  constructor({
    provider,
    tools,
    lifecycle,
    memory = null,
    system = DEFAULT_SYSTEM,
    maxTurns = 8,
    confirm = null,
    context = null,
    session = null,
    temperature = 0.6,
    think = false,
  } = {}) {
    if (!provider) throw new Error('Agent 需要 provider');
    if (!tools) throw new Error('Agent 需要 tools（ToolRegistry）');
    if (!lifecycle) throw new Error('Agent 需要 lifecycle');

    this.provider = provider;
    this.tools = tools;
    this.lifecycle = lifecycle;
    this.memory = memory;
    this.system = system;
    this.maxTurns = maxTurns;
    this.confirm = confirm;
    this.temperature = temperature;
    this.think = think;

    this.context = context || new ContextManager({ maxTokens: 6000, keepRecent: 8 });
    this.session = session || new SessionTree();

    this.traceCount = 0;
    this.aborted = false;
  }

  /** 系统提示 = 固定人格 + 长期记忆召回 + 工具清单说明 */
  buildSystem(goal) {
    let sys = this.system;
    if (this.memory) {
      const recalled = this.memory.render(`${goal}`, 5);
      if (recalled) {
        sys += `\n\n以下是你记得的关于这件事的既往信息（可能过时，仅供参考）：\n${recalled}`;
      }
    }
    return sys;
  }

  /** 用模型自己做摘要：给 ContextManager.fit 当 summarizer */
  async summarize(messages) {
    const transcript = messages
      .map((m) => {
        const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${body.slice(0, 400)}`;
      })
      .join('\n')
      .slice(0, 6000);

    let text = '';
    for await (const chunk of this.provider.chat({
      messages: [
        {
          role: 'system',
          content:
            '你是摘要器。把下面的对话压缩成一段不超过 300 字的中文摘要，'
            + '必须保留：用户最初的目标、已经做过的关键动作、得到的结论或数据、还没解决的问题。不要评价，不要补充。',
        },
        { role: 'user', content: transcript },
      ],
      temperature: 0.2,
    })) {
      if (chunk.type === 'content') text += chunk.text;
    }
    return text.trim() || null;
  }

  /**
   * 跑一次完整 trace。
   * @returns {{ text, turns, toolCalls, events, aborted, error, trace }}
   */
  async run(goal, { signal = null, confirm = null, continueSession = true } = {}) {
    const lifecycle = this.lifecycle;
    const tree = continueSession ? this.session : new SessionTree();
    const confirmFn = confirm || this.confirm;
    const traceId = `t${++this.traceCount}`;
    const started = Date.now();
    const stats = { turns: 0, toolCalls: 0, tokens: 0, compactions: 0 };

    let finalText = '';
    let aborted = false;
    let error = null;

    // ---------------------------------------------------------- trace:start
    const traceCtx = await lifecycle.run(HOOKS.TRACE_START, {
      traceId,
      goal,
      agent: this,
      tree,
      started,
    });
    lifecycle.emit('trace', { traceId, goal, phase: 'start' });

    if (!continueSession) tree.append({ role: 'user', content: goal });
    else tree.append({ role: 'user', content: goal });

    try {
      for (let turn = 1; turn <= this.maxTurns; turn++) {
        if (signal && signal.aborted) {
          aborted = true;
          break;
        }
        stats.turns = turn;

        // ------------------------------------------------------ turn:start
        const turnCtx = await lifecycle.run(HOOKS.TURN_START, {
          traceId,
          turn,
          goal,
          tree,
          agent: this,
        });
        lifecycle.emit('turn', { traceId, turn, phase: 'start' });

        // 组消息：system（含记忆召回） + 会话树当前路径
        const raw = [{ role: 'system', content: this.buildSystem(goal) }, ...tree.path()];
        const fitted = await this.context.fit(raw, {
          summarizer: (mids) => this.summarize(mids),
        });
        if (fitted.compacted) {
          stats.compactions++;
          lifecycle.emit('compact', { traceId, turn, tokens: fitted.tokens });
        }
        const messages = fitted.messages;

        // ------------------------------------------------------ model:start
        // 钩子可以在这里改写"即将发出的 messages"。游戏用它动态注入守阁灵
        // 的身份（层数变了身份也变），所以这里必须把改写结果接回来，
        // 不能像事件那样发完就丢——这就是钩子与事件的分工。
        const modelStartCtx = await lifecycle.run(HOOKS.MODEL_START, {
          traceId,
          turn,
          messages,
          agent: this,
        });
        const outMessages =
          modelStartCtx && modelStartCtx.messages ? modelStartCtx.messages : messages;
        lifecycle.emit('model', { traceId, turn, phase: 'start', tokens: fitted.tokens });

        // 流式收。每片都过一遍 model:stream 钩子，让 UI 和审计都能看到
        let content = '';
        let thinking = '';
        const calls = [];
        let usage = null;

        const stream = this.provider.chat({
          messages: outMessages,
          tools: this.tools.schema(),
          temperature: this.temperature,
          think: this.think,
          signal,
        });

        for await (const chunk of stream) {
          if (signal && signal.aborted) {
            aborted = true;
            break;
          }
          const c = await lifecycle.run(HOOKS.MODEL_STREAM, { traceId, turn, chunk, agent: this });
          const ck = c.chunk || chunk; // 钩子可以改写这一片
          if (ck.type === 'thinking') {
            thinking += ck.text || '';
            lifecycle.emit('thinking', { traceId, turn, text: ck.text || '' });
          } else if (ck.type === 'content') {
            content += ck.text || '';
            lifecycle.emit('content', { traceId, turn, text: ck.text || '' });
          } else if (ck.type === 'tool_call') {
            calls.push(ck.call);
            lifecycle.emit('tool_call', { traceId, turn, call: ck.call });
          } else if (ck.type === 'done') {
            usage = ck.usage || null;
          }
        }

        if (aborted) break;

        // ------------------------------------------------------ model:end
        const modelCtx = await lifecycle.run(HOOKS.MODEL_END, {
          traceId,
          turn,
          content,
          thinking,
          toolCalls: calls,
          usage,
          agent: this,
        });
        content = modelCtx.content ?? content;
        lifecycle.emit('model', { traceId, turn, phase: 'end', calls: calls.length });

        // 把 assistant 这条（可能带 tool_calls）挂到树上
        const assistantMsg = { role: 'assistant', content: content || '' };
        if (calls.length) {
          assistantMsg.tool_calls = calls.map((c) => ({
            id: c.id || `call_${turn}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
              name: c.function?.name,
              arguments:
                typeof c.function?.arguments === 'string'
                  ? c.function.arguments
                  : JSON.stringify(c.function?.arguments || {}),
            },
          }));
        }
        tree.append(assistantMsg);

        // 没有工具调用 = 这一轮就是最终回答
        if (!calls.length) {
          finalText = content;
          await lifecycle.run(HOOKS.TURN_END, { traceId, turn, content, final: true, agent: this });
          lifecycle.emit('turn', { traceId, turn, phase: 'end', final: true });
          break;
        }

        // ------------------------------------------------------ 逐个跑工具
        for (let i = 0; i < assistantMsg.tool_calls.length; i++) {
          const call = assistantMsg.tool_calls[i];
          const name = call.function?.name;
          let rawArgs = call.function?.arguments;
          if (typeof rawArgs === 'string') {
            try {
              rawArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
            } catch {
              /* 保持原样，交给 registry 兜底 */
            }
          }

          // tool:start —— 钩子可以在这里改写参数，或者直接拦下
          const startCtx = await lifecycle.run(HOOKS.TOOL_START, {
            traceId,
            turn,
            index: i,
            name,
            args: rawArgs,
            agent: this,
            skip: false,
          });
          lifecycle.emit('tool', { traceId, turn, phase: 'start', name, args: rawArgs });

          let result;
          if (startCtx.skip) {
            result = {
              name,
              ok: false,
              blocked: true,
              output: `该调用被钩子拦截：${startCtx.skipReason || '未说明原因'}`,
              ms: 0,
            };
          } else {
            // tool:run —— 真正的执行点。invoke 永不抛出
            const runCtx = await lifecycle.run(HOOKS.TOOL_RUN, {
              traceId,
              turn,
              name,
              args: startCtx.args ?? rawArgs,
              agent: this,
              override: null,
            });
            if (runCtx.override) {
              result = runCtx.override;
            } else {
              result = await this.tools.invoke(name, runCtx.args ?? rawArgs, {
                confirm: confirmFn,
                signal,
                agent: this,
              });
            }
          }
          stats.toolCalls++;

          // tool:end —— 钩子可以改写回给模型的结果（比如截断超长输出）
          const endCtx = await lifecycle.run(HOOKS.TOOL_END, {
            traceId,
            turn,
            name,
            args: rawArgs,
            result,
            agent: this,
          });
          lifecycle.emit('tool', {
            traceId,
            turn,
            phase: 'end',
            name,
            ok: result.ok,
            blocked: result.blocked,
            ms: result.ms,
            output: result.output,
          });

          const outName = (endCtx.result && endCtx.result.name) || name;
          const outBody = endCtx.result ? endCtx.result.output : result.output;
          tree.append({
            role: 'tool',
            name: outName,
            content: String(outBody ?? ''),
          });
        }

        // ------------------------------------------------------ turn:end
        await lifecycle.run(HOOKS.TURN_END, {
          traceId,
          turn,
          content,
          final: false,
          agent: this,
        });
        lifecycle.emit('turn', { traceId, turn, phase: 'end', final: false });

        // 到最后一轮还没收尾，给模型一个明确的收口指令
        if (turn === this.maxTurns) {
          tree.append({
            role: 'user',
            content: '已达最大轮次，请停止调用工具，用现有信息直接给出结论。',
          });
        }
      }
    } catch (err) {
      error = err && err.message ? err.message : String(err);
      lifecycle.emit('error', { traceId, message: error });
    }

    // ---------------------------------------------------------- trace:end
    const result = {
      traceId,
      text: finalText,
      turns: stats.turns,
      toolCalls: stats.toolCalls,
      compactions: stats.compactions,
      aborted,
      error,
      ms: Date.now() - started,
      tree,
    };

    const endCtx = await lifecycle.run(HOOKS.TRACE_END, { traceId, goal, result, agent: this });
    lifecycle.emit('trace', { traceId, phase: 'end', ...result });

    // 沉淀情节记忆
    if (this.memory) {
      try {
        this.memory.addEpisode({
          goal,
          result: (finalText || error || '（中断）').slice(0, 800),
          turns: stats.turns,
          ok: !error && !aborted,
        });
        await this.memory.save();
      } catch {
        /* 记忆写不进去不影响本次结果 */
      }
    }

    return endCtx.result || result;
  }
}

module.exports = { Agent, DEFAULT_SYSTEM };
