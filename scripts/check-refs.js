/**
 * 静态扫一遍 src/ 下的 CommonJS 模块，找出"用到却没导入"的全大写常量。
 * ------------------------------------------------------------------
 * 起因：src/http/routes/vision.js 漏导入 CAMERA_URL，运行时抛
 * "CAMERA_URL is not defined"，偏偏被 catch 包装成"摄像头服务未启动"，
 * 排查方向被带偏了很久。node --check 只查语法，查不出这类问题。
 *
 * 只盯全大写常量（CAMERA_URL / FRENZY_MULT / PLAYER_HP …），
 * 因为它们是跨模块引用里最容易漏、又最不会是局部变量的那一类。
 *
 * 用法：node scripts/check-refs.js [target-dir]
 * 默认扫描项目根下的 src/
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGET = process.argv[2] || 'src';
const SRC = path.isAbsolute(TARGET) ? TARGET : path.join(ROOT, TARGET);

if (!fs.existsSync(SRC)) {
  console.error(`扫描目录不存在：${SRC}`);
  process.exit(1);
}

/** 语言内置 / 本文件已声明之外的合法来源 */
const BUILTINS = new Set([
  'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2',
  'JSON', 'Math', 'Object', 'Array', 'Promise', 'Error', 'TypeError',
  'Set', 'Map', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Symbol',
  'Buffer', 'URL', 'NaN', 'Infinity', 'Function', 'Readable', 'AbortSignal',
]);

// 前面不能有 . （process.env.X 这类属性访问）；
// 后面不能紧跟 : （对象字面量的 key，比如 { TRACE_START: 'x' }）
const RE_CONST = /(?<![.\w$])([A-Z][A-Z0-9_]*)\b(?!\s*:)/g;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 去掉注释、字符串、正则字面量，免得把里面的内容当成代码 */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    // 正则字面量：/.../ 后面跟 flag 的，或者形如 /^\w+$/ 的
    .replace(/\/(?:\\.|\[(?:\\.|[^\]])*\]|[^\/\n\\])+\/[gimsuy]*/g, '``');
}

/** 本文件里定义过（或解构导入过）的名字 */
function collectDefined(code) {
  const def = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([^=;{]+?)\s*(?:=|$)/gm)) {
    for (const id of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) def.add(id[0]);
  }
  // 解构：const { A, B } = require(...)
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const id of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) def.add(id[0]);
  }
  return def;
}

let problems = 0;
for (const file of walk(SRC)) {
  const code = strip(fs.readFileSync(file, 'utf8'));
  const defined = collectDefined(code);
  const missing = new Map();
  for (const m of code.matchAll(RE_CONST)) {
    const name = m[1];
    if (BUILTINS.has(name) || defined.has(name)) continue;
    if (!missing.has(name)) missing.set(name, code.slice(0, m.index).split('\n').length);
  }
  if (missing.size) {
    problems += missing.size;
    console.log(`\n${path.relative(ROOT, file)}`);
    for (const [name, line] of missing) console.log(`  第 ${line} 行附近：${name} 没有定义也没有导入`);
  }
}
console.log(problems ? `\n发现 ${problems} 处可疑，请人工确认` : '\n没有发现未导入的常量');
