#!/usr/bin/env python
"""Score polyp detectors the way the service runs them: at one threshold.

mAP integrates over every confidence threshold, so it answers a question the
deployed system never asks.  `backend/config.POLYP_CONF` picks one threshold
and the service lives at it, and two models with the same mAP can behave very
differently there.  This prints what happens at that threshold, and either side
of it, on the validation split `train_polyp.py` built.

A detection counts if it overlaps a labelled box by at least `--iou`; each
label may be claimed once, so extra boxes on a found polyp are false positives.
Images with no detection at all are reported separately: that number is the one
that matters clinically, because it is the number of polyps nobody is shown.

    python scripts/eval_polyp.py Polyp/runs/*/weights/best.pt
"""

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATASET = REPO_ROOT / "Polyp" / "yolo_dataset"

THRESHOLDS = (0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60)


def labels_of(stem: str, width: int, height: int):
    """The image's boxes as (x1, y1, x2, y2), back in pixels."""
    path = DATASET / "labels" / "val" / f"{stem}.txt"
    boxes = []
    for line in path.read_text().split("\n"):
        if not line.strip():
            continue
        _, cx, cy, w, h = (float(v) for v in line.split())
        boxes.append(
            (
                (cx - w / 2) * width,
                (cy - h / 2) * height,
                (cx + w / 2) * width,
                (cy + h / 2) * height,
            )
        )
    return boxes


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    overlap = (ix2 - ix1) * (iy2 - iy1)
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - overlap
    return overlap / union


def score(predictions, min_iou: float):
    """Greedy match, best box first, each label claimed at most once."""
    hits = misses = extras = blank = 0
    for boxes, labels in predictions:
        claimed = set()
        for box in sorted(boxes, key=lambda b: -b[4]):
            best, best_iou = None, min_iou
            for i, label in enumerate(labels):
                if i in claimed:
                    continue
                value = iou(box[:4], label)
                if value >= best_iou:
                    best, best_iou = i, value
            if best is None:
                extras += 1
            else:
                claimed.add(best)
                hits += 1
        misses += len(labels) - len(claimed)
        if labels and not boxes:
            blank += 1
    return hits, misses, extras, blank


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("weights", nargs="+", type=Path)
    parser.add_argument("--iou", type=float, default=0.5)
    parser.add_argument("--imgsz", type=int, default=640)
    args = parser.parse_args()

    images = sorted((DATASET / "images" / "val").glob("*.jpg"))
    if not images:
        sys.exit(f"!! no validation images under {DATASET}. Run train_polyp.py first.")

    from PIL import Image
    from ultralytics import YOLO

    sizes = {p.stem: Image.open(p).size for p in images}
    truth = [labels_of(p.stem, *sizes[p.stem]) for p in images]
    total = sum(len(t) for t in truth)
    print(f"validation: {len(images)} images, {total} labelled polyps, IoU ≥ {args.iou}\n")

    for weight in args.weights:
        model = YOLO(str(weight))
        # Run once at the lowest threshold and filter afterwards: the boxes at
        # 0.5 are a subset of the boxes at 0.2, so predicting seven times would
        # be seven times the work for the same numbers.
        raw = model.predict(
            [str(p) for p in images],
            imgsz=args.imgsz,
            conf=min(THRESHOLDS),
            verbose=False,
        )
        per_image = [
            [(*b.xyxy[0].tolist(), float(b.conf)) for b in r.boxes] for r in raw
        ]

        name = weight.parent.parent.name
        print(f"{name}  ({weight})")
        print(f"  {'conf':>5} {'found':>7} {'missed':>7} {'false+':>7} "
              f"{'recall':>7} {'prec':>7} {'F1':>7} {'blank imgs':>11}")
        for threshold in THRESHOLDS:
            kept = [
                ([b for b in boxes if b[4] >= threshold], labels)
                for boxes, labels in zip(per_image, truth)
            ]
            hits, misses, extras, blank = score(kept, args.iou)
            recall = hits / total if total else 0.0
            precision = hits / (hits + extras) if hits + extras else 0.0
            f1 = (
                2 * precision * recall / (precision + recall)
                if precision + recall
                else 0.0
            )
            mark = "  <- deployed" if abs(threshold - 0.35) < 1e-9 else ""
            print(f"  {threshold:5.2f} {hits:7d} {misses:7d} {extras:7d} "
                  f"{recall:7.3f} {precision:7.3f} {f1:7.3f} {blank:11d}{mark}")
        print()


if __name__ == "__main__":
    main()
