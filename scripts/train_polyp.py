#!/usr/bin/env python
"""Fine-tune a polyp detector on the Zhejiang University gastroscopy dataset.

The upstream project (kojix2/Gastric-polyps-detection) ships the annotated
images but no usable weights — its pretrained ONNX was hosted on a Google Drive
link that is now dead, and its training recipe targets keras-yolo3, a TF1-era
stack.  The annotations themselves are perfectly good, so this script converts
them and fine-tunes an Ultralytics YOLO instead.

Inputs (read-only, from the external project):
    Polyp/Annotations/*.xml      Pascal VOC, one class, coordinates in 565x485
    Polyp/TrainValImages/*.jpg   the originals at 565x485

`Polyp/TrainImages/` is *not* used: those were squashed to 416x416 with
`-resize 416x416!`, which ignores aspect ratio, while the boxes in the XML are
in the original frame.  Letterboxing the originals is Ultralytics' own job.

Outputs (all inside the gitignored external project directory):
    Polyp/yolo_dataset/          the converted dataset
    Polyp/weights/polyp_yolo.pt  the fine-tuned detector the seg service loads
"""

import argparse
import random
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
POLYP_ROOT = Path(__file__).resolve().parent.parent / "Polyp"

ANNOTATIONS = POLYP_ROOT / "Annotations"
IMAGES = POLYP_ROOT / "TrainValImages"
DATASET = POLYP_ROOT / "yolo_dataset"
WEIGHT_OUT = POLYP_ROOT / "weights" / "polyp_yolo.pt"

VAL_FRACTION = 0.2
SEED = 0


def boxes_of(xml_path: Path):
    """VOC boxes as (xmin, ymin, xmax, ymax) plus the image size they live in."""
    root = ET.parse(xml_path).getroot()
    size = root.find("size")
    width = int(size.find("width").text)
    height = int(size.find("height").text)

    boxes = []
    for obj in root.findall("object"):
        box = obj.find("bndbox")
        boxes.append(
            tuple(int(box.find(name).text) for name in ("xmin", "ymin", "xmax", "ymax"))
        )
    return boxes, width, height


def write_label(path: Path, boxes, width: int, height: int) -> None:
    """YOLO format: one `class cx cy w h` line per box, normalised to the image."""
    lines = []
    for xmin, ymin, xmax, ymax in boxes:
        cx = (xmin + xmax) / 2 / width
        cy = (ymin + ymax) / 2 / height
        w = (xmax - xmin) / width
        h = (ymax - ymin) / height
        lines.append(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
    path.write_text("\n".join(lines) + "\n")


def build_dataset() -> Path:
    """Convert VOC to YOLO, splitting so a flip never lands opposite its original.

    Every image in the set appears twice: once as itself and once as `_tb`, a
    vertical flip with the boxes flipped to match.  Splitting per file would put
    a flip of a training image in validation, which is the same picture — so the
    split is over the base names, and the flips follow their original.

    Validation keeps the originals only.  The flips are an augmentation, and
    scoring the model twice on the same picture just weights it double.
    """
    if not ANNOTATIONS.is_dir() or not IMAGES.is_dir():
        sys.exit(
            f"!! dataset not found under {POLYP_ROOT}.\n"
            "   Clone kojix2/Gastric-polyps-detection there — see README.md."
        )

    groups = sorted({p.stem.removesuffix("_tb") for p in ANNOTATIONS.glob("*.xml")})
    random.Random(SEED).shuffle(groups)
    cut = int(len(groups) * (1 - VAL_FRACTION))
    train_groups, val_groups = set(groups[:cut]), set(groups[cut:])

    if DATASET.exists():
        shutil.rmtree(DATASET)
    for split in ("train", "val"):
        (DATASET / "images" / split).mkdir(parents=True)
        (DATASET / "labels" / split).mkdir(parents=True)

    counts = {"train": 0, "val": 0}
    for xml_path in sorted(ANNOTATIONS.glob("*.xml")):
        stem = xml_path.stem
        base = stem.removesuffix("_tb")
        flipped = stem.endswith("_tb")

        if base in val_groups:
            if flipped:
                continue
            split = "val"
        elif base in train_groups:
            split = "train"
        else:
            continue

        image = IMAGES / f"{stem}.jpg"
        if not image.exists():
            print(f"   skipping {stem}: no image", file=sys.stderr)
            continue

        boxes, width, height = boxes_of(xml_path)
        shutil.copy2(image, DATASET / "images" / split / image.name)
        write_label(DATASET / "labels" / split / f"{stem}.txt", boxes, width, height)
        counts[split] += 1

    yaml_path = DATASET / "polyp.yaml"
    yaml_path.write_text(
        f"path: {DATASET}\n"
        "train: images/train\n"
        "val: images/val\n"
        "names:\n"
        "  0: polyp\n"
    )

    print(f"   dataset: {counts['train']} train / {counts['val']} val images")
    return yaml_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="yolo11n.pt", help="pretrained baseline")
    parser.add_argument("--epochs", type=int, default=150)
    parser.add_argument("--imgsz", type=int, default=640)
    # The 4090 is shared with the other model services, so the default stays
    # well clear of what GNS/GIM/CGI hold resident.
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--device", default="0")
    parser.add_argument(
        "--dataset-only", action="store_true", help="convert and stop, no training"
    )
    args = parser.parse_args()

    yaml_path = build_dataset()
    if args.dataset_only:
        return

    from ultralytics import YOLO

    model = YOLO(args.model)
    model.train(
        data=str(yaml_path),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        project=str(POLYP_ROOT / "runs"),
        name="polyp",
        exist_ok=True,
        # The dataset already carries a vertical flip of every image; letting
        # Ultralytics add its own would just repeat it.
        flipud=0.0,
        patience=30,
        seed=SEED,
    )

    best = POLYP_ROOT / "runs" / "polyp" / "weights" / "best.pt"
    WEIGHT_OUT.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, WEIGHT_OUT)
    print(f"\n   detector written to {WEIGHT_OUT}")


if __name__ == "__main__":
    main()
