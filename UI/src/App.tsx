import { useEffect, useMemo, useRef, useState } from 'react'
import type { CgiPair, ExtractedFrame } from './types'
import { modeOf } from './types'
import { captureSquareFrame, detectScopeRoi, blobToBase64, type Roi } from './lib/frameExtractor'
import { smoothStream } from './lib/smoothing'
import { SITE_OF_CLASS } from './lib/siteMapping'
import { useFrameAnalysis } from './hooks/useFrameAnalysis'
import { useUsbCamera } from './hooks/useUsbCamera'
import { analyzeCgi } from './api/gateway'
import { TopBar } from './components/TopBar'
import { ControlBar } from './components/ControlBar'
import { ScopeStage } from './components/ScopeStage'
import { LiveRail } from './components/LiveRail'
import { Inspector } from './components/Inspector'
import { Filmstrip } from './components/Filmstrip'
import { CgiDrawer, type BinKey, type Bins } from './components/CgiDrawer'

const EMPTY_BINS: Bins = { A: [], B: [], C: [] }

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
}

function insertByTime(list: ExtractedFrame[], frame: ExtractedFrame): ExtractedFrame[] {
  const next = [...list]
  let i = next.length
  while (i > 0 && next[i - 1].timestamp > frame.timestamp) i--
  next.splice(i, 0, frame)
  return next
}

