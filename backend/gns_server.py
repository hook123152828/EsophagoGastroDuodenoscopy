"""Batch inference service for the GNS image-classification model."""

import base64
import binascii
import sys
from pathlib import Path
from typing import List

import cv2
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# The model modules use imports relative to the GNS project directory.
GNS_DIR = Path(__file__).resolve().parent.parent / "GNS"
sys.path.insert(0, str(GNS_DIR))

from dataloader import aigns_test_transform  # noqa: E402
from nat import nat_base  # noqa: E402


CLASS_NAMES = [
    "G1_WL", "G1_NBI", "G2_WL", "G2_NBI", "G3_WL", "G3_NBI", "G4_WL",
    "G4_NBI", "G5_WL", "G5_NBI", "G6_WL", "G6_NBI", "D", "E_WL",
    "E_NBI", "none",
]
DEVICE = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
CHECKPOINT_PATH = GNS_DIR / "weights" / "best_94.0050_AIGNS.pth"


def load_model() -> torch.nn.Module:
    model = nat_base(num_classes=len(CLASS_NAMES))
    checkpoint = torch.load(CHECKPOINT_PATH, map_location=DEVICE)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.to(DEVICE)
    model.eval()
    return model


model = load_model()
app = FastAPI(title="GNS Microservice")


class BatchRequest(BaseModel):
    images: List[str]


def decode_image(image_b64: str) -> torch.Tensor:
    try:
        image_bytes = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image is not valid base64") from exc

    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image could not be decoded")
    image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    return aigns_test_transform(image)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/predict_gns_batch")
async def predict_gns_batch(request: BatchRequest) -> dict:
    try:
        tensors = [decode_image(image_b64) for image_b64 in request.images]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not tensors:
        return {"results": []}

    batch = torch.stack(tensors).to(DEVICE)
    with torch.inference_mode():
        probabilities = torch.softmax(model(batch), dim=1).cpu().tolist()

    results = []
    for probs in probabilities:
        best_index = max(range(len(probs)), key=probs.__getitem__)
        results.append({
            "class_name": CLASS_NAMES[best_index],
            "confidence": probs[best_index],
            "probs": dict(zip(CLASS_NAMES, probs)),
        })
    return {"results": results}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
