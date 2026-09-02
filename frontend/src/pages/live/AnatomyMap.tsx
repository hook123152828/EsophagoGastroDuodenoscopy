import { REGION_ORDER, type RegionId, REGION_LABEL } from '@/protocol'

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
 * The stomach and duodenum, traced from the anatomy plate rather than drawn by
 * hand: the plate's organ was masked by colour, its outline followed, and the
 * result fitted through a spline. Drawing it freehand from the picture is what
 * this did first, and it came out wrong everywhere it mattered — the fundus
 * short, the greater curvature too shallow, and the duodenum a spiral instead
 * of a cap turning down into a descending limb.
 *
 * One closed path, because on the plate it is one silhouette. The oesophagus
 * runs off the top of the viewBox and the duodenum off the bottom, as they do
 * there; the spline rounds both cut ends, and the viewBox crops them flat
 * again.
 */
const ORGAN =
  'M186.2 52.1 C183.9 49.1 182.2 47.6 179.7 45.6 C177.2 43.6 173.9 41.6 171.1 ' +
  '40.2 C168.2 38.9 166.1 38.1 162.5 37.5 C158.9 37.0 154.0 36.3 149.5 37.0 ' +
  'C145.1 37.7 140.7 38.1 135.5 41.8 C130.4 45.6 123.1 56.7 118.8 59.6 C114.6 ' +
  '62.6 112.6 60.6 110.2 59.6 C107.9 58.6 106.2 56.5 104.8 53.7 C103.5 50.9 ' +
  '102.8 51.5 102.2 42.9 C101.5 34.3 105.4 8.8 101.1 2.0 C96.8 -4.8 80.4 -5.3 ' +
  '76.3 2.0 C72.2 9.3 75.8 36.1 76.3 45.6 C76.8 55.1 77.4 54.7 79.5 59.1 C81.7 ' +
  '63.5 83.6 68.0 89.2 72.0 C94.9 76.0 109.0 80.3 113.5 83.3 C117.9 86.3 115.7 ' +
  '86.8 116.2 89.8 C116.6 92.7 116.5 97.8 116.2 101.1 C115.8 104.3 115.3 106.4 ' +
  '114.0 109.2 C112.7 111.9 110.7 115.3 108.6 117.8 C106.6 120.2 107.5 121.7 ' +
  '101.6 123.7 C95.7 125.7 79.1 127.8 73.1 129.6 C67.1 131.4 68.8 131.7 65.5 ' +
  '134.5 C62.3 137.2 56.7 144.3 53.7 146.3 C50.7 148.3 49.9 147.1 47.8 146.3 ' +
  'C45.6 145.5 42.9 142.5 40.8 141.5 C38.6 140.4 36.7 140.0 34.8 139.8 C33.0 ' +
  '139.7 31.8 139.2 29.5 140.4 C27.1 141.6 22.6 144.5 20.8 146.8 C19.1 149.2 ' +
  '20.4 152.7 18.7 154.4 C17.0 156.1 13.0 155.2 10.6 157.1 C8.2 159.0 5.6 162.5 ' +
  '4.2 165.7 C2.7 168.9 2.4 169.7 2.0 176.5 C1.6 183.2 -1.1 201.1 2.0 206.1 ' +
  'C5.1 211.1 17.2 211.0 20.3 206.6 C23.4 202.2 20.4 185.3 20.8 179.7 C21.3 ' +
  '174.0 22.3 174.3 23.0 172.7 C23.7 171.1 22.2 170.5 25.2 170.0 C28.1 169.5 ' +
  '36.7 171.0 40.8 169.5 C44.8 167.9 46.8 162.0 49.4 160.8 C52.0 159.7 53.1 ' +
  '159.9 56.4 162.5 C59.7 165.1 65.2 172.9 69.3 176.5 C73.4 180.1 77.4 182.3 ' +
  '81.2 184.0 C84.9 185.7 87.8 186.2 91.9 186.7 C96.1 187.1 101.3 187.1 105.9 ' +
  '186.7 C110.5 186.2 114.3 185.5 119.4 184.0 C124.5 182.5 131.3 179.9 136.6 ' +
  '177.5 C141.9 175.2 146.2 173.1 151.2 170.0 C156.1 166.9 160.9 164.3 166.2 ' +
  '159.2 C171.5 154.1 179.0 145.1 182.9 139.3 C186.9 133.5 187.8 130.5 189.9 ' +
  '124.2 C192.1 117.9 194.6 107.4 195.8 101.6 C197.1 95.9 197.3 94.0 197.5 89.8 ' +
  'C197.6 85.6 197.6 80.7 196.9 76.3 C196.2 71.9 194.9 67.4 193.2 63.4 C191.4 ' +
  '59.3 188.4 55.0 186.2 52.1 Z'

