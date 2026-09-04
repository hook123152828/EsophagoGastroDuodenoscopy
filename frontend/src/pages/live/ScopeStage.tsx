import { useEffect, useRef, useState, type RefObject } from 'react'

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

        {maskVisible && <SmoothedMask src={fileUrl(maskFrame!.gim!.mask_url!)} tint="var(--color-im)" />}

        {/* Drawn over the IM outline: where both models fire on the same
            mucosa, the discrete finding is the one to keep legible. */}
        {polypVisible && <SmoothedMask src={fileUrl(polyp!.mask_url!)} tint="var(--color-polyp)" />}

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

/** How fast the marker follows the finding. One pass in three, per pass. */
const MARKER_BLEND = 0.35

/** Below this share of the frame a finding is noise, not a marker. */
const MARKER_MIN_AREA = 0.004

/**
 * The extent of a mask, as (x, y, w, h) in fractions of the frame.
 *
 * Taken from a coarse grid and from the *bulk* of the coverage rather than its
 * outermost pixel: a segmentation of a diffuse finding has stragglers, and a
 * box drawn to the last of them is a box around the frame.
 */
function extentOf(canvas: HTMLCanvasElement): [number, number, number, number] | null {
  const size = 64
  const probe = document.createElement('canvas')
  probe.width = probe.height = size
  const context = probe.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(canvas, 0, 0, size, size)
  const { data } = context.getImageData(0, 0, size, size)

  const columns = new Float64Array(size)
  const rows = new Float64Array(size)
  let total = 0
  for (let i = 0; i < size * size; i++) {
    const alpha = data[i * 4 + 3]
    if (alpha === 0) continue
    columns[i % size] += alpha
    rows[Math.floor(i / size)] += alpha
    total += alpha
  }
  if (total / (size * size * 255) < MARKER_MIN_AREA) return null

  // The span holding the middle 96% of the coverage on each axis.
  const span = (weights: Float64Array): [number, number] => {
    const tail = total * 0.02
    let seen = 0
    let low = 0
    let high = size - 1
    for (let i = 0; i < size; i++) {
      seen += weights[i]
      if (seen >= tail) { low = i; break }
    }
    seen = 0
    for (let i = size - 1; i >= 0; i--) {
      seen += weights[i]
      if (seen >= tail) { high = i; break }
    }
    return [low / size, (high + 1) / size]
  }

  const [x0, x1] = span(columns)
  const [y0, y1] = span(rows)
  return [x0, y0, x1 - x0, y1 - y0]
}

/**
 * The finding, marked the way the cleared devices mark one.
 *
 * Not a traced outline. The segmentation is recomputed from scratch on every
 * pass and agrees with itself only loosely — over the finding at 9:27 in
 * video1, consecutive masks share a median of 69% of their area — so a contour
 * drawn faithfully at fifteen passes a second does not sit around the finding,
 * it boils. No amount of moving it or smoothing its edge fixes that, because
 * the shape itself is what is unstable.
 *
 * None of the endoscopy CADe systems on the market draws one. GI Genius and
 * AI4GI mark a box; CAD EYE offers a box, a bounding circle and a position
 * map; EndoBRAIN refuses to cover the picture at all and marks the corners
 * with a sound. The one published design study — Van Berkel et al., seven
 * markers rendered on real patient footage and put to 36 clinical staff —
 * found they preferred a wide bounding circle.
 *
 * So what is drawn is the finding's extent: four numbers, smoothed pass to
 * pass, which have no shape of their own to boil. The mask still does the
 * work behind it — the passes are averaged into a canvas that is shifted to
 * follow the lesion first, so the extent is taken from what the passes agree
 * on rather than from the newest of them.
 */
function SmoothedMask({ src, tint }: { src: string; tint: string }) {
  const accumulator = useRef<HTMLCanvasElement | null>(null)
  const scratch = useRef<HTMLCanvasElement | null>(null)
  const previous = useRef<[number, number] | null>(null)
  const [extent, setExtent] = useState<[number, number, number, number] | null>(null)
  const smoothed = useRef<[number, number, number, number] | null>(null)

  useEffect(() => {
    let cancelled = false

    loadMask(src).then((mask) => {
      if (cancelled || !mask) return
      const { image, centroid } = mask
      const width = image.naturalWidth
      const height = image.naturalHeight
      if (!width) return

      let canvas = accumulator.current
      if (!canvas) {
        canvas = document.createElement('canvas')
        accumulator.current = canvas
      }
      const context = canvas.getContext('2d')
      if (!context) return

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
        context.clearRect(0, 0, width, height)
        context.drawImage(image, 0, 0)
        smoothed.current = null
      } else {
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
      }

      const measured = extentOf(canvas)
      if (!measured) {
        smoothed.current = null
        setExtent(null)
        return
      }
      const held = smoothed.current
      const next: [number, number, number, number] = held
        ? (held.map((v, i) => v + (measured[i] - v) * MARKER_BLEND) as [
            number,
            number,
            number,
            number,
          ])
        : measured
      smoothed.current = next
      setExtent(next)
    })

    return () => {
      cancelled = true
    }
  }, [src])

  if (!extent) return null
  const [x, y, w, h] = extent

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute rounded-[38%] border-2 transition-all duration-150 ease-out"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${w * 100}%`,
        height: `${h * 100}%`,
        borderColor: tint,
        boxShadow: `0 0 0 1px rgba(5, 7, 10, 0.55), inset 0 0 0 1px rgba(5, 7, 10, 0.55)`,
      }}
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
