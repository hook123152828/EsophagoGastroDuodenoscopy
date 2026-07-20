import { useCallback, useRef, useState } from 'react'
import type { ExtractedFrame, GnsResult, GimResult } from '../types'
import { classifyGns, segmentGim } from '../api/gateway'

export interface FrameAnalysis {
  gns?: GnsResult
  gim?: GimResult
  status: 'pending' | 'done' | 'error'
  error?: string
}

// A dense, lightweight record of every analysed frame's signal, kept for the
// whole procedure regardless of image retention. The frame images are released
// down to one per class to bound memory, but these few floats per frame are
// cheap to keep and are what the smoothed live signal is actually folded over —
// without them the smoothing would see only the sparse key frames.
export interface SignalPoint {
  timestamp: number
  probs?: Record<string, number>
  area?: number
  score?: 0 | 1 | 2
}

// Frames are sent in groups: GNS batches natively (~5.9 ms/frame at 8, vs 24 ms
// alone) and the gateway walks the group through GIM, whose ~29 ms/frame is the
// real ceiling — about 34 fps, which is what makes 30 fps sampling viable.
const BATCH = 8

// Live streaming queue: frames are enqueued as they are captured during
// playback and processed strictly in order. Nothing is ever dropped — if the
// backend lags behind playback the queue simply grows and drains over time.
export function useFrameAnalysis() {
  const [analyses, setAnalyses] = useState<Record<string, FrameAnalysis>>({})
  const [signalLog, setSignalLog] = useState<SignalPoint[]>([])
  const [queueDepth, setQueueDepth] = useState(0)
  const queueRef = useRef<ExtractedFrame[]>([])
  const drainingRef = useRef(false)

  const setFrame = useCallback((id: string, patch: Partial<FrameAnalysis>) => {
    setAnalyses((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { status: 'pending' }), ...patch },
    }))
  }, [])

  const processBatch = useCallback(
    async (batch: ExtractedFrame[]) => {
      const blobs = batch.map((f) => f.blob)
      try {
        const [gns, gim] = await Promise.all([classifyGns(blobs), segmentGim(blobs)])
        setAnalyses((prev) => {
          const next = { ...prev }
          batch.forEach((frame, i) => {
            next[frame.id] = { gns: gns[i], gim: gim[i], status: 'done' }
          })
          return next
        })
        // Record every frame's signal in the dense log, ordered by media time.
        // Batches usually extend the tail; a seek-back can land one earlier, so
        // sort only when needed.
        setSignalLog((prev) => {
          const pts: SignalPoint[] = batch.map((frame, i) => ({
            timestamp: frame.timestamp,
            probs: gns[i]?.probs,
            area: gim[i]?.area,
            score: gim[i]?.score,
          }))
          const next = [...prev, ...pts]
          const tail = prev.length ? prev[prev.length - 1].timestamp : -Infinity
          if (pts.some((p) => p.timestamp < tail)) next.sort((a, b) => a.timestamp - b.timestamp)
          return next
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setAnalyses((prev) => {
          const next = { ...prev }
          batch.forEach((frame) => {
            next[frame.id] = { status: 'error', error: message }
          })
          return next
        })
      }
    },
    [],
  )

  const drain = useCallback(async () => {
    if (drainingRef.current) return
    drainingRef.current = true
    try {
      while (queueRef.current.length > 0) {
        const batch = queueRef.current.splice(0, BATCH)
        await processBatch(batch)
        setQueueDepth(queueRef.current.length)
      }
    } finally {
      drainingRef.current = false
      setQueueDepth(0)
    }
  }, [processBatch])

  const enqueue = useCallback(
    (frames: ExtractedFrame[]) => {
      setAnalyses((prev) => {
        const next = { ...prev }
        for (const f of frames) next[f.id] = { status: 'pending' }
        return next
      })
      queueRef.current.push(...frames)
      setQueueDepth(queueRef.current.length)
      void drain()
    },
    [drain],
  )

  const retryFrame = useCallback(
    (frame: ExtractedFrame) => {
      setFrame(frame.id, { status: 'pending', error: undefined })
      queueRef.current.push(frame)
      void drain()
    },
    [drain, setFrame],
  )

  const reset = useCallback(() => {
    queueRef.current = []
    setAnalyses({})
    setSignalLog([])
    setQueueDepth(0)
  }, [])

  return { analyses, signalLog, enqueue, retryFrame, reset, queueDepth }
}
