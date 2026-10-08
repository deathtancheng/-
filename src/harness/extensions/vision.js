/**
 * vision 扩展 —— 让 Agent 长眼睛
 * ------------------------------------------------------------------
 * 内核里没有任何视觉代码。装上这个扩展，Agent 才第一次获得
 * "看"的能力；卸掉它，Agent 退回纯文本，但一行内核都不用改。
 *
 * 这就是扩展机制要证明的事：能力是可插拔的，不是写死在循环里的。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { LEVEL } = require('../tools');
const { cameraDetect, cameraSnapshotBytes, runYoloBase64, describeDetection } = require('../../vision/detect');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp']);

module.exports = function visionExtension({ root } = {}) {
  const ROOT = path.resolve(root || path.join(__dirname, '..', '..', 'sandbox'));

  function resolveIn(rel) {
    const target = path.resolve(ROOT, rel || '.');
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      throw new Error(`拒绝访问：${rel} 超出工作区范围`);
    }
    return target;
  }

  return {
    name: 'vision',
    description: 'YOLO 视觉能力：看摄像头、检测图片里的物体',
    system:
      '你装着 vision 扩展，有视觉能力。用户问"这是什么""画面里有什么""帮我看看"时，'
      + '用 look 看摄像头实时画面，用 detect_image 检测工作区里的图片。'
      + '检测结果里的置信度低于 0.5 的目标要说明"不确定"，不要当成确定事实。',

    tools: [
      {
        name: 'look',
        level: LEVEL.SAFE,
        description:
          '用摄像头看一眼当前实时画面，返回 YOLO 识别到的物体清单。'
          + '用户问"看看这是什么""画面里有几个人"时调用。',
        params: { type: 'object', properties: {} },
        async run() {
          const js = await cameraDetect();
          return describeDetection(js);
        },
      },

      {
        name: 'capture',
        level: LEVEL.WRITE,
        description: '抓拍一张摄像头当前画面，存成图片文件到工作区。',
        params: {
          type: 'object',
          properties: {
            save_as: { type: 'string', description: '保存的文件名，例如 desk.jpg' },
          },
          required: ['save_as'],
        },
        async run({ save_as }) {
          const buf = await cameraSnapshotBytes();
          const name = String(save_as).replace(/[\\/]/g, '_');
          const rel = /\.(jpg|jpeg|png)$/i.test(name) ? name : name + '.jpg';
          await fsp.writeFile(resolveIn(rel), buf);
          return `已抓拍保存为 ${rel}（${(buf.length / 1024).toFixed(1)} KB）`;
        },
      },

      {
        name: 'detect_image',
        level: LEVEL.SAFE,
        description: '对工作区里的一张图片跑 YOLO 目标检测，返回识别到的物体和置信度。',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '图片相对工作区的路径，例如 capture/desk.jpg' },
          },
          required: ['path'],
        },
        async run({ path: rel }) {
          const target = resolveIn(rel);
          if (!fs.existsSync(target)) throw new Error(`图片不存在：${rel}`);
          if (!IMAGE_EXT.has(path.extname(target).toLowerCase())) {
            throw new Error(`不是支持的图片格式：${path.extname(target)}`);
          }
          const stat = await fsp.stat(target);
          if (stat.size > 12 * 1024 * 1024) throw new Error('图片超过 12MB');
          const b64 = (await fsp.readFile(target)).toString('base64');
          const js = await runYoloBase64(b64);
          return describeDetection(js);
        },
      },
    ],
  };
};
