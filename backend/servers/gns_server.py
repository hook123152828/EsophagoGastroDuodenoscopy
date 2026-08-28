"""GNS (SGAFormer) anatomical-site classifier — internal microservice, port 8000.

Runs in the ``GNS`` conda environment (torch 1.11 + natten).  The GNS project
itself is an external read-only dependency; this file only imports from it.

Internal API — not part of the page1/page2 contract.  Frames are passed by
local path rather than base64: a full procedure is >12,000 frames and base64
would cost more than the inference does.
"""

import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import torch
import uvicorn
from fastapi import FastAPI
from PIL import Image
from pydantic import BaseModel
from torchvision import transforms

from backend import config
from backend.protocol import CLASS_NAMES, modality_of, region_of

sys.path.insert(0, str(config.GNS_ROOT))
from nat import nat_base  # noqa: E402  (needs GNS_ROOT on sys.path)

app = FastAPI(title="GNS Microservice")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Mirrors ``aigns_test_transform`` in GNS/dataloader.py.
TRANSFORM = transforms.Compose(
    [
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(mean=(0.485, 0.456, 0.406), std=(0.229, 0.224, 0.225)),
    ]
)

MODEL = None


class PredictRequest(BaseModel):
    paths: List[str]


@app.on_event("startup")
def startup() -> None:
    global MODEL
    model = nat_base(num_classes=len(CLASS_NAMES))
    checkpoint = torch.load(str(config.GNS_WEIGHT), map_location=DEVICE)
    model.load_state_dict(checkpoint["model_state_dict"])
    MODEL = model.to(DEVICE).eval()
    print(f"GNS ready on {DEVICE} ({config.GNS_WEIGHT.name})")


@app.get("/health")
def health() -> dict:
    return {"ok": MODEL is not None, "service": "gns"}


# Decoding is what the scan is actually waiting on — see config.DECODE_WORKERS.
# Pillow drops the GIL inside the decoder, so a thread pool is enough; no need
# to pay for processes and pickling the pixels back.
DECODERS = ThreadPoolExecutor(config.DECODE_WORKERS, thread_name_prefix="decode")


def _load(path: str) -> torch.Tensor:
    return TRANSFORM(Image.open(path).convert("RGB"))


@app.post("/predict")
def predict(request: PredictRequest) -> dict:
    if not request.paths:
        return {"results": []}

    batch = torch.stack(list(DECODERS.map(_load, request.paths))).to(DEVICE)

    with torch.no_grad():
        probs = torch.softmax(MODEL(batch), dim=1).cpu()

    confidences, indices = probs.max(dim=1)
    results = []
    for row, index, confidence in zip(probs, indices.tolist(), confidences.tolist()):
        class_name = CLASS_NAMES[index]
        results.append(
            {
                "class_name": class_name,
                "modality": modality_of(class_name),
                "region": region_of(class_name),
                "confidence": round(confidence, 4),
                "probs": {
                    name: round(value, 4)
                    for name, value in zip(CLASS_NAMES, row.tolist())
                },
            }
        )
    return {"results": results}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
