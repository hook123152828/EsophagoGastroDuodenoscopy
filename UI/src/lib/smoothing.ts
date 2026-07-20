// Temporal stabilization of the live signal.
//
// Raw per-frame predictions jitter (the GNS argmax flips between adjacent
// classes, the GIM score bounces across the 5%/30% area thresholds). The live
// readout instead shows a smoothed signal built from three combined rules:
//   1. EMA — exponential moving average of the GNS probability vector and the
//      GIM area, so single-frame outliers are damped.
//   2. Hysteresis — the committed site label only switches after a new label
//      persists for K frames, preventing rapid flip-flop.
//   3. Confidence gate — when the smoothed top probability is below a floor the
//      signal is reported as "uncertain" rather than a low-confidence guess.
//
// A single `windowN` parameter controls responsiveness: larger = steadier but
// slower to react to a real site change. windowN = 1 disables smoothing.
//
// On top of those, a *transition prior* encodes the anatomy of the procedure:
// the scope travels throat → esophagus → cardia/fundus → body → angle → antrum
// → duodenum and back, one station at a time. A frame classified as a station
// far from the committed one is more likely a misread than a real jump, so
// before folding into the EMA, probabilities of non-adjacent stations are
// scaled by max(0.15, 1 − 0.5·(distance−1)) and renormalised. Measured on both
// annotated procedures at 10 fps: site accuracy 68.7% → 70.2% (weighted),
// label flips 5.7→4.9 and 8.7→7.6 per minute, uncertain time also down.
// Strengths 0.4–0.7 all sit on the same plateau; 0.9 over-suppresses and
// collapses. The 0.15 floor keeps a real (if unusual) jump reachable.

import { ORDINAL_OF_CLASS } from './anatomy'
import { modeOf } from '../types'

const TRANSITION_PRIOR = 0.5

function argmaxKey(probs: Record<string, number>): string {
  let bestKey = ''
  let best = -Infinity
  for (const [k, v] of Object.entries(probs)) {
    if (v > best) {
      best = v
      bestKey = k
    }
  }
  return bestKey
}

export interface FrameSignal {
  probs?: Record<string, number>
  area?: number
  score?: 0 | 1 | 2
  timestamp?: number
}

export interface SmoothedSignal {
  siteLabel: string | null
  siteConfidence: number
  uncertain: boolean
  // The site is a persistent state, so it is smoothed. Intestinal metaplasia is
  // not: a lesion is only well-framed for a fraction of a second (measured on a
  // real procedure: 5 flagged frames out of 198 across a 33-second segment, in
  // bursts of 0.17–0.33s). Averaging that away would hide the very finding the
  // 30 fps sampling exists to catch, so IM is peak-held and reported as an
  // event — highest score seen, when, and how many frames confirm it.
  imPeakScore: 0 | 1 | 2
  imPeakArea: number
  imPeakAt: number | null
  imFlaggedCount: number
  count: number
}

// GNS spreads its 16-class softmax thinly — a confident top-1 is only ~0.47,
// with the rest near 0.03. An absolute floor near that ceiling would leave no
// headroom: any smoothing that mixes in one differing frame would dilute the
// peak below it and pin the signal to "uncertain" forever. So the gate is
// primarily a *margin* over the runner-up (scale-invariant on flat
// distributions), with a low absolute floor as a backstop.
const CONFIDENCE_FLOOR = 0.18
const CONFIDENCE_MARGIN = 0.06

function topTwo(probs: Record<string, number>): [string, number, number] {
  let bestKey = ''
  let best = -Infinity
  let second = -Infinity
  for (const [k, v] of Object.entries(probs)) {
    if (v > best) {
      second = best
      best = v
      bestKey = k
    } else if (v > second) {
      second = v
    }
  }
  return [bestKey, best, second === -Infinity ? 0 : second]
}

