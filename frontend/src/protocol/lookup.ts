/**
 * Frame lookup by video time.
 *
 * Extraction, GNS and GIM each run at their own sampling rate, so a frame's
 * index says nothing about when it happened. `t` is the only alignment key.
 */

import { REGION_ORDER, type FrameRecord, type RegionId } from './types'

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

/**
 * The most recent frame at or before `time` that carries a polyp result.
 *
 * Sparser still than GIM: nothing runs the polyp pass in the background, so a
 * frame has a result only where someone asked for one. The same staleness cap
 * applies for the same reason — half a second of scope movement is enough to
 * put an outline over mucosa it was never drawn for.
 */
export function polypFrameAt(
  frames: FrameRecord[],
  time: number,
  maxAge = 0.5,
): FrameRecord | null {
  const current = frameAt(frames, time)
  if (!current) return null

  for (let i = current.index; i >= 0 && current.t - frames[i].t <= maxAge; i--) {
    if (frames[i]?.polyp?.mask_url) return frames[i]
  }
  return null
}

export interface RegionSpan {
  region: RegionId
  start: number
  end: number
}

/*
 * Smoothing of the site readout.
 *
 * Per-frame GNS output is far noisier than the procedure it describes: on
 * video1.mp4 the raw label changes 692 times where the endoscopist visits 23
 * sites, most runs lasting a fifth of a second. Shown frame by frame the site
 * flickers between neighbours instead of naming where the scope is.
 *
 * The readout is therefore a confidence-weighted vote over a trailing window
 * that only moves on sustained evidence. The three constants below were fitted
 * against the annotated ground truth of video1.mp4: 692 changes become 45,
 * agreement with the annotation rises from 72% to 75%, and the readout names a
 * new site a median 1.1 s after the scope arrives there.
 */

/** Trailing window the vote is taken over. */
export const REGION_WINDOW_S = 3

/** How long a challenger must lead before the readout follows it. */
export const REGION_DWELL_S = 0.4

/** Lead the challenger needs over the incumbent, in mean confidence. */
export const REGION_MARGIN = 0.05

/**
 * Resolution the track is built at.
 *
 * Frames are extracted at 60 fps; the readout is a word on a panel and needs
 * nothing near that. Ingesting one frame per 100 ms keeps the whole track
 * cheap enough to rebuild every time a batch of scan results lands.
 */
export const TRACK_STEP_S = 0.1

/**
 * How long the scope must have been watched in a region for it to count as
 * seen, in seconds.
 *
 * A fixed standard rather than a fraction of the current recording: measured
 * over every frame of video1.mp4, which is a complete diagnostic examination,
 * and set at 80% of the time that examination spent in each region. Wired in
 * as constants so a region is judged against what a full examination looks
 * like — the checklist means the same thing on a video that skips the
 * duodenum as on the one it was fitted to, and it no longer depends on the
 * background scan having finished before it can say anything.
 *
 * Measured with the smoothed track below over all 50,455 frames of video1.mp4
 * — oesophagus 256.0 s, cardia 63.2 s, body 271.5 s, angle 65.4 s, antrum
 * 122.8 s, duodenum 38.9 s — and rounded to whole seconds. `unknown` can never
 * be ticked off: unclassified footage is not an examined site.
 */
export const SEEN_SECONDS: Record<RegionId, number> = {
  esophagus: 205,
  cardia: 51,
  body: 217,
  angle: 52,
  antrum: 98,
  duodenum: 31,
  unknown: Infinity,
}

const ALL_REGIONS: RegionId[] = [...REGION_ORDER, 'unknown']

export interface RegionTrack {
  /** Stabilised samples, ascending by `t`, about one every TRACK_STEP_S. */
  samples: { t: number; region: RegionId }[]
  /** The same thing as contiguous runs — where the time is actually counted. */
  spans: RegionSpan[]
}

/**
 * The stabilised site over the whole procedure.
 *
 * Built from `gns.region` and `gns.confidence` only: the 16 classes map to
 * regions in `backend/protocol.py`, which is the single source of that truth,
 * and the frontend must not keep a second copy of it.
 *
 * Frames the scan has not reached are skipped rather than treated as a gap, so
 * this works just as well on the sparse results that on-demand analysis leaves
 * behind during live playback as it does on a finished scan.
 */
