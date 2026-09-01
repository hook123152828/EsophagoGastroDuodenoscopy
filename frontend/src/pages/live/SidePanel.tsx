import { REGION_LABEL, type RegionId } from '@/protocol'

import AnatomyMap from './AnatomyMap'

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
 * Where the scope is: named, and shown.
 *
 * The name sits with the diagram rather than with the coverage list, because
 * the diagram is what it labels — the two answer the same question, one in a
 * word and one in a picture, and reading either confirms the other. The list
 * in the controls column answers a different question: not where the scope is
 * but where it has been.
 */
export default function SidePanel({ region, visited }: Props) {
  return (
    <aside className="flex min-w-0 flex-col gap-4 overflow-hidden border-l border-console-line bg-console-panel/40 p-6">
      <p
        className="shrink-0 text-center text-4xl font-medium tracking-tight transition-colors"
        style={{ color: REGION_COLOR[region] }}
      >
        {REGION_LABEL[region]}
      </p>

      <div className="flex min-h-0 flex-1 items-center justify-center">
        <AnatomyMap current={region} visited={visited} />
      </div>
    </aside>
  )
}
