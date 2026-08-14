"""GIM (Mask Focal Modulation Network) IM segmentation — internal microservice,
port 8001.

Runs in the ``IM_web`` conda environment (torch 2.0.1 + mmseg 1.1.2).

Unlike the GIM project's own demo server, this one returns a *mask*, not a
pre-blended thumbnail: the overlay on page 1 has to line up with the video, and
that is impossible from a 320px-wide composited JPEG.  The mask is written as an
RGBA PNG at ROI resolution — transparent background, tinted IM pixels — so the
front-end can draw it straight over the video with no pixel manipulation.
"""

import sys
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


@app.post("/predict")
def predict(request: PredictRequest) -> dict:
    results = []
    for item in request.items:
        image = np.array(Image.open(item.path).convert("RGB"))
        prediction = inference_model(MODEL, image).pred_sem_seg.data.cpu()

        keep = np.all((image > BRIGHTNESS_LOW) & (image < BRIGHTNESS_HIGH), axis=-1)
        prediction = prediction * torch.from_numpy(keep[None].astype(np.int64))

        mask = prediction.numpy()[0].astype(bool)
        area = float(round(mask.mean() * 100, 2))
        score = _score(area)

        wrote_mask = False
        if score >= 1 and item.mask_out:
            rgba = np.zeros((*mask.shape, 4), dtype=np.uint8)
            rgba[mask] = OVERLAY_RGBA
            Path(item.mask_out).parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(rgba, mode="RGBA").save(item.mask_out, optimize=True)
            wrote_mask = True

        results.append({"score": score, "area": area, "has_mask": wrote_mask})

    return {"results": results}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8001)
