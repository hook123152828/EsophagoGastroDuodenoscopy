import { type RegionId } from '@/protocol'

import AnatomyMap from './AnatomyMap'

interface Props {
  /** The stabilised site, not the raw per-frame classification. */
  region: RegionId
  /** Regions watched for long enough to count as examined. */
  visited: Set<RegionId>
}

/**
 * The anatomy, and nothing else.
 *
 * Where the scope is and where it has been is a spatial question, so it is
 * answered spatially and given the whole panel to be answered in. The naming
 * and the coverage list moved to the controls column, next to the other
 * readouts: they are words, and a column of words beside a picture only
 * competes with it.
 */
export default function SidePanel({ region, visited }: Props) {
  return (
    <aside className="flex min-w-0 items-center justify-center overflow-hidden border-l border-console-line bg-console-panel/40 p-6">
      <AnatomyMap current={region} visited={visited} />
    </aside>
  )
}
