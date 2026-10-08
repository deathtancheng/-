/**
 * research 扩展 —— 自动科研流水线
 * ------------------------------------------------------------------
 * 题目里那句"人类仅作启动子"，落到这里就是：
 * 你只给一句话目标，Agent 自己跑完 检索 → 记笔记 → 做实验 → 沉淀 → 汇报，
 * 全程只有危险操作才回来敲门。
 *
 * 它证明的是扩展能承载"方法论"，不只是"多几个工具"：
 *   - 工具：read_web / save_note / remember / recall
 *   - 钩子：TOOL_END 写审计流水，TRACE_END 自动落一份结构化报告
 *   - 系统提示：把科研流程的约定注入模型
 *
 * 换一个专业方向（比如乐队推广、量化回测），复制这个文件改掉流程和
 * 笔记模板即可，内核完全不用动。
 */

const fsp = require('fs/promises');
const path = require('path');
const { LEVEL } = require('../tools');
const { HOOKS } = require('../lifecycle');

const NOTE_TEMPLATE = (topic) => `# ${topic}

> 由 Harness research 扩展自动生成 · ${new Date().toLocaleString('zh-CN')}

## 一、问题
<!-- 要搞清楚什么 -->

## 二、已有信息
<!-- 检索/实验拿到的事实，标注来源 -->

## 三、实验与数据
<!-- 跑了什么、得到什么数字 -->

## 四、结论
<!-- 目前能确定的、还不能确定的 -->

## 五、下一步
<!-- 还缺什么、下一步做什么 -->
`;

