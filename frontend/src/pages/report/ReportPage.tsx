import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  getFrames,
  getSession,
  subscribeSession,
  type FrameRecord,
  type SessionManifest,
} from '@/protocol'

/**
 * Page 2 — report. THIS IS A SHELL.
 *
 * It demonstrates the one thing the contract requires — subscribe to the
 * session, start work on `ready` — and leaves the report itself empty.
 *
 * Everything below `pages/report/` belongs to whoever builds this page. Import
 * from `@/protocol` only; never from `pages/live/`. See docs/PROTOCOL.md §6.
 */
export default function ReportPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [manifest, setManifest] = useState<SessionManifest | null>(null)
  const [frames, setFrames] = useState<FrameRecord[]>([])
  const [pipelineState, setPipelineState] = useState('waiting for session')

  useEffect(() => {
    if (!sessionId) return

    getSession(sessionId).then(setManifest).catch(() => undefined)

    const unsubscribe = subscribeSession(sessionId, async (event) => {
      if (event.type === 'status') {
        setManifest((current) =>
          current ? { ...current, status: event.status } : current,
        )
        setPipelineState(`session ${event.status}`)
      }

      // The automatic hand-off: page 1 finished scanning, downstream work
      // starts here. Pool selection, CGI, report assembly all go below.
      if (event.type === 'ready') {
        setPipelineState('scan complete, loading per-frame results…')
        const loaded = await getFrames(sessionId)
        setFrames(loaded)
        setPipelineState(`${loaded.length} frames loaded — downstream pipeline not implemented yet`)

        // TODO(page 2): build pools A/B/C from `loaded` (white-light frames,
        // regions antrum / body / cardia), encode them, then call
        // `predictCgi({ pool_A, pool_B, pool_C })`.
      }
    })

    return unsubscribe
  }, [sessionId])

  if (!sessionId) {
    return (
      <main className="grid min-h-screen place-items-center bg-white text-slate-500">
        <p className="text-sm">
          A session id is required: <code className="text-slate-800">/report/&lt;session_id&gt;</code>
        </p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-white text-slate-900">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <header className="flex items-baseline justify-between border-b border-slate-200 pb-4">
          <div>
            <h1 className="text-xl font-medium tracking-tight">Examination Report</h1>
            <p className="mt-1 text-sm text-slate-500">
              {manifest?.video.filename ?? sessionId}
            </p>
          </div>
          <Link
            to={`/live?session=${sessionId}`}
            className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
          >
            ← Live
          </Link>
        </header>

        <section className="mt-8 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8">
          <h2 className="text-sm font-medium text-slate-700">Downstream pipeline</h2>
          <p className="mt-2 text-sm text-slate-500">{pipelineState}</p>

          {frames.length > 0 && (
            <dl className="mt-6 grid grid-cols-3 gap-4 text-sm">
              <Stat label="Frames" value={String(frames.length)} />
              <Stat
                label="White-light"
                value={String(
                  frames.filter((frame) => frame.gns?.modality === 'WL').length,
                )}
              />
              <Stat
                label="IM findings"
                value={String(
                  frames.filter((frame) => (frame.gim?.score ?? 0) >= 1).length,
                )}
              />
            </dl>
          )}

          <p className="mt-8 text-xs leading-relaxed text-slate-400">
            This page is a shell. Report content, CGI pool selection and layout
            are all up to whoever builds page 2; the starting point is the{' '}
            <code>ready</code> branch in <code>subscribeSession</code> above.
            See <code>docs/PROTOCOL.md</code> for the contract.
          </p>
        </section>
      </div>
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-lg font-medium tabular-nums">{value}</dd>
    </div>
  )
}
