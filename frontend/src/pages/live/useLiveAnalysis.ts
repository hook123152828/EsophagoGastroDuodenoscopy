import { useEffect, useRef, useState, type RefObject } from 'react'

import {
  analyzeFrame,
  frameAt,
  gimApplies,
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
 * Stricter than the gateway's own rule, which is NBI alone: a mask outside the
 * stomach would not be shown, so there is no reason to spend the GPU on it.
 *
 * The polyp pass is owed only while its overlay is on. Nothing runs it in the
 * background at all, and it is far dearer than the rest of the frame, so it is
 * not paid for by a page that is not showing it. Applying the site rule here
 * as well is what stops a frame the model is undefined on — anything under NBI
 * — from being asked for on every tick and never being satisfied.
 */
function pending(frame: FrameRecord, wantPolyp: boolean): boolean {
  if (!frame.gns) return true
  if (gimApplies(frame.gns) && !frame.gim) return true
  return wantPolyp && polypApplies(frame.gns) && !frame.polyp
}

/**
 * Analyses whatever is on screen right now, ahead of the background scan.
 *
 * Fires wherever the frame under the playhead is still incomplete: everywhere
 * right after loading a video, and on every gastric NBI frame the GIM pass has
 * not reached. The mask lands a few hundred milliseconds late as a result —
 * what is on screen matters more than being in step with it.
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

    const tick = async () => {
      const video = videoRef.current
      if (!video) return

      const stale = performance.now() - lastResultAt.current > ACTIVE_GRACE_MS
      const time = video.currentTime
      const cached = frameAt(framesRef.current, time)

      if (cached && !pending(cached, wantPolyp)) {
        // The scan covers this timestamp. Drop the on-demand record at once so
        // the display never shows a result for a different frame, but let the
        // indicator fade on its own.
        setState((current) =>
          current.frame || (current.active && stale)
            ? { ...current, frame: null, active: current.active && !stale }
            : current,
        )
        return
      }

      if (inFlight.current) return

      inFlight.current = true
      const started = performance.now()
      try {
        const frame = await analyzeFrame(sessionId, time, { polyp: wantPolyp })
        if (!cancelled) {
          lastResultAt.current = performance.now()
          setState({
            frame,
            latencyMs: Math.round(lastResultAt.current - started),
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
