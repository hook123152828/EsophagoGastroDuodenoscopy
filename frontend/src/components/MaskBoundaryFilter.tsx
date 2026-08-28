export const MASK_BOUNDARY_FILTER_ID = 'mask-boundary'
export const MASK_BOUNDARY_FILTER = `url(#${MASK_BOUNDARY_FILTER_ID})`

/**
 * Strokes the edge of a filled segmentation mask.
 *
 * Filled, a mask covers the very mucosa the endoscopist is reading — the pit
 * pattern inside a lesion is what the call is made on — so only its boundary
 * is drawn.
 *
 * The shape itself arrives ready: smoothed, closed up and free of holes, done
 * in ROI pixels by the service that produced it (`backend/masks.py`). This
 * used to be a chain of `feMorphology`, which was wrong twice over — its
 * structuring element is a square, so every boundary came out with axis-
 * aligned corners, and its radii are in CSS pixels, so one finding was a
 * different shape in the report's thumbnails than on the live stage.
 *
 * What is left is a band across the edge: blur the coverage into a ramp, then
 * keep the middle of that ramp. The line lands centred on the boundary, is
 * anti-aliased for free, and follows a curve as a curve. The tint is taken
 * from the mask itself — spread outwards first, so the half of the band lying
 * outside the original shape is painted too rather than fading to black —
 * which keeps GIM purple and polyps yellow through one shared filter.
 */
export function MaskBoundaryFilter() {
  return (
    <svg aria-hidden className="pointer-events-none absolute h-0 w-0">
      <filter
        id={MASK_BOUNDARY_FILTER_ID}
        x="-8%"
        y="-8%"
        width="116%"
        height="116%"
        colorInterpolationFilters="sRGB"
      >
        {/* The tint is stored below half opacity so the mucosa stays readable
            under a filled mask; as a line it should be fully drawn. */}
        <feComponentTransfer in="SourceGraphic" result="solid">
          <feFuncA type="linear" slope="255" />
        </feComponentTransfer>

        <feGaussianBlur in="solid" stdDeviation="3" result="ramp" />
        <feComponentTransfer in="ramp" result="band">
          <feFuncA type="table" tableValues="0 0 1 1 0 0" />
        </feComponentTransfer>

        <feMorphology in="SourceGraphic" operator="dilate" radius="6" result="spread" />
        <feComponentTransfer in="spread" result="ink">
          <feFuncA type="linear" slope="255" />
        </feComponentTransfer>

        <feComposite in="ink" in2="band" operator="in" />
      </filter>
    </svg>
  )
}
