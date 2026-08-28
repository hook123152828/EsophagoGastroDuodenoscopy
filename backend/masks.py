"""Turning a model's raw segmentation into the shape that gets drawn.

Both mask-producing services store two different things about one frame: the
*measurement* (score, area, boxes), which is the model's own output and is
never touched, and the *display shape*, which is what an endoscopist actually
sees outlined on the video.

They are not the same picture.  Segmentation of mucosa comes back speckled —
a typical antrum frame carries 213 separate pieces and 366 holes — and drawing
that literally covers the field in rings that trace noise rather than the
finding.  The shape below is the finding: smoothed, its interior closed up,
and (for IM) with the gaps between neighbouring patches bridged.

Done here rather than in the browser for two reasons.  Holes cannot be filled
with an SVG filter at all — it is a global operation and filters are local —
and closing the gaps between patches *creates* new holes where two arms meet,
so the two steps have to happen together, in that order.  Doing it in ROI
pixels also means a mask looks the same wherever it is drawn; the filter it
replaced measured its radii in CSS pixels, so the same finding came out a
different shape in the report's thumbnails and on the live stage.
"""

from typing import Optional

import cv2
import numpy as np

# Rounds off the staircase left by per-pixel classification. In ROI pixels.
SMOOTH_SIGMA = 9.0

# How far apart two patches can be and still be read as one finding.  IM is
# diffuse and arrives in fragments of what the endoscopist sees as a single
# affected area; polyps are discrete and counted, so they are never merged.
IM_MERGE_RADIUS = 60


def _threshold_blur(binary: np.ndarray, sigma: float, level: float) -> np.ndarray:
    """Blur the indicator and cut it at ``level``.

    Below 0.5 this grows the shape, above it shrinks it, and at 0.5 it leaves
    the area alone and only moves each point of the boundary by its own
    curvature — which is what rounds corners off rather than merely chamfering
    them.  Used in place of a structuring element throughout: a Gaussian is
    separable, so the cost does not grow with the radius, and the 121-pixel
    kernel a 60-pixel closing would need takes seconds per frame.
    """
    blurred = cv2.GaussianBlur(binary.astype(np.float32), (0, 0), sigma)
    return (blurred > level).astype(np.uint8)


def display_shape(mask: np.ndarray, merge_radius: int = 0) -> np.ndarray:
    """The outline-able shape of ``mask``, as a bool array of the same size."""
    binary = _threshold_blur(mask.astype(np.uint8), SMOOTH_SIGMA, 0.5)

    if merge_radius:
        # Grow then shrink by the same amount: patches within the radius of one
        # another meet while they are grown and stay joined once both are pulled
        # back. The approximation leaves the odd hole where two arms close a
        # ring, which is exactly what the fill below is for.
        sigma = merge_radius / 2
        binary = _threshold_blur(binary, sigma, 0.15)
        binary = _threshold_blur(binary, sigma, 0.80)

    # Filling comes last. Closing joins nearby patches by growing them into each
    # other, and two arms that meet enclose the gap they were reaching across —
    # so a fill done before the merge leaves holes the merge itself created.
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    filled = np.zeros_like(binary)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    return filled.astype(bool)


def write_overlay(
    path, mask: np.ndarray, rgba: tuple, merge_radius: int = 0
) -> Optional[bool]:
    """Write the display shape of ``mask`` as a tinted RGBA PNG.

    Returns whether anything was written — an empty shape is not a finding.
    """
    shape = display_shape(mask, merge_radius)
    if not shape.any():
        return False

    canvas = np.zeros((*shape.shape, 4), dtype=np.uint8)
    canvas[shape] = rgba
    path.parent.mkdir(parents=True, exist_ok=True)
    # cv2 writes BGRA; the caller states the colour the way the front-end reads
    # it, so the channels are swapped here rather than at every call site.
    cv2.imwrite(str(path), canvas[:, :, [2, 1, 0, 3]])
    return True
