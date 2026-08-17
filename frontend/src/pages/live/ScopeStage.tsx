import { useEffect, useState, type RefObject } from 'react'

import {
  fileUrl,
  REGION_LABEL,
  roiCropStyle,
  type FrameRecord,
  type SessionManifest,
} from '@/protocol'

interface Props {
  manifest: SessionManifest
  videoRef: RefObject<HTMLVideoElement | null>
  frame: FrameRecord | null
  maskFrame: FrameRecord | null
  showMask: boolean
}

/**
 * The scope viewport.
 *
 * The stage is cropped to the ROI: the console's left column carries patient
 * identifiers and nothing the models look at, so the video is scaled up and
 * offset until only the endoscope field remains. That makes overlay alignment
 * exact by construction — the container *is* the ROI, so a mask (which is
 * rendered at ROI resolution) simply fills it.
 */
export default function ScopeStage({
  manifest,
  videoRef,
  frame,
  maskFrame,
  showMask,
}: Props) {
  // A callback ref rather than useRef: the box is remounted when the page
  // rearranges (layout mode), and a plain ref would leave the observer watching
  // the detached element, freezing the stage at its last size.
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null)
  const [videoStyle, setVideoStyle] = useState<React.CSSProperties>({
    visibility: 'hidden',
  })

  // Sized here rather than by CSS aspect-ratio: as a flex item the ratio can be
  // overridden by the row's own sizing, which leaves the border wrapping empty
  // black either side of the picture. Fitting inside the box explicitly also
  // guarantees the stage never overflows its share of the layout.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !box) return

    const update = () => {
      const scale = Math.min(
        box.clientWidth / manifest.roi.width,
        box.clientHeight / manifest.roi.height,
      )
      if (!Number.isFinite(scale) || scale <= 0) return

      const width = Math.floor(manifest.roi.width * scale)
      const height = Math.floor(manifest.roi.height * scale)
      setStage({ width, height })

      if (!video.videoWidth) return
      setVideoStyle({
        position: 'absolute',
        ...roiCropStyle(manifest.roi, width, video.videoWidth, video.videoHeight),
        maxWidth: 'none',
      })
    }

    const observer = new ResizeObserver(update)
    observer.observe(box)
    video.addEventListener('loadedmetadata', update)
    update()

    return () => {
      observer.disconnect()
      video.removeEventListener('loadedmetadata', update)
    }
  }, [videoRef, manifest.roi, box])

  const modality = frame?.gns?.modality ?? null
  const region = frame?.gns?.region ?? 'unknown'
  const gim = maskFrame?.gim ?? null
  const alerting = showMask && gim !== null && gim.score >= 1
  const maskVisible = showMask && Boolean(maskFrame?.gim?.mask_url)

  return (
    <div ref={setBox} className="flex h-full w-full items-center justify-center">
      <div
        style={stage ? { width: stage.width, height: stage.height } : undefined}
        className={`relative overflow-hidden rounded-lg border-2 bg-black transition-colors ${
          alerting ? 'border-scope-alert' : 'border-console-line'
        }`}
      >
        <video
          ref={videoRef}
          src={
            manifest.video.media_url ? fileUrl(manifest.video.media_url) : undefined
          }
          style={videoStyle}
          preload="metadata"
          playsInline
        />

        {maskVisible && (
          <img
            src={fileUrl(maskFrame!.gim!.mask_url!)}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        )}

        {alerting && <CornerBrackets />}

        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
          <div className="flex items-start justify-between">
            <Badge active={showMask}>CAD</Badge>
            {modality && <Badge active={modality === 'NBI'}>{modality}</Badge>}
          </div>

          <div className="flex items-end justify-between gap-2">
            <span className="rounded bg-black/60 px-3 py-1.5 text-base font-medium text-console-text backdrop-blur-sm">
              {REGION_LABEL[region]}
              {frame?.gns && (
                <span className="ml-2 text-sm text-console-muted">
                  {frame.gns.class_name} · {(frame.gns.confidence * 100).toFixed(0)}%
                </span>
              )}
            </span>
            {gim && showMask && (
              <span className="rounded bg-black/60 px-3 py-1.5 text-sm text-console-text backdrop-blur-sm">
                IM score {gim.score} · {gim.area.toFixed(1)}%
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The framing marks an endoscope console draws around a detection. */
function CornerBrackets() {
  const inset = 20
  const size = 8

  const corners = [
    { x: inset, y: inset, sx: 1, sy: 1 },
    { x: 100 - inset, y: inset, sx: -1, sy: 1 },
    { x: inset, y: 100 - inset, sx: 1, sy: -1 },
    { x: 100 - inset, y: 100 - inset, sx: -1, sy: -1 },
  ]

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {corners.map((corner, index) => (
        <path
          key={index}
          d={`M ${corner.x} ${corner.y + corner.sy * size} L ${corner.x} ${corner.y} L ${corner.x + corner.sx * size} ${corner.y}`}
          className="stroke-scope-accent"
          strokeWidth={0.5}
          vectorEffect="non-scaling-stroke"
          fill="none"
        />
      ))}
    </svg>
  )
}

function Badge({ children, active }: { children: string; active: boolean }) {
  return (
    <span
      className={`rounded border px-2 py-0.5 text-[11px] font-medium tracking-wider backdrop-blur-sm ${
        active
          ? 'border-scope-accent bg-scope-accent/15 text-scope-accent'
          : 'border-console-line bg-black/50 text-console-muted'
      }`}
    >
      {children}
    </span>
  )
}
