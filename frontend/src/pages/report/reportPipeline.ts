import {
  fileUrl,
  type CgiPair,
  type FrameRecord,
  type RegionId,
} from '@/protocol'

const CGI_POOL_SIZE = 4
const CGI_MIN_GAP_S = 2
const CGI_QUALITY_SCAN_LIMIT = 24
const CGI_QUALITY_SAMPLE_WIDTH = 160
const GIM_EVIDENCE_SIZE = 6
const GIM_CONSENSUS_SIZE = 3
const GIM_CONSENSUS_POSITIVES = 2
const GIM_CONSENSUS_WINDOW_S = 1
const GIM_EPISODE_GAP_S = 1

/**
 * Conservative rejection thresholds for obviously unusable CGI inputs.
 * These are acquisition-quality checks, not clinical decision thresholds.
 */
export const CGI_QUALITY_THRESHOLDS = {
  minMeanLuminance: 35,
  maxMeanLuminance: 220,
  maxDarkFraction: 0.35,
  maxHighlightFraction: 0.2,
  minSharpness: 35,
} as const

export type CgiRegion = Extract<RegionId, 'antrum' | 'body' | 'cardia'>

export interface EncodedFrame {
  frame: FrameRecord
  base64: string
  quality: CgiFrameQuality
}

export interface CgiPools {
  antrum: EncodedFrame[]
  body: EncodedFrame[]
  cardia: EncodedFrame[]
}

export interface CgiEvidence {
  region: CgiRegion
  frame: FrameRecord | null
  base64: string
  quality: CgiFrameQuality | null
}

export interface CgiFrameQuality {
  accepted: boolean
  meanLuminance: number
  darkFraction: number
  highlightFraction: number
  sharpness: number
  rejectionReasons: string[]
}

export interface GimEpisode {
  region: RegionId
  startT: number
  endT: number
  frames: FrameRecord[]
  representative: FrameRecord
}

/**
 * CGI was trained on white-light gastric images. Check both normalized
 * modality and the original GNS class so inconsistent records cannot enter a
 * candidate pool.
 */
export function isCgiCandidate(
  frame: FrameRecord,
  region: CgiRegion,
): boolean {
  return (
    frame.gns?.region === region &&
    frame.gns.modality === 'WL' &&
    frame.gns.class_name.endsWith('_WL')
  )
}

/** GIM is not applicable to the esophagus, even when GNS reports NBI. */
export function hasValidGimResult(frame: FrameRecord): boolean {
  return (
    frame.gim !== null &&
    frame.gns?.modality === 'NBI' &&
    frame.gns.region !== 'esophagus'
  )
}

/**
 * Pick a small, temporally diverse set of high-confidence white-light frames.
 *
 * CGI evaluates the Cartesian product A x B x C, so passing every scan frame
 * would grow without bound. Four candidates per region caps one report at 64
 * combinations while avoiding four nearly identical adjacent frames.
 */
export function selectCgiCandidates(
  frames: FrameRecord[],
  region: CgiRegion,
): FrameRecord[] {
  return prioritizedCgiCandidates(frames, region, CGI_POOL_SIZE).sort(
    (left, right) => left.t - right.t,
  )
}

function prioritizedCgiCandidates(
  frames: FrameRecord[],
  region: CgiRegion,
  limit: number,
): FrameRecord[] {
  const ranked = frames
    .filter((frame) => isCgiCandidate(frame, region))
    .sort(
      (left, right) =>
        (right.gns?.confidence ?? 0) - (left.gns?.confidence ?? 0),
    )

  const selected: FrameRecord[] = []
  for (const frame of ranked) {
    if (selected.every((item) => Math.abs(item.t - frame.t) >= CGI_MIN_GAP_S)) {
      selected.push(frame)
      if (selected.length === limit) break
    }
  }

  // Very short clips may not contain enough frames two seconds apart. Fill the
  // remaining quality-check queue while preserving GNS confidence order.
  for (const frame of ranked) {
    if (selected.length === limit) break
    if (!selected.includes(frame)) selected.push(frame)
  }

  return selected
}

