/**
 * Frame lookup by video time.
 *
 * Extraction, GNS and GIM each run at their own sampling rate, so a frame's
 * index says nothing about when it happened. `t` is the only alignment key.
 */

import type { FrameRecord, RegionId } from './types'

/**
 * The frame that should be on screen at `time`.
 *
 * Binary search for the last frame at or before `time`; returns the first
 * frame when `time` precedes it. Frames must be sorted by `t` — the gateway
 * guarantees that.
 */
export function frameAt(frames: FrameRecord[], time: number): FrameRecord | null {
  if (frames.length === 0) return null
  if (time <= frames[0].t) return frames[0]

  let low = 0
  let high = frames.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (frames[mid].t <= time) low = mid
    else high = mid - 1
  }
  return frames[low]
}

/**
 * The most recent frame at or before `time` that carries a GIM result.
 *
 * GIM runs at a lower rate than playback and skips white-light frames
 * entirely, so the nearest frame often has nothing to show. `maxAge` caps how
 * stale a mask may be before it is dropped — without it, a mask from a
 * previous NBI segment would linger over unrelated mucosa.
 */
export function gimFrameAt(
  frames: FrameRecord[],
  time: number,
  maxAge = 0.5,
): FrameRecord | null {
  const current = frameAt(frames, time)
  if (!current) return null

  for (let i = current.index; i >= 0 && current.t - frames[i].t <= maxAge; i--) {
    if (frames[i]?.gim) return frames[i]
  }
  return null
}

export interface RegionSpan {
  region: RegionId
  start: number
  end: number
}

/** Contiguous runs of the same region — the timeline's coloured bands. */
export function regionSpans(frames: FrameRecord[], minDuration = 0.5): RegionSpan[] {
  const spans: RegionSpan[] = []

  for (const frame of frames) {
    const region = frame.gns?.region ?? 'unknown'
    const last = spans[spans.length - 1]
    if (last && last.region === region) last.end = frame.t
    else spans.push({ region, start: frame.t, end: frame.t })
  }

  return spans.filter((span) => span.end - span.start >= minDuration)
}
