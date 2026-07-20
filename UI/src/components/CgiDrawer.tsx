import { useEffect, useState } from 'react'
import type { ExtractedFrame, CgiPair } from '../types'
import type { FrameAnalysis } from '../hooks/useFrameAnalysis'
import type { SmoothedSignal } from '../lib/smoothing'
import { ReportCard } from './ReportCard'

export type BinKey = 'A' | 'B' | 'C'
export type Bins = Record<BinKey, string[]>

const BAYS: { key: BinKey; label: string }[] = [
  { key: 'A', label: '胃竇 Antrum' },
  { key: 'B', label: '胃體 Body' },
  { key: 'C', label: '賁門 Cardia' },
]

interface Props {
  open: boolean
  onClose: () => void
  frames: ExtractedFrame[]
  bins: Bins
  onDropToBin: (bin: BinKey, frameId: string) => void
  onRemoveFromBin: (bin: BinKey, frameId: string) => void
  onAnalyze: () => void
  analyzing: boolean
  result: CgiPair | null
  error: string | null
  auto: boolean
  onResumeAuto: () => void
  // Report — folds the whole exam, independent of the live playhead.
  sampledCount: number
  analyses: Record<string, FrameAnalysis>
  fps: number
  reportSignal: SmoothedSignal
}

export function CgiDrawer({
  open,
  onClose,
  frames,
  bins,
  onDropToBin,
  onRemoveFromBin,
  onAnalyze,
  analyzing,
  result,
  error,
  auto,
  onResumeAuto,
  sampledCount,
  analyses,
  fps,
  reportSignal,
}: Props) {
  const [dragOver, setDragOver] = useState<BinKey | null>(null)
  const frameById = (id: string) => frames.find((f) => f.id === id)
  const ready = BAYS.every(({ key }) => bins[key].length > 0)
  const positive = result != null && result.probability > 0.5

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <div
      className={`fixed inset-0 z-40 transition-opacity duration-300 ${
        open ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
      aria-hidden={!open}
    >
      <div className="absolute inset-0 bg-ink/25 backdrop-blur-sm" onClick={onClose} />
      <aside
        className={`absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col bg-paper shadow-lg transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        role="dialog"
        aria-label="判讀與報告"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-5 py-3.5">
          <h2 className="font-display text-base font-semibold text-ink">判讀與報告</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-inkSoft transition hover:bg-sunken"
            aria-label="關閉"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {/* CGI */}
          <section className="card p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h3 className="font-display text-sm font-semibold text-ink">慢性胃炎 CGI</h3>
              {auto ? (
                <span className="pill" style={{ color: 'var(--brand)', borderColor: 'var(--brand)' }}>
                  <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
                  自動挑選
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="pill">已手動調整</span>
                  <button
                    type="button"
                    onClick={onResumeAuto}
                    className="text-xs text-brand underline-offset-2 transition hover:underline"
                  >
                    重新自動挑選
                  </button>
                </span>
              )}
            </div>
            <p className="mb-3 text-xs text-inkFaint">
              {auto
                ? '每個部位取信心最高的白光影格。可從關鍵影格拖曳調整。'
                : '將關鍵影格拖入各部位。'}
            </p>

            <div className="space-y-2.5">
              {BAYS.map(({ key, label }) => {
                const active = dragOver === key
                return (
                  <div
                    key={key}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setDragOver(key)
                    }}
                    onDragLeave={() => setDragOver((c) => (c === key ? null : c))}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDragOver(null)
                      const id = e.dataTransfer.getData('text/plain')
                      if (id) onDropToBin(key, id)
                    }}
                    className={`rounded-xl border-2 border-dashed p-3 transition ${
                      active ? 'border-brand bg-brandTint/50' : 'border-line bg-sunken'
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-display text-sm font-medium text-ink">{label}</span>
                      <span className="font-mono text-[11px] text-inkFaint">{bins[key].length}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {bins[key].map((id) => {
                        const frame = frameById(id)
                        if (!frame) return null
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => onRemoveFromBin(key, id)}
                            title="移除"
                            aria-label={`從 ${label} 移除影格`}
                            className="group relative h-12 w-12 overflow-hidden rounded-lg border border-line"
                          >
                            <img src={frame.url} alt="" className="h-full w-full object-cover" />
                            <span className="absolute inset-0 hidden items-center justify-center bg-ink/70 text-sm text-white group-hover:flex">
                              ✕
                            </span>
                          </button>
                        )
                      })}
                      {bins[key].length === 0 && (
                        <span className="text-xs text-inkFaint">拖曳影格到此</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={onAnalyze}
                disabled={!ready || analyzing}
                className="rounded-xl bg-brand px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brandDeep disabled:cursor-not-allowed disabled:bg-inkFaint"
              >
                {analyzing ? '分析中…' : '執行分析'}
              </button>
              {!ready && <span className="text-xs text-inkFaint">每個部位至少一張影格。</span>}
              {error && <span className="text-xs text-im">{error}</span>}
            </div>

            {result && (
              <div className="animate-fade-up mt-4 well p-4">
                <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="eyebrow">判定</span>
                  <span
                    className="font-display text-2xl font-semibold tracking-tight"
                    style={{ color: positive ? 'var(--im)' : 'var(--ink)' }}
                  >
                    {positive ? '可能為慢性胃炎' : '慢性胃炎可能性低'}
                  </span>
                  <span className="font-mono text-base text-inkSoft">
                    {(result.probability * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="flex gap-3">
                  {[result.img1, result.img2, result.img3].map((b64, i) => (
                    <figure key={i} className="text-center">
                      <img
                        src={`data:image/png;base64,${b64}`}
                        alt={BAYS[i].label}
                        className="h-20 w-20 rounded-lg border border-line object-cover"
                      />
                      <figcaption className="mt-1 font-mono text-[11px] text-inkSoft">
                        {BAYS[i].label.split(' ')[0]}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Report */}
          <ReportCard
            sampledCount={sampledCount}
            analyses={analyses}
            fps={fps}
            live={reportSignal}
            cgiResult={result}
          />
        </div>
      </aside>
    </div>
  )
}