/**
 * Confirm GIM only when at least two of three consecutively evaluated frames
 * from the same anatomical region are positive within one second. Confirmed
 * findings separated by at most one second are reported as one episode.
 */
export function buildGimEpisodes(frames: FrameRecord[]): GimEpisode[] {
  const byRegion = new Map<RegionId, FrameRecord[]>()
  for (const frame of frames.filter(hasValidGimResult)) {
    const region = frame.gns?.region ?? 'unknown'
    const regionFrames = byRegion.get(region) ?? []
    regionFrames.push(frame)
    byRegion.set(region, regionFrames)
  }

  const confirmed = new Map<number, FrameRecord>()
  for (const regionFrames of byRegion.values()) {
    regionFrames.sort((left, right) => left.t - right.t)
    for (let index = 0; index <= regionFrames.length - GIM_CONSENSUS_SIZE; index += 1) {
      const window = regionFrames.slice(index, index + GIM_CONSENSUS_SIZE)
      if (window[GIM_CONSENSUS_SIZE - 1].t - window[0].t > GIM_CONSENSUS_WINDOW_S) {
        continue
      }

      const positives = window.filter((frame) => (frame.gim?.score ?? 0) >= 1)
      if (positives.length >= GIM_CONSENSUS_POSITIVES) {
        for (const frame of positives) confirmed.set(frame.index, frame)
      }
    }
  }

  const episodes: GimEpisode[] = []
  for (const frame of [...confirmed.values()].sort((left, right) => left.t - right.t)) {
    const region = frame.gns?.region ?? 'unknown'
    const current = episodes[episodes.length - 1]
    if (
      current &&
      current.region === region &&
      frame.t - current.endT <= GIM_EPISODE_GAP_S
    ) {
      current.frames.push(frame)
      current.endT = frame.t
      current.representative = strongerGimFrame(current.representative, frame)
    } else {
      episodes.push({
        region,
        startT: frame.t,
        endT: frame.t,
        frames: [frame],
        representative: frame,
      })
    }
  }

  return episodes
}

export function selectGimEvidence(episodes: GimEpisode[]): FrameRecord[] {
  return [...episodes]
    .sort((left, right) =>
      compareGimStrength(right.representative, left.representative),
    )
    .slice(0, GIM_EVIDENCE_SIZE)
    .sort((left, right) => left.startT - right.startT)
    .map((episode) => episode.representative)
}

export async function encodeCgiPools(frames: FrameRecord[]): Promise<CgiPools> {
  const [antrum, body, cardia] = await Promise.all(
    (['antrum', 'body', 'cardia'] as const).map((region) =>
      encodeQualityApprovedPool(frames, region),
    ),
  )

  return { antrum, body, cardia }
}

export function evidenceForPair(pair: CgiPair, pools: CgiPools): CgiEvidence[] {
  const items = [
    { region: 'antrum' as const, base64: pair.img1, pool: pools.antrum },
    { region: 'body' as const, base64: pair.img2, pool: pools.body },
    { region: 'cardia' as const, base64: pair.img3, pool: pools.cardia },
  ]

  return items.map(({ region, base64, pool }) => ({
    region,
    base64,
    frame: pool.find((candidate) => candidate.base64 === base64)?.frame ?? null,
    quality: pool.find((candidate) => candidate.base64 === base64)?.quality ?? null,
  }))
}

export function jpegDataUrl(base64: string): string {
  return `data:image/jpeg;base64,${base64}`
}