export default function App() {
  // `frames` holds only the frames worth keeping — see the retention effect
  // below. `sampledCount` is the true number captured, since at 30 fps a full
  // procedure samples tens of thousands and almost none of them are kept.
  const [frames, setFrames] = useState<ExtractedFrame[]>([])
  const [sampledCount, setSampledCount] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Defaults tuned against the annotated procedure: 30 fps is what catches a
  // brief IM lesion at all (1 fps missed it entirely), and a 30-frame window —
  // 1.0s at that rate — was the best accuracy/jitter trade-off measured
  // (77.1% site accuracy, 6.4 label flips per minute against 2.5 real ones).
  const [fps, setFps] = useState(30)
  const [windowN, setWindowN] = useState(30)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [sourceMode, setSourceMode] = useState<'file' | 'usb'>('file')
  // Current playback position (file sources only), so the live readout tracks
  // the playhead instead of the furthest-sampled point after a seek.
  const [playhead, setPlayhead] = useState(0)

  const [manualBins, setManualBins] = useState<Bins>(EMPTY_BINS)
  const [binsManual, setBinsManual] = useState(false)
  const [cgiResult, setCgiResult] = useState<CgiPair | null>(null)
  const [cgiError, setCgiError] = useState<string | null>(null)
  const [analyzingCgi, setAnalyzingCgi] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)

  const { analyses, signalLog, enqueue, retryFrame, reset, queueDepth } = useFrameAnalysis()
  const camera = useUsbCamera()
  const hasSource = !!videoUrl || !!camera.stream

  const videoRef = useRef<HTMLVideoElement>(null)
  const fpsRef = useRef(fps)
  const sampledSlotsRef = useRef<Set<number>>(new Set())
  const startMsRef = useRef(0)
  const roiRef = useRef<Roi | null>(null)
  useEffect(() => {
    fpsRef.current = fps
  }, [fps])

  const selectedFrame = useMemo(
    () => frames.find((f) => f.id === selectedId) ?? null,
    [frames, selectedId],
  )

  // One representative frame per GNS class. Within a class an IM finding wins,
  // ranked by score then area (the lesion is what a physician returns to);
  // otherwise the clearest view, by GNS confidence. This is both the key-frame
  // set shown on the timeline and the source for the CGI bays.
  const bestPerClass = useMemo(() => {
    type Cand = { id: string; imScore: number; imArea: number; conf: number }
    const better = (a: Cand, b: Cand) => {
      if (a.imScore !== b.imScore) return a.imScore > b.imScore
      if (a.imScore >= 1 && a.imArea !== b.imArea) return a.imArea > b.imArea
      return a.conf > b.conf
    }
    const best = new Map<string, Cand>()
    for (const f of frames) {
      const a = analyses[f.id]
      if (a?.status !== 'done' || !a.gns) continue
      // IM only counts on NBI frames (GIM is an NBI model), so a white-light
      // class is never chosen for its — untrustworthy — IM score.
      const imValid = modeOf(a.gns.class_name) === 'NBI'
      const cand: Cand = {
        id: f.id,
        imScore: imValid ? a.gim?.score ?? 0 : 0,
        imArea: imValid ? a.gim?.area ?? 0 : 0,
        conf: a.gns.confidence,
      }
      const cur = best.get(a.gns.class_name)
      if (!cur || better(cand, cur)) best.set(a.gns.class_name, cand)
    }
    return best
  }, [frames, analyses])

  // The retained best frame of each white-light class feeds its CGI site.
  const autoBins = useMemo<Bins>(() => {
    const out: Bins = { A: [], B: [], C: [] }
    for (const [cls, cand] of bestPerClass) {
      const site = SITE_OF_CLASS[cls]
      if (site) out[site].push(cand.id)
    }
    return out
  }, [bestPerClass])

  const bins = binsManual ? manualBins : autoBins

  // Surface the first IM finding without waiting to be asked.
  useEffect(() => {
    if (selectedId) return
    const firstIm = frames.find((f) => (analyses[f.id]?.gim?.score ?? 0) >= 1)
    if (firstIm) setSelectedId(firstIm.id)
  }, [frames, analyses, selectedId])

  // Keep only one frame per GNS class (the best, above), plus frames still being
  // analysed, anything in a manual bin, and the current selection. Everything
  // else is released — at 30 fps the discarded images would run to hundreds of
  // megabytes, while their analysis metadata (kept in `analyses`, and all the
  // report needs) costs almost nothing.
  useEffect(() => {
    const keep = new Set<string>()
    for (const f of frames) {
      const a = analyses[f.id]
      if (!a || a.status !== 'done') keep.add(f.id) // still in flight
    }
    for (const cand of bestPerClass.values()) keep.add(cand.id)
    if (binsManual) for (const ids of Object.values(manualBins)) ids.forEach((id) => keep.add(id))
    if (selectedId) keep.add(selectedId)

    const doomed = frames.filter((f) => !keep.has(f.id))
    if (doomed.length === 0) return
    doomed.forEach((f) => URL.revokeObjectURL(f.url))
    setFrames((prev) => prev.filter((f) => keep.has(f.id)))
  }, [frames, analyses, bestPerClass, manualBins, binsManual, selectedId])

  // Smoothed live signal, folded over the dense per-frame signal log (which
  // covers every analysed frame — the retained key-frame images are far too
  // sparse to smooth over) up to the current playhead. Folding only up to
  // `cutoff` keeps the readout tied to where playback actually is: after
  // seeking back over already-sampled footage the signal reflects that earlier
  // position, not the furthest point ever reached. While playing at the leading
  // edge (playhead within 0.75s of the newest point) nothing is filtered, so
  // forward playback is unchanged; a live device never seeks, so the whole log
  // is always used.
  const liveSignal = useMemo(() => {
    const maxT = signalLog.length ? signalLog[signalLog.length - 1].timestamp : 0
    const atFrontier = !videoUrl || playhead >= maxT - 0.75
    const stream = atFrontier
      ? signalLog
      : signalLog.filter((p) => p.timestamp <= playhead + 1e-3)
    return smoothStream(stream, windowN)
  }, [signalLog, windowN, videoUrl, playhead])

  // The examination report summarises the whole procedure, so it folds the full
  // log regardless of the playhead — scrubbing back must not erase a finding
  // already recorded.
  const examSignal = useMemo(() => smoothStream(signalLog, windowN), [signalLog, windowN])

  // Everything that must be cleared before a new source (file or live device)
  // starts streaming frames.
  const prepareNewSource = () => {
    frames.forEach((f) => URL.revokeObjectURL(f.url))
    reset()
    setFrames([])
    setSampledCount(0)
    setSelectedId(null)
    setManualBins(EMPTY_BINS)
    setBinsManual(false)
    setCgiResult(null)
    setCgiError(null)
    setCapturing(false)
    setPlayhead(0)
    sampledSlotsRef.current = new Set()
    roiRef.current = null
  }

  const handleVideo = (file: File) => {
    camera.stop()
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    prepareNewSource()
    setVideoUrl(URL.createObjectURL(file))
  }

  const startUsb = async (deviceId?: string) => {
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl)
      setVideoUrl(null)
    }
    prepareNewSource()
    await camera.start(deviceId)
  }

  const stopUsb = () => {
    camera.stop()
    setCapturing(false)
  }

  const changeSourceMode = (mode: 'file' | 'usb') => {
    setSourceMode(mode)
    if (mode === 'usb') void camera.listDevices()
    else stopUsb()
  }

  // Drive playback and sample the current frame at the chosen rate, tied to the
  // video's own playback position so results stream in live as it plays.
  const stream = camera.stream
  useEffect(() => {
    const video = videoRef.current
    if (!video || (!videoUrl && !stream)) return
    // A live device has no timeline of its own — drive it off elapsed wall-clock
    // instead of the media's currentTime/mediaTime (which a stream doesn't have).
    const live = !!stream
    video.srcObject = live ? stream : null
    const v = video as RVFCVideo
    const supported = typeof v.requestVideoFrameCallback === 'function'
    let stopped = false
    let running = false
    let intervalId: number | undefined

    const sample = (t: number) => {
      // One frame per 1/fps time-slot, keyed to the video's own position. A slot
      // is captured at most once, so scrubbing back over already-sampled footage
      // neither re-counts nor re-analyses it — only genuinely new time is added.
      const slot = Math.round(t * Math.max(0.1, fpsRef.current))
      if (sampledSlotsRef.current.has(slot)) return
      sampledSlotsRef.current.add(slot)
      // Lock onto the scope's view once it is visible; the processor's screen
      // layout stays fixed for the rest of the procedure.
      if (!roiRef.current) roiRef.current = detectScopeRoi(video)
      captureSquareFrame(video, t, roiRef.current)
        .then((frame) => {
          setFrames((prev) => insertByTime(prev, frame))
          setSampledCount((n) => n + 1)
          enqueue([frame])
        })
        .catch(() => {})
    }

    const now = () => (performance.now() - startMsRef.current) / 1000

    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      if (stopped) {
        running = false
        return
      }
      sample(live ? now() : meta.mediaTime)
      if (!video.ended && !video.paused) {
        v.requestVideoFrameCallback!(onFrame)
      } else {
        running = false
        if (video.ended) setCapturing(false)
      }
    }

    const kick = () => {
      if (running || stopped) return
      running = true
      startMsRef.current = performance.now()
      setCapturing(true)
      if (supported) {
        v.requestVideoFrameCallback!(onFrame)
      } else {
        intervalId = window.setInterval(() => {
          if (stopped || video.paused || video.ended) return
          sample(live ? now() : video.currentTime)
        }, 250)
      }
    }

    const onPlay = () => kick()
    const onPause = () => setCapturing(false)
    const onEnded = () => setCapturing(false)
    const onTime = () => setPlayhead(video.currentTime)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('seeked', onTime)
    video.muted = true
    video.play().catch(() => {})

    return () => {
      stopped = true
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('seeked', onTime)
      if (intervalId) window.clearInterval(intervalId)
      if (live) video.srcObject = null
    }
  }, [videoUrl, stream, enqueue])

  // The first hand edit takes the bays off auto-pick, seeded with what the
  // physician currently sees so nothing jumps around under them.
  const editBins = (fn: (prev: Bins) => Bins) => {
    setManualBins((prev) => fn(binsManual ? prev : autoBins))
    setBinsManual(true)
  }

  const dropToBin = (bin: BinKey, frameId: string) => {
    editBins((prev) =>
      prev[bin].includes(frameId) ? prev : { ...prev, [bin]: [...prev[bin], frameId] },
    )
  }

  const removeFromBin = (bin: BinKey, frameId: string) => {
    editBins((prev) => ({ ...prev, [bin]: prev[bin].filter((id) => id !== frameId) }))
  }

  const resumeAutoPick = () => {
    setManualBins(EMPTY_BINS)
    setBinsManual(false)
  }

  const runCgi = async () => {
    setAnalyzingCgi(true)
    setCgiError(null)
    setCgiResult(null)
    try {
      // Encoded here rather than at capture time — only these few frames need it.
      const base64Of = (ids: string[]) =>
        Promise.all(
          ids
            .map((id) => frames.find((f) => f.id === id))
            .filter((f): f is ExtractedFrame => !!f)
            .map((f) => blobToBase64(f.blob)),
        )
      const [poolA, poolB, poolC] = await Promise.all([
        base64Of(bins.A),
        base64Of(bins.B),
        base64Of(bins.C),
      ])
      const pairs = await analyzeCgi(poolA, poolB, poolC)
      setCgiResult(pairs[0] ?? null)
      if (pairs.length === 0) setCgiError('沒有回傳結果。')
    } catch (err) {
      setCgiError(err instanceof Error ? err.message : 'CGI 分析失敗')
    } finally {
      setAnalyzingCgi(false)
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar />
      <ControlBar
        fps={fps}
        onFpsChange={setFps}
        windowN={windowN}
        onWindowChange={setWindowN}
        onVideoSelected={handleVideo}
        sourceMode={sourceMode}
        onSourceModeChange={changeSourceMode}
        devices={camera.devices}
        usbActive={!!camera.stream}
        usbError={camera.error}
        onStartUsb={startUsb}
        onStopUsb={stopUsb}
        capturing={capturing}
        frameCount={sampledCount}
        keptCount={frames.length}
        queueDepth={queueDepth}
        onOpenReview={() => setReviewOpen(true)}
        reviewReady={sampledCount > 0}
      />

      <main className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[1fr_380px] lg:overflow-hidden">
        <ScopeStage
          videoRef={videoRef}
          videoUrl={videoUrl}
          hasSource={hasSource}
          capturing={capturing}
          live={liveSignal}
        />
        <div className="flex min-h-0 flex-col gap-3">
          <LiveRail live={liveSignal} />
          <Inspector frame={selectedFrame} analysis={selectedFrame ? analyses[selectedFrame.id] : undefined} />
        </div>
      </main>

      <div className="h-[136px] shrink-0 border-t border-line bg-surface/70 px-3 py-2.5">
        <Filmstrip
          frames={frames}
          analyses={analyses}
          selectedId={selectedId}
          onSelect={(f) => setSelectedId(f.id)}
          onRetry={retryFrame}
        />
      </div>

      <CgiDrawer
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        frames={frames}
        bins={bins}
        onDropToBin={dropToBin}
        onRemoveFromBin={removeFromBin}
        onAnalyze={runCgi}
        analyzing={analyzingCgi}
        result={cgiResult}
        error={cgiError}
        auto={!binsManual}
        onResumeAuto={resumeAutoPick}
        sampledCount={sampledCount}
        analyses={analyses}
        fps={fps}
        reportSignal={examSignal}
      />
    </div>
  )
}
