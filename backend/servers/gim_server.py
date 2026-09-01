"""GIM (Mask Focal Modulation Network) IM segmentation — internal microservice,
port 8001.

Runs in the ``IM_web`` conda environment (torch 2.0.1 + mmseg 1.1.2).

Unlike the GIM project's own demo server, this one returns a *mask*, not a
pre-blended thumbnail: the overlay on page 1 has to line up with the video, and
that is impossible from a 320px-wide composited JPEG.  The mask is written as an
RGBA PNG at ROI resolution — transparent background, tinted IM pixels — so the
front-end can draw it straight over the video with no pixel manipulation.

The score and the area are measured on the model's raw output.  The PNG is the
*display shape* of that output — see ``backend/masks`` for why the two differ
and why the difference is resolved here rather than in the browser.
"""

import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI
from PIL import Image
from pydantic import BaseModel

from backend import config
from backend.masks import IM_MERGE_RADIUS, write_overlay

from mmseg.apis import inference_model, init_model  # noqa: E402

app = FastAPI(title="GIM Microservice")

# Overlay tint for IM pixels (RGBA).  Alpha is deliberately below 50% so the
# mucosa underneath stays readable.
OVERLAY_RGBA = (168, 85, 247, 130)

# Brightness gate from the GIM project: pixels outside this range are specular
# highlights or shadow and are excluded from the IM area before scoring.
BRIGHTNESS_LOW, BRIGHTNESS_HIGH = 50, 200

MODEL = None


class Item(BaseModel):
    path: str
    mask_out: Optional[str] = None


class PredictRequest(BaseModel):
    items: List[Item]


@app.on_event("startup")
def startup() -> None:
    global MODEL
    MODEL = init_model(str(config.GIM_CONFIG), str(config.GIM_WEIGHT), "cuda")
    print(f"GIM ready ({config.GIM_WEIGHT.name})")


@app.get("/health")
def health() -> dict:
    return {"ok": MODEL is not None, "service": "gim"}


def _score(area: float) -> int:
    if area >= 30:
        return 2
    if area >= 5:
        return 1
    return 0


# The batch is decoded up front, across threads, so the GPU is not left waiting
# on Pillow between frames. See config.DECODE_WORKERS.
DECODERS = ThreadPoolExecutor(config.DECODE_WORKERS, thread_name_prefix="decode")


def _load(path: str) -> np.ndarray:
    return np.array(Image.open(path).convert("RGB"))


@app.post("/predict")
def predict(request: PredictRequest) -> dict:
    images = list(DECODERS.map(_load, [item.path for item in request.items]))

    results = []
    for item, image in zip(request.items, images):
        prediction = inference_model(MODEL, image).pred_sem_seg.data.cpu()

        keep = np.all((image > BRIGHTNESS_LOW) & (image < BRIGHTNESS_HIGH), axis=-1)
        prediction = prediction * torch.from_numpy(keep[None].astype(np.int64))

        mask = prediction.numpy()[0].astype(bool)
        area = float(round(mask.mean() * 100, 2))
        score = _score(area)

        wrote_mask = False
        if score >= 1 and item.mask_out:
            # IM arrives as scattered patches of one affected area, so the gaps
            # between neighbours are bridged; a polyp is a discrete lesion and
            # is never merged with the one beside it.
            wrote_mask = bool(
                write_overlay(
                    Path(item.mask_out), mask, OVERLAY_RGBA, IM_MERGE_RADIUS
                )
            )

        results.append({"score": score, "area": area, "has_mask": wrote_mask})

    return {"results": results}


if __name__ == "__main__":
    # Several of these run at once — one request each, several instances — so
    # the port is chosen by whoever starts them.  See config.GIM_URLS.
    import os

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("GIM_PORT", "8001")))
