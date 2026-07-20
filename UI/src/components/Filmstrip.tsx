import type { ExtractedFrame } from '../types'
import type { FrameAnalysis } from '../hooks/useFrameAnalysis'
import { modeOf } from '../types'
import { MODE_COLOR, SCORE_COLOR } from '../lib/display'
import { formatTimestamp } from '../lib/frameExtractor'

interface Props {
  frames: ExtractedFrame[]
  analyses: Record<string, FrameAnalysis>
  selectedId: string | null
  onSelect: (frame: ExtractedFrame) => void
  onRetry: (frame: ExtractedFrame) => void
}

export function Filmstrip({ frames, analyses, selectedId, onSelect, onRetry }: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex shrink-0 items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="eyebrow">關鍵影格</span>
          <span className="text-xs text-inkFaint">每個部位保留最具代表性的一張(病灶優先,否則取最清晰)</span>
        </div>
        <span className="font-mono text-[11px] text-inkFaint">{frames.length} 保留</span>
      </div>

      {frames.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-line text-sm text-inkFaint">
          影片播放時,值得保留的影格會出現在這裡。
        </div>
      ) : (
        <div className="flex flex-1 gap-2.5 overflow-x-auto pb-1">
          {frames.map((frame) => {
            const a = analyses[frame.id]
            const gns = a?.gns
            const mode = gns ? modeOf(gns.class_name) : 'neutral'
            const pending = !a || a.status === 'pending'
            const isError = a?.status === 'error'
            const selected = frame.id === selectedId

            return (
              <div key={frame.id} className="animate-pop-in flex w-28 shrink-0 flex-col">
                <button
                  type="button"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', frame.id)}
                  onClick={() => onSelect(frame)}
                  className={`group relative block w-full select-none overflow-hidden rounded-lg border transition-all [touch-action:manipulation] hover:-translate-y-0.5 ${
                    selected
                      ? 'border-brand ring-2 ring-brand/30'
                      : 'border-line hover:border-inkFaint'
                  }`}
                  style={{ cursor: 'grab' }}
                >
                  <img
                    src={frame.url}
                    alt={`影格 ${formatTimestamp(frame.timestamp)}`}
                    className="h-[68px] w-full object-cover"
                  />
                  {pending && (
                    <span className="animate-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/50 to-transparent bg-[length:200%_100%]" />
                  )}
                  {a?.gim && a.gim.score >= 1 && mode === 'NBI' && (
                    <span
                      className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white"
                      style={{ backgroundColor: SCORE_COLOR[a.gim.score] }}
                      aria-label={`IM score ${a.gim.score}`}
                    />
                  )}
                  <span
                    className="absolute bottom-0 left-0 right-0 h-[3px]"
                    style={{ backgroundColor: MODE_COLOR[mode] }}
                  />
                </button>
                <div className="mt-1 flex items-center justify-between px-0.5">
                  <span className="font-mono text-[11px] text-inkSoft">
                    {formatTimestamp(frame.timestamp)}
                  </span>
                  {gns && <span className="font-mono text-[10px] text-inkFaint">{gns.class_name}</span>}
                </div>
                {isError && (
                  <button
                    type="button"
                    onClick={() => onRetry(frame)}
                    className="mt-1 rounded-md bg-im/10 py-0.5 text-[11px] text-im transition hover:bg-im/20"
                  >
                    重試
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
