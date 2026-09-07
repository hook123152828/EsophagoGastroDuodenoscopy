import { useEffect, useState, type RefObject } from 'react'

import {
  MASK_BOUNDARY_FILTER,
  MaskBoundaryFilter,
} from '@/components/MaskBoundaryFilter'
import {
  fileUrl,
  roiCropStyle,
  type FrameRecord,
  type SessionManifest,
} from '@/protocol'

interface Props {
  manifest: SessionManifest
  videoRef: RefObject<HTMLVideoElement | null>
  maskFrame: FrameRecord | null
  showMask: boolean
  polypFrame: FrameRecord | null
  showPolyp: boolean
}

/**
 * The scope viewport.
 *
 * The stage is cropped to the ROI: the console's left column carries patient
 * identifiers and nothing the models look at, so the video is scaled up and
 * offset until only the endoscope field remains. That makes overlay alignment
 * exact by construction — the container *is* the ROI, so a mask (which is
 * rendered at ROI resolution) simply fills it.
 *
 * Nothing is written over the picture. Every readout the stage used to carry —
 * the light, the site, the scores — is in the controls column instead, where
 * it can be read without competing with the mucosa for the same pixels. What
 * stays is what only the stage can say: an outline around a finding, and a
 * border and brackets marking that there is one.
 */
export default function ScopeStage({
  manifest,
  videoRef,
  maskFrame,
  showMask,
  polypFrame,
  showPolyp,
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

  // A source the browser cannot decode used to leave the stage black with
  // nothing said, while the analysis ran perfectly underneath it. The element
  // knows why it failed; this puts it where it can be read.
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onError = () =>
      setPlaybackError(
        video.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
          ? 'This recording is in a format the browser cannot play'
          : (video.error?.message ?? 'The recording could not be played'),
      )
    const onLoaded = () => setPlaybackError(null)

    video.addEventListener('error', onError)
    video.addEventListener('loadeddata', onLoaded)
    return () => {
      video.removeEventListener('error', onError)
      video.removeEventListener('loadeddata', onLoaded)
    }
  }, [videoRef])

  const gim = maskFrame?.gim ?? null
  const polyp = showPolyp ? (polypFrame?.polyp ?? null) : null
  const maskVisible = showMask && Boolean(maskFrame?.gim?.mask_url)
  const polypVisible = Boolean(polyp?.mask_url)
  const alerting =
    (showMask && gim !== null && gim.score >= 1) || Boolean(polyp?.boxes.length)

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

        {playbackError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-scope-alert">{playbackError}</p>
            <p className="text-xs text-console-muted">
              The analysis is unaffected — it reads the recording on the server.
            </p>
          </div>
        )}

        {(maskVisible || polypVisible) && <MaskBoundaryFilter />}

        {maskVisible && (
          <img
            src={fileUrl(maskFrame!.gim!.mask_url!)}
            alt=""
            style={{ filter: MASK_BOUNDARY_FILTER }}
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        )}

        {/* Drawn over the IM outline: where both models fire on the same
            mucosa, the discrete finding is the one to keep legible. */}
        {polypVisible && (
          <img
            src={fileUrl(polyp!.mask_url!)}
            alt=""
            style={{ filter: MASK_BOUNDARY_FILTER }}
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        )}

        {alerting && <CornerBrackets />}

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
