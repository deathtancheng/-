"""
同一张图上对比两种推理引擎的延迟：PyTorch(.pt) vs ONNX Runtime(onnx, CUDA EP)。

    python benchmark.py --weights yolo11n.pt --onnx yolo11n.onnx --iters 50

输出的是端到端延迟（含前处理 + 推理 + 后处理 NMS），不是纯 forward 时间。
"""

import argparse
import statistics
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from infer import Detector  # noqa: E402


def make_test_image(size=640):
    """没有素材时造一张有内容的图，避免测出失真的空图延迟"""
    img = np.zeros((size, size, 3), np.uint8)
    cv2.rectangle(img, (60, 60), (300, 300), (120, 180, 90), -1)
    cv2.circle(img, (450, 200), 90, (200, 120, 120), -1)
    cv2.putText(img, "bench", (120, 480), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (240, 240, 240), 3)
    return img


def bench(det, img, iters, warmup):
    for _ in range(warmup):
        det.detect(img)
    times = []
    for _ in range(iters):
        t0 = time.perf_counter()
        det.detect(img)
        times.append((time.perf_counter() - t0) * 1000)
    return {
        "engine": det.engine,
        "avg_ms": round(statistics.mean(times), 1),
        "p95_ms": round(sorted(times)[int(len(times) * 0.95)], 1),
        "min_ms": round(min(times), 1),
        "fps": round(1000 / statistics.mean(times), 1),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--onnx", default="yolo11n.onnx")
    ap.add_argument("--img", default=None, help="用真实图片测，不给就用生成的")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--iters", type=int, default=40)
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--fp16", action="store_true", help="额外测一轮 PyTorch FP16")
    ap.add_argument("--threads", type=int, default=4,
                    help="ONNX 推理线程数。同进程里还有 PyTorch 时必须调小，否则线程打满反而更慢")
    args = ap.parse_args()

    img = cv2.imread(args.img) if args.img else make_test_image(args.imgsz)
    if img is None:
        print(f"[x] 读不了图片 {args.img}，用生成的测试图")
        img = make_test_image(args.imgsz)

    rows = []

    print(f"\n测试图：{img.shape[1]}x{img.shape[0]}   迭代 {args.warmup}+{args.iters} 次\n")

    d_pt = Detector(args.weights, "pt", args.imgsz)
    rows.append(bench(d_pt, img, args.iters, args.warmup))

    if args.fp16:
        d_f16 = Detector(args.weights, "pt", args.imgsz, fp16=True)
        r = bench(d_f16, img, args.iters, args.warmup)
        r["engine"] = "pt+fp16"
        rows.append(r)

    onnx_path = Path(args.onnx)
    if not onnx_path.exists():
        onnx_path = Path(args.weights).with_suffix(".onnx")
    if onnx_path.exists():
        d_ox = Detector(str(onnx_path), "onnx", args.imgsz, num_threads=args.threads)
        rows.append(bench(d_ox, img, args.iters, args.warmup))
    else:
        print(f"[!] 没找到 {onnx_path}，跳过 ONNX 对比（先跑 export_onnx.py）")

    print(f"{'引擎':<10}{'平均(ms)':>10}{'P95(ms)':>10}{'最快(ms)':>10}{'FPS':>9}")
    print("-" * 49)
    for r in rows:
        print(f"{r['engine']:<10}{r['avg_ms']:>10}{r['p95_ms']:>10}{r['min_ms']:>10}{r['fps']:>9}")

    if len(rows) >= 2:
        base = rows[0]
        best = min(rows, key=lambda r: r["avg_ms"])
        delta = (base["avg_ms"] - best["avg_ms"]) / base["avg_ms"] * 100
        print(f"\n结论：最快的是 {best['engine']}，比 {base['engine']} 快 {delta:.1f}%")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
