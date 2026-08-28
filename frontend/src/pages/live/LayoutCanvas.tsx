import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * A scratch layout mode for agreeing on the page arrangement.
 *
 * Toggle it with Ctrl+L (or `?layout=1`). Blocks become draggable and
 * resizable, the arrangement is kept in localStorage, and "Copy layout" puts
 * the rectangles on the clipboard as percentages of the canvas — percentages
 * rather than pixels so the numbers still mean something at another window
 * size.
 *
 * This is a design tool, not part of the product: with layout mode off the
 * page renders its normal arrangement and none of this is in the way.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type LayoutRects = Record<string, Rect>

const STORAGE_KEY = 'live-layout-draft'

interface LayoutState {
  enabled: boolean
  toggle: () => void
  rects: LayoutRects
  setRect: (id: string, rect: Rect) => void
  reset: () => void
  exportJson: () => string
}

const LayoutContext = createContext<LayoutState | null>(null)

export function useLayoutEditor(defaults: LayoutRects): LayoutState {
  const [enabled, setEnabled] = useState(
    () => new URLSearchParams(window.location.search).get('layout') === '1',
  )
  const [rects, setRects] = useState<LayoutRects>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? { ...defaults, ...JSON.parse(saved) } : defaults
    } catch {
      return defaults
    }
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setEnabled((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setRect = useCallback((id: string, rect: Rect) => {
    setRects((current) => {
      const next = { ...current, [id]: rect }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const reset = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setRects(defaults)
  }, [defaults])

  const exportJson = useCallback(() => JSON.stringify(rects, null, 2), [rects])

  return useMemo(
    () => ({ enabled, toggle: () => setEnabled((v) => !v), rects, setRect, reset, exportJson }),
    [enabled, rects, setRect, reset, exportJson],
  )
}

export function LayoutCanvas({
  layout,
  children,
}: {
  layout: LayoutState
  children: ReactNode
}) {
  const [copied, setCopied] = useState(false)

  if (!layout.enabled) return <>{children}</>

  return (
    <LayoutContext.Provider value={layout}>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {children}

        <div className="pointer-events-auto absolute top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-scope-accent/40 bg-console-bg/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
          <span className="font-medium text-scope-accent">LAYOUT MODE</span>
          <span className="text-console-muted">drag to move · corner to resize</span>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(layout.exportJson())
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            className="rounded bg-scope-accent/20 px-2.5 py-1 text-scope-accent transition hover:bg-scope-accent/30"
          >
            {copied ? 'copied' : 'copy layout'}
          </button>
          <button
            type="button"
            onClick={layout.reset}
            className="rounded bg-console-panel px-2.5 py-1 text-console-muted transition hover:bg-console-line"
          >
            reset
          </button>
          <button
            type="button"
            onClick={layout.toggle}
            className="rounded bg-console-panel px-2.5 py-1 text-console-muted transition hover:bg-console-line"
          >
            exit
          </button>
        </div>
      </div>
    </LayoutContext.Provider>
  )
}

export function LayoutBlock({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: ReactNode
}) {
  const layout = useContext(LayoutContext)
  if (!layout?.enabled) return <>{children}</>

  const rect = layout.rects[id]
  if (!rect) return <>{children}</>

  const drag = (event: React.PointerEvent, mode: 'move' | 'resize') => {
    event.preventDefault()
    event.stopPropagation()
    const canvas = (event.currentTarget as HTMLElement).closest(
      '.relative',
    ) as HTMLElement | null
    if (!canvas) return

    const bounds = canvas.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const start = { ...rect }

    const onMove = (move: PointerEvent) => {
      const dx = ((move.clientX - startX) / bounds.width) * 100
      const dy = ((move.clientY - startY) / bounds.height) * 100
      const round = (value: number) => Math.round(value * 10) / 10

      if (mode === 'move') {
        layout.setRect(id, {
          ...start,
          x: round(Math.max(0, Math.min(100 - start.w, start.x + dx))),
          y: round(Math.max(0, Math.min(100 - start.h, start.y + dy))),
        })
      } else {
        layout.setRect(id, {
          ...start,
          w: round(Math.max(8, Math.min(100 - start.x, start.w + dx))),
          h: round(Math.max(6, Math.min(100 - start.y, start.h + dy))),
        })
      }
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: `${rect.x}%`,
        top: `${rect.y}%`,
        width: `${rect.w}%`,
        height: `${rect.h}%`,
      }}
      className="flex flex-col overflow-hidden rounded-lg outline-2 outline-scope-accent/50 outline-dashed"
    >
      <div
        onPointerDown={(event) => drag(event, 'move')}
        className="flex shrink-0 cursor-move items-center justify-between bg-scope-accent/20 px-2 py-1 text-[11px] text-scope-accent select-none"
      >
        <span>{label}</span>
        <span className="tabular-nums opacity-70">
          {rect.x}, {rect.y} · {rect.w}×{rect.h}
        </span>
      </div>

      {/* A flex column, so children sized with flex-1 still resolve a height
          here the way they do in the page's normal arrangement. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>

      <div
        onPointerDown={(event) => drag(event, 'resize')}
        className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize bg-scope-accent/60"
        style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}
      />
    </div>
  )
}
