import { fileUrl, gimApplies, polypApplies, type FrameRecord } from '@/protocol'

export const MASK_LOOKAHEAD_S = 0.5
export const MASK_SMOOTH_RADIUS_S = 0.4
export const MASK_KNOT_S = 0.1
export type MaskKind = 'gim' | 'polyp'
export interface MaskSample { t: number; src: string | null }
export interface MaskWindow {
  samples: MaskSample[]
  /** Contiguous classification segment; a seek must not reuse the previous segment. */
  from: number
  to: number
}
export const EMPTY_MASK_WINDOW: MaskWindow = { samples: [], from: 0, to: 0 }

/** Playback-only temporal context. Keep negatives as evidence, not immediate hide commands. */
export function maskWindowAt(
  frames: FrameRecord[], time: number, kind: MaskKind, live: FrameRecord | null,
): MaskWindow {
  let low = 0
  let high = frames.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (frames[mid].t < time - MASK_LOOKAHEAD_S) low = mid + 1
    else high = mid
  }
  const nearby: FrameRecord[] = []
  for (let i = low; i < frames.length && frames[i].t <= time + MASK_LOOKAHEAD_S; i++) {
    nearby.push(frames[i])
  }
  if (live && Math.abs(live.t - time) <= MASK_LOOKAHEAD_S && live[kind]) {
    const index = nearby.findIndex(frame => frame.index === live.index)
    if (index < 0) nearby.push(live)
    else if (!nearby[index][kind]) nearby[index] = live
    nearby.sort((a, b) => a.t - b.t)
  }
  const applies = kind === 'gim' ? gimApplies : polypApplies
  const current = [...nearby].reverse().find(frame => frame.t <= time)
  if (!current || !applies(current.gns)) return EMPTY_MASK_WINDOW
  const sameScene = (frame: FrameRecord) => applies(frame.gns) &&
    frame.gns?.region === current.gns?.region
  const currentIndex = nearby.indexOf(current)
  let start = currentIndex
  let end = currentIndex
  while (start > 0 && sameScene(nearby[start - 1])) start--
  while (end + 1 < nearby.length && sameScene(nearby[end + 1])) end++
  return {
    from: start > 0 ? nearby[start].t : time - MASK_LOOKAHEAD_S,
    to: end + 1 < nearby.length ? nearby[end + 1].t : time + MASK_LOOKAHEAD_S,
    samples: nearby.slice(start, end + 1).filter(frame => frame[kind]).map(frame => ({
      t: frame.t,
      src: frame[kind]!.mask_url ? fileUrl(frame[kind]!.mask_url!) : null,
    })),
  }
}

/** Compact, continuous weights: samples enter and leave the window at zero weight. */
export function temporalWeight(time: number, sampleTime: number): number {
  const distance = Math.abs(time - sampleTime) / MASK_SMOOTH_RADIUS_S
  return distance >= 1 ? 0 : (1 - distance * distance) ** 2
}

/** Several agreeing samples make a visible finding; a single flicker does not. */
export function maskPresence(samples: MaskSample[], time: number): number {
  let positive = 0
  let total = 0
  let count = 0
  for (const sample of samples) {
    const weight = temporalWeight(time, sample.t)
    total += weight
    if (sample.src && weight > 0) { positive += weight; count++ }
  }
  if (count < 2 || total === 0) return 0
  const support = Math.max(0, Math.min(1, (positive / total - 0.12) / 0.48))
  const nearest = Math.min(...samples.filter(sample => sample.src).map(sample => Math.abs(time - sample.t)))
  // In a sparsely analysed stretch, evidence expires even if no negative arrives.
  const freshness = Math.max(0, Math.min(1, (MASK_SMOOTH_RADIUS_S - nearest) / 0.15))
  return Math.min(support * support * (3 - 2 * support), freshness)
}
