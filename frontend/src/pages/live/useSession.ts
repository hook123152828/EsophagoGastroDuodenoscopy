import { useCallback, useEffect, useState } from 'react'

import {
  getFrames,
  getSession,
  subscribeSession,
  type FrameRecord,
  type SessionManifest,
} from '@/protocol'

interface SessionState {
  manifest: SessionManifest | null
  frames: FrameRecord[]
  error: string | null
}

/**
 * Tracks one session: manifest, progress and the frame table.
 *
 * Frames are fetched twice — once up front so the timeline is populated while
 * the scan is still running, and again on `ready` to pick up the results. A
 * full procedure is ~12,000 rows, which is a few MB and cheap to hold in
 * memory; every per-frame lookup afterwards is local.
 */
export function useSession(sessionId: string | null): SessionState & {
  refresh: () => void
} {
  const [manifest, setManifest] = useState<SessionManifest | null>(null)
  const [frames, setFrames] = useState<FrameRecord[]>([])
  const [error, setError] = useState<string | null>(null)

  const loadFrames = useCallback(async (id: string) => {
    try {
      setFrames(await getFrames(id))
    } catch (cause) {
      setError(String(cause))
    }
  }, [])

  useEffect(() => {
    if (!sessionId) {
      setManifest(null)
      setFrames([])
      return
    }

    let cancelled = false
    getSession(sessionId)
      .then((next) => !cancelled && setManifest(next))
      .catch((cause) => !cancelled && setError(String(cause)))
    loadFrames(sessionId)

    const unsubscribe = subscribeSession(sessionId, (event) => {
      if (cancelled) return
      if (event.type === 'progress') {
        setManifest((current) =>
          current ? { ...current, progress: event.progress } : current,
        )
      } else if (event.type === 'frames') {
        // Results stream in batch by batch; splice them into the table in place
        // so the timeline and readouts fill as the scan advances.
        setFrames((current) => {
          if (current.length === 0) return current
          const next = current.slice()
          for (const frame of event.frames) {
            if (frame.index < next.length) next[frame.index] = frame
          }
          return next
        })
      } else if (event.type === 'status') {
        setManifest((current) =>
          current
            ? { ...current, status: event.status, error: event.error }
            : current,
        )
      } else if (event.type === 'ready') {
        setManifest((current) =>
          current
            ? { ...current, status: 'ready', frame_count: event.frame_count }
            : current,
        )
        loadFrames(sessionId)
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId, loadFrames])

  return {
    manifest,
    frames,
    error,
    refresh: () => sessionId && loadFrames(sessionId),
  }
}
