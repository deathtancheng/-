/**
 * YOLO 能力封装（供 vision 扩展使用）
 * ------------------------------------------------------------------
 * 和 server.js 里那份实现同一套逻辑，但独立成模块，这样 Harness
 * 不依赖 HTTP 层——将来换成 CLI 或 Electron，这一段原样搬走即可。
 *
 * 两个坑（已在第二部分踩过，这里直接规避）：
 *   1. 中文路径不能直接进命令行参数 → 图片走 stdin 传 base64
 *   2. Python 的 stdout 会被库日志污染 → 从后往前找最后一段合法 JSON
 */

const { spawn } = require('child_process');
const path = require('path');

// 配置统一从 src/config.js 取，这里不要再抄一份。
// 抄两份的下场就是：改了 config 这边纹丝不动，而报错信息又指向别处。
const {
  YOLO_PY, YOLO_DIR, YOLO_WEIGHTS, YOLO_ENGINE, YOLO_CONF, CAMERA_URL,
} = require('../config');

function runYoloBase64(base64Image) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(
        YOLO_PY,
        [
          path.join(YOLO_DIR, 'detect_stdin.py'),
          '--weights', YOLO_WEIGHTS,
          '--engine', YOLO_ENGINE,
          '--conf', String(YOLO_CONF),
          '--imgsz', '640',
        ],
        { cwd: YOLO_DIR, windowsHide: true }
      );
    } catch (err) {
      reject(new Error('启动 Python 失败，检查 YOLO_PY：' + err.message));
      return;
    }
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', () => {
      const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          resolve(JSON.parse(lines[i]));
          return;
        } catch {
          /* 不是 JSON 就继续往上找 */
        }
      }
      reject(new Error('Python 输出解析失败：' + (err || out).slice(0, 300)));
    });
    proc.stdin.end(base64Image);
  });
}

async function cameraDetect() {
  const r = await fetch(`${CAMERA_URL}/detect`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('摄像头服务返回 ' + r.status + '（确认 camera_server.py 已启动）');
  return await r.json();
}

async function cameraSnapshotBytes() {
  const r = await fetch(`${CAMERA_URL}/snapshot`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('摄像头服务返回 ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

/** 把检测结果渲染成人能读、模型也能读的一段话 */
function describeDetection(js) {
  if (!js || js.error) return `检测失败：${(js && js.error) || '未知错误'}`;
  const dets = js.detections || js.boxes || [];
  const ms = js.ms != null ? `${js.ms.toFixed(1)}ms` : '未知耗时';
  const engine = js.engine || YOLO_ENGINE;
  if (!dets.length) return `没检测到任何目标（${engine}，${ms}）。画面可能太暗或没有可识别物体。`;
  const counts = new Map();
  for (const d of dets) {
    const label = d.label || d.name || 'object';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const summary = [...counts.entries()].map(([k, v]) => `${k}×${v}`).join('、');
  const top = dets
    .slice(0, 8)
    .map((d) => `  - ${d.label || d.name} 置信度 ${(d.conf ?? d.confidence ?? 0).toFixed(2)}`)
    .join('\n');
  return `检测到 ${dets.length} 个目标（${engine}，${ms}）：${summary}\n${top}`;
}

module.exports = {
  runYoloBase64,
  cameraDetect,
  cameraSnapshotBytes,
  describeDetection,
  YOLO_DIR,
  CAMERA_URL,
};
