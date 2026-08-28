import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  fileUrl,
  getFrames,
  getSession,
  predictCgi,
  REGION_LABEL,
  subscribeSession,
  type FrameRecord,
  type SessionManifest,
} from '@/protocol'

import {
  buildGimEpisodes,
  encodeCgiPools,
  evidenceForPair,
  hasValidGimResult,
  jpegDataUrl,
  selectCgiCandidates,
  selectGimEvidence,
  type CgiEvidence,
} from './reportPipeline'

type CgiState =
  | { status: 'waiting' }
  | { status: 'preparing' }
  | { status: 'running'; poolSizes: [number, number, number] }
  | {
      status: 'ready'
      probability: number
      evidence: CgiEvidence[]
      poolSizes: [number, number, number]
      combinations: number
    }
  | { status: 'unavailable'; message: string }
  | { status: 'error'; message: string }

const INITIAL_CGI_STATE: CgiState = { status: 'waiting' }

/**
 * Page 2 — report.
 *
 * This page owns all downstream policy: it summarises GIM findings, selects
 * small white-light pools for CGI, runs CGI once the scan is ready, and shows
 * the three images used by the highest-scoring combination.
 */
export default function ReportPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [manifest, setManifest] = useState<SessionManifest | null>(null)
  const [frames, setFrames] = useState<FrameRecord[]>([])
  const [pipelineState, setPipelineState] = useState('Waiting for session')
  const [pageError, setPageError] = useState<string | null>(null)
  const [cgi, setCgi] = useState<CgiState>(INITIAL_CGI_STATE)

  // React StrictMode reconnects effects during development. This guard keeps a
  // replayed ready event from running the expensive CGI pipeline twice.
  const processingSession = useRef<string | null>(null)
  const activeSession = useRef(sessionId)
  activeSession.current = sessionId

  useEffect(() => {
    if (!sessionId) return

    const id = sessionId
    setManifest(null)
    setFrames([])
    setCgi(INITIAL_CGI_STATE)
    setPageError(null)
    setPipelineState('Loading session')

    async function buildReport() {
      if (processingSession.current === id) return
      processingSession.current = id

      try {
        setPipelineState('Scan complete — loading frame results')
        const loaded = await getFrames(id)
        if (activeSession.current !== id) return
        setFrames(loaded)

        const candidateFrames = {
          antrum: selectCgiCandidates(loaded, 'antrum'),
          body: selectCgiCandidates(loaded, 'body'),
          cardia: selectCgiCandidates(loaded, 'cardia'),
        }
        const missing = Object.entries(candidateFrames)
          .filter(([, items]) => items.length === 0)
          .map(([region]) => region)

        if (missing.length > 0) {
          setCgi({
            status: 'unavailable',
            message: `No white-light candidate for: ${missing.join(', ')}`,
          })
          setPipelineState('Report ready — CGI could not be evaluated')
          return
        }

        setCgi({ status: 'preparing' })
        setPipelineState('Preparing CGI candidate frames')
        const pools = await encodeCgiPools(loaded)
        if (activeSession.current !== id) return

        const qualityMissing = (['antrum', 'body', 'cardia'] as const).filter(
          (region) => pools[region].length === 0,
        )
        if (qualityMissing.length > 0) {
          setCgi({
            status: 'unavailable',
            message: `No quality-approved white-light candidate for: ${qualityMissing.join(', ')}`,
          })
          setPipelineState('Report ready — CGI image-quality gate was not satisfied')
          return
        }

        const poolSizes: [number, number, number] = [
          pools.antrum.length,
          pools.body.length,
          pools.cardia.length,
        ]
        setCgi({ status: 'running', poolSizes })
        setPipelineState('Running CGI analysis')

        const pairs = await predictCgi({
          pool_A: pools.antrum.map((item) => item.base64),
          pool_B: pools.body.map((item) => item.base64),
          pool_C: pools.cardia.map((item) => item.base64),
        })
        if (activeSession.current !== id) return

        const best = pairs[0]
        if (!best) {
          setCgi({
            status: 'unavailable',
            message: 'CGI returned no image combinations.',
          })
          setPipelineState('Report ready — CGI returned no result')
          return
        }

        setCgi({
          status: 'ready',
          probability: best.probability,
          evidence: evidenceForPair(best, pools),
          poolSizes,
          combinations: poolSizes.reduce((total, size) => total * size, 1),
        })
        setPipelineState('Report ready')
      } catch (cause) {
        if (activeSession.current !== id) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setCgi({ status: 'error', message })
        setPipelineState('GIM results loaded — CGI analysis failed')
      }
    }

    getSession(id)
      .then((next) => {
        if (activeSession.current !== id) return
        setManifest(next)
        if (next.status === 'ready') void buildReport()
        if (next.status === 'failed') {
          setPageError(next.error ?? 'Session processing failed')
        }
      })
      .catch((cause) => {
        if (activeSession.current === id) setPageError(String(cause))
      })

    const unsubscribe = subscribeSession(id, (event) => {
      if (activeSession.current !== id) return

      if (event.type === 'progress') {
        setManifest((current) =>
          current ? { ...current, progress: event.progress } : current,
        )
      } else if (event.type === 'status') {
        setManifest((current) =>
          current
            ? { ...current, status: event.status, error: event.error }
            : current,
        )
        setPipelineState(`Session ${event.status}`)
        if (event.status === 'failed') {
          setPageError(event.error ?? 'Session processing failed')
        }
      } else if (event.type === 'ready') {
        setManifest((current) =>
          current
            ? { ...current, status: 'ready', frame_count: event.frame_count }
            : current,
        )
        void buildReport()
      }
    })

    return unsubscribe
  }, [sessionId])

  const summary = useMemo(() => {
    const gimEvaluated = frames.filter(hasValidGimResult)
    const gimEpisodes = buildGimEpisodes(frames)
    const consensusFrames = gimEpisodes.flatMap((episode) => episode.frames)
    return {
      whiteLight: frames.filter((frame) => frame.gns?.modality === 'WL').length,
      gimEvaluated: gimEvaluated.length,
      gimEpisodes,
      consensusFrames,
      maxScore: Math.max(0, ...consensusFrames.map((frame) => frame.gim?.score ?? 0)),
      maxArea: Math.max(0, ...consensusFrames.map((frame) => frame.gim?.area ?? 0)),
      gimEvidence: selectGimEvidence(gimEpisodes),
    }
  }, [frames])

  if (!sessionId) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-50 text-slate-500">
        <p className="text-sm">
          A session id is required:{' '}
          <code className="text-slate-800">/report/&lt;session_id&gt;</code>
        </p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl px-6 py-8 lg:px-10">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-5">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">Examination Report</h1>
              {manifest && <StatusChip status={manifest.status} />}
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {manifest?.video.filename ?? sessionId}
            </p>
          </div>

          <Link
            to={`/live?session=${sessionId}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
          >
            ← Live review
          </Link>
        </header>

        {pageError && (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
            {pageError}
          </div>
        )}

        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-800">Analysis status</h2>
              <p className="mt-1 text-sm text-slate-500">{pipelineState}</p>
            </div>
            {manifest && manifest.status !== 'ready' && (
              <ScanProgress manifest={manifest} />
            )}
          </div>
        </section>

        {frames.length > 0 && (
          <>
            <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard label="Analysed frames" value={String(frames.length)} />
              <SummaryCard label="White-light frames" value={String(summary.whiteLight)} />
              <SummaryCard label="NBI frames evaluated" value={String(summary.gimEvaluated)} />
              <SummaryCard
                label="GIM-positive episodes"
                value={String(summary.gimEpisodes.length)}
                accent={summary.gimEpisodes.length > 0}
              />
            </section>

            <GimSection
              episodeCount={summary.gimEpisodes.length}
              consensusFrameCount={summary.consensusFrames.length}
              maxScore={summary.maxScore}
              maxArea={summary.maxArea}
              evidence={summary.gimEvidence}
            />

            <CgiSection state={cgi} />
          </>
        )}
      </div>
    </main>
  )
}

function StatusChip({ status }: { status: SessionManifest['status'] }) {
  const tone =
    status === 'ready'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : status === 'failed'
        ? 'bg-red-50 text-red-700 ring-red-200'
        : 'bg-amber-50 text-amber-700 ring-amber-200'

  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${tone}`}>
      {status}
    </span>
  )
}

