export const MASK_BOUNDARY_FILTER_ID = 'mask-boundary'
export const MASK_BOUNDARY_FILTER = `url(#${MASK_BOUNDARY_FILTER_ID})`

/**
 * Turns a filled segmentation mask into the shared Live/Report outline.
 *
 * The filter works only on alpha, so GIM stays purple and polyp masks stay
 * yellow. Closing and opening merge nearby regions and remove isolated noise
 * before the final erosion is subtracted to leave the boundary.
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
        <feComponentTransfer result="solid">
          <feFuncA type="linear" slope="255" />
        </feComponentTransfer>
        <feMorphology in="solid" operator="dilate" radius="5" result="grown" />
        <feMorphology in="grown" operator="erode" radius="7" result="shrunk" />
        <feMorphology in="shrunk" operator="dilate" radius="2" result="merged" />
        <feMorphology in="merged" operator="erode" radius="4" result="inner" />
        <feComposite in="merged" in2="inner" operator="out" />
      </filter>
    </svg>
  )
}