async function encodeQualityApprovedPool(
  frames: FrameRecord[],
  region: CgiRegion,
): Promise<EncodedFrame[]> {
  const approved: EncodedFrame[] = []
  const candidates = prioritizedCgiCandidates(frames, region, CGI_QUALITY_SCAN_LIMIT)

  for (const frame of candidates) {
    const blob = await fetchFrameBlob(frame)
    const quality = await measureCgiFrameQuality(blob)
    if (!quality.accepted) continue

    approved.push({ frame, quality, base64: await blobAsBase64(blob) })
    if (approved.length === CGI_POOL_SIZE) break
  }

  return approved.sort((left, right) => left.frame.t - right.frame.t)
}

async function fetchFrameBlob(frame: FrameRecord): Promise<Blob> {
  const response = await fetch(fileUrl(frame.image_url))
  if (!response.ok) {
    throw new Error(`Could not load frame ${frame.index} (${response.status})`)
  }

  return response.blob()
}

async function blobAsBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not encode frame'))
    reader.readAsDataURL(blob)
  })

  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

async function measureCgiFrameQuality(blob: Blob): Promise<CgiFrameQuality> {
  const bitmap = await createImageBitmap(blob)
  const width = Math.min(CGI_QUALITY_SAMPLE_WIDTH, bitmap.width)
  const height = Math.max(1, Math.round((bitmap.height / bitmap.width) * width))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    bitmap.close()
    throw new Error('Canvas is unavailable for CGI image-quality checks')
  }

  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const pixels = context.getImageData(0, 0, width, height).data
  const luminance = new Float32Array(width * height)
  let luminanceTotal = 0
  let darkPixels = 0
  let highlightPixels = 0

  for (let pixel = 0; pixel < luminance.length; pixel += 1) {
    const offset = pixel * 4
    const value =
      0.2126 * pixels[offset] +
      0.7152 * pixels[offset + 1] +
      0.0722 * pixels[offset + 2]
    luminance[pixel] = value
    luminanceTotal += value
    if (value < 25) darkPixels += 1
    if (value > 245) highlightPixels += 1
  }

  const meanLuminance = luminanceTotal / luminance.length
  const darkFraction = darkPixels / luminance.length
  const highlightFraction = highlightPixels / luminance.length

  let laplacianTotal = 0
  let laplacianSquaredTotal = 0
  let laplacianCount = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x
      const value =
        4 * luminance[index] -
        luminance[index - 1] -
        luminance[index + 1] -
        luminance[index - width] -
        luminance[index + width]
      laplacianTotal += value
      laplacianSquaredTotal += value * value
      laplacianCount += 1
    }
  }
  const laplacianMean = laplacianTotal / Math.max(laplacianCount, 1)
  const sharpness =
    laplacianSquaredTotal / Math.max(laplacianCount, 1) - laplacianMean ** 2

  const rejectionReasons: string[] = []
  if (meanLuminance < CGI_QUALITY_THRESHOLDS.minMeanLuminance) {
    rejectionReasons.push('underexposed')
  }
  if (meanLuminance > CGI_QUALITY_THRESHOLDS.maxMeanLuminance) {
    rejectionReasons.push('overexposed')
  }
  if (darkFraction > CGI_QUALITY_THRESHOLDS.maxDarkFraction) {
    rejectionReasons.push('too much darkness')
  }
  if (highlightFraction > CGI_QUALITY_THRESHOLDS.maxHighlightFraction) {
    rejectionReasons.push('too much glare')
  }
  if (sharpness < CGI_QUALITY_THRESHOLDS.minSharpness) {
    rejectionReasons.push('blurred')
  }

  return {
    accepted: rejectionReasons.length === 0,
    meanLuminance,
    darkFraction,
    highlightFraction,
    sharpness,
    rejectionReasons,
  }
}

function strongerGimFrame(left: FrameRecord, right: FrameRecord): FrameRecord {
  return compareGimStrength(left, right) >= 0 ? left : right
}

function compareGimStrength(left: FrameRecord, right: FrameRecord): number {
  const scoreDifference = (left.gim?.score ?? 0) - (right.gim?.score ?? 0)
  return scoreDifference || (left.gim?.area ?? 0) - (right.gim?.area ?? 0)
}
