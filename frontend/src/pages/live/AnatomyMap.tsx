import { REGION_ORDER, REGION_LABEL, type RegionId } from '@/protocol'

const REGION_COLOR: Record<RegionId, string> = {
  esophagus: 'var(--color-region-esophagus)',
  cardia: 'var(--color-region-cardia)',
  body: 'var(--color-region-body)',
  angle: 'var(--color-region-angle)',
  antrum: 'var(--color-region-antrum)',
  duodenum: 'var(--color-region-duodenum)',
  unknown: 'var(--color-region-unknown)',
}

/**
 * The stomach, laid out as in the anatomy plate this diagram was drawn from:
 * the oesophagus entering from the upper left, the cardia where it meets the
 * stomach, the fundus doming up and to the right of it, the greater curvature
 * ballooning down the right, and the antrum tapering left into the pylorus.
 *
 * Drawn as a silhouette rather than an outline: the organ is composed of two
 * overlapping shapes, and filling *through the clip* unions them seamlessly.
 * Stroking each sub-shape instead would expose the seam between them.
 */
const STOMACH =
  'M70 0 L92 0 ' +
  'C95 20 99 40 106 54 ' + // oesophagus, leaning right into the cardia
  'C128 28 166 32 184 66 ' + // fundus, doming up and right of the cardia
  'C198 92 200 132 192 162 ' + // greater curvature, ballooning right
  'C184 196 162 220 130 228 ' +
  'C106 234 80 228 62 208 ' + // antrum, tapering left into the pylorus
  'C74 196 92 182 110 168 ' + // its upper border, up to the angular incisure
  'C106 150 96 104 84 66 ' + // lesser curvature, concave
  'C80 52 74 26 70 8 Z'

/** Pyloric ring and duodenal cap — the C hooking down at the bottom left. */
const DUODENUM =
  'M74 202 C46 194 20 206 14 226 C8 248 24 264 44 260 ' +
  'C56 258 62 248 58 238 C55 230 44 230 42 239 ' +
  'C40 247 30 246 28 236 C25 220 42 210 68 214 Z'

/**
 * Region slabs, drawn clipped to the silhouette.
 *
 * They tile the viewBox without overlapping, so the clip decides each region's
 * shape. The oesophagus slab is bounded on the right and the duodenum on the
 * right of the pylorus, because both sit beside the stomach rather than above
 * or below it — banding the whole diagram horizontally would colour the fundus
 * as oesophagus and the duodenal cap as antrum.
 */
const REGION_SLAB: Record<Exclude<RegionId, 'unknown'>, string> = {
  esophagus: 'M0 0 H106 V54 H0 Z',
  cardia: 'M106 0 H200 V100 H106 Z M0 54 H106 V100 H0 Z',
  body: 'M0 100 H200 V150 H0 Z',
  angle: 'M0 150 H200 V176 H0 Z',
  antrum: 'M62 176 H200 V260 H62 Z',
  duodenum: 'M0 176 H62 V260 H0 Z',
}

interface Props {
  current: RegionId
  /** Regions already seen in this procedure — the coverage checklist. */
  visited: Set<RegionId>
}

export default function AnatomyMap({ current, visited }: Props) {
  return (
    <svg
      viewBox="0 0 200 260"
      className="h-full max-h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Examination site: ${REGION_LABEL[current]}`}
    >
      <defs>
        <clipPath id="gi-outline">
          <path d={STOMACH} />
          <path d={DUODENUM} />
        </clipPath>
      </defs>

      <g clipPath="url(#gi-outline)">
        {/* Unlit organ, so the shape reads even where nothing has been seen. */}
        <rect x="0" y="0" width="200" height="260" fill="var(--color-console-line)" />
        {REGION_ORDER.map((region) => {
          const isCurrent = region === current
          return (
            <path
              key={region}
              d={REGION_SLAB[region as Exclude<RegionId, 'unknown'>]}
              fill={REGION_COLOR[region]}
              fillOpacity={isCurrent ? 0.95 : visited.has(region) ? 0.28 : 0}
              className="transition-opacity duration-300"
            />
          )
        })}
      </g>
    </svg>
  )
}
