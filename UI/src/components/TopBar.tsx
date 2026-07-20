import { useEffect, useState } from 'react'
import { getHealth } from '../api/gateway'

type Health = { gns: boolean; gim: boolean; cgi: boolean }
type DotState = boolean | null

const SERVICES: { key: keyof Health; label: string; role: string }[] = [
  { key: 'gns', label: 'GNS', role: '部位與影像模式分類' },
  { key: 'gim', label: 'GIM', role: '腸上皮化生分割' },
  { key: 'cgi', label: 'CGI', role: '慢性胃炎判讀' },
]

function dotColor(state: DotState): string {
  if (state === null) return 'var(--ink-faint)'
  return state ? 'var(--ok)' : 'var(--im)'
}

export function TopBar() {
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const h = await getHealth()
        if (alive) setHealth(h)
      } catch {
        if (alive) setHealth({ gns: false, gim: false, cgi: false })
      }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface/80 px-5 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        {/* Aperture mark — the endoscope lens, the emblem of this whole tool. */}
        <span className="relative flex h-8 w-8 items-center justify-center" aria-hidden>
          <span className="absolute inset-0 rounded-full border-2 border-brand" />
          <span className="absolute inset-[5px] rounded-full border border-brand/40" />
          <span className="h-1.5 w-1.5 rounded-full bg-brand" />
        </span>
        <div className="leading-tight">
          <h1 className="font-display text-[15px] font-semibold tracking-tight text-ink">
            上消化道內視鏡檢查系統
          </h1>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-inkFaint">
            Real-time AI assist · GNS · GIM · CGI
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2" aria-label="模型服務狀態" aria-live="polite">
        {SERVICES.map(({ key, label, role }) => {
          const state: DotState = health ? health[key] : null
          const word = state === null ? '檢查中' : state ? '上線' : '離線'
          return (
            <span key={key} className="pill" title={`${label} · ${role} — ${word}`}>
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{
                  backgroundColor: dotColor(state),
                  boxShadow: state ? `0 0 0 3px ${dotColor(state)}22` : 'none',
                }}
                aria-hidden
              />
              <span className="font-medium text-ink">{label}</span>
            </span>
          )
        })}
      </div>
    </header>
  )
}
