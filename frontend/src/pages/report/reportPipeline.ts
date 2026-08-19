import {
  fileUrl,
  type CgiPair,
  type FrameRecord,
  type RegionId,
} from '@/protocol'

const CGI_POOL_SIZE = 4
const CGI_MIN_GAP_S = 2
const GIM_EVIDENCE_SIZE = 6
const GIM_MIN_GAP_S = 1

export type CgiRegion = Extract<RegionId, 'antrum' | 'body' | 'cardia'>

export interface EncodedFrame {
  frame: FrameRecord
  base64: string
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
  const ranked = frames
    .filter(
      (frame) =>
        frame.gns?.modality === 'WL' && frame.gns.region === region,
    )
    .sort(
      (left, right) =>
        (right.gns?.confidence ?? 0) - (left.gns?.confidence ?? 0),
    )

  const selected: FrameRecord[] = []
  for (const frame of ranked) {
    if (selected.every((item) => Math.abs(item.t - frame.t) >= CGI_MIN_GAP_S)) {
      selected.push(frame)
      if (selected.length === CGI_POOL_SIZE) break
    }
  }

  // Very short clips may not contain four frames two seconds apart. Fill the
  // remaining slots so CGI can still run, while preserving confidence order.
  for (const frame of ranked) {
    if (selected.length === CGI_POOL_SIZE) break
    if (!selected.includes(frame)) selected.push(frame)
  }

  return selected.sort((left, right) => left.t - right.t)
}

export function selectGimEvidence(frames: FrameRecord[]): FrameRecord[] {
  const ranked = frames
    .filter((frame) => (frame.gim?.score ?? 0) >= 1)
    .sort((left, right) => {
      const scoreDifference = (right.gim?.score ?? 0) - (left.gim?.score ?? 0)
      return scoreDifference || (right.gim?.area ?? 0) - (left.gim?.area ?? 0)
    })

  const selected: FrameRecord[] = []
  for (const frame of ranked) {
    if (selected.every((item) => Math.abs(item.t - frame.t) >= GIM_MIN_GAP_S)) {
      selected.push(frame)
      if (selected.length === GIM_EVIDENCE_SIZE) break
    }
  }
  return selected.sort((left, right) => left.t - right.t)
}

export async function encodeCgiPools(frames: FrameRecord[]): Promise<CgiPools> {
  const [antrum, body, cardia] = await Promise.all(
    (['antrum', 'body', 'cardia'] as const).map(async (region) =>
      Promise.all(
        selectCgiCandidates(frames, region).map(async (frame) => ({
          frame,
          base64: await fetchFrameAsBase64(frame),
        })),
      ),
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
  }))
}

export function jpegDataUrl(base64: string): string {
  return `data:image/jpeg;base64,${base64}`
}

async function fetchFrameAsBase64(frame: FrameRecord): Promise<string> {
  const response = await fetch(fileUrl(frame.image_url))
  if (!response.ok) {
    throw new Error(`Could not load frame ${frame.index} (${response.status})`)
  }

  const blob = await response.blob()
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not encode frame'))
    reader.readAsDataURL(blob)
  })

  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}
