"""CGI (GSCNet) corpus-predominant-gastritis classifier — internal microservice,
port 8002.

Runs in the ``cgi_env`` conda environment (torch 2.0.1 + cu118).

The model scores one *triple* of white-light images — antrum (A), body (B),
cardia (C) — at a time.  This service takes three candidate pools, evaluates
every A x B x C combination on the GPU and returns the highest-scoring ones.
Deciding what goes into each pool is page 2's job, not this service's.
"""

import base64
import io
import itertools
import sys
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import torch
import uvicorn
from fastapi import FastAPI
from PIL import Image
from torchvision import transforms

from backend import config
from backend.protocol import CgiRequest

sys.path.insert(0, str(config.CGI_ROOT))
from CGI_model import Mymodel  # noqa: E402  (needs CGI_ROOT on sys.path)

app = FastAPI(title="CGI Microservice")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
TOP_K = 10
BATCH = 64

# Mirrors ``valid_transform`` in the CGI project.
TRANSFORM = transforms.Compose(
    [
        transforms.Resize((280, 280), interpolation=transforms.InterpolationMode.BICUBIC),
        transforms.CenterCrop((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(
            mean=[0.58714539, 0.3315281, 0.27107792],
            std=[0.23290901, 0.17506568, 0.15077295],
        ),
    ]
)

MODEL = None


@app.on_event("startup")
def startup() -> None:
    global MODEL
    model = Mymodel()
    model.load_state_dict(torch.load(str(config.CGI_WEIGHT), map_location=DEVICE))
    MODEL = model.to(DEVICE).eval()
    print(f"CGI ready on {DEVICE} ({config.CGI_WEIGHT.name})")


@app.get("/health")
def health() -> dict:
    return {"ok": MODEL is not None, "service": "cgi"}


def _decode(encoded: str) -> torch.Tensor:
    image = Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")
    return TRANSFORM(image)


@app.post("/predict_cgi_batch")
def predict(request: CgiRequest) -> dict:
    pools = [request.pool_A, request.pool_B, request.pool_C]
    if not all(pools):
        return {"top_10_pairs": []}

    # Decode each image once, then combine by index — the pools are small but
    # their product is not.
    tensors = [[_decode(image) for image in pool] for pool in pools]
    combinations = list(itertools.product(*(range(len(t)) for t in tensors)))

    scored: List[dict] = []
    with torch.no_grad():
        for start in range(0, len(combinations), BATCH):
            chunk = combinations[start : start + BATCH]
            a, b, c = (
                torch.stack([tensors[axis][combo[axis]] for combo in chunk]).to(DEVICE)
                for axis in range(3)
            )
            *_, fused = MODEL(a, b, c, a, b, c, a, b, c)
            probabilities = torch.softmax(fused, dim=1)[:, 1].cpu().tolist()

            for combo, probability in zip(chunk, probabilities):
                scored.append(
                    {
                        "probability": float(probability),
                        "img1": pools[0][combo[0]],
                        "img2": pools[1][combo[1]],
                        "img3": pools[2][combo[2]],
                    }
                )

    scored.sort(key=lambda item: item["probability"], reverse=True)
    return {"top_10_pairs": scored[:TOP_K]}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8002)
