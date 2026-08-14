"""Runtime configuration.

The three model projects (GNS / GIM / CGI) are *external read-only dependencies*
— they are not part of this repository and are never modified.  Their locations
are injected here so the servers can put them on ``sys.path`` and load weights.

Every value can be overridden with an environment variable of the same name.
"""

import os
import shutil
import sys
from pathlib import Path
from typing import List

REPO_ROOT = Path(__file__).resolve().parent.parent


def _path(name: str, default: Path) -> Path:
    return Path(os.getenv(name, str(default))).expanduser().resolve()


# --- External model projects -------------------------------------------------
GNS_ROOT = _path("GNS_ROOT", REPO_ROOT / "GNS")
GIM_ROOT = _path("GIM_ROOT", REPO_ROOT / "GIM")
CGI_ROOT = _path("CGI_ROOT", REPO_ROOT / "CGI")

GNS_WEIGHT = _path("GNS_WEIGHT", GNS_ROOT / "weights" / "best_94.0050_AIGNS.pth")
GIM_CONFIG = _path(
    "GIM_CONFIG",
    GIM_ROOT / "model" / "mask2former_FocalNet_tiny_50_IM_Aug_focal_decoder.py",
)
GIM_WEIGHT = _path("GIM_WEIGHT", GIM_ROOT / "model" / "epoch_50_bd.pth")
CGI_WEIGHT = _path(
    "CGI_WEIGHT", CGI_ROOT / "weight" / "Paper_95.74_93.75_96.15_98.36.pth"
)

# --- Data --------------------------------------------------------------------
VIDEO_DIR = _path("VIDEO_DIR", REPO_ROOT / "video")
SESSION_DIR = _path("SESSION_DIR", REPO_ROOT / "backend" / "sessions")

# --- Services ----------------------------------------------------------------
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "8080"))
GNS_URL = os.getenv("GNS_URL", "http://127.0.0.1:8000").rstrip("/")
GIM_URL = os.getenv("GIM_URL", "http://127.0.0.1:8001").rstrip("/")
CGI_URL = os.getenv("CGI_URL", "http://127.0.0.1:8002").rstrip("/")

FRONTEND_ORIGINS = os.getenv(
    "FRONTEND_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")

# --- External binaries -------------------------------------------------------
def _binary(name: str) -> str:
    """Locate an external tool without depending on the launching shell's PATH.

    The services are started by calling an environment's interpreter directly,
    so that environment's ``bin`` is *not* on PATH. Looking next to the
    interpreter first means a tool installed into the environment is found
    whether the gateway is launched by hand or by start_services.sh.
    """
    override = os.getenv(f"{name.upper()}_BIN")
    if override:
        return override

    beside_interpreter = Path(sys.executable).parent / name
    if beside_interpreter.exists():
        return str(beside_interpreter)

    return shutil.which(name) or name


FFMPEG_BIN = _binary("ffmpeg")
FFPROBE_BIN = _binary("ffprobe")


def missing_binaries() -> List[str]:
    """Names of the required binaries that cannot be executed."""
    return [
        name
        for name, path in (("ffmpeg", FFMPEG_BIN), ("ffprobe", FFPROBE_BIN))
        if shutil.which(path) is None
    ]


# --- Pipeline ----------------------------------------------------------------
# Batch size for GNS; the model runs at ~500 fps on an RTX 4090 so this is
# bounded by JPEG decoding rather than by the GPU.
GNS_BATCH = int(os.getenv("GNS_BATCH", "32"))
