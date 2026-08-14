import { REGION_LABEL, REGION_ORDER, type FrameRecord, type RegionId } from '@/protocol'

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
  frame: FrameRecord | null
  visited: Set<RegionId>
}

/**
 * Site readout. Deliberately the only thing in the panel — the diagram and the
 * coverage list are what the operator reads at a glance, so they get the whole
 * width rather than competing with per-frame numbers.
 */
export default function SidePanel({ frame, visited }: Props) {
  const current = frame?.gns?.region ?? 'unknown'

  return (
    <aside className="flex min-w-0 flex-col gap-8 overflow-y-auto border-l border-console-line bg-console-panel/40 p-8">
      <header>
        <h2 className="text-xs font-medium tracking-widest text-console-muted uppercase">
          Site
        </h2>
        <p
          className="mt-1 text-3xl font-medium tracking-tight transition-colors"
          style={{ color: REGION_COLOR[current] }}
        >
          {REGION_LABEL[current]}
        </p>
      </header>

      {/* The diagram takes whatever vertical space the list leaves, so it grows
          with the window instead of being pinned to a fixed width. */}
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <AnatomyMap current={current} visited={visited} />
      </div>

      <ul className="shrink-0 space-y-3.5">
        {REGION_ORDER.map((region) => {
          const isCurrent = region === current
          const seen = visited.has(region)
          return (
            <li
              key={region}
              className={`flex items-center gap-3 text-lg transition-colors ${
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
              <span>{REGION_LABEL[region]}</span>
              {isCurrent ? (
                <span className="ml-auto text-sm text-scope-accent">current</span>
              ) : (
                seen && <span className="ml-auto text-sm">seen</span>
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
