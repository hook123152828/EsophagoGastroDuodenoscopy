"""Runtime configuration.

The model projects (GNS / GIM / CGI / Polyp / MedSAM) are *external read-only
dependencies* — they are not part of this repository and are never modified.
Their locations are injected here so the servers can put them on ``sys.path``
and load weights.

Polyp is the one exception to "never modified": it ships annotations but no
usable weights, so ``scripts/train_polyp.py`` writes a fine-tuned detector into
``Polyp/weights/``.  The upstream files themselves are still left alone.

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
POLYP_ROOT = _path("POLYP_ROOT", REPO_ROOT / "Polyp")
MEDSAM_ROOT = _path("MEDSAM_ROOT", REPO_ROOT / "MedSAM")

GNS_WEIGHT = _path("GNS_WEIGHT", GNS_ROOT / "weights" / "best_94.0050_AIGNS.pth")
GIM_CONFIG = _path(
    "GIM_CONFIG",
    GIM_ROOT / "model" / "mask2former_FocalNet_tiny_50_IM_Aug_focal_decoder.py",
)
GIM_WEIGHT = _path("GIM_WEIGHT", GIM_ROOT / "model" / "epoch_50_bd.pth")
CGI_WEIGHT = _path(
    "CGI_WEIGHT", CGI_ROOT / "weight" / "Paper_95.74_93.75_96.15_98.36.pth"
)
# Produced by scripts/train_polyp.py, not shipped by the upstream project.
POLYP_WEIGHT = _path("POLYP_WEIGHT", POLYP_ROOT / "weights" / "polyp_yolo.pt")
MEDSAM_WEIGHT = _path(
    "MEDSAM_WEIGHT", MEDSAM_ROOT / "work_dir" / "MedSAM" / "medsam_vit_b.pth"
)

# --- Data --------------------------------------------------------------------
VIDEO_DIR = _path("VIDEO_DIR", REPO_ROOT / "video")
SESSION_DIR = _path("SESSION_DIR", REPO_ROOT / "backend" / "sessions")

# --- Services ----------------------------------------------------------------
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "8080"))
GNS_URL = os.getenv("GNS_URL", "http://127.0.0.1:8000").rstrip("/")
GIM_URL = os.getenv("GIM_URL", "http://127.0.0.1:8001").rstrip("/")

# Every GIM instance the scan may use, in order.
#
# Segmentation is the scan's critical path — on a 14-minute procedure it is
# ~80% of it — and it cannot be sped up by asking one instance for more at
# once: its endpoint is synchronous, so a second concurrent request runs a
# second thread through the same mmseg model and deadlocks it.  More instances
# is the way, each still answering one request at a time.  Roughly 5 GB of card
# apiece.
GIM_URLS = [
    url.strip().rstrip("/")
    for url in os.getenv("GIM_URLS", GIM_URL).split(",")
    if url.strip()
]
CGI_URL = os.getenv("CGI_URL", "http://127.0.0.1:8002").rstrip("/")
POLYP_URL = os.getenv("POLYP_URL", "http://127.0.0.1:8003").rstrip("/")

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

# How many batches each scan stage keeps in flight, so one batch is decoded
# while the previous one is still on the GPU.
#
# Each in-flight batch holds its own activations, so this is also the knob that
# decides how much of the card the scan wants at once.  On a 4090 the pipeline
# has to itself there is room to spare; on a card shared with other work a
# batch can fail for want of memory, which the gateway handles by splitting it
# and retrying rather than losing the scan.  Drop it to 1 if that is happening
# often enough to be slowing things down.
SCAN_CONCURRENCY = int(os.getenv("SCAN_CONCURRENCY", "3"))

# Threads each model service uses to decode a batch of JPEGs.
#
# This is the scan's real bottleneck, not the GPU.  Decoding 1000x871 frames one
# after another runs at ~160/s while GNS itself classifies at ~500/s, so the
# card spends most of the scan waiting.  Pillow releases the GIL inside the
# decoder, so threads scale nearly linearly: 16 of them reach ~1200/s and the
# GPU becomes the limit, as it should be.
DECODE_WORKERS = int(os.getenv("DECODE_WORKERS", str(min(16, (os.cpu_count() or 4)))))

# Detector confidence floor.  The detector was fine-tuned on a different scope
# and console than the procedure videos, so it is run deliberately shy: a box
# that survives this is worth a MedSAM pass, and MedSAM is the expensive half.
POLYP_CONF = float(os.getenv("POLYP_CONF", "0.35"))
