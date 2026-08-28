import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import {
  buildRegionTrack,
  frameAt,
  gimFrameAt,
  polypFrameAt,
  seenRegions,
  trackRegionAt,
  GIM_REGIONS,
  POLYP_REGIONS,
} from '@/protocol'

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
  // Off by default, unlike the IM overlay: detection plus MedSAM is an order of
  // magnitude dearer per frame, so it runs only once someone asks to see it.
  const [showPolyp, setShowPolyp] = useState(false)

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
  const live = useLiveAnalysis(
    sessionId,
    videoRef,
    frames,
    manifest !== null,
    showPolyp,
  )

  const cached = useMemo(() => frameAt(frames, currentTime), [frames, currentTime])
  const frame = live.frame ?? cached
  const cachedMask = useMemo(
    () => gimFrameAt(frames, currentTime),
    [frames, currentTime],
  )
  const maskFrame = live.frame?.gim ? live.frame : cachedMask

  const cachedPolyp = useMemo(
    () => polypFrameAt(frames, currentTime),
    [frames, currentTime],
  )
  const polypFrame = live.frame?.polyp ? live.frame : cachedPolyp

  // Per-frame GNS output flickers between neighbouring sites; the track is the
  // smoothed version of it, and everything that names a site reads from there.
  const track = useMemo(() => buildRegionTrack(frames), [frames])
  const region = trackRegionAt(track, currentTime)

  // Regions watched for long enough to count as examined, so the map and the
  // checklist report coverage rather than a glimpse.
  const visited = useMemo(() => seenRegions(track, currentTime), [track, currentTime])

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

  // GIM is a gastric NBI model, so the overlay is offered nowhere else. The
  // site comes from the smoothed track rather than the frame, so a single
  // stray classification cannot blink the overlay off mid-examination.
  const imEligible =
    frame?.gns?.modality === 'NBI' && GIM_REGIONS.includes(region)
  // The detector was fine-tuned on white-light stomach, so the overlay is
  // offered there and nowhere else — the mirror of the IM rule.
  const polypEligible =
    frame?.gns?.modality === 'WL' && POLYP_REGIONS.includes(region)
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

      {/* Three columns, with the video column split into stage and timeline.
          minmax(0, …fr) rather than plain fr: a track's content minimum would
          otherwise push the proportions off. */}
      <LayoutCanvas layout={layout}>
      <div
        style={{
          gridTemplateColumns:
            'minmax(0, 47.5fr) minmax(0, 18.5fr) minmax(0, 34fr)',
        }}
        className="grid min-h-0 flex-1"
      >
        <div
          style={{ gridTemplateRows: 'minmax(0, 91.5fr) minmax(0, 8.5fr)' }}
          className="grid min-w-0 gap-3 p-4"
        >
          <LayoutBlock id="stage" label="Video">
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <ScopeStage
                manifest={manifest}
                videoRef={videoRef}
                frame={frame}
                region={region}
                maskFrame={maskFrame}
                showMask={showMask && imEligible}
                polypFrame={polypFrame}
                showPolyp={showPolyp && polypEligible}
              />
            </div>
          </LayoutBlock>

          <LayoutBlock id="timeline" label="Timeline">
            <div className="flex min-h-0 flex-1 flex-col justify-center">
              <Timeline
                track={track}
                frames={frames}
                currentTime={currentTime}
                onSeek={seek}
              />
            </div>
          </LayoutBlock>
        </div>

        <LayoutBlock id="controls" label="Controls">
          <div className="flex min-w-0 flex-col gap-3 overflow-y-auto border-l border-console-line p-4">
            <button
              type="button"
              onClick={togglePlay}
              className="rounded bg-console-panel px-5 py-2.5 text-sm transition hover:bg-console-line"
            >
              {playing ? 'Pause' : 'Play'}
            </button>

            <button
              type="button"
              onClick={() => setShowMask((value) => !value)}
              disabled={!imEligible}
              title={
                imEligible
                  ? undefined
                  : 'GIM is only valid on gastric mucosa under NBI'
              }
              className={`rounded px-5 py-2.5 text-sm transition ${
                !imEligible
                  ? 'cursor-not-allowed bg-console-panel/50 text-console-muted/50'
                  : showMask
                    ? 'bg-im/20 text-im ring-1 ring-im/60'
                    : 'bg-console-panel text-console-muted hover:bg-console-line'
              }`}
            >
              IM overlay {showMask ? 'on' : 'off'}
              {!imEligible && (
                <span className="ml-1.5 text-xs">(gastric NBI only)</span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setShowPolyp((value) => !value)}
              disabled={!polypEligible}
              title={
                polypEligible
                  ? undefined
                  : 'The polyp detector is only valid on gastric mucosa under white light'
              }
              className={`rounded px-5 py-2.5 text-sm transition ${
                !polypEligible
                  ? 'cursor-not-allowed bg-console-panel/50 text-console-muted/50'
                  : showPolyp
                    ? 'bg-polyp/20 text-polyp ring-1 ring-polyp/60'
                    : 'bg-console-panel text-console-muted hover:bg-console-line'
              }`}
            >
              Polyp overlay {showPolyp ? 'on' : 'off'}
              {!polypEligible && (
                <span className="ml-1.5 text-xs">(gastric WL only)</span>
              )}
            </button>

            {live.active && (
              <span className="flex items-center gap-2 rounded bg-scope-accent/10 px-3 py-2 text-sm text-scope-accent ring-1 ring-scope-accent/40">
                <span className="h-2 w-2 animate-pulse rounded-full bg-scope-accent" />
                LIVE
                {live.latencyMs !== null && (
                  <span className="ml-auto text-console-muted">
                    {live.latencyMs} ms
                  </span>
                )}
              </span>
            )}

            <p className="text-sm leading-relaxed text-console-muted">
              {!imEligible
                ? frame?.gns?.modality === 'NBI'
                  ? 'IM is assessed on gastric mucosa only'
                  : 'white-light imaging'
                : maskFrame?.gim?.mask_url
                  ? `overlay from t=${maskFrame.t.toFixed(2)}s`
                  : frame?.gim
                    ? 'no IM finding at this timestamp'
                    : 'IM scan has not reached this frame'}
            </p>

            {showPolyp && polypEligible && (
              <p className="text-sm leading-relaxed text-console-muted">
                {polypFrame?.polyp?.mask_url
                  ? `${polypFrame.polyp.boxes.length} detected at t=${polypFrame.t.toFixed(2)}s`
                  : frame?.polyp
                    ? 'no polyp at this timestamp'
                    : 'detecting…'}
              </p>
            )}
          </div>
        </LayoutBlock>

        <LayoutBlock id="site" label="Site panel">
          <SidePanel region={region} visited={visited} />
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
  stage: { x: 0, y: 0, w: 47.5, h: 91.5 },
  timeline: { x: 0, y: 91.5, w: 47.5, h: 8.5 },
  controls: { x: 47.5, y: 0, w: 18.5, h: 100 },
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
