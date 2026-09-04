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
 * What is left is a hairline across the edge over a wash of the same colour.
 *
 * The line: blur the coverage into a ramp, then keep the middle of that ramp.
 * It lands centred on the boundary, is anti-aliased for free, and follows a
 * curve as a curve. The tint is taken from the mask itself — spread outwards
 * first, so the half of the band lying outside the original shape is painted
 * too rather than fading to black — which keeps GIM purple and polyps yellow
 * through one shared filter.
 *
 * It is kept *thin*. A heavy line traced around an amorphous region reads as
 * something drawn on with a marker, and these regions are amorphous: they
 * wander, they neck, they have lobes. The thinner the line the more the shape
 * looks measured rather than sketched. It matters most in the report, where
 * the same finding is a 200px thumbnail and these radii are in CSS pixels, so
 * a line that is fine on the stage is a crayon there.
 *
 * The wash under it is what a line alone cannot do: bind two lobes of one
 * finding into one region, and say which side of the line the finding is on.
 * At a sixth of full strength the pit pattern reads straight through it, which
 * is the point — the pattern inside a lesion is what the call is made on, and
 * covering it to announce it would be a poor trade.
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
            under a filled mask; the line wants it whole, the wash wants its
            own strength, so both are taken from a solid copy. */}
        <feComponentTransfer in="SourceGraphic" result="solid">
          <feFuncA type="linear" slope="255" />
        </feComponentTransfer>

        <feComponentTransfer in="solid" result="wash">
          <feFuncA type="linear" slope="0.16" />
        </feComponentTransfer>

        <feGaussianBlur in="solid" stdDeviation="1.6" result="ramp" />
        <feComponentTransfer in="ramp" result="band">
          <feFuncA type="table" tableValues="0 0 1 1 0 0" />
        </feComponentTransfer>

        <feMorphology in="SourceGraphic" operator="dilate" radius="4" result="spread" />
        <feComponentTransfer in="spread" result="ink">
          <feFuncA type="linear" slope="255" />
        </feComponentTransfer>
        <feComposite in="ink" in2="band" operator="in" result="line" />

        <feMerge>
          <feMergeNode in="wash" />
          <feMergeNode in="line" />
        </feMerge>
      </filter>
    </svg>
  )
}
