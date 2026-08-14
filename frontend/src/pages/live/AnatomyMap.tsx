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
 * Oesophagus down from the top, greater curvature ballooning right, antrum
 * sweeping down-left into the pyloric hook.
 *
 * Drawn as a silhouette rather than an outline: the organ is composed of two
 * overlapping shapes, and filling *through the clip* unions them seamlessly.
 * Stroking each sub-shape instead would expose the seam between them.
 */
const STOMACH =
  'M97 4 L117 4 ' +
  'C118 22 120 36 124 48 ' + // oesophagus, kept narrow before it flares
  'C133 58 143 60 154 66 ' +
  'C178 84 188 118 180 150 ' + // greater curvature, ballooning right
  'C172 182 150 203 120 210 ' +
  'C100 216 78 214 62 204 ' + // bottom, sweeping left into the antrum
  'C72 192 89 174 97 150 ' +
  'C104 120 102 96 93 80 ' + // lesser curvature, concave
  'C85 66 73 58 74 46 ' + // fundus, doming up and left of the cardia
  'C75 34 86 32 97 38 Z'

/** Pylorus and duodenal cap — the hook at the bottom left. */
const DUODENUM =
  'M67 194 ' +
  'C49 199 33 210 29 227 ' +
  'C25 244 45 253 55 242 ' +
  'C64 232 53 222 43 228 ' +
  'C34 232 35 219 46 213 ' +
  'C54 208 63 205 70 203 Z'

/**
 * Region slabs, drawn clipped to the silhouette.
 *
 * They tile the viewBox without overlapping, so the clip decides each region's
 * shape. The lower part splits by x because the antrum and duodenum run
 * sideways — banding the whole diagram horizontally would colour the hook as
 * antrum.
 */
const REGION_SLAB: Record<Exclude<RegionId, 'unknown'>, string> = {
  // Bounded on the left as well, so the fundus dome beside the tube is not
  // coloured as oesophagus.
  esophagus: 'M96 0 H200 V52 H96 Z',
  cardia: 'M0 0 H96 V104 H0 Z M96 52 H200 V104 H96 Z',
  body: 'M0 104 H200 V156 H0 Z',
  angle: 'M0 156 H200 V192 H0 Z',
  antrum: 'M62 192 H200 V260 H62 Z',
  duodenum: 'M0 192 H62 V260 H0 Z',
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
