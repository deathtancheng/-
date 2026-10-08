/**
 * 内置原子工具集 —— Harness 的极简内核
 * ------------------------------------------------------------------
 * Pi 的内核只有四个工具：read / write / edit / bash。我原样照搬这个
 * 思路，只多加两个零风险的（calculator / now），理由是本地 8B 模型
 * 心算和时间感知都不可靠，而这两个工具不碰任何外部资源。
 *
 * 业务能力（YOLO、摄像头、联网）一律不进内核，走 extensions/ 热插拔。
 * 这样内核可以保持到几百行，换一个专业方向只要换扩展不改内核。
 *
 * 安全基线：
 *   - 所有路径先 resolve 再比对前缀，挡掉 ../ 穿越
 *   - 读有大小上限，写有大小上限，bash 有超时和黑名单
 *   - 每个工具都不抛异常（ToolRegistry.invoke 兜底），报错就是一条消息
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const LEVEL = require('./tools').LEVEL;

const MAX_READ = 128 * 1024; // 128KB，够读代码和笔记
const MAX_WRITE = 512 * 1024; // 512KB
const BASH_TIMEOUT = 20000;

/** 危险命令黑名单：挡掉会物理破坏环境的操作 */
const BASH_DENY = [
  /\brm\s+(-rf|-fr|-r\s+-f|--recursive)\b/i,
  /\bformat\b/i,
  /\bdel\s+\/s\b/i,
  /\bshutdown\b/i,
  /\breg\s+(delete|add)\b/i,
  /\btaskkill\b/i,
  /\bnet\s+user\b/i,
  />\s*\/(?:dev|etc|sys)\//i,
];

/** 计算表达式白名单，沿用 server.js 里已经验证过的实现 */
function safeCalc(rawExpr) {
  let expr = String(rawExpr)
    .replace(/\^/g, '**')
    .replace(/\b(sqrt|abs|round|floor|ceil|sin|cos|tan|log|exp|pow|min|max)\b/g, 'Math.$1')
    .replace(/\b(pi|PI)\b/g, 'Math.PI')
    .replace(/\b(e|E)\b/g, 'Math.E');

  const allowed = /^[0-9+\-*/().%\s,]+$/;
  const stripped = expr.replace(/Math\.[A-Za-z]+/g, '');
  if (!allowed.test(stripped)) {
    throw new Error('表达式含有不允许的字符，只支持数字与 + - * / ^ % ( ) 及基础数学函数');
  }
  const value = Function(`"use strict"; return (${expr});`)();
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error('计算结果不是有效数字');
  }
  return value;
}

/**
 * 生成内置工具。root 是沙箱根目录。
 * 注意：read 返回带行号，是为了让 edit 能精确指向"第几行"——
 * 本地小模型对行号的把握远好于对整段文本匹配的把握。
 */
