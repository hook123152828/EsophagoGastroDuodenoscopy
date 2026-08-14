import { useMemo } from 'react'

import { regionSpans, type FrameRecord, type RegionId } from '@/protocol'

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
  frames: FrameRecord[]
  duration: number
  currentTime: number
  onSeek: (time: number) => void
}

/**
 * The procedure at a glance: which region the scope was in, and where IM was
 * flagged. Click to seek.
 */
export default function Timeline({ frames, duration, currentTime, onSeek }: Props) {
  const spans = useMemo(() => regionSpans(frames), [frames])
  const findings = useMemo(
    () => frames.filter((frame) => frame.gim && frame.gim.score >= 1),
    [frames],
  )

  const percent = (time: number) => `${(time / Math.max(duration, 1)) * 100}%`

  function seekFromEvent(event: React.MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    onSeek(((event.clientX - bounds.left) / bounds.width) * duration)
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
          {formatTime(duration)}
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
