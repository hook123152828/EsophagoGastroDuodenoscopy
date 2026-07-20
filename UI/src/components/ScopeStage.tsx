import type { RefObject } from 'react'
import type { SmoothedSignal } from '../lib/smoothing'
import { modeOf } from '../types'
import { MODE_COLOR, MODE_LABEL } from '../lib/display'
import { partNameOfClass } from '../lib/anatomy'
import { formatTimestamp } from '../lib/frameExtractor'

interface Props {
  videoRef: RefObject<HTMLVideoElement>
  videoUrl: string | null
  hasSource: boolean
  capturing: boolean
  live: SmoothedSignal
}

export function ScopeStage({ videoRef, videoUrl, hasSource, capturing, live }: Props) {
  const liveMode = live.uncertain ? 'neutral' : modeOf(live.siteLabel ?? '')
  const imActive = live.imPeakScore >= 1

  return (
    <div className="card relative flex min-h-0 flex-col overflow-hidden p-0">
      {/* Stage header */}
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="eyebrow">內視鏡即時影像</span>
          {capturing && (
            <span className="flex items-center gap-1.5 rounded-full bg-im/10 px-2 py-0.5">
              <span className="h-1.5 w-1.5 animate-rec rounded-full bg-im" aria-hidden />
              <span className="font-mono text-[10px] uppercase tracking-wide text-im">Live</span>
            </span>
          )}
        </div>
        <span className="font-mono text-[11px] text-inkFaint">
          {live.count > 0 ? `${live.count} 影格已分析` : '待載入'}
        </span>
      </div>

      {/* Video / aperture */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[#05090c]">
        {hasSource ? (
          <div className="aperture relative flex h-full w-full items-center justify-center">
            <video
              ref={videoRef}
              src={videoUrl ?? undefined}
              muted
              playsInline
              controls
              className="max-h-full w-full object-contain"
            />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 px-10 py-16 text-center">
            <span className="relative flex h-16 w-16 items-center justify-center" aria-hidden>
              <span className="absolute inset-0 rounded-full border-2 border-white/20" />
              <span className="absolute inset-[7px] rounded-full border border-white/10" />
              <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
            </span>
            <p className="max-w-sm text-sm leading-relaxed text-white/45">
              載入內視鏡影片或連接 USB 擷取裝置即可開始。畫面在此播放,每一格都在瀏覽器內即時分析——影像不會離開本機。
            </p>
          </div>
        )}

        {/* Live HUD — floats over the scope view like an instrument overlay. */}
        {hasSource && live.count > 0 && (
          <div className="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-2">
            <div className="flex items-center gap-2 rounded-lg bg-black/55 px-3 py-2 backdrop-blur-sm">
              {live.uncertain ? (
                <span className="font-display text-lg font-semibold text-white/70">辨識中…</span>
              ) : (
                <>
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: MODE_COLOR[liveMode], boxShadow: `0 0 10px ${MODE_COLOR[liveMode]}` }}
                    aria-hidden
                  />
                  <span className="font-display text-lg font-semibold tracking-tight text-white">
                    {partNameOfClass(live.siteLabel) ?? live.siteLabel}
                  </span>
                  <span className="font-mono text-xs text-white/60">
                    {live.siteLabel} · {MODE_LABEL[liveMode]} · {(live.siteConfidence * 100).toFixed(0)}%
                  </span>
                </>
              )}
            </div>
            {imActive && (
              <div className="flex items-center gap-1.5 rounded-lg bg-im/85 px-2.5 py-1.5 backdrop-blur-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden />
                <span className="font-mono text-xs font-semibold text-white">
                  IM score {live.imPeakScore}
                  {live.imPeakAt !== null && ` @ ${formatTimestamp(live.imPeakAt)}`}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
