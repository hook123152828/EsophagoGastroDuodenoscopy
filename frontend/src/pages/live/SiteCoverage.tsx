import { REGION_LABEL, REGION_ORDER, type RegionId } from '@/protocol'

const REGION_COLOR: Record<RegionId, string> = {
  esophagus: 'var(--color-region-esophagus)',
  cardia: 'var(--color-region-cardia)',
  body: 'var(--color-region-body)',
  angle: 'var(--color-region-angle)',
  antrum: 'var(--color-region-antrum)',
  duodenum: 'var(--color-region-duodenum)',
  unknown: 'var(--color-region-unknown)',
}

interface Props {
  /** The stabilised site, not the raw per-frame classification. */
  region: RegionId
  /** Regions watched for long enough to count as examined. */
  visited: Set<RegionId>
}

/**
 * Everywhere a complete examination goes, and which of them this one has
 * reached.
 *
 * Coverage, not position — the site panel names where the scope is now. The
 * list runs proximal to distal, the order the scope travels, so a site that
 * was never examined shows up as a gap in the column rather than as something
 * to go looking for. It is given half the controls column and set large
 * enough to be read from across the room, which is where it is read from.
 */
export default function SiteCoverage({ region: current, visited }: Props) {
  return (
    // Spread down the whole block rather than stacked at a fixed rhythm: the
    // height is decided by the layout, and a list that kept its own spacing
    // would leave the space below it empty.
    <ul className="flex h-full min-h-0 flex-col justify-between">
        {REGION_ORDER.map((region) => {
          const isCurrent = region === current
          const seen = visited.has(region)
          return (
            <li
              key={region}
              className={`flex items-center gap-3 text-xl transition-colors ${
                isCurrent
                  ? 'font-medium text-console-text'
                  : seen
                    ? 'text-console-muted'
                    : 'text-console-muted/50'
              }`}
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full transition-opacity"
                style={{
                  background: REGION_COLOR[region],
                  opacity: isCurrent ? 1 : seen ? 0.55 : 0.2,
                }}
              />
              <span className="truncate">{REGION_LABEL[region]}</span>
              {isCurrent ? (
                <span className="ml-auto shrink-0 text-sm text-scope-accent">
                  current
                </span>
              ) : (
                seen && <span className="ml-auto shrink-0 text-sm">seen</span>
              )}
            </li>
          )
        })}
    </ul>
  )
}