export function smoothStream(stream: FrameSignal[], windowN: number): SmoothedSignal {
  const n = Math.max(1, Math.round(windowN))
  const alpha = n <= 1 ? 1 : 2 / (n + 1)
  // Hysteresis scales with the window rather than being capped at a fixed frame
  // count: a cap that is a comfortable 0.8s at 5 fps shrinks to 0.13s at 30 fps,
  // where it stops holding anything. Measured against the annotated procedure at
  // 30 fps / window 30, dropping the old cap of 4 halved the label jitter
  // (12.4 -> 6.4 flips per minute) and slightly raised accuracy (76.4 -> 77.1%).
  const holdK = Math.max(1, Math.round(n / 2))

  let emaProbs: Record<string, number> | null = null

  let imPeakScore: 0 | 1 | 2 = 0
  let imPeakArea = 0
  let imPeakAt: number | null = null
  let imFlaggedCount = 0

  let committed: string | null = null
  let candidate: string | null = null
  let candidateCount = 0
  let lastTop = 0
  let lastConfident = false

  let count = 0

  for (const item of stream) {
    if (item.probs) {
      // Apply the anatomical transition prior relative to the committed station.
      let probs = item.probs
      const committedOrd = committed !== null ? ORDINAL_OF_CLASS[committed] : undefined
      if (committedOrd !== undefined) {
        const scaled: Record<string, number> = {}
        let sum = 0
        for (const [k, v] of Object.entries(probs)) {
          const ord = ORDINAL_OF_CLASS[k]
          const dist = ord === undefined ? 0 : Math.abs(ord - committedOrd)
          const w = v * Math.max(0.15, 1 - TRANSITION_PRIOR * Math.max(0, dist - 1))
          scaled[k] = w
          sum += w
        }
        if (sum > 0) {
          for (const k of Object.keys(scaled)) scaled[k] /= sum
          probs = scaled
        }
      }

      emaProbs = emaProbs
        ? Object.fromEntries(
            Object.keys(probs).map((k) => [
              k,
              alpha * probs[k] + (1 - alpha) * (emaProbs![k] ?? probs[k]),
            ]),
          )
        : { ...probs }

      const [curLabel, curTop, curSecond] = topTwo(emaProbs)
      lastTop = curTop
      lastConfident = curTop >= CONFIDENCE_FLOOR && curTop - curSecond >= CONFIDENCE_MARGIN

      if (!lastConfident) {
        candidate = null
        candidateCount = 0
      } else if (committed === null) {
        committed = curLabel
        candidate = null
        candidateCount = 0
      } else if (curLabel === committed) {
        candidate = null
        candidateCount = 0
      } else if (curLabel === candidate) {
        candidateCount += 1
        if (candidateCount >= holdK) {
          committed = curLabel
          candidate = null
          candidateCount = 0
        }
      } else {
        candidate = curLabel
        candidateCount = 1
        if (candidateCount >= holdK) {
          committed = curLabel
          candidate = null
          candidateCount = 0
        }
      }
      count += 1
    }

    // GIM was trained only on NBI images (per its paper), and IM is clinically
    // an NBI finding, so a score on a white-light frame is off-distribution and
    // is ignored — mirroring CGI's white-light-only rule.
    if (typeof item.score === 'number' && item.probs && modeOf(argmaxKey(item.probs)) === 'NBI') {
      if (item.score >= 1) imFlaggedCount += 1
      const area = item.area ?? 0
      if (item.score > imPeakScore || (item.score === imPeakScore && area > imPeakArea)) {
        imPeakScore = item.score
        imPeakArea = area
        imPeakAt = item.timestamp ?? null
      }
    }
  }

  const uncertain = committed === null || !lastConfident

  return {
    siteLabel: committed,
    siteConfidence: committed && emaProbs ? emaProbs[committed] : lastTop,
    uncertain,
    imPeakScore,
    imPeakArea: Math.round(imPeakArea * 100) / 100,
    imPeakAt,
    imFlaggedCount,
    count,
  }
}
