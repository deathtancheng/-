"""
YOLO 训练脚本（ultralytics）

用法示例：
    python train.py                                   # 默认 coco128 + yolo11n
    python train.py --data coco8.yaml --epochs 5      # 极速冒烟
    python train.py --model yolo11s.pt --batch 4      # 换更大的模型

参数选择的理由（本机 RTX 4060 Laptop 8GB / 16GB 内存）：
  * model=yolo11n   —— n 系列 2.6M 参数，8GB 显存下能开大 batch，训练一个 epochs=30 的
                       coco128 只要几分钟；换成 s/m 就要把 batch 砍到 2~4，性价比不高。
  * imgsz=640       —— COCO 预训练权重的原生分辨率，改成 320 掉点明显。
  * batch=8         —— 显存实测占用约 4.5GB，留出余量；OOM 时自动降级见下方 try/except。
  * amp=True        —— 4060 有 TensorCore，混合精度约省 30% 显存、提速 20%。
  * workers=0       —— Windows 上 dataloader 多进程极易炸（实测 workers=2 会直接崩），
                       coco128 只有 128 张图，单进程加载完全够用，别为了省那点时间踩坑。
  * cos_lr + warmup —— 小数据集上比固定学习率收敛更稳。
"""

import argparse
import json
import sys
from pathlib import Path

import torch
from ultralytics import YOLO


def parse_args():
    ap = argparse.ArgumentParser(description="ultralytics YOLO 训练封装")
    ap.add_argument("--model", default="yolo11n.pt", help="预训练权重，如 yolo11n.pt / yolo11s.pt")
    ap.add_argument("--data", default="coco128.yaml", help="数据集 yaml")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--workers", type=int, default=0)
    ap.add_argument("--device", default=None, help="None=自动，0=一号显卡，cpu=纯 CPU")
    ap.add_argument("--name", default="coco128_yolo11n")
    ap.add_argument("--project", default="runs")
    return ap.parse_args()


def main():
    args = parse_args()

    device = args.device
    if device is None:
        device = 0 if torch.cuda.is_available() else "cpu"

    print("=" * 56)
    print(f"  torch      : {torch.__version__}")
    print(f"  CUDA 可用  : {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"  显卡       : {torch.cuda.get_device_name(0)}")
        free, total = torch.cuda.mem_get_info()
        print(f"  显存       : {free/1024**3:.1f} GB 可用 / {total/1024**3:.1f} GB 总量")
    print(f"  模型/数据  : {args.model} @ {args.data}")
    print(f"  epochs     : {args.epochs}   batch: {args.batch}   imgsz: {args.imgsz}")
    print("=" * 56, flush=True)

    model = YOLO(args.model)

    try:
        results = model.train(
            data=args.data,
            epochs=args.epochs,
            batch=args.batch,
            imgsz=args.imgsz,
            device=device,
            workers=args.workers,
            project=args.project,
            name=args.name,
            exist_ok=True,
            amp=True,
            cos_lr=True,
            warmup_epochs=3,
            patience=10,
            plots=True,
            verbose=True,
        )
    except torch.cuda.OutOfMemoryError:
        # 显存不够就自动减半 batch 再试一次，避免整轮重跑
        print(f"\n[!] batch={args.batch} 显存溢出，自动降到 {max(1, args.batch // 2)} 重试", flush=True)
        torch.cuda.empty_cache()
        results = model.train(
            data=args.data,
            epochs=args.epochs,
            batch=max(1, args.batch // 2),
            imgsz=args.imgsz,
            device=device,
            workers=0,
            project=args.project,
            name=args.name,
            exist_ok=True,
            amp=True,
            cos_lr=True,
            patience=10,
            plots=True,
            verbose=True,
        )

    # 训练完立刻在验证集上评一次，把指标落盘
    metrics = model.val(data=args.data, imgsz=args.imgsz, device=device, workers=args.workers)

    # ultralytics 实际输出目录是 <project>/<task>/<name>，以 trainer.save_dir 为准
    save_dir = Path(getattr(model.trainer, "save_dir", Path(args.project) / args.name))
    best = getattr(model.trainer, "best", None)

    summary = {
        "model": args.model,
        "data": args.data,
        "epochs": args.epochs,
        "batch": args.batch,
        "imgsz": args.imgsz,
        "map50": round(float(metrics.box.map50), 4),
        "map50_95": round(float(metrics.box.map), 4),
        "best_weights": str(Path(best).resolve()) if best else None,
        "save_dir": str(save_dir.resolve()),
    }
    out = save_dir / "summary.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n" + "=" * 56)
    print(f"  mAP@0.5     : {summary['map50']}")
    print(f"  mAP@0.5:.95 : {summary['map50_95']}")
    print(f"  最佳权重    : {summary['best_weights']}")
    print(f"  指标已写入  : {out}")
    print("=" * 56)
    return 0


if __name__ == "__main__":
    sys.exit(main())
