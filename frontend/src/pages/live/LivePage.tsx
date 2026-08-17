import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { frameAt, gimFrameAt, type RegionId } from '@/protocol'

import { LayoutBlock, LayoutCanvas, useLayoutEditor } from './LayoutCanvas'
import ScopeStage from './ScopeStage'
import SessionPicker from './SessionPicker'
import SidePanel from './SidePanel'
import Timeline from './Timeline'
import { useLiveAnalysis } from './useLiveAnalysis'
import { useSession } from './useSession'

/**
 * Page 1 — live review.
 *
 * Plays the source video at full rate and drives every readout off
 * `video.currentTime`: the analysis runs at its own sampling rates, so the
 * frame on screen and the frame that was analysed are matched by time, never
 * by index.
 */
export default function LivePage() {
  const [params, setParams] = useSearchParams()
  const sessionId = params.get('session')

  const videoRef = useRef<HTMLVideoElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [showMask, setShowMask] = useState(true)

  const { manifest, frames, error } = useSession(sessionId)

  // requestAnimationFrame rather than the timeupdate event: timeupdate fires
  // about four times a second, which is visibly behind the video.
  useEffect(() => {
    let handle = 0
    const tick = () => {
      const video = videoRef.current
      if (video) setCurrentTime(video.currentTime)
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [])

  // On-demand analysis of the current timestamp, for wherever the background
  // scan has not reached yet.
  const live = useLiveAnalysis(sessionId, videoRef, frames, manifest !== null)

  const cached = useMemo(() => frameAt(frames, currentTime), [frames, currentTime])
  const frame = live.frame ?? cached
  const cachedMask = useMemo(
    () => gimFrameAt(frames, currentTime),
    [frames, currentTime],
  )
  const maskFrame = live.frame?.gim ? live.frame : cachedMask

  // Regions seen so far, so the map can double as a coverage checklist.
  const visited = useMemo(() => {
    const seen = new Set<RegionId>()
    for (const item of frames) {
      if (item.t > currentTime) break
      if (item.gns) seen.add(item.gns.region)
    }
    return seen
  }, [frames, currentTime])

  const layout = useLayoutEditor(DEFAULT_LAYOUT)

  if (!sessionId) {
    return (
      <main className="min-h-screen bg-console-bg text-console-text">
        <SessionPicker onOpen={(id) => setParams({ session: id })} />
      </main>
    )
  }

  if (error) {
    return (
      <main className="grid min-h-screen place-items-center bg-console-bg text-scope-alert">
        {error}
      </main>
    )
  }

  if (!manifest) {
    return (
      <main className="grid min-h-screen place-items-center bg-console-bg text-console-muted">
        Loading…
      </main>
    )
  }

  const isNbi = frame?.gns?.modality === 'NBI'
  const scanning = manifest.status !== 'ready'

  function togglePlay() {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.play()
      setPlaying(true)
    } else {
      video.pause()
      setPlaying(false)
    }
  }

  function seek(time: number) {
    const video = videoRef.current
    if (video) video.currentTime = time
  }

  return (
    <main className="flex h-screen flex-col bg-console-bg text-console-text">
      <header className="flex shrink-0 items-center justify-between border-b border-console-line px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-medium">{manifest.video.filename}</h1>
          <span className="text-sm text-console-muted">
            {manifest.frame_count} frames · {manifest.video.fps.toFixed(0)} fps source
          </span>
        </div>

        <div className="flex items-center gap-4">
          {scanning && <ScanProgress manifest={manifest} />}
          {manifest.status === 'ready' && (
            <span className="text-sm text-emerald-400">Scan complete</span>
          )}
          <Link
            to={`/report/${manifest.session_id}`}
            className="rounded border border-console-line px-3 py-1.5 text-sm text-console-muted transition hover:border-console-muted hover:text-console-text"
          >
            Report →
          </Link>
        </div>
      </header>

      {/* Grid rather than flex: minmax(0, …fr) holds the 2:1 exactly, where flex
          basis still yields to the panel's content minimum. */}
      <LayoutCanvas layout={layout}>
      <div
        style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}
        className="grid min-h-0 flex-1"
      >
        <div className="flex min-w-0 flex-col gap-3 p-4">
          <LayoutBlock id="stage" label="Video">
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <ScopeStage
              manifest={manifest}
              videoRef={videoRef}
              frame={frame}
              maskFrame={maskFrame}
              showMask={showMask}
            />
          </div>
          </LayoutBlock>

          <LayoutBlock id="timeline" label="Timeline">
          <Timeline
            frames={frames}
            duration={manifest.video.duration_s}
            currentTime={currentTime}
            onSeek={seek}
          />
          </LayoutBlock>

          <LayoutBlock id="controls" label="Controls">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              className="rounded bg-console-panel px-5 py-2 text-sm transition hover:bg-console-line"
            >
              {playing ? 'Pause' : 'Play'}
            </button>

            <button
              type="button"
              onClick={() => setShowMask((value) => !value)}
              disabled={!isNbi}
              title={isNbi ? undefined : 'GIM is only valid on NBI imaging'}
              className={`rounded px-5 py-2 text-sm transition ${
                !isNbi
                  ? 'cursor-not-allowed bg-console-panel/50 text-console-muted/50'
                  : showMask
                    ? 'bg-im/20 text-im ring-1 ring-im/60'
                    : 'bg-console-panel text-console-muted hover:bg-console-line'
              }`}
            >
              IM overlay {showMask ? 'on' : 'off'}
              {!isNbi && <span className="ml-1.5 text-xs">(NBI only)</span>}
            </button>

            {live.active && (
              <span className="flex items-center gap-2 rounded bg-scope-accent/10 px-3 py-1.5 text-sm text-scope-accent ring-1 ring-scope-accent/40">
                <span className="h-2 w-2 animate-pulse rounded-full bg-scope-accent" />
                LIVE
                {live.latencyMs !== null && (
                  <span className="text-console-muted">{live.latencyMs} ms</span>
                )}
              </span>
            )}

            <span className="ml-auto text-sm text-console-muted">
              {maskFrame?.gim
                ? `overlay from t=${maskFrame.t.toFixed(2)}s`
                : isNbi
                  ? 'no IM finding at this timestamp'
                  : 'white-light imaging'}
            </span>
          </div>
          </LayoutBlock>
        </div>

        <LayoutBlock id="site" label="Site panel">
          <SidePanel frame={frame} visited={visited} />
        </LayoutBlock>
      </div>
      </LayoutCanvas>
    </main>
  )
}

/**
 * Starting arrangement for layout mode, as percentages of the canvas — the
 * current production layout, so dragging starts from what is on screen.
 */
const DEFAULT_LAYOUT = {
  stage: { x: 0, y: 0, w: 66, h: 78 },
  timeline: { x: 0, y: 78, w: 66, h: 10 },
  controls: { x: 0, y: 88, w: 66, h: 12 },
  site: { x: 66, y: 0, w: 34, h: 100 },
}

function ScanProgress({ manifest }: { manifest: import('@/protocol').SessionManifest }) {
  const stages = [
    { label: 'Extract', value: manifest.progress.extract },
    { label: 'GNS', value: manifest.progress.gns },
    { label: 'GIM', value: manifest.progress.gim },
  ]
  return (
    <div className="flex items-center gap-3">
      {stages.map((stage) => (
        <span key={stage.label} className="flex items-center gap-1.5 text-sm">
          <span className="text-console-muted">{stage.label}</span>
          <span className="h-1 w-14 overflow-hidden rounded-full bg-console-line">
            <span
              className="block h-full bg-scope-accent transition-all"
              style={{ width: `${stage.value * 100}%` }}
            />
          </span>
        </span>
      ))}
    </div>
  )
}
