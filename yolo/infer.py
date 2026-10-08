"""
YOLO 推理封装：图片 / 视频 / 摄像头，支持 PyTorch 与 ONNX 两种引擎。

为什么要有 ONNX 这一档：
    .pt 权重每次推理都要带上 Python + PyTorch 的全部开销（约 2.5GB 常驻显存/内存）；
    导出成 ONNX 后用 onnxruntime-gpu 跑，算子被图优化 + CUDA EP 加速，
    同一张 640×640 图的端到端延迟通常能降 30%~50%，而且部署时不需要 PyTorch。
    再往下要极致性能，就是换成 OpenCV DNN / TensorRT C++ 部署——那是同一套 ONNX 文件的下游。

命令行：
    python infer.py --source 0                      # 摄像头窗口实时检测
    python infer.py --source bus.jpg --json         # 输出 JSON 结果
    python infer.py --source bus.jpg --engine onnx  # 走 ONNX Runtime
"""

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

COCO_NAMES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
    "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
    "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
    "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
    "toothbrush",
]


def register_nvidia_dlls():
    """onnxruntime 的 CUDA EP 要求能搜到 CUDA 12 + cuDNN 9 的 DLL。

    pip 装的 nvidia-cublas-cu12 / nvidia-cudnn-cu12 不会自动进 PATH，
    不注册的话 ORT 只会报 "Require cuDNN 9.* and CUDA 12.*" 然后静默退回 CPU EP。
    """
    import os
    import sysconfig

    roots = [Path(sysconfig.get_paths()["purelib"])]
    try:
        roots.append(Path(sysconfig.get_paths()["platlib"]))
    except Exception:  # noqa: BLE001
        pass

    hit = 0
    for root in roots:
        for sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
            d = root / "nvidia" / sub / "bin"
            if d.is_dir():
                try:
                    os.add_dll_directory(str(d))
                    hit += 1
                except (OSError, AttributeError):
                    pass
    return hit


