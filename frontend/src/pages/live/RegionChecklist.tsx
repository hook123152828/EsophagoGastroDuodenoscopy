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
 * Coverage: every site of a complete examination, which have been reached, and
 * which one the scope is in.
 *
 * Reads proximal to distal, the order the scope travels, so a gap in the
 * examination shows up as a gap in the column rather than as something to go
 * looking for. The current site carries the only accent in the list — it is
 * the one thing here that changes while you watch.
 */
export default function RegionChecklist({ region: current, visited }: Props) {
  return (
    <ul className="mt-auto shrink-0 space-y-2 border-t border-console-line pt-3">
      {REGION_ORDER.map((region) => {
        const isCurrent = region === current
        const seen = visited.has(region)
        return (
          <li
            key={region}
            className={`flex items-center gap-2 text-sm transition-colors ${
              isCurrent
                ? 'font-medium text-console-text'
                : seen
                  ? 'text-console-muted'
                  : 'text-console-muted/50'
            }`}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full transition-opacity"
              style={{
                background: REGION_COLOR[region],
                opacity: isCurrent ? 1 : seen ? 0.55 : 0.2,
              }}
            />
            <span className="truncate">{REGION_LABEL[region]}</span>
            {isCurrent ? (
              <span className="ml-auto shrink-0 text-xs text-scope-accent">
                current
              </span>
            ) : (
              seen && <span className="ml-auto shrink-0 text-xs">seen</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
