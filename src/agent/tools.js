/**
 * 智能体的内置工具
 * ------------------------------------------------------------------
 * 这一层是"手"：算数、读写沙箱文件、抓网页、调 YOLO 看东西。
 * 工具只管忠实执行，不负责判断该不该做——判断在上层。
 *
 * 两个已经踩过的坑（这里直接规避）：
 *   1. 中文路径进不了命令行参数 → 图片走 stdin 传 base64
 *   2. 沙箱外的路径一律拒绝 → resolveInSandbox 挡在门口
 */

const fsp = require('fs/promises');
const path = require('path');
const { SANDBOX_DIR } = require('../config');
const { runYoloBase64, cameraDetect, cameraSnapshotBytes } = require('../vision/detect');

// 下面几个名字沿用原实现，方便按老名字调用
const runYolo = runYoloBase64;
async function cameraSnapshot(saveAs) {
  const buf = await cameraSnapshotBytes();
  const name = String(saveAs || `camera_${Date.now()}`).replace(/[\\/]/g, '_');
  const rel = name.endsWith('.jpg') ? name : name + '.jpg';
  await fsp.writeFile(path.join(SANDBOX_DIR, rel), buf);
  return `已保存 ${rel}（${(buf.length / 1024).toFixed(1)} KB）`;
}

function safeCalc(rawExpr) {
  let expr = String(rawExpr)
    .replace(/\^/g, '**')
    .replace(/\b(sqrt|abs|round|floor|ceil|sin|cos|tan|log|exp|pow|min|max)\b/g, 'Math.$1')
    .replace(/\b(pi|PI)\b/g, 'Math.PI')
    .replace(/\b(e|E)\b/g, 'Math.E');

  // 允许：数字、运算符、括号、空格、Math.xxx
  const allowed = /^[0-9+\-*/().%\s,]+$/;
  const stripped = expr.replace(/Math\.[A-Za-z]+/g, '');
  if (!allowed.test(stripped)) {
    throw new Error('表达式含有不允许的字符，只支持数字与 + - * / ^ % ( ) 及基础数学函数');
  }
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${expr});`)();
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error('计算结果不是有效数字');
  }
  return value;
}

/** 目录/文件访问限制在 sandbox 内，防目录穿越 */
function resolveInSandbox(relPath) {
  const target = path.resolve(SANDBOX_DIR, relPath || '.');
  if (target !== SANDBOX_DIR && !target.startsWith(SANDBOX_DIR + path.sep)) {
    throw new Error('拒绝访问：路径超出沙箱范围');
  }
  return target;
}

async function toolListFiles() {
  const entries = await fsp.readdir(SANDBOX_DIR, { withFileTypes: true });
  if (entries.length === 0) return '沙箱目录为空';
  return entries
    .map((e) => `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}`)
    .join('\n');
}

async function toolReadFile(relPath) {
  const target = resolveInSandbox(relPath);
  const stat = await fsp.stat(target);
  if (stat.size > 64 * 1024) throw new Error('文件超过 64KB，拒绝读取');
  return await fsp.readFile(target, 'utf8');
}

async function toolWriteFile(relPath, content) {
  const target = resolveInSandbox(relPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, String(content), 'utf8');
  const stat = await fsp.stat(target);
  return `已写入 ${path.relative(SANDBOX_DIR, target)}（${stat.size} 字节）`;
}

async function toolFetchUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error('URL 格式不合法');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('仅支持 http/https');
  const res = await fetch(parsed, {
    signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': 'Mozilla/5.0 local-ai-lab' },
  });
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
}

// ---------------------------------------------------------------- YOLO 推理

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: '计算数学表达式，例如 "12 * (3 + 4)"、"sqrt(2) * 10"、"2^10"。需要精确数值时必须调用，不要心算。',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: '要计算的数学表达式' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取本机当前的日期、时间和星期几。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出沙箱工作目录中的文件和子目录。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取沙箱工作目录中的一个文本文件内容。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对沙箱目录的文件路径，如 notes/todo.md' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把一段文本内容写入沙箱工作目录中的文件（会覆盖同名文件）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对沙箱目录的文件路径' },
          content: { type: 'string', description: '要写入的文本内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '抓取一个网页并提取正文文本（最多 3000 字），用于查资料。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整的 http/https 网址' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detect_image',
      description: '对沙箱目录里的一张图片做 YOLO 目标检测，返回画面中有哪些物体、各有几个、位置在哪。想知道图片内容时必须调用。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对沙箱目录的图片路径，如 camera_1.jpg' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detect_camera',
      description: '对摄像头当前这一帧做 YOLO 目标检测，返回画面里有什么东西、各有几个。用户问「你看到了什么」「摄像头前有什么」时调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'camera_snapshot',
      description: '拍一张摄像头当前画面并保存到沙箱目录，返回文件名。之后可以用 detect_image 分析它。',
      parameters: {
        type: 'object',
        properties: { filename: { type: 'string', description: '保存的文件名，如 desk.jpg；留空则自动生成' } },
      },
    },
  },
];

async function dispatchTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'calculator':
      return String(safeCalc(a.expression));
    case 'get_current_time': {
      const now = new Date();
      const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
      return now.toLocaleString('zh-CN', { hour12: false }) + ' ' + week;
    }
    case 'list_files':
      return await toolListFiles();
    case 'read_file':
      return await toolReadFile(a.path);
    case 'write_file':
      return await toolWriteFile(a.path, a.content);
    case 'fetch_url':
      return await toolFetchUrl(a.url);
    case 'detect_image': {
      const buf = await fsp.readFile(resolveInSandbox(a.path));
      const r = await runYolo(buf.toString('base64'));
      if (r.error) return `检测失败：${r.error}`;
      const detail = (r.detections || []).map((d) => `${d.label}(${d.conf})`).join(', ');
      return `${r.summary}\n明细：${detail || '无'}\n（${r.latency_ms} ms，引擎 ${r.engine}，画面 ${r.size.w}x${r.size.h}）`;
    }
    case 'detect_camera': {
      const r = await cameraDetect();
      if (r.error) return `摄像头不可用：${r.error}`;
      const detail = (r.detections || []).map((d) => `${d.label}(${d.conf})`).join(', ');
      return `${r.summary}\n明细：${detail || '无'}\n（${r.latency_ms} ms，${r.fps} FPS）`;
    }
    case 'camera_snapshot':
      return await cameraSnapshot(a.filename);
    default:
      throw new Error(`未知工具：${name}`);
  }
}

// ---------------------------------------------------------------- Ollama 流式读取

/** 把 ReadableStream 按行拆成 JSON（Ollama 返回 NDJSON） */
async function* ndjson(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        try {
          yield JSON.parse(line);
        } catch {
          /* 忽略半行 */
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 智能体主循环


module.exports = { safeCalc, resolveInSandbox, TOOLS, dispatchTool, cameraDetect, cameraSnapshot, ndjson };