function createBuiltinTools({ root } = {}) {
  const ROOT = path.resolve(root || path.join(__dirname, '..', 'sandbox'));

  function resolveIn(rel) {
    const target = path.resolve(ROOT, rel || '.');
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      throw new Error(`拒绝访问：${rel} 超出工作区范围（${ROOT}）`);
    }
    return target;
  }

  async function ensureDir(p) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
  }

  return [
    // ---------------------------------------------------------- read
    {
      name: 'read',
      level: LEVEL.SAFE,
      description:
        '读取工作区内的文件内容，返回带行号的文本。想看某文件有什么时用这个。',
      params: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的路径，例如 notes/todo.md' },
          offset: { type: 'number', description: '从第几行开始读，默认 1' },
          limit: { type: 'number', description: '最多读多少行，默认 400' },
        },
        required: ['path'],
      },
      async run({ path: rel, offset = 1, limit = 400 }) {
        const target = resolveIn(rel);
        const stat = await fsp.stat(target);
        if (stat.isDirectory()) {
          const entries = await fsp.readdir(target, { withFileTypes: true });
          return `这是一个目录，里面有：\n${entries
            .map((e) => `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}`)
            .join('\n')}`;
        }
        if (stat.size > MAX_READ) {
          throw new Error(`文件 ${(stat.size / 1024).toFixed(0)}KB，超过 ${MAX_READ / 1024}KB 上限`);
        }
        const text = await fsp.readFile(target, 'utf8');
        const lines = text.split(/\r?\n/);
        const start = Math.max(1, Number(offset) || 1);
        const end = Math.min(lines.length, start + (Number(limit) || 400) - 1);
        const body = lines
          .slice(start - 1, end)
          .map((l, i) => `${String(start + i).padStart(5)}| ${l}`)
          .join('\n');
        return `文件 ${path.relative(ROOT, target)}（共 ${lines.length} 行，显示 ${start}-${end}）：\n${body}`;
      },
    },

    // ---------------------------------------------------------- list
    {
      name: 'list',
      level: LEVEL.SAFE,
      description: '列出工作区某个目录下的文件和子目录。',
      params: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，默认工作区根目录' },
          recursive: { type: 'boolean', description: '是否递归，默认 false' },
        },
      },
      async run({ path: rel = '.', recursive = false }) {
        const target = resolveIn(rel);
        async function walk(dir, prefix, depth) {
          const entries = await fsp.readdir(dir, { withFileTypes: true });
          const rows = [];
          for (const e of entries) {
            const relPath = path.join(prefix, e.name);
            rows.push(`${e.isDirectory() ? '[目录]' : '[文件]'} ${relPath}`);
            if (recursive && e.isDirectory() && depth < 4) {
              rows.push(...(await walk(path.join(dir, e.name), relPath, depth + 1)));
            }
          }
          return rows;
        }
        const rows = await walk(target, rel === '.' ? '' : rel, 0);
        return rows.length ? rows.join('\n') : '（空目录）';
      },
    },

    // ---------------------------------------------------------- write
    {
      name: 'write',
      level: LEVEL.WRITE,
      description:
        '把内容完整写入文件（覆盖原内容）。新建文件、重写整个文件用这个；只改一小段请用 edit。',
      params: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的路径' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
        required: ['path', 'content'],
      },
      async run({ path: rel, content }) {
        const target = resolveIn(rel);
        const buf = Buffer.from(String(content ?? ''), 'utf8');
        if (buf.length > MAX_WRITE) {
          throw new Error(`内容 ${(buf.length / 1024).toFixed(0)}KB 超过上限`);
        }
        const existed = fs.existsSync(target);
        await ensureDir(target);
        await fsp.writeFile(target, buf);
        return `${existed ? '已覆盖' : '已新建'} ${path.relative(ROOT, target)}（${buf.length} 字节）`;
      },
    },

    // ---------------------------------------------------------- edit
    {
      name: 'edit',
      level: LEVEL.WRITE,
      description:
        '对已有文件做精确替换：把 old_text 换成 new_text。old_text 必须在文件中唯一，'
        + '否则会拒绝并提示出现次数。改一小段时用这个，比整个文件重写安全得多。',
      params: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的路径' },
          old_text: { type: 'string', description: '要被替换的原文，必须唯一' },
          new_text: { type: 'string', description: '替换后的新文本' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
      async run({ path: rel, old_text, new_text }) {
        const target = resolveIn(rel);
        const text = await fsp.readFile(target, 'utf8');
        const needle = String(old_text);
        const count = text.split(needle).length - 1;
        if (count === 0) {
          throw new Error(
            `没找到这段原文。请先用 read 确认文件实际内容（注意空格和换行要完全一致）。文件共 ${text.split(/\r?\n/).length} 行。`
          );
        }
        if (count > 1) {
          throw new Error(
            `这段原文出现了 ${count} 次，无法唯一定位。请把 old_text 写长一点，带上前后文。`
          );
        }
        const next = text.replace(needle, String(new_text));
        await fsp.writeFile(target, next, 'utf8');
        return `已修改 ${path.relative(ROOT, target)}（替换 1 处，${text.length} → ${next.length} 字符）`;
      },
    },

    // ---------------------------------------------------------- bash
    {
      name: 'bash',
      level: LEVEL.DANGER,
      description:
        '在工作区内执行一条 shell 命令并返回输出。会执行外部命令，需要用户确认。'
        + '禁止用于删除、格式化等破坏性操作。',
      params: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeout: { type: 'number', description: '超时毫秒数，默认 20000' },
        },
        required: ['command'],
      },
      async run({ command, timeout = BASH_TIMEOUT }, ctx) {
        const cmd = String(command || '').trim();
        if (!cmd) throw new Error('命令为空');

        for (const re of BASH_DENY) {
          if (re.test(cmd)) {
            throw new Error(`命令命中安全黑名单，拒绝执行：${re}`);
          }
        }

        const cwd = ctx && ctx.cwd ? path.resolve(ctx.cwd) : ROOT;
        return await new Promise((resolve, reject) => {
          const isWin = process.platform === 'win32';
          const shell = isWin ? 'cmd.exe' : '/bin/sh';
          const args = isWin ? ['/c', cmd] : ['-c', cmd];
          const proc = execFile(
            shell,
            args,
            { cwd, timeout: Number(timeout) || BASH_TIMEOUT, maxBuffer: 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
              const out = String(stdout || '');
              const errOut = String(stderr || '');
              if (err && !out && !errOut) {
                reject(new Error(err.message || '命令执行失败'));
                return;
              }
              const tail = (s) => (s.length > 6000 ? s.slice(0, 6000) + '\n…（输出已截断）' : s);
              const pieces = [];
              if (out) pieces.push(tail(out));
              if (errOut) pieces.push(`[stderr]\n${tail(errOut)}`);
              if (err) pieces.push(`[退出码 ${err.code ?? '?'}]`);
              resolve(pieces.join('\n') || '（无输出）');
            }
          );
          if (ctx && ctx.signal) {
            const onAbort = () => {
              try {
                proc.kill();
              } catch {
                /* 已经结束了 */
              }
            };
            ctx.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      },
    },

    // ---------------------------------------------------------- calculator
    {
      name: 'calculator',
      level: LEVEL.SAFE,
      description:
        '计算数学表达式，如 "12 * (3 + 4)"、"sqrt(2) * 10"、"2^10"。需要精确数值时必须调用，不要心算。',
      params: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '数学表达式' },
        },
        required: ['expression'],
      },
      async run({ expression }) {
        const v = safeCalc(expression);
        return `${expression} = ${Number.isInteger(v) ? v : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
      },
    },

    // ---------------------------------------------------------- now
    {
      name: 'now',
      level: LEVEL.SAFE,
      description: '获取本机当前的日期、时间和星期几。涉及"今天""最近"这类时间判断时先调这个。',
      params: { type: 'object', properties: {} },
      async run() {
        const d = new Date();
        const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 星期${week}`;
      },
    },
  ];
}

module.exports = { createBuiltinTools, safeCalc, BASH_DENY };