/**
 * Region slabs, drawn clipped to the silhouette.
 *
 * They tile the plane without overlapping, so the clip decides each region's
 * shape. Every boundary here was measured off a marked-up screenshot rather
 * than judged by eye: the drawing was registered to this viewBox by fitting
 * its silhouette against the traced one, and each stroke read back in these
 * coordinates. The five lines, as x = f(y) or y = f(x):
 *
 *   oesophagus | cardia   x = 149.9 - 0.8y    (down the tube, not across it:
 *                          the cardia is the pocket at the bend, not a band)
 *   cardia+fundus | body  y = 81.25 - 0.1x    (just under the dome)
 *   antrum | angle        x = 48.83 + 0.233y
 *   angle | body          x = 42.9 + 0.525y   (through the angular incisure)
 *   antrum | duodenum     x = 34 + 0.1488y    (the pyloric channel)
 *
 * The last two open away from each other going distally, which is what makes
 * the angle a band across the stomach -- 胃角部 -- rather than a sliver on the
 * lesser curvature.
 */
const REGION_SLAB: Record<Exclude<RegionId, 'unknown'>, string> = {
  esophagus: 'M31 -20 H165.9 L92.3 72 L45.4 76.7 Z',
  cardia: 'M92.3 72 L165.9 -20 H220 V59.25 Z',
  body: 'M81.3 73.1 L220 59.25 V240 L168.9 240 Z',
  angle: 'M66.2 74.6 L81.3 73.1 L168.9 240 H104.8 Z',
  antrum: 'M45.4 76.7 L66.2 74.6 L104.8 240 H69.7 Z',
  duodenum: 'M31 -20 L69.7 240 H-20 V-20 Z',
}

/**
 * Cardia and fundus, which the plates separate and this map does not: GNS has
 * one class for the proximal stomach, so both sides of this line light up
 * together and it is drawn for orientation only.
 */
const CARDIA_FUNDUS = 'M119.6 37.9 V69.3'

/**
 * Where each region's badge sits — inside the region, clear of the outline.
 * Hand-placed rather than derived: a slab is a half-plane, and its centre is
 * nowhere near the part of it the silhouette keeps.
 */
const BADGE_AT: Record<RegionId, [number, number]> = {
  esophagus: [89, 25],
  cardia: [150, 48],
  body: [152, 110],
  angle: [106, 158],
  antrum: [72, 158],
  duodenum: [27, 160],
  unknown: [152, 110],
}

interface Props {
  current: RegionId
  /** Regions already seen in this procedure — the coverage checklist. */
  visited: Set<RegionId>
  /** White light or narrow band, written onto the site it was seen under. */
  modality: 'WL' | 'NBI' | null
}

export default function AnatomyMap({ current, visited, modality }: Props) {
  const [badgeX, badgeY] = BADGE_AT[current]

  return (
    <svg
      viewBox="0 2 200 205"
      className="h-full max-h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={
        modality
          ? `Examination site: ${REGION_LABEL[current]}, under ${modality}`
          : `Examination site: ${REGION_LABEL[current]}`
      }
    >
      <defs>
        <clipPath id="gi-outline">
          <path d={ORGAN} />
        </clipPath>
      </defs>

      <g clipPath="url(#gi-outline)">
        {/* Unlit organ, so the shape reads even where nothing has been seen. */}
        <rect x="-20" y="-20" width="240" height="250" fill="var(--color-console-line)" />
        {REGION_ORDER.map((region) => {
          const isCurrent = region === current
          return (
            <path
              key={region}
              d={REGION_SLAB[region as Exclude<RegionId, 'unknown'>]}
              fill={REGION_COLOR[region]}
              fillOpacity={isCurrent ? 0.85 : visited.has(region) ? 0.24 : 0}
              className="transition-opacity duration-300"
            />
          )
        })}

        {/* The divisions, dashed as they are on the plate. Without them an
            unvisited stomach is one dark shape and the diagram says nothing
            until a site lights up; with them it is a map the whole time. */}
        {REGION_ORDER.map((region) => (
          <path
            key={region}
            d={REGION_SLAB[region as Exclude<RegionId, 'unknown'>]}
            fill="none"
            stroke="var(--color-console-muted)"
            strokeOpacity={0.55}
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path
          d={CARDIA_FUNDUS}
          fill="none"
          stroke="var(--color-console-muted)"
          strokeOpacity={0.55}
          strokeWidth={1}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
      </g>

      {/* Drawn last, over both: the silhouette is the one line that has to
          survive whatever is filled underneath it. */}
      <path
        d={ORGAN}
        fill="none"
        stroke="var(--color-console-muted)"
        strokeWidth={1.75}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />

      {/* The light source, on the site it is lighting. Outside the clip: a
          badge the silhouette could cut in half would be worse than no badge,
          and the anchors sit close to the outline in the oesophagus and at the
          duodenal cap. */}
      {modality && (
        <g
          className="transition-transform duration-300"
          transform={`translate(${badgeX} ${badgeY})`}
        >
          <rect
            x={-13}
            y={-7}
            width={26}
            height={14}
            rx={7}
            fill="var(--color-console-bg)"
            fillOpacity={0.86}
          />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={8}
            fontWeight={600}
            letterSpacing={0.5}
            fill={modality === 'NBI' ? 'var(--color-scope-accent)' : 'var(--color-console-text)'}
          >
            {modality}
          </text>
        </g>
      )}
    </svg>
  )
}
