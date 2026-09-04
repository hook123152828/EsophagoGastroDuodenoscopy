import { useEffect, useRef, useState, type RefObject } from 'react'

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

        {maskVisible && <SmoothedMask src={fileUrl(maskFrame!.gim!.mask_url!)} />}

        {/* Drawn over the IM outline: where both models fire on the same
            mucosa, the discrete finding is the one to keep legible. */}
        {polypVisible && <SmoothedMask src={fileUrl(polyp!.mask_url!)} />}

        {alerting && <CornerBrackets />}

      </div>
    </div>
  )
}

/**
 * The furthest a finding is taken to have moved between two passes, as a
 * fraction of the frame. Beyond it the two are treated as unrelated and the
 * older one is dropped rather than dragged across the picture.
 *
 * Set above the largest movement actually seen: over video1, consecutive masks
 * move a median of 4.6% of the frame and at most 31%. At 0.25 it fired part way
 * through a finding the scope was moving quickly across, and each firing throws
 * the accumulated shape away and shows a single raw pass — the one thing this
 * is here to avoid. It is a guard against two unrelated findings, not a limit
 * on how fast a scope may move.
 */
const MAX_TRAVEL = 0.35

/**
 * How much of each new mask is taken, against what is already accumulated.
 *
 * The segmentation is recomputed from scratch on every pass and agrees with
 * itself only loosely: over video1, consecutive masks share a median of 69% of
 * their area, and a quarter of the pairs differ by more than a third. Shown
 * one after another at fifteen a second, the outline does not sit around a
 * finding, it writhes — the shape is rewritten faster than the eye can take
 * any one of them in, and no amount of moving it to the right place helps,
 * because it was never the position that was wrong.
 *
 * So the mask is not drawn. What is drawn is a running average of the last few,
 * which is what a finding that is really there looks like: a pixel inside the
 * lesion on most passes stays opaque, one that flickers in and out lands
 * between and falls under the outline's threshold. At 0.4 the average turns
 * over in about two passes, damping the disagreement without holding a shape
 * after the scope has left it.
 */
const BLEND = 0.4

/**
 * The centroid of a mask's opaque pixels, as fractions of the frame.
 *
 * Cached: the same mask is shown again on every scrub back over it, and the
 * answer is a property of the file.
 */
const CENTROIDS = new Map<string, [number, number] | null>()

function centroidOfImage(image: HTMLImageElement): [number, number] | null {
  // Small: the centroid of a blob does not need the blob's resolution, and
  // this runs on every mask the scan produces.
  const size = 48
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(image, 0, 0, size, size)
  const { data } = context.getImageData(0, 0, size, size)

  let weight = 0
  let x = 0
  let y = 0
  for (let i = 0; i < size * size; i++) {
    const alpha = data[i * 4 + 3]
    if (alpha === 0) continue
    weight += alpha
    x += (i % size) * alpha
    y += Math.floor(i / size) * alpha
  }
  return weight === 0 ? null : [x / weight / size, y / weight / size]
}

async function loadMask(
  src: string,
): Promise<{ image: HTMLImageElement; centroid: [number, number] | null } | null> {
  const image = new Image()
  image.src = src
  try {
    await image.decode()
  } catch {
    return null
  }
  let centroid = CENTROIDS.get(src)
  if (centroid === undefined) {
    centroid = centroidOfImage(image)
    CENTROIDS.set(src, centroid)
  }
  return { image, centroid }
}

/**
 * The finding, drawn as what the last few passes agree on rather than as the
 * newest of them.
 *
 * Each pass is folded into a canvas that is carried between them. Before the
 * fold the canvas is shifted by however far the finding's centroid moved, so
 * the accumulated shape follows the lesion instead of smearing along its path
 * — the average is over what the passes said about the *same* mucosa, not
 * about the same pixels. Then it is faded and the new pass blended in.
 *
 * This replaced sliding the mask image into position, which was addressing the
 * wrong half of it. The outline did travel, but it changed shape on arrival,
 * and a shape that is redrawn fifteen times a second reads as boiling however
 * smoothly it is moved.
 */
function SmoothedMask({ src }: { src: string }) {
  const node = useRef<HTMLCanvasElement>(null)
  const scratch = useRef<HTMLCanvasElement | null>(null)
  const previous = useRef<[number, number] | null>(null)

  useEffect(() => {
    let cancelled = false

    loadMask(src).then((mask) => {
      const canvas = node.current
      if (cancelled || !canvas || !mask) return

      const { image, centroid } = mask
      const width = image.naturalWidth
      const height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context || !width) return

      // A change of size means a different session, not a moved lesion.
      const started = canvas.width !== width || canvas.height !== height
      if (started) {
        canvas.width = width
        canvas.height = height
      }

      const last = previous.current
      previous.current = centroid

      const dx = last && centroid ? (centroid[0] - last[0]) * width : 0
      const dy = last && centroid ? (centroid[1] - last[1]) * height : 0
      const travelled = Math.hypot(dx / width, dy / height)

      if (started || !last || !centroid || travelled > MAX_TRAVEL) {
        // Nothing worth carrying: show this pass on its own rather than blend
        // it with a finding it has nothing to do with.
        context.clearRect(0, 0, width, height)
        context.drawImage(image, 0, 0)
        return
      }

      if (dx || dy) {
        // Carried through a scratch copy: a canvas drawn onto itself at an
        // offset would read the pixels it is writing.
        let buffer = scratch.current
        if (!buffer) {
          buffer = document.createElement('canvas')
          scratch.current = buffer
        }
        if (buffer.width !== width || buffer.height !== height) {
          buffer.width = width
          buffer.height = height
        }
        const into = buffer.getContext('2d')
        if (into) {
          into.clearRect(0, 0, width, height)
          into.drawImage(canvas, dx, dy)
          context.clearRect(0, 0, width, height)
          context.drawImage(buffer, 0, 0)
        }
      }

      context.globalCompositeOperation = 'destination-out'
      context.fillStyle = `rgba(0, 0, 0, ${BLEND})`
      context.fillRect(0, 0, width, height)

      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = BLEND
      context.drawImage(image, 0, 0)
      context.globalAlpha = 1
    })

    return () => {
      cancelled = true
    }
  }, [src])

  return (
    <canvas
      ref={node}
      style={{ filter: MASK_BOUNDARY_FILTER }}
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
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