class Detector:
    """统一的检测接口，底层可以是 ultralytics(.pt) 也可以是 onnxruntime(.onnx)。"""

    def __init__(self, weights="yolo11n.pt", engine="pt", imgsz=640, conf=0.25,
                 fp16=False, num_threads=4):
        self.engine = engine
        self.imgsz = imgsz
        self.conf = conf
        self.fp16 = fp16
        # ORT 默认会按 CPU 核数开满线程；如果同进程里还有 PyTorch 的 OMP 线程池，
        # 两边加起来的线程数远超物理核，实测能把延迟从 35ms 拖到 486ms。默认压到 4。
        self.num_threads = num_threads
        self.names = COCO_NAMES
        self._ort = None
        self._model = None

        w = Path(weights)
        if engine == "onnx":
            # 顺序要紧：必须在 import onnxruntime 之前把 DLL 目录注册好
            register_nvidia_dlls()
            from onnxruntime import InferenceSession, SessionOptions  # noqa: PLC0415

            opts = SessionOptions()
            opts.intra_op_num_threads = max(1, int(self.num_threads))
            opts.inter_op_num_threads = 1

            onnx_path = w if w.suffix == ".onnx" else w.with_suffix(".onnx")
            if not onnx_path.exists():
                raise FileNotFoundError(f"找不到 ONNX 文件：{onnx_path}，先跑 export_onnx.py")
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            self._ort = InferenceSession(str(onnx_path), providers=providers, sess_options=opts)
            self._input = self._ort.get_inputs()[0].name
            print(f"[engine] onnxruntime | {self._ort.get_providers()[0]} | {onnx_path.name}", file=sys.stderr)
        else:
            from ultralytics import YOLO  # noqa: PLC0415

            self._model = YOLO(str(w))
            names = getattr(self._model, "names", None)
            if names:
                self.names = [names[i] for i in sorted(names)]
            print(f"[engine] ultralytics | {w.name}", file=sys.stderr)

    # ---------- 前处理 ----------
    def _preprocess(self, bgr):
        h0, w0 = bgr.shape[:2]
        img = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        img = cv2.resize(img, (self.imgsz, self.imgsz), interpolation=cv2.INTER_LINEAR)
        x = img.astype(np.float32) / 255.0
        x = np.transpose(x, (2, 0, 1))[None]  # 1x3xHxW
        return x, (h0, w0)

    # ---------- NMS ----------
    @staticmethod
    def _nms(boxes, scores, iou_thres=0.45):
        if len(boxes) == 0:
            return []
        x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        areas = (x2 - x1) * (y2 - y1)
        order = scores.argsort()[::-1]
        keep = []
        while order.size > 0:
            i = order[0]
            keep.append(i)
            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])
            inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
            union = areas[i] + areas[order[1:]] - inter
            iou = np.where(union > 0, inter / union, 0)
            order = order[1:][iou <= iou_thres]
        return keep

    def _postprocess(self, preds, shape):
        """preds: 1x(4+nc)xN 或 1xNx(4+nc)，输出缩放回原图坐标的框列表"""
        p = np.asarray(preds)
        if p.ndim == 3:
            p = p[0]
        if p.shape[0] < p.shape[1]:      # (4+nc, N) → (N, 4+nc)
            p = p.T

        h0, w0 = shape
        sx, sy = w0 / self.imgsz, h0 / self.imgsz

        boxes = p[:, :4]
        scores = p[:, 4:].max(axis=1)
        labels = p[:, 4:].argmax(axis=1)

        mask = scores >= self.conf
        boxes, scores, labels = boxes[mask], scores[mask], labels[mask]
        if len(boxes) == 0:
            return []

        # cxcywh → xyxy（按 imgsz 空间）
        cx, cy, bw, bh = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        xyxy = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], axis=1)
        xyxy[:, [0, 2]] *= sx
        xyxy[:, [1, 3]] *= sy
        xyxy[:, [0, 2]] = np.clip(xyxy[:, [0, 2]], 0, w0)
        xyxy[:, [1, 3]] = np.clip(xyxy[:, [1, 3]], 0, h0)

        keep = self._nms(xyxy, scores)
        out = []
        for i in keep:
            name = self.names[int(labels[i])] if int(labels[i]) < len(self.names) else str(labels[i])
            out.append({
                "label": name,
                "conf": round(float(scores[i]), 3),
                "box": [round(float(v), 1) for v in xyxy[i]],
            })
        return out

    # ---------- 推理 ----------
    def detect(self, bgr):
        t0 = time.perf_counter()
        if self.engine == "onnx":
            x, shape = self._preprocess(bgr)
            preds = self._ort.run(None, {self._input: x})[0]
            items = self._postprocess(preds, shape)
        else:
            # 精度参数：ultralytics 8.4 起 half 已弃用，改用 quantize（16=FP16）。
            # 关键：half 只要传了（哪怕传 False）就会每帧打印一次弃用警告，
            # 摄像头 50FPS 跑几小时能堆出几十万行日志。所以 FP32 时干脆不传。
            kwargs = {"verbose": False}
            if self.fp16:
                kwargs["quantize"] = 16
            res = self._model.predict(
                bgr, imgsz=self.imgsz, conf=self.conf, **kwargs
            )[0]
            items = []
            for b in res.boxes:
                items.append({
                    "label": res.names[int(b.cls)],
                    "conf": round(float(b.conf), 3),
                    "box": [round(float(v), 1) for v in b.xyxy[0].tolist()],
                })
        return items, (time.perf_counter() - t0) * 1000

    # ---------- 画框 ----------
    @staticmethod
    def draw(bgr, items):
        img = bgr.copy()
        palette = [(92, 160, 95), (233, 180, 76), (100, 150, 200), (200, 110, 110), (150, 120, 190)]
        for it in items:
            x1, y1, x2, y2 = [int(v) for v in it["box"]]
            c = palette[hash(it["label"]) % len(palette)]
            cv2.rectangle(img, (x1, y1), (x2, y2), c, 2)
            text = f'{it["label"]} {it["conf"]:.2f}'
            (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            cv2.rectangle(img, (x1, y1 - th - 8), (x1 + tw + 6, y1), c, -1)
            cv2.putText(img, text, (x1 + 3, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        return img

    @staticmethod
    def summarize(items):
        """把检测结果压成一句话，方便直接喂给文本大模型"""
        if not items:
            return "画面中没有检测到任何目标。"
        counts = {}
        for it in items:
            counts[it["label"]] = counts.get(it["label"], 0) + 1
        parts = [f"{k}×{v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])]
        return "检测到：" + "、".join(parts) + f"，共 {len(items)} 个目标。"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--engine", default="pt", choices=["pt", "onnx"])
    ap.add_argument("--source", default="0", help="图片/视频路径，或摄像头序号（默认 0）")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--fp16", action="store_true", help="PyTorch 引擎下用半精度推理（4060 有 TensorCore）")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出结果而不是弹窗口")
    ap.add_argument("--save", default=None, help="把画框结果存到该路径")
    args = ap.parse_args()

    det = Detector(args.weights, args.engine, args.imgsz, args.conf, args.fp16)

    src = args.source
    is_cam = src.isdigit()
    cap = cv2.VideoCapture(int(src) if is_cam else src)
    if not cap.isOpened():
        print(f"[x] 打不开视频源：{src}")
        return 1

    if args.json and not is_cam:
        # 单张图模式
        ok, frame = cap.read()
        cap.release()
        if not ok:
            print("[x] 读取失败")
            return 1
        items, ms = det.detect(frame)
        print(json.dumps({"detections": items, "summary": det.summarize(items), "latency_ms": round(ms, 1)},
                         ensure_ascii=False, indent=2))
        if args.save:
            cv2.imwrite(args.save, det.draw(frame, items))
        return 0

    print("[i] 按 q 退出")
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        items, ms = det.detect(frame)
        cv2.putText(frame, f"{ms:.1f} ms | {len(items)} objs | {args.engine}", (10, 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (60, 160, 90), 2)
        cv2.imshow("YOLO", det.draw(frame, items))
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break
    cap.release()
    cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    sys.exit(main())
