"""
把训练好的 .pt 权重导出成 ONNX，供 onnxruntime / OpenCV DNN / TensorRT 部署使用。

    python export_onnx.py --weights runs/coco128_yolo11n/weights/best.pt
    python export_onnx.py --weights runs/coco128_yolo11n/weights/best.pt --half --simplify
"""

import argparse
import sys
from pathlib import Path

from ultralytics import YOLO


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="runs/coco128_yolo11n/weights/best.pt")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--half", action="store_true", help="导出 FP16，体积减半、GPU 上更快")
    ap.add_argument("--simplify", action="store_true", help="图融合简化（需 onnxsim）")
    ap.add_argument("--dynamic", action="store_true", help="允许动态 batch / 分辨率")
    args = ap.parse_args()

    model = YOLO(args.weights)
    out = model.export(
        format="onnx",
        imgsz=args.imgsz,
        half=args.half,
        simplify=args.simplify,
        dynamic=args.dynamic,
        opset=12,
        nms=False,   # 关掉内置 NMS：需要自己后处理，但换后端时兼容性最好
    )
    p = Path(out)
    print(f"\n  导出完成: {p.resolve()}")
    print(f"  体积: {p.stat().st_size / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