function ScanProgress({ manifest }: { manifest: SessionManifest }) {
  const stages = [
    { label: 'Extract', value: manifest.progress.extract },
    { label: 'GNS', value: manifest.progress.gns },
    { label: 'GIM', value: manifest.progress.gim },
  ]

  return (
    <div className="flex flex-wrap gap-3">
      {stages.map((stage) => (
        <div key={stage.label} className="w-24">
          <div className="mb-1 flex justify-between text-[11px] text-slate-500">
            <span>{stage.label}</span>
            <span>{Math.round(stage.value * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-sky-500 transition-all"
              style={{ width: `${stage.value * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function SummaryCard({
  label,
  value,
  accent = false,
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div
      className={`rounded-xl border bg-white p-5 shadow-sm ${
        accent ? 'border-purple-200' : 'border-slate-200'
      }`}
    >
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
        {label}
      </p>
      <p className={`mt-2 text-3xl font-semibold ${accent ? 'text-purple-700' : ''}`}>
        {value}
      </p>
    </div>
  )
}

function GimSection({
  episodeCount,
  consensusFrameCount,
  maxScore,
  maxArea,
  evidence,
}: {
  episodeCount: number
  consensusFrameCount: number
  maxScore: number
  maxArea: number
  evidence: FrameRecord[]
}) {
  const [expandedFrame, setExpandedFrame] = useState<FrameRecord | null>(null)

  return (
    <>
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-widest text-purple-600 uppercase">
              GIM
            </p>
            <h2 className="mt-1 text-xl font-semibold">Intestinal metaplasia findings</h2>
            <p className="mt-1 text-sm text-slate-500">
              NBI-only results confirmed when at least 2 of 3 consecutive
              same-region frames are positive within 1 second.
            </p>
          </div>

          <div className="flex gap-6 text-right">
            <Metric label="Positive episodes" value={String(episodeCount)} />
            <Metric label="Consensus frames" value={String(consensusFrameCount)} />
            <Metric label="Maximum score" value={String(maxScore)} />
            <Metric label="Maximum area" value={`${maxArea.toFixed(1)}%`} />
          </div>
        </div>

        {evidence.length > 0 ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {evidence.map((frame) => (
              <GimEvidenceCard
                key={frame.index}
                frame={frame}
                onExpand={() => setExpandedFrame(frame)}
              />
            ))}
          </div>
        ) : (
          <div className="mt-6 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-center text-sm text-slate-500">
            No GIM finding satisfied the 2-of-3 temporal consensus rule.
          </div>
        )}
      </section>

      {expandedFrame && (
        <GimImageDialog
          frame={expandedFrame}
          onClose={() => setExpandedFrame(null)}
        />
      )}
    </>
  )
}

function GimEvidenceCard({
  frame,
  onExpand,
}: {
  frame: FrameRecord
  onExpand: () => void
}) {
  const region = frame.gns?.region ?? 'unknown'

  return (
    <figure className="overflow-hidden rounded-lg border border-slate-200 bg-slate-950">
      <button
        type="button"
        onClick={onExpand}
        aria-label={`Expand GIM finding at ${formatTime(frame.t)}`}
        className="group relative block aspect-[1000/871] w-full cursor-zoom-in overflow-hidden text-left"
      >
        <img
          src={fileUrl(frame.image_url)}
          alt={`GIM finding at ${formatTime(frame.t)}`}
          className="absolute inset-0 h-full w-full object-cover transition group-hover:brightness-110"
          loading="lazy"
        />
        {frame.gim?.mask_url && (
          <img
            src={fileUrl(frame.gim.mask_url)}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            loading="lazy"
          />
        )}
        <span className="absolute top-2 left-2 rounded-md bg-slate-950/80 px-2.5 py-1 text-xs font-medium text-white shadow-sm backdrop-blur-sm">
          {REGION_LABEL[region]}
        </span>
        <span className="absolute right-2 bottom-2 rounded-md bg-slate-950/80 px-2.5 py-1 text-xs font-medium text-white opacity-0 shadow-sm backdrop-blur-sm transition group-hover:opacity-100">
          Expand
        </span>
      </button>
      <figcaption className="flex items-center justify-between bg-white px-3 py-2 text-xs">
        <span className="text-slate-500">
          {REGION_LABEL[region]} · {formatTime(frame.t)}
        </span>
        <span className="font-medium text-purple-700">
          Score {frame.gim?.score} · {frame.gim?.area.toFixed(1)}%
        </span>
      </figcaption>
    </figure>
  )
}

function GimImageDialog({
  frame,
  onClose,
}: {
  frame: FrameRecord
  onClose: () => void
}) {
  const region = frame.gns?.region ?? 'unknown'

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`GIM finding at ${formatTime(frame.t)}`}
      className="fixed inset-0 z-50 bg-slate-950/95 p-4 backdrop-blur-sm sm:p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="relative h-full w-full">
        <img
          src={fileUrl(frame.image_url)}
          alt={`GIM finding at ${formatTime(frame.t)}`}
          className="absolute inset-0 h-full w-full object-contain"
        />
        {frame.gim?.mask_url && (
          <img
            src={fileUrl(frame.gim.mask_url)}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        )}

        <div className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 rounded-lg bg-slate-950/85 px-4 py-2 text-center text-sm text-white shadow-lg backdrop-blur-sm">
          {REGION_LABEL[region]} · {formatTime(frame.t)} · Score {frame.gim?.score} ·{' '}
          {frame.gim?.area.toFixed(1)}%
        </div>
        <button
          type="button"
          onClick={onClose}
          className="absolute top-0 right-0 rounded-lg border border-white/20 bg-slate-950/80 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          Close
        </button>
      </div>
    </div>
  )
}

function CgiSection({ state }: { state: CgiState }) {
  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-widest text-sky-600 uppercase">
            CGI
          </p>
          <h2 className="mt-1 text-xl font-semibold">Corpus-predominant gastritis</h2>
          <p className="mt-1 text-sm text-slate-500">
            Highest-scoring antrum × body × upper-corpus white-light combination.
          </p>
        </div>
      </div>

      {state.status === 'waiting' && (
        <CgiMessage>Waiting for the full scan to finish.</CgiMessage>
      )}
      {state.status === 'preparing' && (
        <CgiMessage>Loading and encoding candidate frames…</CgiMessage>
      )}
      {state.status === 'running' && (
        <CgiMessage>
          Evaluating {state.poolSizes[0]} × {state.poolSizes[1]} ×{' '}
          {state.poolSizes[2]} candidate frames…
        </CgiMessage>
      )}
      {state.status === 'unavailable' && (
        <CgiMessage tone="warning">{state.message}</CgiMessage>
      )}
      {state.status === 'error' && (
        <CgiMessage tone="error">{state.message}</CgiMessage>
      )}
      {state.status === 'ready' && (
        <>
          <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div>
              <div className="flex items-end gap-3">
                <span className="text-5xl font-semibold tracking-tight text-sky-700">
                  {(state.probability * 100).toFixed(1)}%
                </span>
                <span className="pb-1 text-sm text-slate-500">model probability</span>
              </div>
              <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-sky-500"
                  style={{ width: `${Math.max(0, Math.min(1, state.probability)) * 100}%` }}
                />
              </div>
            </div>
            <p className="text-sm text-slate-500 md:text-right">
              Pools {state.poolSizes.join(' / ')}
              <br />
              {state.combinations} combinations evaluated
            </p>
          </div>

          <CgiEvidenceGrid evidence={state.evidence} />
        </>
      )}

      <p className="mt-5 text-xs leading-relaxed text-slate-400">
        Model output is decision support and must be interpreted with the full
        examination by a qualified clinician.
      </p>
    </section>
  )
}

function CgiMessage({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'warning' | 'error'
}) {
  const style =
    tone === 'error'
      ? 'border-red-200 bg-red-50 text-red-700'
      : tone === 'warning'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-slate-200 bg-slate-50 text-slate-500'
  return <div className={`mt-6 rounded-lg border px-5 py-6 text-sm ${style}`}>{children}</div>
}

function CgiEvidenceGrid({ evidence }: { evidence: CgiEvidence[] }) {
  const label = {
    antrum: 'Antrum (A)',
    body: 'Body (B)',
    cardia: 'Upper corpus (C)',
  }

  return (
    <div className="mt-7">
      <h3 className="text-sm font-semibold text-slate-800">
        Selected white-light frames
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Highest-scoring antrum / body / upper-corpus combination used for this result.
      </p>
      <div className="mt-4 grid gap-5 md:grid-cols-3">
        {evidence.map((item) => (
          <figure
            key={item.region}
            className="overflow-hidden rounded-xl border border-slate-200"
          >
            <img
              src={jpegDataUrl(item.base64)}
              alt={label[item.region]}
              className="aspect-[1000/871] w-full bg-slate-950 object-cover"
            />
            <figcaption className="p-4">
              <p className="font-medium text-slate-900">{label[item.region]}</p>
              {item.frame ? (
                <>
                  <p className="mt-1 text-sm text-slate-500">
                    {formatTime(item.frame.t)} · GNS confidence{' '}
                    {(item.frame.gns!.confidence * 100).toFixed(1)}%
                  </p>
                  {item.quality && (
                    <p className="mt-1 text-xs text-emerald-700">
                      Quality passed · brightness {item.quality.meanLuminance.toFixed(0)} ·
                      sharpness {item.quality.sharpness.toFixed(0)}
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-1 text-sm text-slate-500">Timestamp unavailable</p>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}
