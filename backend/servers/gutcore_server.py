"""Optional GutCore whole-case gastric cancer microservice, port 8003.

GutCore remains an external, read-only dependency. Install the official project
into ``gutcore_env`` (or place it at ``GUTCORE_ROOT``) and obtain the official
``GutCore-GC.pth`` checkpoint separately. The model is licensed for
noncommercial academic research and its score is not calibrated clinical risk.
"""

from __future__ import annotations

import sys
from pathlib import Path
from threading import Lock
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel
from torch.amp import autocast

from backend import config

# GutCore uses a src/ package layout. This also works when the official project
# has already been installed editable into its dedicated environment.
sys.path.insert(0, str(config.GUTCORE_ROOT / "src"))
from gutcore import build_transform, load_cancer_detector  # noqa: E402
from gutcore.config import CANCER_CONFIG  # noqa: E402

app = FastAPI(title="GutCore Microservice")

MODEL = None
DEVICE = torch.device("cpu")
TRANSFORM = build_transform()
INFERENCE_LOCK = Lock()


class GutCoreItem(BaseModel):
    frame_index: int
    path: str


class PredictRequest(BaseModel):
    items: List[GutCoreItem]


@app.on_event("startup")
def startup() -> None:
    global MODEL, DEVICE
    if config.GUTCORE_BATCH <= 0:
        raise RuntimeError("GUTCORE_BATCH must be positive")
    if config.GUTCORE_TOP_K <= 0:
        raise RuntimeError("GUTCORE_TOP_K must be positive")
    # Passing None lets the official package use its verified Hugging Face
    # cache. An explicit existing path always wins and avoids network access.
    weight = str(config.GUTCORE_WEIGHT) if config.GUTCORE_WEIGHT.is_file() else None
    MODEL = load_cancer_detector(weights=weight, device=config.GUTCORE_DEVICE)
    DEVICE = next(MODEL.parameters()).device
    print(f"GutCore ready on {DEVICE} ({weight or 'official cache'})")


@app.get("/health")
def health() -> dict:
    return {"ok": MODEL is not None, "service": "gutcore"}


def _amp_dtype() -> torch.dtype | None:
    if DEVICE.type != "cuda":
        return None
    return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16


@app.post("/predict")
def predict(request: PredictRequest) -> dict:
    if not request.items:
        raise HTTPException(400, "At least one examination image is required")
    if MODEL is None:
        raise HTTPException(503, "GutCore is not loaded")

    missing = [item.path for item in request.items if not Path(item.path).is_file()]
    if missing:
        raise HTTPException(400, f"Missing input image: {missing[0]}")

    amp_dtype = _amp_dtype()
    feature_batches = []

    # A single process owns the model, but sync FastAPI handlers may run in
    # parallel threads. Serialize inference to prevent avoidable GPU OOMs.
    with INFERENCE_LOCK, torch.inference_mode():
        for start in range(0, len(request.items), config.GUTCORE_BATCH):
            chunk = request.items[start : start + config.GUTCORE_BATCH]
            tensors = []
            for item in chunk:
                with Image.open(item.path) as image:
                    tensors.append(TRANSFORM(image.convert("RGB")))
            images = torch.stack(tensors).to(DEVICE)
            with autocast(
                device_type=DEVICE.type,
                dtype=amp_dtype,
                enabled=amp_dtype is not None,
            ):
                feature_batches.append(MODEL.encoder(images).cpu())

        features = torch.cat(feature_batches, dim=0).to(DEVICE).unsqueeze(0)
        with autocast(
            device_type=DEVICE.type,
            dtype=amp_dtype,
            enabled=amp_dtype is not None,
        ):
            logits, attention = MODEL.aggregator(features)

    scores = torch.softmax(logits.float(), dim=1)[0].cpu()
    cancer_score = float(scores[1])
    predicted_class = CANCER_CONFIG.class_names[int(scores.argmax())]
    weights = attention[0].float().cpu().tolist()
    ranked = sorted(
        (
            {"frame_index": item.frame_index, "contribution": float(weight)}
            for item, weight in zip(request.items, weights, strict=True)
        ),
        key=lambda item: item["contribution"],
        reverse=True,
    )

    warning = None
    if len(request.items) < CANCER_CONFIG.minimum_images:
        warning = (
            f"Only {len(request.items)} images were supplied; GutCore recommends "
            f"at least {CANCER_CONFIG.minimum_images}."
        )

    return {
        "prediction": predicted_class,
        "cancer_score": cancer_score,
        "threshold": 0.5,
        "score_is_calibrated": False,
        "research_only": True,
        "image_count": len(request.items),
        "recommended_minimum": CANCER_CONFIG.minimum_images,
        "warning": warning,
        "evidence": ranked[: config.GUTCORE_TOP_K],
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8003)
