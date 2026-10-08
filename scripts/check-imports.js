/**
 * 静态检查：前端模块之间的 import / export 是否对得上
 * ------------------------------------------------------------------
 * 浏览器里少一个导出会直接白屏，而且报错信息很难定位。
 * 所以在起服务之前先扫一遍：
 *   1. 每个 import 的文件存在吗
 *   2. 每个具名 import 在目标文件里真的 export 了吗
 *   3. 有没有 import 了却没用到的（只是提示，不拦）
 *
 * 用法：node scripts/check-imports.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'public', 'game.js');

/** 抓 import 语句：`import a, {b, c as d} from './x.js'` */
const RE_IMPORT = /import\s+([^'"]*?)\s+from\s+['"]([^'"]+)['"]/g;
// 注意 `export async function* gen()` 这种生成器，星号也要算进去
const RE_EXPORT_NAMED = /export\s+(?:async\s+)?(?:function\s*\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g;
const RE_EXPORT_BRACE = /export\s*\{([^}]*)\}/g;

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(RE_EXPORT_NAMED)) names.add(m[1]);
  for (const m of src.matchAll(RE_EXPORT_BRACE)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
}

const problems = [];
const unused = [];
const seen = new Set();

function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);

  for (const m of src.matchAll(RE_IMPORT)) {
    const clause = m[1];
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(dir, spec);
    if (!fs.existsSync(target)) {
      problems.push(`${path.relative(ROOT, file)} → 找不到 ${spec}`);
      continue;
    }
    walk(target);
    const avail = exportsOf(target);
    const brace = clause.match(/\{([^}]*)\}/);
    if (!brace) continue;
    for (const part of brace[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      const name = as[0].trim();
      const local = (as[1] || as[0]).trim();   // `x as y` 时正文里用的是 y
      if (!avail.has(name)) {
        problems.push(`${path.relative(ROOT, file)} → ${spec} 里没有导出 ${name}`);
        continue;
      }
      // 这个标识符在文件正文里除了 import 行还出现过吗
      const body = src.replace(RE_IMPORT, '');
      if (!new RegExp(`(?<![\\w$.])${local}(?![\\w$])`).test(body)) {
        unused.push(`${path.relative(ROOT, file)} → import 了 ${name} 但没用`);
      }
    }
  }
}

walk(ENTRY);

console.log(`扫了 ${seen.size} 个前端模块`);
if (problems.length) {
  console.log('\n✗ 有问题：');
  for (const p of problems) console.log('  ' + p);
} else {
  console.log('✓ import / export 全部对得上');
}
if (unused.length) {
  console.log('\n· 没用到的 import：');
  for (const p of unused) console.log('  ' + p);
}
process.exit(problems.length ? 1 : 0);
