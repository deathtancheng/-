/**
 * 上下文工程：会话树 + token 预算 + 压缩
 * ------------------------------------------------------------------
 * 两件事值得单拎出来说：
 *
 * 1. 对话是树，不是列表。
 *    分支和回退只是把指针挪到另一个节点，不破坏已有数据——
 *    "刚才那条路走错了，退回上一步重来" 因此是 O(1) 操作。
 *
 * 2. 窗口是预算，不是容器。
 *    超预算时不粗暴砍头，而是把中间那段压成一条摘要塞回去，
 *    系统提示和最近几轮永远保留。
 */

/** 粗估 token 数。中英混排下按 2 字符 ≈ 1 token 估，够做预算裁剪用 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 2);
}

function estimateMessages(messages) {
  return messages.reduce((sum, m) => {
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + estimateTokens(body) + 4; // +4 给 role 和分隔
  }, 0);
}

class SessionTree {
  constructor() {
    this.nodes = new Map();
    this.seq = 0;
    const root = { id: 'root', parent: null, msg: null, children: [] };
    this.nodes.set('root', root);
    this.currentId = 'root';
  }

  /** 在当前位置追加一条消息，返回新节点 id */
  append(msg) {
    const id = `n${++this.seq}`;
    const node = { id, parent: this.currentId, msg, children: [], at: Date.now() };
    this.nodes.get(this.currentId).children.push(id);
    this.nodes.set(id, node);
    this.currentId = id;
    return id;
  }

  /** 把指针挪到任意节点，之后的新消息从这里分叉 */
  checkout(id) {
    if (!this.nodes.has(id)) throw new Error(`节点不存在：${id}`);
    this.currentId = id;
    return this;
  }

  /** 回退 n 步 */
  rewind(steps = 1) {
    let cur = this.nodes.get(this.currentId);
    for (let i = 0; i < steps && cur.parent; i++) cur = this.nodes.get(cur.parent);
    this.currentId = cur.id;
    return this;
  }

  /** 从根走到当前节点的消息链 */
  path() {
    const out = [];
    let cur = this.nodes.get(this.currentId);
    while (cur && cur.msg) {
      out.unshift(cur.msg);
      cur = this.nodes.get(cur.parent);
    }
    return out;
  }

  stats() {
    return { nodes: this.nodes.size - 1, current: this.currentId };
  }
}

class ContextManager {
  constructor({ maxTokens = 6000, keepRecent = 6 } = {}) {
    this.maxTokens = maxTokens;
    this.keepRecent = keepRecent;
    this.compactions = 0;
  }

  /**
   * 把消息压进预算。超了就用 summarizer（一个 async fn）压缩中间段。
   * 返回 { messages, compacted, tokens }
   */
  async fit(messages, { summarizer } = {}) {
    let tokens = estimateMessages(messages);
    if (tokens <= this.maxTokens) return { messages, compacted: false, tokens };

    const head = messages.filter((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');
    const tail = rest.slice(-this.keepRecent);
    const middle = rest.slice(0, rest.length - this.keepRecent);

    let summary = null;
    if (middle.length && typeof summarizer === 'function') {
      try {
        summary = await summarizer(middle);
      } catch {
        summary = null;
      }
    }
    if (!summary) {
      // 没有 summarizer 就老实丢中间段，但明确告诉模型丢了东西
      summary = `（已省略前 ${middle.length} 条较早的消息以节省上下文）`;
    }

    const out = [...head, { role: 'system', content: `以下是此前对话的摘要：\n${summary}` }, ...tail];
    this.compactions++;
    return { messages: out, compacted: true, tokens: estimateMessages(out) };
  }
}

module.exports = { SessionTree, ContextManager, estimateTokens, estimateMessages };
