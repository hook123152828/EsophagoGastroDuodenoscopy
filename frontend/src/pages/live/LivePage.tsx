import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import {
  buildModalityTrack,
  buildRegionTrack,
  frameAt,
  gimFrameAt,
  polypFrameAt,
  seenRegions,
  trackModalityAt,
  trackRegionAt,
  GIM_REGIONS,
  POLYP_REGIONS,
} from '@/protocol'

import { LayoutBlock, LayoutCanvas, useLayoutEditor } from './LayoutCanvas'
import RegionChecklist from './RegionChecklist'
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

  // The overlays are driven from the keyboard: during a procedure the
  // endoscopist has one hand on the scope, and reaching for a mouse to turn a
  // readout on is a hand they do not have. The buttons stay clickable, but
  // they are the readout of the state rather than the way to reach it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) {
        return
      }

      const key = event.key.toLowerCase()
      if (key === OVERLAY_KEYS.im) {
        event.preventDefault()
        setShowMask((value) => !value)
      } else if (key === OVERLAY_KEYS.polyp) {
        event.preventDefault()
        setShowPolyp((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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

  // The light is smoothed for the same reason the site is, and it matters for
  // the same decision: whether a model applies to what is on screen. Read off
  // the frame it changes 88 times a minute, which blinks the overlay on and
  // off around a scope that has not gone anywhere.
  const modalityTrack = useMemo(() => buildModalityTrack(frames), [frames])
  const modality = trackModalityAt(modalityTrack, currentTime)

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
  const imEligible = modality === 'NBI' && GIM_REGIONS.includes(region)
  // The detector was fine-tuned on white-light stomach, so the overlay is
  // offered there and nowhere else — the mirror of the IM rule.
  const polypEligible = modality === 'WL' && POLYP_REGIONS.includes(region)

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

      {/* Three columns over two rows. The video takes the left column whole,
          so it is as tall as the window allows; the timeline runs along the
          bottom of the other two. minmax(0, …fr) rather than plain fr: a
          track's content minimum would otherwise push the proportions off. */}
      <LayoutCanvas layout={layout}>
      <div
        style={{
          gridTemplateColumns:
            'minmax(0, 52.6fr) minmax(0, 18.4fr) minmax(0, 29fr)',
          gridTemplateRows: 'minmax(0, 91.5fr) minmax(0, 8.5fr)',
        }}
        className="grid min-h-0 flex-1"
      >
        <div style={{ gridArea: '1 / 1 / 3 / 2' }} className="flex min-w-0 p-4">
          <LayoutBlock id="stage" label="Video">
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <ScopeStage
                manifest={manifest}
                videoRef={videoRef}
                maskFrame={maskFrame}
                showMask={showMask && imEligible}
                polypFrame={polypFrame}
                showPolyp={showPolyp && polypEligible}
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

            {/* Armed at any time, effective only where the model is defined:
                the light changes many times a minute, so a control that could
                only be set while the right light happened to be on would be
                dead about as often as it was live. The button says whether the
                overlay is on, and nothing else — whether it applies right now
                is already visible on the stage. */}
            <OverlayButton
              label="IM overlay"
              on={showMask}
              shortcut={OVERLAY_KEYS.im}
              tone="im"
              onClick={() => setShowMask((value) => !value)}
            />

            <OverlayButton
              label="Polyp overlay"
              on={showPolyp}
              shortcut={OVERLAY_KEYS.polyp}
              tone="polyp"
              onClick={() => setShowPolyp((value) => !value)}
            />

            {/* What the stage used to write over the mucosa. Off the picture it
                can be read without covering the thing being read. */}
            <dl className="mt-1 flex flex-col gap-2 border-t border-console-line pt-3 text-sm">
              <Readout label="Light">
                <span className={modality === 'NBI' ? 'text-scope-accent' : undefined}>
                  {modality ?? '—'}
                </span>
              </Readout>

              <Readout label="GNS">
                {frame?.gns ? (
                  <>
                    {frame.gns.class_name}
                    <span className="ml-1.5 text-console-muted">
                      {(frame.gns.confidence * 100).toFixed(0)}%
                    </span>
                  </>
                ) : (
                  '—'
                )}
              </Readout>

              <Readout label="IM">
                {showMask && imEligible && maskFrame?.gim ? (
                  <span className="text-im">
                    score {maskFrame.gim.score} · {maskFrame.gim.area.toFixed(1)}%
                  </span>
                ) : (
                  <span className="text-console-muted">—</span>
                )}
              </Readout>

              <Readout label="Polyp">
                {showPolyp && polypEligible && polypFrame?.polyp?.boxes.length ? (
                  <span className="text-polyp">
                    {polypFrame.polyp.boxes.length} · {polypFrame.polyp.area.toFixed(1)}%
                  </span>
                ) : (
                  <span className="text-console-muted">—</span>
                )}
              </Readout>
            </dl>

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
                ? modality === 'NBI'
                  ? 'IM is assessed on gastric mucosa only'
                  : 'white-light imaging'
                : maskFrame?.gim?.mask_url
                  ? `overlay from t=${maskFrame.t.toFixed(2)}s`
                  : frame?.gim
                    ? 'no IM finding at this timestamp'
                    : 'IM scan has not reached this frame'}
            </p>

            <RegionChecklist region={region} visited={visited} />

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

        <div
          style={{ gridArea: '2 / 2 / 3 / 4' }}
          className="flex min-w-0 border-t border-console-line px-4"
        >
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
      </div>
      </LayoutCanvas>
    </main>
  )
}

/** One line of the frame readout: what it is on the left, what it says on the right. */
function Readout({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-console-muted">{label}</dt>
      <dd className="truncate text-right">{children}</dd>
    </div>
  )
}

/** Keys that toggle each overlay. Shown on the buttons so they are findable. */
const OVERLAY_KEYS = { im: 'i', polyp: 'p' } as const

/** An overlay toggle: on or off, and which key does it. */
function OverlayButton({
  label,
  on,
  shortcut,
  tone,
  onClick,
}: {
  label: string
  on: boolean
  shortcut: string
  tone: 'im' | 'polyp'
  onClick: () => void
}) {
  const active = {
    im: 'bg-im/20 text-im ring-1 ring-im/60',
    polyp: 'bg-polyp/20 text-polyp ring-1 ring-polyp/60',
  }[tone]

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex items-center justify-between rounded px-5 py-2.5 text-sm transition ${
        on ? active : 'bg-console-panel text-console-muted hover:bg-console-line'
      }`}
    >
      <span>
        {label} {on ? 'on' : 'off'}
      </span>
      <kbd className="ml-3 rounded border border-current/30 px-1.5 py-0.5 text-[11px] opacity-60">
        {shortcut.toUpperCase()}
      </kbd>
    </button>
  )
}

/**
 * Starting arrangement for layout mode, as percentages of the canvas — the
 * current production layout, so dragging starts from what is on screen.
 */
const DEFAULT_LAYOUT = {
  stage: { x: 0, y: 0, w: 52.6, h: 100 },
  controls: { x: 52.6, y: 0, w: 18.4, h: 91.5 },
  site: { x: 71, y: 0, w: 29, h: 91.5 },
  timeline: { x: 52.6, y: 91.5, w: 47.4, h: 8.5 },
}
