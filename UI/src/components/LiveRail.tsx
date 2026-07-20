import type { SmoothedSignal } from '../lib/smoothing'
import { modeOf } from '../types'
import { MODE_COLOR, MODE_LABEL } from '../lib/display'
import { partNameOfClass } from '../lib/anatomy'
import { formatTimestamp } from '../lib/frameExtractor'
import { AnatomyMap } from './AnatomyMap'

interface Props {
  live: SmoothedSignal
}

export function LiveRail({ live }: Props) {
  const mode = live.uncertain ? 'neutral' : modeOf(live.siteLabel ?? '')
  const accent = MODE_COLOR[mode]
  const partName = live.uncertain ? null : partNameOfClass(live.siteLabel)
  const imActive = live.imPeakScore >= 1

  return (
    <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="eyebrow">目前部位 · 即時定位</span>
        <span className="font-mono text-[11px] text-inkFaint">GNS</span>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 p-4">
        {/* Anatomy route map — the live position on the tract. */}
        <div className="flex w-[46%] shrink-0 items-center justify-center">
          <AnatomyMap
            activeClass={live.uncertain ? null : live.siteLabel}
            uncertain={live.uncertain}
          />
        </div>

        {/* Readout */}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          {live.count === 0 ? (
            <p className="font-mono text-sm text-inkFaint">等待影格…</p>
          ) : live.uncertain ? (
            <p className="font-display text-2xl font-semibold text-inkFaint">辨識中</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span
                  className="h-3 w-3 rounded-sm"
                  style={{ backgroundColor: accent, boxShadow: `0 0 0 3px ${accent}22` }}
                  aria-hidden
                />
                <span className="pill" style={{ color: accent, borderColor: `${accent}55` }}>
                  {MODE_LABEL[mode]}
                </span>
              </div>
              <p className="mt-2 font-display text-[30px] font-semibold leading-none tracking-tight text-ink">
                {partName ?? live.siteLabel}
              </p>
              <p className="mt-1 font-mono text-xs text-inkFaint">{live.siteLabel}</p>
              <div className="mt-3">
                <div className="flex items-baseline justify-between">
                  <span className="eyebrow">信心</span>
                  <span className="font-mono text-xs font-medium text-ink">
                    {(live.siteConfidence * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(100, live.siteConfidence * 100)}%`,
                      backgroundColor: accent,
                    }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* IM event — a persistent finding, not an average. */}
      <div
        className="border-t px-4 py-3"
        style={{
          borderColor: imActive ? 'var(--im)' : 'var(--line)',
          backgroundColor: imActive ? 'rgba(206,31,94,0.05)' : 'transparent',
        }}
      >
        <div className="flex items-center justify-between">
          <span className="eyebrow" style={imActive ? { color: 'var(--im)' } : undefined}>
            腸上皮化生
          </span>
          {imActive && (
            <span className="font-mono text-[11px] text-inkFaint">{live.imFlaggedCount} 影格確認</span>
          )}
        </div>
        {imActive ? (
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-display text-lg font-semibold text-im">偵測到</span>
            <span className="font-mono text-sm font-medium text-ink">score {live.imPeakScore}</span>
            <span className="font-mono text-xs text-inkSoft">
              峰值 {live.imPeakArea}%
              {live.imPeakAt !== null && ` @ ${formatTimestamp(live.imPeakAt)}`}
            </span>
          </div>
        ) : (
          <p className="mt-1 font-mono text-sm text-inkFaint">
            {live.count === 0 ? '等待影格…' : '目前尚未偵測到'}
          </p>
        )}
      </div>
    </div>
  )
}
