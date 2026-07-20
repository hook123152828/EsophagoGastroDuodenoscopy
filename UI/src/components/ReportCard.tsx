import type { CgiPair } from '../types'
import type { FrameAnalysis } from '../hooks/useFrameAnalysis'
import type { SmoothedSignal } from '../lib/smoothing'
import { formatTimestamp } from '../lib/frameExtractor'

interface Props {
  sampledCount: number
  analyses: Record<string, FrameAnalysis>
  fps: number
  live: SmoothedSignal
  cgiResult: CgiPair | null
}

function Row({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="whitespace-nowrap text-inkSoft">{label}</span>
      <span className="min-w-0 flex-1 translate-y-[-3px] border-b border-dotted border-line" />
      <span className={`whitespace-nowrap font-mono font-medium ${alert ? 'text-im' : 'text-ink'}`}>
        {value}
      </span>
    </div>
  )
}

export function ReportCard({ sampledCount, analyses, fps, live, cgiResult }: Props) {
  const done = Object.values(analyses).filter((a) => a.status === 'done')
  const dist: Record<string, number> = {}
  for (const a of done) {
    if (a.gns) dist[a.gns.class_name] = (dist[a.gns.class_name] ?? 0) + 1
  }
  const distEntries = Object.entries(dist).sort((a, b) => b[1] - a[1])

  return (
    <div className="well p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-sm font-semibold text-ink">檢查報告</h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-inkFaint">
          AI-assisted · 醫師確認
        </span>
      </div>

      {sampledCount === 0 ? (
        <p className="font-mono text-xs text-inkFaint">尚無資料,載入影片後產生報告。</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Row label="取樣影格" value={String(sampledCount)} />
            <Row label="已分析" value={String(done.length)} />
            <Row label="取樣率" value={`${fps} fps`} />
          </div>

          <div>
            <p className="mb-1.5 eyebrow">腸上皮化生</p>
            <div className="space-y-1.5">
              {live.imPeakScore >= 1 ? (
                <>
                  <Row
                    label="判定"
                    value={`偵測到 · score ${live.imPeakScore}`}
                    alert={live.imPeakScore === 2}
                  />
                  <Row
                    label="峰值面積"
                    value={`${live.imPeakArea}%${
                      live.imPeakAt !== null ? ` @ ${formatTimestamp(live.imPeakAt)}` : ''
                    }`}
                  />
                  <Row label="確認影格" value={String(live.imFlaggedCount)} />
                </>
              ) : (
                <Row label="判定" value="未偵測到" />
              )}
            </div>
          </div>

          <div>
            <p className="mb-1.5 eyebrow">GNS 部位分佈</p>
            {distEntries.length === 0 ? (
              <p className="font-mono text-xs text-inkFaint">尚無分類影格。</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs text-ink">
                {distEntries.map(([cls, n]) => (
                  <div key={cls} className="flex justify-between">
                    <span className="text-inkSoft">{cls}</span>
                    <span className="font-medium">{n}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-line pt-3">
            <Row
              label="慢性胃炎 (CGI)"
              value={
                cgiResult
                  ? `${cgiResult.probability > 0.5 ? '可能' : '不太可能'} · ${(
                      cgiResult.probability * 100
                    ).toFixed(1)}%`
                  : '尚未執行'
              }
              alert={cgiResult ? cgiResult.probability > 0.5 : false}
            />
          </div>
        </div>
      )}
    </div>
  )
}
