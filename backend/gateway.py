"""Stateless HTTP gateway for the Upper GI Endoscopy model services."""

import asyncio
import base64
import os
from typing import List

import httpx
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


GNS_URL = os.getenv("GNS_URL", "http://127.0.0.1:8000").rstrip("/")
GIM_URL = os.getenv("GIM_URL", "http://127.0.0.1:8001").rstrip("/")
CGI_URL = os.getenv("CGI_URL", "http://127.0.0.1:8002").rstrip("/")

app = FastAPI(title="Upper GI Endoscopy Gateway")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:2026"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class CGIRequest(BaseModel):
    pool_A: List[str]
    pool_B: List[str]
    pool_C: List[str]


async def is_up(client: httpx.AsyncClient, url: str) -> bool:
    try:
        response = await client.get(url)
        return response.status_code < 500
    except httpx.RequestError:
        return False


def downstream_error(exc: httpx.HTTPError) -> HTTPException:
    return HTTPException(status_code=502, detail=f"Downstream service error: {exc}")


@app.get("/api/health")
async def health() -> dict:
    async with httpx.AsyncClient(timeout=2.0) as client:
        gns, gim, cgi = await asyncio.gather(
            is_up(client, f"{GNS_URL}/health"),
            is_up(client, f"{GIM_URL}/docs"),
            is_up(client, f"{CGI_URL}/docs"),
        )
    return {"gns": gns, "gim": gim, "cgi": cgi}


@app.post("/api/gns/classify")
async def classify_gns(files: List[UploadFile] = File(...)) -> dict:
    filenames = [upload.filename for upload in files]
    encoded_images = [base64.b64encode(await upload.read()).decode("ascii") for upload in files]
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{GNS_URL}/predict_gns_batch", json={"images": encoded_images}
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise downstream_error(exc) from exc

    payload = response.json()
    for filename, result in zip(filenames, payload.get("results", [])):
        result["filename"] = filename
    return payload


@app.post("/api/gim/segment")
async def segment_gim(files: List[UploadFile] = File(...)) -> dict:
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            results = []
            for upload in files:
                response = await client.post(f"{GIM_URL}/predict", content=await upload.read())
                response.raise_for_status()
                result = response.json()
                results.append({"filename": upload.filename, **result})
    except httpx.HTTPError as exc:
        raise downstream_error(exc) from exc
    return {"results": results}


@app.post("/api/cgi/analyze")
async def analyze_cgi(request: CGIRequest) -> dict:
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{CGI_URL}/predict_cgi_batch", json=request.model_dump()
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise downstream_error(exc) from exc
    return response.json()


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
