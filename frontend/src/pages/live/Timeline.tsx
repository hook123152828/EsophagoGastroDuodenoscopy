import { useMemo } from 'react'

import {
  REGION_WINDOW_S,
  regionSpans,
  type FrameRecord,
  type RegionId,
  type RegionTrack,
} from '@/protocol'

const REGION_COLOR: Record<RegionId, string> = {
  esophagus: 'var(--color-region-esophagus)',
  cardia: 'var(--color-region-cardia)',
  body: 'var(--color-region-body)',
  angle: 'var(--color-region-angle)',
  antrum: 'var(--color-region-antrum)',
  duodenum: 'var(--color-region-duodenum)',
  unknown: 'var(--color-region-unknown)',
}

interface Props {
  /** Smoothed site over the procedure — the coloured bands. */
  track: RegionTrack
  /** Raw frames, still the only place the IM findings live. */
  frames: FrameRecord[]
  currentTime: number
  onSeek: (time: number) => void
}

/**
 * How far the scan has actually got, in video seconds.
 *
 * The frame table is built at full length before ffmpeg even starts — a row
 * per extracted frame, results filled in later — so its length says nothing
 * about progress. What has been analysed is the run of frames carrying a GNS
 * result, which the scan fills in order from the start.
 *
 * Read as a contiguous frontier rather than the furthest analysed frame,
 * because on-demand analysis leaves islands far ahead of the scan: jumping to
 * the twelfth minute of an untouched procedure analyses that one frame, and
 * taking the maximum would stretch the axis over eleven minutes of nothing.
 * The tolerated gap is the site window — a hole smaller than that is the
 * sampling stride, anything wider is unscanned video.
 */
function scannedTo(frames: FrameRecord[]): number {
  let frontier = 0
  for (const frame of frames) {
    if (!frame.gns) continue
    if (frame.t - frontier > REGION_WINDOW_S) break
    frontier = frame.t
  }
  return frontier
}

/**
 * The procedure at a glance: which region the scope was in, and where IM was
 * flagged. Click to seek.
 *
 * The axis spans what has been scanned, not the whole video: a procedure that
 * has just been loaded has nothing to show and says so by being empty, rather
 * than by drawing a full-width bar that is almost entirely a lie. It grows as
 * results land, which slides everything already on it leftwards.
 */
export default function Timeline({
  track,
  frames,
  currentTime,
  onSeek,
}: Props) {
  const spans = useMemo(() => regionSpans(track), [track])
  const findings = useMemo(
    () => frames.filter((frame) => frame.gim && frame.gim.score >= 1),
    [frames],
  )
  const extent = useMemo(() => scannedTo(frames), [frames])

  const percent = (time: number) =>
    `${Math.min(100, (time / Math.max(extent, 1)) * 100)}%`

  function seekFromEvent(event: React.MouseEvent<HTMLDivElement>) {
    if (extent === 0) return
    const bounds = event.currentTarget.getBoundingClientRect()
    onSeek(((event.clientX - bounds.left) / bounds.width) * extent)
  }

  return (
    <div className="space-y-1.5">
      <div
        onClick={seekFromEvent}
        className="relative h-7 cursor-pointer overflow-hidden rounded bg-console-panel"
      >
        {spans.map((span, index) => (
          <div
            key={index}
            className="absolute inset-y-0"
            title={span.region}
            style={{
              left: percent(span.start),
              width: percent(span.end - span.start),
              background: REGION_COLOR[span.region],
              opacity: 0.55,
            }}
          />
        ))}

        {findings.map((frame) => (
          <div
            key={frame.index}
            className="absolute inset-y-0 w-0.5 bg-im"
            style={{ left: percent(frame.t) }}
            title={`IM score ${frame.gim!.score}`}
          />
        ))}

        <div
          className="absolute inset-y-0 w-0.5 bg-console-text"
          style={{ left: percent(currentTime) }}
        />
      </div>

      <div className="flex justify-between text-sm text-console-muted">
        <span>{formatTime(currentTime)}</span>
        <span>
          {findings.length > 0 && (
            <span className="mr-3 text-im">{findings.length} IM findings</span>
          )}
          {/* How far the scan has reached, not how long the video is: the
              length is not known to be interesting until it has been looked
              at, and showing it would imply the empty bar means "nothing
              found" rather than "nothing analysed". */}
          {extent > 0 && formatTime(extent)}
        </span>
      </div>
    </div>
  )
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}
