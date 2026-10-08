/**
 * 长期记忆：跨会话的那层"我"
 * ------------------------------------------------------------------
 * 上下文窗口是一次性的，记忆不是。这一层解决三个问题：
 *
 *   1. 下次开机还记得你 —— 事实记忆（fact），稳定不变的东西
 *      （"用户叫 XX"、"项目根目录在哪"、"别用 A 方案"）
 *   2. 上次干了什么 —— 情节记忆（episode），每次 trace 结束时沉淀一条
 *   3. 怎么找回来 —— 不做向量库，就用关键词加权打分 + 时间衰减
 *      理由：本地 8B 模型 + 个人使用规模，几十到几百条记忆，
 *      一个倒排打分就够了，为这点数据量上一套嵌入模型是过度设计。
 *
 * 落盘格式：单个 JSON 文件。理由是可以直接 git 追踪、可以直接人肉改。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** 极简中文/英文混合分词：中文按双字滑窗，英文按词 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const en = s.match(/[a-z][a-z0-9_]{1,}/g) || [];
  out.push(...en);
  const zh = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of zh) {
    if (seg.length <= 2) {
      out.push(seg);
    } else {
      for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}

class Memory {
  constructor({ dir, maxEpisodes = 200 } = {}) {
    this.dir = dir || path.join(__dirname, '..', 'sandbox', 'memory');
    this.maxEpisodes = maxEpisodes;
    this.file = path.join(this.dir, 'memory.json');
    this.data = { facts: {}, episodes: [], updatedAt: null };
    this._dirty = false;
  }

  async load() {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
    } catch {
      /* 目录建不了就只读，不动摇主流程 */
    }
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        facts: parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {},
        episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
        updatedAt: parsed.updatedAt || null,
      };
    } catch {
      // 没有记忆文件 = 第一次见面，不是错误
      this.data = { facts: {}, episodes: [], updatedAt: null };
    }
    return this;
  }

  async save() {
    if (!this._dirty) return;
    this.data.updatedAt = new Date().toISOString();
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      this._dirty = false;
    } catch (err) {
      // 记忆写不进去不能让 agent 崩掉，只是这次记不住而已
      console.error('[memory] 落盘失败：', err.message);
    }
  }

  // ------------------------------------------------------------ 事实记忆

  /** 记一条事实。同 key 覆盖，会留下修改时间方便追溯 */
  remember(key, value) {
    const k = String(key).trim();
    if (!k) throw new Error('key 不能为空');
    const existed = Object.prototype.hasOwnProperty.call(this.data.facts, k);
    this.data.facts[k] = {
      value: String(value),
      at: Date.now(),
      hits: existed ? (this.data.facts[k].hits || 0) : 0,
    };
    this._dirty = true;
    return existed ? `已更新事实「${k}」` : `已记住事实「${k}」`;
  }

  forget(key) {
    const k = String(key).trim();
    if (!Object.prototype.hasOwnProperty.call(this.data.facts, k)) {
      return `没有叫「${k}」的事实`;
    }
    delete this.data.facts[k];
    this._dirty = true;
    return `已忘掉「${k}」`;
  }

  // ------------------------------------------------------------ 情节记忆

  /** trace 结束时沉淀一条。超上限就丢最老的 */
  addEpisode({ goal, result, turns = 0, tools = [], ok = true }) {
    this.data.episodes.push({
      at: Date.now(),
      goal: String(goal || '').slice(0, 500),
      result: String(result || '').slice(0, 800),
      turns,
      tools,
      ok,
    });
    if (this.data.episodes.length > this.maxEpisodes) {
      this.data.episodes.splice(0, this.data.episodes.length - this.maxEpisodes);
    }
    this._dirty = true;
    return this.data.episodes.length;
  }

  // ------------------------------------------------------------ 检索

  /**
   * 关键词加权检索。打分规则：
   *   - 命中一个查询词 +1，命中 key 本身 +2（标题比正文重要）
   *   - 时间衰减：越新分越高，半衰期 30 天
   *   - 事实自带 hits 加成：被反复想起的更可能有用
   */
  recall(query, limit = 5) {
    const qs = tokenize(query);
    if (!qs.length) return [];
    const now = Date.now();
    const DAY = 86400000;
    const scored = [];

    for (const [k, v] of Object.entries(this.data.facts)) {
      const hay = `${k} ${v.value}`.toLowerCase();
      let score = 0;
      for (const q of qs) {
        if (hay.includes(q)) score += 1;
        if (k.toLowerCase().includes(q)) score += 2;
      }
      if (score <= 0) continue;
      const ageDays = (now - (v.at || now)) / DAY;
      score *= Math.pow(0.5, ageDays / 30); // 30 天半衰
      score += Math.min(v.hits || 0, 5) * 0.2;
      scored.push({ kind: 'fact', key: k, text: `${k}: ${v.value}`, score });
      // 被检索到就记作一次命中，形成"越用越准"的正反馈
      v.hits = (v.hits || 0) + 1;
      this._dirty = true;
    }

    for (const ep of this.data.episodes) {
      const hay = `${ep.goal} ${ep.result}`.toLowerCase();
      let score = 0;
      for (const q of qs) if (hay.includes(q)) score += 1;
      if (score <= 0) continue;
      const ageDays = (now - ep.at) / DAY;
      score *= Math.pow(0.5, ageDays / 30);
      scored.push({
        kind: 'episode',
        at: ep.at,
        text: `目标：${ep.goal}\n结果：${ep.result}`,
        score,
      });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** 给系统提示用的一段渲染文本 */
  render(query, limit = 5) {
    const hits = this.recall(query, limit);
    if (!hits.length) return '';
    return hits.map((h) => `- [${h.kind}] ${h.text}`).join('\n');
  }

  stats() {
    return {
      facts: Object.keys(this.data.facts).length,
      episodes: this.data.episodes.length,
      updatedAt: this.data.updatedAt,
    };
  }
}

module.exports = { Memory, tokenize };
