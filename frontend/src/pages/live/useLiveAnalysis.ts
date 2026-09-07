import { useEffect, useRef, useState, type RefObject } from 'react'
import { MASK_LOOKAHEAD_S } from '@/components/maskPlayback'

import {
  analyzeFrame,
  frameAt,
  gimApplies,
  gimScannedAt,
  polypApplies,
  type FrameRecord,
} from '@/protocol'

/** ~30 Hz. Single-frame GNS round trip measures ~22 ms, so this keeps up. */
const INTERVAL_MS = 33

/** How long the LIVE indicator lingers after the last on-demand result. */
const ACTIVE_GRACE_MS = 1500

export interface LiveAnalysis {
  /** Result for the current timestamp, when the scan had not reached it yet. */
  frame: FrameRecord | null
  /** Round-trip time of the last on-demand request, for the live readout. */
  latencyMs: number | null
  /**
   * Whether analysis is currently running ahead of the scan.
   *
   * Separate from `frame`: an on-demand result is echoed back over SSE and
   * lands in the frame table within milliseconds, at which point `frame` is
   * dropped in favour of the cached record. Without a grace period the
   * indicator would flicker off immediately even though every frame on screen
   * is still being analysed on demand.
   */
  active: boolean
}

/**
 * Whether the frame under the playhead is still missing something.
 *
 * A frame GIM does not apply to is finished once GNS has run. A gastric NBI
 * frame is not: the scan runs its GIM pass only after GNS has covered the
 * whole procedure, so for most of a session such a frame already carries a
 * site but no mask, and asking for it here is the only thing that puts a mask
 * on screen before that pass arrives.
 *
 * What counts as covered is a GIM result *near* this frame, not one on it. The
 * scan samples GIM at a fraction of the extract rate, so most frames will
 * never carry one however long it runs -- and asking each of them for a pass
 * of its own meant the live analyser fired forever on a finished session, on
 * every other frame, feeding single-frame results into a readout that is
 * otherwise decided by consensus over a window. That is what made the IM cell
 * alternate between a score and no finding. The window is the one the display
 * reads on, so the rule is exactly: fire when the display would otherwise say
 * the frame was never scanned.
 *
 * Stricter than the gateway's own rule, which is NBI alone: a mask outside the
 * stomach would not be shown, so there is no reason to spend the GPU on it.
 *
 * The polyp pass is owed only while its overlay is on. Nothing runs it in the
 * background at all, and it is far dearer than the rest of the frame, so it is
 * not paid for by a page that is not showing it. Applying the site rule here
 * as well is what stops a frame the model is undefined on — anything under NBI
 * — from being asked for on every tick and never being satisfied.
 */
function pending(
  frames: FrameRecord[],
  frame: FrameRecord,
  wantPolyp: boolean,
): boolean {
  if (!frame.gns) return true
  if (gimApplies(frame.gns) && !gimScannedAt(frames, frame.t)) return true
  return wantPolyp && polypApplies(frame.gns) && !nearbyResult(frames, frame.t, 'polyp')
}

/** Reuse a nearby analysed sample, including negatives, instead of chasing every frame. */
function nearbyResult(frames: FrameRecord[], time: number, kind: 'gim' | 'polyp'): boolean {
  const start = frameAt(frames, time - 0.12)
  const at = frameAt(frames, time)
  if (!start || !at) return false
  for (let i = start.index; i < frames.length && frames[i].t <= time + 0.12; i++) {
    const frame = frames[i]
    if (Math.abs(frame.t - time) <= 0.12 && frame[kind] &&
        frame.gns?.modality === at.gns?.modality && frame.gns?.region === at.gns?.region) return true
  }
  return false
}

/**
 * Fills missing analysis at the playhead first. Once it is covered, playback
 * uses spare capacity to prepare a sample up to half a second ahead so the
 * overlay can interpolate towards it. Paused playback requests only its own
 * missing result. Future results reach the overlay through the session table.
 *
 * One request in flight at a time: the requests naturally serialise behind the
 * round trip, and dropping ticks is better than queueing stale timestamps
 * behind the playhead.
 */
export function useLiveAnalysis(
  sessionId: string | null,
  videoRef: RefObject<HTMLVideoElement | null>,
  frames: FrameRecord[],
  enabled: boolean,
  /** Whether to also ask for detection and segmentation of polyps. */
  wantPolyp: boolean,
): LiveAnalysis {
  const [state, setState] = useState<LiveAnalysis>({
    frame: null,
    latencyMs: null,
    active: false,
  })

  // Read through refs so the polling loop is not torn down and rebuilt every
  // time a batch of scan results lands.
  const framesRef = useRef(frames)
  framesRef.current = frames
  const inFlight = useRef(false)
  const lastResultAt = useRef(0)

  useEffect(() => {
    if (!sessionId || !enabled) return

    let cancelled = false
    let roundTripMs = 200

    const tick = async () => {
      const video = videoRef.current
      if (!video || video.seeking) return

      const stale = performance.now() - lastResultAt.current > ACTIVE_GRACE_MS
      const time = video.currentTime
      const cached = frameAt(framesRef.current, time)
      let requestTime = time
      let prefetch = false

      if (cached && !pending(framesRef.current, cached, wantPolyp)) {
        // The scan covers this timestamp. Drop the on-demand record at once so
        // the display never shows a result for a different frame, but let the
        // indicator fade on its own.
        setState((current) =>
          current.frame || (current.active && stale)
            ? { ...current, frame: null, active: current.active && !stale }
            : current,
        )
        if (video.paused || video.ended || !Number.isFinite(video.duration)) return
        // Use spare request capacity to get a right-hand interpolation endpoint.
        const lead = Math.min(MASK_LOOKAHEAD_S, Math.max(0.25, roundTripMs / 1000 * video.playbackRate + 0.1))
        requestTime = Math.min(video.duration, time + lead)
        const future = frameAt(framesRef.current, requestTime)
        if (!future || future.t <= time || Math.abs(future.t - requestTime) > 0.12) return
        const needed = !future.gns ||
          (gimApplies(future.gns) && !nearbyResult(framesRef.current, requestTime, 'gim')) ||
          (wantPolyp && polypApplies(future.gns) && !nearbyResult(framesRef.current, requestTime, 'polyp'))
        if (!needed) return
        prefetch = true
      }

      if (inFlight.current) return

      inFlight.current = true
      const started = performance.now()
      try {
        const frame = await analyzeFrame(sessionId, requestTime, { polyp: wantPolyp })
        if (!cancelled) {
          lastResultAt.current = performance.now()
          roundTripMs = lastResultAt.current - started
          setState({
            // Future results enter the frame table through SSE, never current readouts.
            frame: prefetch || video.seeking || Math.abs(video.currentTime - frame.t) > MASK_LOOKAHEAD_S ? null : frame,
            latencyMs: Math.round(roundTripMs),
            active: true,
          })
        }
      } catch {
        // A failed probe is not worth surfacing — the next tick retries.
      } finally {
        inFlight.current = false
      }
    }

    const handle = window.setInterval(tick, INTERVAL_MS)
    tick()

    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [sessionId, videoRef, enabled, wantPolyp])

  return state
}
