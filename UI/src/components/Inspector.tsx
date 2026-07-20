import { useEffect, useState } from 'react'
import type { ExtractedFrame } from '../types'
import type { FrameAnalysis } from '../hooks/useFrameAnalysis'
import { modeOf } from '../types'
import { MODE_COLOR, MODE_LABEL, SCORE_COLOR } from '../lib/display'
import { partNameOfClass } from '../lib/anatomy'
import { formatTimestamp } from '../lib/frameExtractor'

interface Props {
  frame: ExtractedFrame | null
  analysis: FrameAnalysis | undefined
}

export function Inspector({ frame, analysis }: Props) {
  const [showOverlay, setShowOverlay] = useState(false)
  const [zoomed, setZoomed] = useState(false)

  const gns = analysis?.gns
  const gim = analysis?.gim
  const mode = gns ? modeOf(gns.class_name) : 'neutral'
  // IM overlay is only meaningful on NBI frames (GIM is an NBI model).
  const maskSrc = gim?.mask_b64 && mode === 'NBI' ? `data:image/jpeg;base64,${gim.mask_b64}` : null

  useEffect(() => {
    if (!zoomed) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoomed(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomed])

  // A new selection replaces the zoomed image, so stale zoom state is fine to
  // keep; but if the frame disappears (retention pruned it) close the viewer.
  useEffect(() => {
    if (!frame) setZoomed(false)
  }, [frame])

  return (
    <div className="card flex shrink-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="eyebrow">選取影格</span>
        {frame && (
          <span className="font-mono text-[11px] text-inkFaint">{formatTimestamp(frame.timestamp)}</span>
        )}
      </div>

      {!frame ? (
        <p className="px-4 py-6 text-center text-xs text-inkFaint">
          點選下方關鍵影格即可檢視細節與 IM 疊圖。
        </p>
      ) : (
        <div className="flex gap-3 p-4">
          <button
            type="button"
            onClick={() => setZoomed(true)}
            title="點擊放大"
            className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-line bg-[#05090c] transition hover:border-brand/60"
          >
            <img
              src={showOverlay && maskSrc ? maskSrc : frame.url}
              alt={`影格 ${formatTimestamp(frame.timestamp)}`}
              className="h-full w-full object-cover"
            />
            <span className="absolute inset-0 hidden items-center justify-center bg-ink/40 group-hover:flex">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm10 14-4.35-4.35M11 8v6M8 11h6"
                  stroke="#fff"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </button>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
            {gns ? (
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-ink">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: MODE_COLOR[mode] }}
                  aria-hidden
                />
                {partNameOfClass(gns.class_name) && (
                  <span className="font-display font-semibold">{partNameOfClass(gns.class_name)}</span>
                )}
                <span className="font-mono text-xs text-inkFaint">{gns.class_name}</span>
                <span className="font-mono text-xs text-inkFaint">{MODE_LABEL[mode]}</span>
                <span className="font-mono text-xs text-inkSoft">{(gns.confidence * 100).toFixed(0)}%</span>
              </p>
            ) : (
              <p className="font-mono text-sm text-inkFaint">
                {analysis?.status === 'error' ? '分析失敗' : '分析中…'}
              </p>
            )}
            {gim && mode === 'NBI' && (
              <p className="flex items-center gap-1.5 font-mono text-sm text-ink">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: SCORE_COLOR[gim.score] }}
                  aria-hidden
                />
                IM score {gim.score}
                <span className="text-inkSoft">· {gim.area}%</span>
              </p>
            )}
            {gim && mode !== 'neutral' && mode !== 'NBI' && (
              <p className="font-mono text-xs text-inkFaint">IM 僅於 NBI 判讀</p>
            )}
            <button
              type="button"
              disabled={!maskSrc}
              onClick={() => setShowOverlay((v) => !v)}
              className="mt-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              {maskSrc ? (showOverlay ? '隱藏 IM 疊圖' : '顯示 IM 疊圖') : '無疊圖(score 0)'}
            </button>
          </div>
        </div>
      )}

      {/* Zoomed viewer */}
      {zoomed && frame && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-6 backdrop-blur-sm"
          onClick={() => setZoomed(false)}
          role="dialog"
          aria-label="影格放大檢視"
        >
          <div
            className="animate-pop-in flex max-h-full flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={showOverlay && maskSrc ? maskSrc : frame.url}
              alt={`影格 ${formatTimestamp(frame.timestamp)} 放大`}
              className="max-h-[78vh] max-w-[86vw] rounded-2xl border border-white/20 object-contain shadow-lg"
            />
            <div className="flex items-center gap-3">
              <span className="pill bg-surface">
                {formatTimestamp(frame.timestamp)}
                {gns && ` · ${gns.class_name}`}
                {gim && ` · IM ${gim.score}`}
              </span>
              {maskSrc && (
                <button
                  type="button"
                  onClick={() => setShowOverlay((v) => !v)}
                  className="rounded-lg bg-surface px-3 py-1.5 text-xs font-medium text-ink shadow-sm transition hover:bg-sunken"
                >
                  {showOverlay ? '隱藏 IM 疊圖' : '顯示 IM 疊圖'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setZoomed(false)}
                className="rounded-lg bg-surface px-3 py-1.5 text-xs font-medium text-ink shadow-sm transition hover:bg-sunken"
              >
                關閉 (Esc)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
