"""Polyp detection and segmentation — internal microservice, port 8003.

Runs in the ``polyp_env`` conda environment (torch 2.0.1 + ultralytics).

Two models in series, in one service because they are never useful apart:

  1. An Ultralytics YOLO fine-tuned on the Zhejiang University gastroscopy
     annotations proposes boxes (``scripts/train_polyp.py`` produces it — the
     upstream project ships no usable weights).
  2. Each box prompts MedSAM, which turns it into a mask.

Keeping them in one process means the frame is decoded once and the boxes never
cross a network hop just to come straight back as a prompt.

Like the GIM service, this returns a *mask*, not a composited picture: the
overlay has to line up with the video, so the masks are written as one RGBA PNG
at ROI resolution — transparent background, tinted polyp pixels — which the
front-end draws straight over the video.
"""

import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import numpy as np
import torch
import torch.nn.functional as F
import uvicorn
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel

from backend import config
from backend.masks import write_overlay

# MedSAM is a read-only checkout, so it goes on the path rather than being
# installed — its setup.py drags in jupyterlab, monai and SimpleITK, none of
# which this service touches.
sys.path.insert(0, str(config.MEDSAM_ROOT))

from segment_anything import sam_model_registry  # noqa: E402
from ultralytics import YOLO  # noqa: E402

app = FastAPI(title="Polyp Microservice")

# Overlay tint for polyp pixels (RGBA).  Yellow rather than the IM purple, so
# the two overlays are never mistaken for each other when both are on; alpha
# matches GIM's, below 50% so the mucosa underneath stays readable.
OVERLAY_RGBA = (250, 204, 21, 130)

# MedSAM's own input size — the image encoder is trained at 1024x1024.
SAM_SIZE = 1024

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

DETECTOR: Optional[YOLO] = None
MEDSAM = None

# One thread through the models at a time, for the reason written out in
# gim_server: a synchronous endpoint runs in a thread pool, and two threads in
# one model is not safe. Ultralytics is stateful about it too — predict()
# builds and reuses a predictor hanging off the model object.
MODEL_LOCK = threading.Lock()
_STATE = {"busy_since": None}

LOCK_WAIT_S = float(os.getenv("POLYP_LOCK_WAIT_S", "120"))
WEDGED_AFTER_S = float(os.getenv("POLYP_WEDGED_AFTER_S", "300"))


class Item(BaseModel):
    path: str
    mask_out: Optional[str] = None


class PredictRequest(BaseModel):
    items: List[Item]


@app.on_event("startup")
def startup() -> None:
    global DETECTOR, MEDSAM
    if not config.POLYP_WEIGHT.exists():
        raise RuntimeError(
            f"detector weight not found at {config.POLYP_WEIGHT}. "
            "Run scripts/train_polyp.py first — see README.md."
        )
    DETECTOR = YOLO(str(config.POLYP_WEIGHT))
    MEDSAM = sam_model_registry["vit_b"](checkpoint=str(config.MEDSAM_WEIGHT))
    MEDSAM = MEDSAM.to(DEVICE)
    MEDSAM.eval()
    print(f"Polyp ready on {DEVICE} ({config.POLYP_WEIGHT.name} + MedSAM vit_b)")


@app.get("/health")
def health() -> dict:
    busy_since = _STATE["busy_since"]
    wedged = busy_since is not None and time.monotonic() - busy_since > WEDGED_AFTER_S
    return {
        "ok": DETECTOR is not None and MEDSAM is not None and not wedged,
        "service": "polyp",
        "wedged": wedged,
    }


def _detect(image: np.ndarray) -> np.ndarray:
    """Boxes above the confidence floor, as (N, 5) of x1 y1 x2 y2 conf.

    Handed BGR, not the RGB everything else here works in: given an array
    rather than a path, Ultralytics assumes the channel order OpenCV loads in,
    and silently detects on a colour-swapped image if it is given anything
    else. On the held-out set that cost three quarters of the detections — 36
    boxes over 40 frames became 8 — with nothing to show that anything was
    wrong. MedSAM keeps the RGB array; only the detector sees this one.
    """
    result = DETECTOR.predict(
        np.ascontiguousarray(image[:, :, ::-1]),
        conf=config.POLYP_CONF,
        verbose=False,
        device=DEVICE,
    )[0]
    if not len(result.boxes):
        return np.zeros((0, 5), dtype=np.float32)
    return np.concatenate(
        [
            result.boxes.xyxy.cpu().numpy(),
            result.boxes.conf.cpu().numpy()[:, None],
        ],
        axis=1,
    ).astype(np.float32)


@torch.no_grad()
def _segment(image: np.ndarray, boxes: np.ndarray) -> np.ndarray:
    """Union of MedSAM's masks for every box, at the image's own resolution.

    The image is encoded once and the embedding is shared across the boxes —
    the encoder is the expensive part, and it does not depend on the prompt.

    Run in half precision.  The ViT-B encoder attends globally over 1024x1024,
    and its attention matrix alone wants most of a gigabyte in fp32 — enough to
    put the service over the edge on a card it shares with the other three
    models.  Halving it costs nothing visible: the output is thresholded at 0.5,
    far from where fp16's precision is in question.
    """
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
        embedding = MEDSAM.image_encoder(tensor)  # (1, 256, 64, 64)

        sparse, dense = MEDSAM.prompt_encoder(points=None, boxes=box_torch, masks=None)
        logits, _ = MEDSAM.mask_decoder(
            # One embedding, many prompts: the decoder is batched over the
            # prompts, so the shared embedding is repeated to match rather than
            # recomputed.
            image_embeddings=embedding.repeat(len(boxes), 1, 1, 1),
            image_pe=MEDSAM.prompt_encoder.get_dense_pe(),
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
    return (probability[:, 0] > 0.5).any(dim=0).cpu().numpy()


DECODERS = ThreadPoolExecutor(config.DECODE_WORKERS, thread_name_prefix="decode")


def _load(path: str) -> np.ndarray:
    return np.array(Image.open(path).convert("RGB"))


@app.post("/predict")
def predict(request: PredictRequest) -> dict:
    images = list(DECODERS.map(_load, [item.path for item in request.items]))

    results = []
    for item, image in zip(request.items, images):
        if not MODEL_LOCK.acquire(timeout=LOCK_WAIT_S):
            raise HTTPException(
                503,
                f"Polyp did not become free within {LOCK_WAIT_S:.0f}s — it is "
                "either saturated or wedged; see /health",
            )
        _STATE["busy_since"] = time.monotonic()
        try:
            boxes = _detect(image)
            mask = _segment(image, boxes) if len(boxes) else None
        finally:
            _STATE["busy_since"] = None
            MODEL_LOCK.release()

        if mask is None:
            results.append({"boxes": [], "area": 0.0, "has_mask": False})
            continue
        area = float(round(mask.mean() * 100, 2))

        # No merge radius: the count is reported on screen, so two polyps a few
        # tens of pixels apart must stay two outlines rather than becoming one.
        wrote_mask = False
        if mask.any() and item.mask_out:
            wrote_mask = bool(write_overlay(Path(item.mask_out), mask, OVERLAY_RGBA))

        results.append(
            {
                "boxes": [
                    {
                        "x1": float(box[0]),
                        "y1": float(box[1]),
                        "x2": float(box[2]),
                        "y2": float(box[3]),
                        "confidence": float(box[4]),
                    }
                    for box in boxes
                ],
                "area": area,
                "has_mask": wrote_mask,
            }
        )

    return {"results": results}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8003)
