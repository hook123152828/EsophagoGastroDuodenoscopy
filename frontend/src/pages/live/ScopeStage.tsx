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

        {maskVisible && <SlidingMask src={fileUrl(maskFrame!.gim!.mask_url!)} />}

        {/* Drawn over the IM outline: where both models fire on the same
            mucosa, the discrete finding is the one to keep legible. */}
        {polypVisible && <SlidingMask src={fileUrl(polyp!.mask_url!)} />}

        {alerting && <CornerBrackets />}

      </div>
    </div>
  )
}

/**
 * The furthest the outline is ever seen to travel, as a fraction of the frame.
 *
 * A cap, not a rejection. Refusing to animate the long jumps meant the outline
 * cut on exactly the frames where the scope was moving fastest and the motion
 * mattered most. Measured over video1, consecutive masks move a median of 4.6%
 * of the frame and at most 31%, so this only shortens the run-up on the fastest
 * few; what it is really for is the case the measurement cannot rule out, where
 * two masks half a second apart are different lesions and the outline would
 * otherwise sweep the width of the picture between them.
 */
const MAX_TRAVEL = 0.25

/**
 * How much of the gap between masks the slide is allowed to use, and the
 * longest it may ever take.
 *
 * A slide that outlasts the gap never arrives: it is interrupted by the next
 * mask, and the outline sits permanently short of wherever the lesion is. The
 * gap is not a constant -- masks arrive as fast as the pass that made them and
 * as fast as the video is played, 49ms at normal speed here and 15ms at four
 * times it -- so the duration is measured from the last one rather than
 * guessed. The overlay is already up to half a second behind the mucosa and
 * the animation must not add to that.
 *
 * At 80% of a 49ms gap it is still two or three frames of travel, which reads
 * as movement where a cut does not. Where the gap is shorter than a frame there
 * is nothing to animate and it becomes the cut again, which is the right answer
 * -- at four times speed nobody can see 15ms of easing.
 */
const SLIDE_OF_GAP = 0.8
const SLIDE_MAX_MS = 60

/**
 * Under this, the outline is put where it belongs and not animated at all.
 *
 * Two frames. Below that there is no animation to see -- the masks are arriving
 * faster than the display can draw the travel -- and attempting one only leaves
 * the outline permanently mid-slide, which is the fault this was meant to fix
 * rather than cause. It is reached by playing the recording back at speed.
 */
const SLIDE_MIN_GAP_MS = 32

/**
 * The centroid of a mask's opaque pixels, as fractions of the frame.
 *
 * Cached: the same mask is shown again on every scrub back over it, and the
 * answer is a property of the file.
 */
const CENTROIDS = new Map<string, [number, number] | null>()

async function centroidOf(src: string): Promise<[number, number] | null> {
  const cached = CENTROIDS.get(src)
  if (cached !== undefined) return cached

  const image = new Image()
  image.src = src
  try {
    await image.decode()
  } catch {
    return null
  }

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
  const centroid: [number, number] | null =
    weight === 0 ? null : [x / weight / size, y / weight / size]
  CENTROIDS.set(src, centroid)
  return centroid
}

/**
 * A mask that slides to where the lesion has moved instead of jumping there.
 *
 * The masks are computed at a fraction of the video's rate and held until the
 * next one, so an outline is always a little behind the mucosa under it and
 * catches up in one step. Cutting between two positions several times a second
 * reads as flicker, and the eye loses which of the two is the finding.
 *
 * So each new mask is placed where the last one was and moved into position.
 * The offset is the shift between their centroids, measured off the images
 * themselves — the protocol carries a mask's area and score but not where it
 * is. A mask that lands more than a quarter of the frame away is not the same
 * lesion having moved, so it appears where it is.
 *
 * The two positions are written straight to the node with a reflow between
 * them, rather than through state. Going through state costs a render for the
 * offset, a frame for the callback that clears it, and a render for the zero —
 * about 48ms before the outline starts moving, against a 64ms median gap
 * between masks. The overlay spent most of its life parked where the lesion
 * used to be, which is the opposite of the point.
 */
function SlidingMask({ src }: { src: string }) {
  const node = useRef<HTMLImageElement>(null)
  const previous = useRef<[number, number] | null>(null)
  const previousAt = useRef(0)

  useEffect(() => {
    let cancelled = false

    const now = performance.now()
    const gap = previousAt.current ? now - previousAt.current : SLIDE_MAX_MS
    previousAt.current = now

    centroidOf(src).then((centroid) => {
      const image = node.current
      if (cancelled || !image) return

      const last = previous.current
      previous.current = centroid

      // Where this mask belongs, whether or not it is animated into place.
      // Every path that does not animate has to say so: the element survives
      // the change of src, so an offset left on it by the last slide is still
      // there, and the outline would stay parked at a position two masks old.
      if (!last || !centroid || gap < SLIDE_MIN_GAP_MS) {
        image.style.transition = 'none'
        image.style.transform = 'translate(0, 0)'
        return
      }

      // Start from where the outline actually *is*, not from where the last
      // mask was. A slide can be interrupted -- at double speed the masks come
      // every 24ms against a 60ms travel -- and reading the offset off the last
      // pair of centroids throws away however much of the previous slide had
      // run, yanking the outline back each time. The error compounded until the
      // outline was a fifth of the frame behind and following nothing. Composed
      // against the live position instead, an interrupted slide is just a slide
      // that got part of the way, and the remainder decays.
      const matrix = new DOMMatrixReadOnly(getComputedStyle(image).transform)
      let dx = matrix.e / (image.clientWidth || 1) + (last[0] - centroid[0])
      let dy = matrix.f / (image.clientHeight || 1) + (last[1] - centroid[1])

      const travel = Math.hypot(dx, dy)
      if (travel === 0) return
      if (travel > MAX_TRAVEL) {
        dx *= MAX_TRAVEL / travel
        dy *= MAX_TRAVEL / travel
      }

      image.style.transition = 'none'
      image.style.transform = `translate(${dx * 100}%, ${dy * 100}%)`
      void image.offsetWidth // flush, so the two positions are not coalesced
      const duration = Math.min(gap * SLIDE_OF_GAP, SLIDE_MAX_MS)
      image.style.transition = `transform ${duration.toFixed(0)}ms ease-out`
      image.style.transform = 'translate(0, 0)'
    })

    return () => {
      cancelled = true
    }
  }, [src])

  return (
    <img
      ref={node}
      src={src}
      alt=""
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
