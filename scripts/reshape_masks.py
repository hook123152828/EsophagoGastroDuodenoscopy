#!/usr/bin/env python
"""Re-shape the mask PNGs of sessions that were scanned before the front-end
stopped doing the shaping itself.

The outline used to be built in the browser out of SVG morphology, so what was
stored was the model's raw output, speckled and full of holes.  The shape is
now settled server-side (``backend/masks``) and the browser only strokes it,
which means masks written by an earlier run still look the way they used to.
This rewrites them in place.

    python scripts/reshape_masks.py            # every session
    python scripts/reshape_masks.py <id> ...   # just these

Not idempotent in the strict sense — smoothing an already-smoothed shape moves
it a little further — but it is safe to run twice; the shape converges rather
than degrading.  The measurements in frames.jsonl are untouched: they were
taken from the model's output and stay that way.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2
import numpy as np

from backend import config
from backend.masks import IM_MERGE_RADIUS, display_shape

# Directory name -> how far apart two patches may be and still read as one.
MERGE_BY_DIRECTORY = {"masks": IM_MERGE_RADIUS, "polyp_masks": 0}


def reshape(path: Path, merge_radius: int) -> bool:
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None or image.shape[2] != 4:
        return False

    mask = image[:, :, 3] > 0
    if not mask.any():
        return False

    # The tint is whatever the service wrote; this only changes the shape.
    colour = image[mask][0]
    shape = display_shape(mask, merge_radius)

    canvas = np.zeros_like(image)
    canvas[shape] = colour
    cv2.imwrite(str(path), canvas)
    return True


def main() -> None:
    wanted = set(sys.argv[1:])
    sessions = sorted(
        d for d in config.SESSION_DIR.iterdir()
        if d.is_dir() and (not wanted or d.name in wanted)
    )
    if not sessions:
        sys.exit(f"no sessions under {config.SESSION_DIR}")

    for session in sessions:
        print(session.name)
        for directory, merge_radius in MERGE_BY_DIRECTORY.items():
            folder = session / directory
            if not folder.is_dir():
                continue
            files = sorted(folder.glob("*.png"))
            done = sum(reshape(path, merge_radius) for path in files)
            print(f"   {directory:12s} {done}/{len(files)} reshaped")


if __name__ == "__main__":
    main()
