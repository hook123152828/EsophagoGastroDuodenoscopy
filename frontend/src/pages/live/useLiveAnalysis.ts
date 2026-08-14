import { useEffect, useRef, useState, type RefObject } from 'react'

import { analyzeFrame, frameAt, type FrameRecord } from '@/protocol'

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
 * Analyses whatever is on screen right now, ahead of the background scan.
 *
 * The scan streams its results in, so most of the time the frame under the
 * playhead is already classified and this does nothing. It only fires where the
 * scan has not reached — which, right after loading a video, is everywhere.
 *
 * One request in flight at a time: at 30 Hz with a ~22 ms round trip the
 * requests naturally serialise, and dropping ticks is better than queueing
 * stale timestamps behind the playhead.
 */
export function useLiveAnalysis(
  sessionId: string | null,
  videoRef: RefObject<HTMLVideoElement | null>,
  frames: FrameRecord[],
  enabled: boolean,
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

      if (cached?.gns) {
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
        const frame = await analyzeFrame(sessionId, time)
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
  }, [sessionId, videoRef, enabled])

  return state
}
