"""The contract between page 1 and page 2 — Python side.

This mirrors ``frontend/src/protocol/types.ts``.  The specification is
``docs/PROTOCOL.md``; all three must be changed together.
"""

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel

PROTOCOL_VERSION = 1

# --- Region of interest ------------------------------------------------------
# The endoscope viewport inside the 1920x1080 console output.  Measured on five
# timestamps of both video1 and video2 (identical GIF-H290 console); constant.
# Cropping to it also removes the patient identifiers printed in the left column.
ROI_X, ROI_Y, ROI_W, ROI_H = 799, 105, 1000, 871

# --- GNS classes -------------------------------------------------------------
CLASS_NAMES: List[str] = [
    "G1_WL", "G1_NBI", "G2_WL", "G2_NBI", "G3_WL", "G3_NBI", "G4_WL", "G4_NBI",
    "G5_WL", "G5_NBI", "G6_WL", "G6_NBI", "D", "E_WL", "E_NBI", "none",
]

RegionId = Literal[
    "esophagus", "cardia", "body", "angle", "antrum", "duodenum", "unknown"
]

# Single source of truth for the anatomy mapping.  G1-G6 are opaque identifiers
# in both the SGAFormer paper and the code; this mapping is empirical.
REGION_MAP: Dict[str, RegionId] = {
    "G1": "antrum", "G2": "antrum",
    "G3": "body", "G4": "body",
    "G5": "angle",
    "G6": "cardia",
    "E": "esophagus",
    "D": "duodenum",
    "none": "unknown",
}


def region_of(class_name: str) -> RegionId:
    if class_name == "none":
        return "unknown"
    return REGION_MAP.get(class_name.split("_")[0], "unknown")


def modality_of(class_name: str) -> Optional[Literal["WL", "NBI"]]:
    """``D`` and ``none`` carry no modality; everything else does."""
    if class_name.endswith("_NBI"):
        return "NBI"
    if class_name.endswith("_WL"):
        return "WL"
    return None


# --- Models ------------------------------------------------------------------
SessionStatus = Literal["extracting", "scanning", "ready", "failed"]


class Roi(BaseModel):
    x: int = ROI_X
    y: int = ROI_Y
    width: int = ROI_W
    height: int = ROI_H


class Sampling(BaseModel):
    extract_fps: float = 15
    gns_fps: float = 15
    gim_fps: float = 5


class VideoInfo(BaseModel):
    path: str
    filename: str
    width: int
    height: int
    fps: float
    duration_s: float
    # Streamable URL for <video>. Only videos inside VIDEO_DIR are served;
    # anything else is None and the page must fall back to frames.
    media_url: Optional[str] = None


class Progress(BaseModel):
    extract: float = 0.0
    gns: float = 0.0
    gim: float = 0.0


class SessionManifest(BaseModel):
    protocol_version: int = PROTOCOL_VERSION
    session_id: str
    created_at: str
    status: SessionStatus
    error: Optional[str] = None
    video: VideoInfo
    roi: Roi = Roi()
    sampling: Sampling
    frame_count: int = 0
    progress: Progress = Progress()


class GnsResult(BaseModel):
    class_name: str
    modality: Optional[Literal["WL", "NBI"]]
    region: str
    confidence: float
    probs: Dict[str, float]


class GimResult(BaseModel):
    score: int
    area: float
    mask_url: Optional[str] = None


class FrameRecord(BaseModel):
    index: int
    t: float
    image_url: str
    gns: Optional[GnsResult] = None
    gim: Optional[GimResult] = None


class CreateSessionRequest(BaseModel):
    video_path: str
    sampling: Optional[Sampling] = None


class AnalyzeRequest(BaseModel):
    """Analyse whatever is on screen at ``t`` right now, ahead of the scan."""

    t: float


class CgiRequest(BaseModel):
    pool_A: List[str]
    pool_B: List[str]
    pool_C: List[str]


class GutCoreRequest(BaseModel):
    """Run whole-case GutCore analysis over frames owned by this session."""

    frame_indices: List[int]
