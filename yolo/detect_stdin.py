"""
从 stdin 读一张 base64 图片，跑 YOLO，往 stdout 吐 JSON。
专门给 Node 后端调用用——把图片走 stdin 传，可以彻底绕开中文路径在命令行里的编码坑。

    echo <base64> | python detect_stdin.py --weights best.pt
"""

import argparse
import base64
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from infer import Detector  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--engine", default="pt", choices=["pt", "onnx"])
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--conf", type=float, default=0.25)
    args = ap.parse_args()

    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"error": "stdin 为空"}, ensure_ascii=False))
        return 1

    try:
        buf = base64.b64decode(raw)
        img = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"图片解码失败：{e}"}, ensure_ascii=False))
        return 1

    if img is None:
        print(json.dumps({"error": "图片解码失败：不是有效图片"}, ensure_ascii=False))
        return 1

    det = Detector(args.weights, args.engine, args.imgsz, args.conf)
    items, ms = det.detect(img)
    print(json.dumps({
        "size": {"w": img.shape[1], "h": img.shape[0]},
        "detections": items,
        "summary": Detector.summarize(items),
        "latency_ms": round(ms, 1),
        "engine": args.engine,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
