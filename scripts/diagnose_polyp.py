#!/usr/bin/env python
"""Split the polyp pipeline's failures between the detector and MedSAM.

The overlay only appears where YOLO drew a box *and* MedSAM turned it into a
mask, so a polyp can be lost twice over and the screen looks the same either
way.  Improving the detector is worth nothing if the losses are downstream of
it, so this counts them separately, on the validation split, through the same
code the service runs:

  - not boxed:   the detector never proposed anything over the label.
  - boxed, empty: it did, and MedSAM's mask for that box came back blank at the
    0.5 threshold the service reads it at.
  - boxed, thin:  a mask so small against its box that the outline would be a
    speck rather than a lesion.

    python scripts/diagnose_polyp.py [--weights path/to/best.pt]
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from backend import config  # noqa: E402

sys.path.insert(0, str(config.MEDSAM_ROOT))

from segment_anything import sam_model_registry  # noqa: E402
from ultralytics import YOLO  # noqa: E402

DATASET = REPO_ROOT / "Polyp" / "yolo_dataset"
SAM_SIZE = 1024
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
THIN_FRACTION = 0.05


def labels_of(stem: str, width: int, height: int):
    boxes = []
    for line in (DATASET / "labels" / "val" / f"{stem}.txt").read_text().split("\n"):
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
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    overlap = (ix2 - ix1) * (iy2 - iy1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - overlap
    return overlap / union


@torch.no_grad()
def masks_for(medsam, image: np.ndarray, boxes: np.ndarray) -> np.ndarray:
    """One mask per box — the service unions them, which hides an empty one."""
    height, width = image.shape[:2]
    resized = np.array(
        Image.fromarray(image).resize((SAM_SIZE, SAM_SIZE), Image.BICUBIC)
    ).astype(np.float32)
    span = max(resized.max() - resized.min(), 1e-8)
    resized = (resized - resized.min()) / span
    tensor = torch.tensor(resized).float().permute(2, 0, 1).unsqueeze(0).to(DEVICE)

    scale = np.array([width, height, width, height], dtype=np.float32)
    boxes_1024 = boxes[:, :4] / scale * SAM_SIZE
    box_torch = torch.as_tensor(boxes_1024, dtype=torch.float, device=DEVICE)[:, None]

    with torch.autocast(DEVICE, dtype=torch.float16, enabled=DEVICE == "cuda"):
        embedding = medsam.image_encoder(tensor)
        sparse, dense = medsam.prompt_encoder(points=None, boxes=box_torch, masks=None)
        logits, _ = medsam.mask_decoder(
            image_embeddings=embedding.repeat(len(boxes), 1, 1, 1),
            image_pe=medsam.prompt_encoder.get_dense_pe(),
            sparse_prompt_embeddings=sparse,
            dense_prompt_embeddings=dense,
            multimask_output=False,
        )

    probability = F.interpolate(
        torch.sigmoid(logits.float()),
        size=(height, width),
        mode="bilinear",
        align_corners=False,
    )
    return (probability[:, 0] > 0.5).cpu().numpy()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, default=config.POLYP_WEIGHT)
    parser.add_argument("--conf", type=float, default=config.POLYP_CONF)
    parser.add_argument("--iou", type=float, default=0.5)
    args = parser.parse_args()

    images = sorted((DATASET / "images" / "val").glob("*.jpg"))
    if not images:
        sys.exit(f"!! no validation images under {DATASET}. Run train_polyp.py first.")

    detector = YOLO(str(args.weights))
    medsam = sam_model_registry["vit_b"](checkpoint=str(config.MEDSAM_WEIGHT))
    medsam = medsam.to(DEVICE).eval()

    labelled = boxed = empty = thin = shown = 0
    fractions = []
    spare_boxes = spare_empty = 0

    for path in images:
        image = np.array(Image.open(path).convert("RGB"))
        height, width = image.shape[:2]
        labels = labels_of(path.stem, width, height)
        labelled += len(labels)

        # BGR, exactly as the service hands it over.
        result = detector.predict(
            np.ascontiguousarray(image[:, :, ::-1]),
            conf=args.conf,
            verbose=False,
            device=DEVICE,
        )[0]
        if not len(result.boxes):
            continue
        boxes = result.boxes.xyxy.cpu().numpy()
        masks = masks_for(medsam, image, boxes)

        claimed = set()
        for box, mask in zip(boxes, masks):
            best, best_iou = None, args.iou
            for i, label in enumerate(labels):
                if i in claimed:
                    continue
                value = iou(box, label)
                if value >= best_iou:
                    best, best_iou = i, value

            area = int(mask.sum())
            box_area = max((box[2] - box[0]) * (box[3] - box[1]), 1.0)
            fraction = area / box_area

            if best is None:
                spare_boxes += 1
                spare_empty += area == 0
                continue

            claimed.add(best)
            boxed += 1
            if area == 0:
                empty += 1
            elif fraction < THIN_FRACTION:
                thin += 1
            else:
                shown += 1
                fractions.append(fraction)

    print(f"detector: {args.weights}   conf {args.conf}   IoU ≥ {args.iou}\n")
    print(f"  labelled polyps            {labelled}")
    print(f"  not boxed by the detector  {labelled - boxed:4d}"
          f"   ({(labelled - boxed) / labelled:.0%} of all)")
    print(f"  boxed, MedSAM blank        {empty:4d}")
    print(f"  boxed, mask < {THIN_FRACTION:.0%} of box   {thin:4d}")
    print(f"  boxed and outlined         {shown:4d}"
          f"   ({shown / labelled:.0%} of all)")
    if fractions:
        arr = np.array(fractions)
        print(f"\n  of the {len(arr)} outlined, mask/box area: "
              f"median {np.median(arr):.2f}, "
              f"10th pct {np.percentile(arr, 10):.2f}, "
              f"min {arr.min():.2f}")
    print(f"\n  boxes over no label        {spare_boxes:4d}"
          f"   ({spare_empty} of them blank from MedSAM)")


if __name__ == "__main__":
    main()