module.exports = function researchExtension({ root, memory } = {}) {
  const ROOT = path.resolve(root || path.join(__dirname, '..', '..', 'sandbox'));
  const NOTES_DIR = path.join(ROOT, 'notes');
  const AUDIT_LOG = path.join(ROOT, 'notes', '.audit.log');

  function resolveIn(rel) {
    const target = path.resolve(ROOT, rel || '.');
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      throw new Error(`拒绝访问：${rel} 超出工作区范围`);
    }
    return target;
  }

  return {
    name: 'research',
    description: '自动科研流水线：检索、记笔记、沉淀记忆、自动出报告',
    system:
      '你装着 research 扩展，按科研流程工作：\n'
      + '1. 先确认问题边界，不急着动手；\n'
      + '2. 用 read_web 取资料，重要结论必须存 save_note，不要只停在对话里；\n'
      + '3. 数字必须来自 calculator 或真实实验结果，不许心算和编造；\n'
      + '4. 得到的稳定结论用 remember 存进长期记忆，下次开工前先 recall；\n'
      + '5. 收尾时给出可复核的结论，并明确说清哪些是推测。',

    tools: [
      {
        name: 'read_web',
        level: LEVEL.SAFE,
        description: '抓取一个网页的正文文本（自动去掉脚本样式），最多返回 3000 字。',
        params: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'http/https 开头的完整网址' },
          },
          required: ['url'],
        },
        async run({ url }) {
          let parsed;
          try {
            parsed = new URL(String(url));
          } catch {
            throw new Error('URL 格式不合法');
          }
          if (!/^https?:$/.test(parsed.protocol)) throw new Error('仅支持 http/https');
          const res = await fetch(parsed, {
            signal: AbortSignal.timeout(15000),
            headers: { 'user-agent': 'Mozilla/5.0 local-ai-lab-harness' },
          });
          if (!res.ok) throw new Error(`页面返回 ${res.status}`);
          const html = await res.text();
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim();
          if (!text) throw new Error('页面没有可提取的文本');
          return text.slice(0, 3000);
        },
      },

      {
        name: 'save_note',
        level: LEVEL.WRITE,
        description:
          '把研究笔记写入 notes/ 目录的 Markdown 文件。如果文件不存在，'
          + '会先用标准模板（问题/已有信息/实验数据/结论/下一步）创建。',
        params: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '笔记主题，也用作文件名' },
            content: { type: 'string', description: '笔记正文（Markdown）' },
            mode: {
              type: 'string',
              description: 'append 追加（默认）或 overwrite 覆盖',
            },
          },
          required: ['topic', 'content'],
        },
        async run({ topic, content, mode = 'append' }) {
          await fsp.mkdir(NOTES_DIR, { recursive: true });
          const safe = String(topic).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
          const file = resolveIn(path.join('notes', `${safe}.md`));
          let text;
          try {
            text = await fsp.readFile(file, 'utf8');
          } catch {
            text = NOTE_TEMPLATE(topic);
          }
          const next =
            mode === 'overwrite'
              ? String(content)
              : `${text.replace(/\s+$/, '')}\n\n---\n\n${String(content)}\n`;
          await fsp.writeFile(file, next, 'utf8');
          return `笔记已写入 notes/${safe}.md（${next.length} 字符）`;
        },
      },

      {
        name: 'remember',
        level: LEVEL.WRITE,
        description:
          '把一条稳定结论存进长期记忆，下次会话还能想起来。'
          + '适合存：用户偏好、项目约定、验证过的结论、踩过的坑。',
        params: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '记忆的标题/关键词，例如 "YOLO权重路径"' },
            value: { type: 'string', description: '具体内容' },
          },
          required: ['key', 'value'],
        },
        async run({ key, value }) {
          if (!memory) return '记忆模块未启用，这条没记住。';
          const msg = memory.remember(key, value);
          await memory.save();
          return msg;
        },
      },

      {
        name: 'recall',
        level: LEVEL.SAFE,
        description: '从长期记忆里检索与某话题相关的既往信息。开工前先查一次，别重复踩坑。',
        params: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词或一句话' },
          },
          required: ['query'],
        },
        async run({ query }) {
          if (!memory) return '记忆模块未启用。';
          const hits = memory.recall(query, 6);
          if (!hits.length) return `记忆里没有和「${query}」相关的内容。`;
          return hits.map((h) => `- [${h.kind}] ${h.text}`).join('\n');
        },
      },
    ],

    hooks: [
      // 每个工具跑完都记一笔流水账。长任务事后复盘全靠它
      {
        hook: HOOKS.TOOL_END,
        async fn(ctx) {
          try {
            const line =
              `[${new Date().toISOString()}] ${ctx.traceId}/t${ctx.turn} `
              + `${ctx.name} ok=${ctx.result.ok} blocked=${ctx.result.blocked} ${ctx.result.ms}ms\n`;
            await fsp.mkdir(NOTES_DIR, { recursive: true });
            await fsp.appendFile(AUDIT_LOG, line, 'utf8');
          } catch {
            /* 审计写不进去不能影响主流程 */
          }
        },
      },

      // trace 收尾自动落一份报告，人回来就有东西可读
      {
        hook: HOOKS.TRACE_END,
        async fn(ctx) {
          const r = ctx.result || {};
          if (!r.text && !r.error) return; // 空跑不记
          try {
            await fsp.mkdir(NOTES_DIR, { recursive: true });
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const file = resolveIn(path.join('notes', `report-${stamp}.md`));
            const body = [
              `# 自动科研报告 · ${new Date().toLocaleString('zh-CN')}`,
              '',
              `**目标**：${ctx.goal}`,
              '',
              `**过程**：${r.turns} 轮对话，${r.toolCalls} 次工具调用，`
                + `上下文压缩 ${r.compactions} 次，耗时 ${(r.ms / 1000).toFixed(1)}s`,
              '',
              r.aborted ? '> ⚠ 本次执行被中断' : '',
              r.error ? `> ❌ 出错：${r.error}` : '',
              '',
              '## 结论',
              '',
              r.text || '（无文本输出）',
              '',
            ]
              .filter(Boolean)
              .join('\n');
            await fsp.writeFile(file, body, 'utf8');
            ctx.result = { ...r, reportPath: `notes/report-${stamp}.md` };
            return ctx;
          } catch {
            /* 报告写不出来就算了 */
          }
        },
      },
    ],
  };
};
