"""Finding the endoscope's field of view in a console recording.

The frame a video console writes is not the picture the models want: it is a
black canvas with a column of text down one side — patient name, date of
birth, scope settings — and the octagonal endoscope image set into the rest of
it.  Cropping to that octagon is what feeds the models only what they were
trained on, and it is also what keeps the identifiers out of everything this
system stores.

This used to be one measured constant, which held for exactly one console
geometry.  A recording at any other size failed at the first ffmpeg call with
a message about crop dimensions, and — worse — a recording that merely put the
octagon somewhere else would have been cropped to the wrong place without
saying so.

Detected instead of measured: the octagon is the one large bright region on
the canvas, and the text is thin.  Erode and the text is gone; the largest
thing still standing is the field of view.
"""

import subprocess
import tempfile
from collections import deque
from pathlib import Path
from statistics import median
from typing import List, Optional, Tuple

from PIL import Image

Box = Tuple[int, int, int, int]  # x, y, width, height

# Above this, a pixel is part of the picture rather than the canvas around it.
THRESHOLD = 18

# Detection runs on a frame no wider than this. The search is a flood fill in
# Python, which is fast at this size and not at 1920; the box it finds is then
# refined against the full-resolution frame, so nothing is lost by it.
WORK_WIDTH = 480

# How many frames to look at, and how many must agree for the answer to stand.
SAMPLES = 5
NEEDED = 3

# A field of view smaller than this share of the frame is not a field of view.
MIN_AREA_SHARE = 0.05


def _largest_bright_region(image: Image.Image) -> Optional[Box]:
    """Bounding box of the biggest connected bright area, in image pixels."""
    width, height = image.size
    pixels = image.load()
    seen = bytearray(width * height)
    best: Optional[Tuple[int, int, int, int, int]] = None

    for start_y in range(height):
        for start_x in range(width):
            if seen[start_y * width + start_x] or pixels[start_x, start_y] <= THRESHOLD:
                continue

            queue = deque([(start_x, start_y)])
            seen[start_y * width + start_x] = 1
            area = 0
            left = right = start_x
            top = bottom = start_y

            while queue:
                x, y = queue.popleft()
                area += 1
                left, right = min(left, x), max(right, x)
                top, bottom = min(top, y), max(bottom, y)
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < width and 0 <= ny < height:
                        index = ny * width + nx
                        if not seen[index] and pixels[nx, ny] > THRESHOLD:
                            seen[index] = 1
                            queue.append((nx, ny))

            if best is None or area > best[0]:
                best = (area, left, top, right, bottom)

    if best is None:
        return None
    _, left, top, right, bottom = best
    return left, top, right - left + 1, bottom - top + 1


def _detect_in(frame: Path) -> Optional[Box]:
    image = Image.open(frame).convert("L")
    width, height = image.size

    scale = max(1, -(-max(width, height) // WORK_WIDTH))
    small = image.resize((width // scale, height // scale)) if scale > 1 else image

    coarse = _largest_bright_region(small)
    if coarse is None:
        return None
    x, y, w, h = coarse

    if (w * scale) * (h * scale) < MIN_AREA_SHARE * width * height:
        return None

    # Refine against the full-resolution frame. The window is the coarse box
    # with a margin, and there is nothing but canvas between it and the text,
    # so widening it cannot pull the text back in.
    margin = scale + 2
    window = (
        max(0, x * scale - margin),
        max(0, y * scale - margin),
        min(width, (x + w) * scale + margin),
        min(height, (y + h) * scale + margin),
    )
    exact = (
        image.crop(window)
        .point(lambda value: 255 if value > THRESHOLD else 0)
        .getbbox()
    )
    if exact is None:
        return None
    left, top, right, bottom = exact
    return window[0] + left, window[1] + top, right - left, bottom - top


def _grab(ffmpeg: str, video: Path, at: float, into: Path) -> Optional[Path]:
    frame = into / f"{at:.0f}.png"
    result = subprocess.run(
        [ffmpeg, "-loglevel", "error", "-ss", str(at), "-i", str(video),
         "-frames:v", "1", "-y", str(frame)],
        capture_output=True,
    )
    return frame if result.returncode == 0 and frame.exists() else None


def detect_roi(ffmpeg: str, video: Path, duration_s: float) -> Box:
    """The endoscope's field of view, from several frames of ``video``.

    Sampled rather than taken from one frame, and reduced by median rather than
    by first answer: a procedure opens and closes on frames that are dark or
    frozen, and one of those alone would place the crop somewhere it stays for
    the whole recording.

    Raises ``ValueError`` when the frames do not agree on anything that looks
    like a field of view. That is deliberate — a wrong crop is not a cosmetic
    fault. It feeds the models mucosa they were not trained on, and it is what
    would put a patient's name into every frame this system writes to disk.
    """
    with tempfile.TemporaryDirectory() as directory:
        into = Path(directory)
        # Spread across the middle of the recording, away from the ends.
        moments = [duration_s * (i + 1) / (SAMPLES + 1) for i in range(SAMPLES)]
        found: List[Box] = []
        for at in moments:
            frame = _grab(ffmpeg, video, at, into)
            if frame is None:
                continue
            box = _detect_in(frame)
            if box is not None:
                found.append(box)

    if len(found) < NEEDED:
        raise ValueError(
            f"could not find the endoscope's field of view: only {len(found)} of "
            f"{SAMPLES} sampled frames yielded one"
        )

    return (
        int(median(box[0] for box in found)),
        int(median(box[1] for box in found)),
        int(median(box[2] for box in found)),
        int(median(box[3] for box in found)),
    )