export function buildRegionTrack(frames: FrameRecord[]): RegionTrack {
  const samples: RegionTrack['samples'] = []
  const spans: RegionSpan[] = []

  // Running confidence sum per region over the window, updated as frames enter
  // and leave, so each step costs the same no matter how wide the window is.
  const window: { t: number; region: RegionId; confidence: number }[] = []
  const sums = new Map<RegionId, number>()
  let shown: RegionId = 'unknown'
  let challenger: RegionId | null = null
  let challengerSince = 0
  let lastIngested = -Infinity

  for (const frame of frames) {
    if (!frame.gns || frame.t - lastIngested < TRACK_STEP_S) continue

    // A gap wider than the window means the results either side of it are not
    // evidence about the same moment — playback jumped, or the scan has only
    // reached here and there. Start again from the new frame rather than
    // carrying a site over the gap, which is how the readout used to end up
    // naming a region minutes away from the one on screen.
    if (frame.t - lastIngested > REGION_WINDOW_S) {
      window.length = 0
      sums.clear()
      shown = frame.gns.region
      challenger = null
    }
    lastIngested = frame.t

    window.push({
      t: frame.t,
      region: frame.gns.region,
      confidence: frame.gns.confidence,
    })
    sums.set(frame.gns.region, (sums.get(frame.gns.region) ?? 0) + frame.gns.confidence)

    while (window.length > 0 && window[0].t < frame.t - REGION_WINDOW_S) {
      const dropped = window.shift()!
      sums.set(dropped.region, (sums.get(dropped.region) ?? 0) - dropped.confidence)
    }

    // Ties go to whatever is on screen — the readout never moves for free.
    let leader: RegionId = shown
    let best = sums.get(shown) ?? 0
    for (const region of ALL_REGIONS) {
      const value = sums.get(region) ?? 0
      if (value > best) {
        best = value
        leader = region
      }
    }

    if (leader === shown) {
      challenger = null
    } else {
      if (leader !== challenger) {
        challenger = leader
        challengerSince = frame.t
      }
      const lead = (best - (sums.get(shown) ?? 0)) / window.length
      if (frame.t - challengerSince >= REGION_DWELL_S && lead >= REGION_MARGIN) {
        shown = leader
        challenger = null
      }
    }

    samples.push({ t: frame.t, region: shown })
    const last = spans[spans.length - 1]
    if (last && last.region === shown) last.end = frame.t
    else spans.push({ region: shown, start: frame.t, end: frame.t })
  }

  return { samples, spans }
}

/** The stabilised site at `time` — what the panel names. */
export function trackRegionAt(track: RegionTrack, time: number): RegionId {
  const { samples } = track
  if (samples.length === 0 || time < samples[0].t) return 'unknown'

  let low = 0
  let high = samples.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (samples[mid].t <= time) low = mid
    else high = mid - 1
  }
  return samples[low].region
}

/**
 * How many seconds of each region have been played past.
 *
 * Counted off the spans rather than the samples, so it is real video time and
 * not a count of however densely the scan happened to be sampled. There are a
 * few dozen spans in a procedure, which is cheap enough to call on every
 * animation frame.
 */
export function watchedSeconds(
  track: RegionTrack,
  time: number,
): Record<RegionId, number> {
  const watched = Object.fromEntries(
    ALL_REGIONS.map((region) => [region, 0]),
  ) as Record<RegionId, number>

  for (const span of track.spans) {
    if (span.start >= time) break
    watched[span.region] += Math.min(span.end, time) - span.start
  }
  return watched
}

/**
 * The regions the operator has covered — the checklist.
 *
 * A region is only ticked off once it has been watched for `SEEN_SECONDS`, so
 * the mark means the site was examined rather than passed through. Regions the
 * scan has not classified yet simply never reach their standard.
 */
export function seenRegions(track: RegionTrack, time: number): Set<RegionId> {
  const watched = watchedSeconds(track, time)
  return new Set(
    ALL_REGIONS.filter((region) => watched[region] >= SEEN_SECONDS[region]),
  )
}

/**
 * Contiguous runs of the same region — the timeline's coloured bands.
 *
 * Read off the same track as the site readout, so the two can never disagree
 * about where the scope was.
 */
export function regionSpans(track: RegionTrack, minDuration = 0.5): RegionSpan[] {
  return track.spans.filter((span) => span.end - span.start >= minDuration)
}
