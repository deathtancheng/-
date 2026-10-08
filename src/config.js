/**
 * 全局配置 —— 端口、路径、上游地址
 * ------------------------------------------------------------------
 * 所有会随环境变的东西集中在这里，别散落到各个模块里。
 * 每个值都能用环境变量覆盖，方便换机器演示。
 */

const path = require('path');
const fs = require('fs');

/** Ollama 上游（本地大模型） */
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
/** Web 服务端口 */
const PORT = Number(process.env.PORT || 5178);
/** 前端静态资源目录 */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
/** 沙箱：智能体能读写的唯一目录 */
const SANDBOX_DIR = path.join(__dirname, '..', 'sandbox');
/** 单次提问最多跑几轮工具循环 */
const MAX_AGENT_STEPS = 6;

// ---- YOLO 视觉 ----
/** 跑 YOLO 的 Python 解释器 */
const YOLO_PY = process.env.YOLO_PY || 'D:/yolo-venv/Scripts/python.exe';
/** YOLO 工程目录（项目根的 yolo/） */
const YOLO_DIR = path.join(__dirname, '..', 'yolo');
const TRAINED_REL = 'runs/detect/runs/coco128_yolo11n/weights/best.pt';
/** 权重优先用自己训的，没有就退回官方 yolo11n */
const YOLO_WEIGHTS =
  process.env.YOLO_WEIGHTS
  || (fs.existsSync(path.join(YOLO_DIR, TRAINED_REL)) ? TRAINED_REL : 'yolo11n.pt');
const YOLO_ENGINE = process.env.YOLO_ENGINE || 'pt';   // pt | onnx
const YOLO_CONF = Number(process.env.YOLO_CONF || 0.25);
/** 摄像头 YOLO 服务（camera_server.py） */
const CAMERA_URL = process.env.CAMERA_URL || 'http://127.0.0.1:5179';

module.exports = {
  OLLAMA, PORT, PUBLIC_DIR, SANDBOX_DIR, MAX_AGENT_STEPS,
  YOLO_PY, YOLO_DIR, YOLO_WEIGHTS, YOLO_ENGINE, YOLO_CONF, TRAINED_REL, CAMERA_URL,
};
