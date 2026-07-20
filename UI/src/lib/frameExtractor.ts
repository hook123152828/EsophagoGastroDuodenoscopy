import type { ExtractedFrame } from '../types'

// The three models were all trained on square frames (GNS 224², CGI 224²,
// GIM 256²) and GIM's Mask2Former head assumes a square feature map, so each
// captured frame is center-cropped to a square. OUT_SIZE caps the square edge —
// it stays just above the largest native input (GIM's 256) because at 30 fps
// every extra pixel is multiplied by tens of thousands of retained frames.
const OUT_SIZE = 320

// A per-session unique frame id. `crypto.randomUUID` only exists in a secure
// context, so it is undefined when the app is served over plain HTTP from a LAN
// address (not localhost) — calling it there threw and silently dropped every
// captured frame. This falls back to a counter+time+random id, which is unique
// enough for React keys and lookup maps.
let frameSeq = 0
function makeFrameId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `f${Date.now().toString(36)}-${(frameSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface Roi {
  x: number
  y: number
  w: number
  h: number
}

// A recording is the processor's whole screen: the scope's circular view sits
// off-center beside a patient-info panel, framed by black. The scope view is
// the only strongly *colorful* region — the surrounding black and the white
// overlay text carry almost no saturation — so project saturated, bright
// pixels onto each axis and take their bounding box. Returns null while the
// frame has too little colorful content to trust (e.g. a dark lead-in).
export function detectScopeRoi(video: HTMLVideoElement): Roi | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const SW = 320
  const scale = SW / vw
  const sh = Math.max(1, Math.round(vh * scale))
  const canvas = document.createElement('canvas')
  canvas.width = SW
  canvas.height = sh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, SW, sh)

  const { data } = ctx.getImageData(0, 0, SW, sh)
  const colCount = new Array<number>(SW).fill(0)
  const rowCount = new Array<number>(sh).fill(0)
  let total = 0

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      if (lum > 28 && max - min > 22) {
        colCount[x] += 1
        rowCount[y] += 1
        total += 1
      }
    }
  }
  if (total < SW * sh * 0.02) return null

  const colThresh = Math.max(2, sh * 0.04)
  const rowThresh = Math.max(2, SW * 0.04)
  const firstIdx = (arr: number[], t: number) => arr.findIndex((c) => c >= t)
  const lastIdx = (arr: number[], t: number) => {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= t) return i
    return -1
  }
  const x0 = firstIdx(colCount, colThresh)
  const x1 = lastIdx(colCount, colThresh)
  const y0 = firstIdx(rowCount, rowThresh)
  const y1 = lastIdx(rowCount, rowThresh)
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) return null

  const inv = 1 / scale
  return { x: x0 * inv, y: y0 * inv, w: (x1 - x0 + 1) * inv, h: (y1 - y0 + 1) * inv }
}

export function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

// Strips the "data:image/jpeg;base64," prefix — the backend wants raw base64.
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

// Grabs the video element's *current* displayed frame as a square crop, taken
// from `roi` (the detected scope view) when given, otherwise from the whole
// frame. drawImage runs synchronously up front, so call this the moment the
// target frame is on screen (e.g. inside requestVideoFrameCallback); the async
// part is only JPEG/base64 encoding.
export async function captureSquareFrame(
  video: HTMLVideoElement,
  timestamp: number,
  roi?: Roi | null,
  outSize = OUT_SIZE,
): Promise<ExtractedFrame> {
  const vw = video.videoWidth || outSize
  const vh = video.videoHeight || outSize
  const src = roi ?? { x: 0, y: 0, w: vw, h: vh }
  const cropSize = Math.min(src.w, src.h)
  const cropX = src.x + (src.w - cropSize) / 2
  const cropY = src.y + (src.h - cropSize) / 2
  const edge = Math.min(Math.round(cropSize), outSize)

  // Fresh canvas per capture so overlapping async encodes never race.
  const canvas = document.createElement('canvas')
  canvas.width = edge
  canvas.height = edge
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create a 2D canvas context')
  ctx.drawImage(video, cropX, cropY, cropSize, cropSize, 0, 0, edge, edge)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/jpeg',
      0.85,
    )
  })
  return {
    id: makeFrameId(),
    timestamp,
    blob,
    url: URL.createObjectURL(blob),
  }
}
