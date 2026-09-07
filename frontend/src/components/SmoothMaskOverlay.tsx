import { useEffect, useRef, type RefObject } from 'react'

import { distanceMask, paintBoundary, stabilizeMasks, type DistanceMask } from './maskDistance'
import { MASK_KNOT_S, maskPresence, temporalWeight, type MaskWindow } from './maskPlayback'

interface Props {
  samples: MaskWindow
  videoRef: RefObject<HTMLVideoElement | null>
  width: number
  height: number
}
interface Knot { mask: DistanceMask | null; opacity: number }

/** Stabilise a neighbourhood first, then interpolate on the video clock. */
export function SmoothMaskOverlay({ samples, videoRef, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const samplesRef = useRef(samples)
  samplesRef.current = samples

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const context = canvas.getContext('2d')
    if (!context) return
    const scale = 256 / Math.max(width, height)
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const output = context.createImageData(canvas.width, canvas.height)
    const scratch = document.createElement('canvas')
    scratch.width = canvas.width
    scratch.height = canvas.height
    const decoder = scratch.getContext('2d', { willReadFrequently: true })!
    const cache = new Map<string, DistanceMask | null>()
    const pending = new Set<string>()
    const knots = new Map<string, Knot>()
    let disposed = false
    let revision = 0
    let lastRevision = -1
    let lastTime = -1
    let lastPainted = -Infinity
    let lastSamples: MaskWindow | null = null
    let handle = 0

    const load = (src: string | null) => {
      if (!src || cache.has(src)) return
      cache.set(src, null)
      pending.add(src)
      if (cache.size > 48) cache.delete(cache.keys().next().value!)
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.src = src
      void image.decode().then(() => {
        if (disposed || !cache.has(src)) return
        decoder.clearRect(0, 0, scratch.width, scratch.height)
        decoder.drawImage(image, 0, 0, scratch.width, scratch.height)
        cache.set(src, distanceMask(
          decoder.getImageData(0, 0, scratch.width, scratch.height).data,
          scratch.width, scratch.height,
        ))
      }).catch(() => { /* Skip a failed PNG without retaining an old outline. */ })
        .finally(() => { pending.delete(src); revision++ })
    }
    const knotAt = (window: MaskWindow, time: number): Knot | null => {
      const relevant = window.samples.filter(sample => temporalWeight(time, sample.t) > 0)
      const key = `${time}:${relevant.map(sample => `${sample.t}=${sample.src}`).join('|')}`
      const cached = knots.get(key)
      if (cached) return cached
      if (relevant.some(sample => sample.src && pending.has(sample.src))) return null
      const inputs = relevant.flatMap(sample => {
        const mask = sample.src ? cache.get(sample.src) : null
        return mask ? [{ mask, weight: temporalWeight(time, sample.t) }] : []
      })
      const opacity = maskPresence(relevant, time)
      const knot = { mask: opacity > 0 && inputs.length ? stabilizeMasks(inputs) : null, opacity }
      knots.set(key, knot)
      if (knots.size > 12) knots.delete(knots.keys().next().value!)
      return knot
    }
    const clear = () => {
      context.clearRect(0, 0, canvas.width, canvas.height)
      lastTime = -1
      lastPainted = -Infinity
    }
    const draw = () => {
      handle = requestAnimationFrame(draw)
      const time = video.currentTime
      const window = samplesRef.current
      if (video.seeking || !window.samples.length || time < window.from || time >= window.to) {
        clear()
        return
      }
      // Decode the whole short window, including the next knot's support.
      for (const sample of window.samples) load(sample.src)
      if (time === lastTime && revision === lastRevision && window === lastSamples) return
      lastTime = time
      lastRevision = revision
      lastSamples = window
      const knotIndex = Math.floor(time / MASK_KNOT_S + 1e-7)
      const fromTime = knotIndex * MASK_KNOT_S
      const a = knotAt(window, fromTime)
      const b = knotAt(window, (knotIndex + 1) * MASK_KNOT_S)
      if (!a || !b) {
        // A network decode is not a negative finding. Briefly keep the last
        // estimate during playback; seeking always clears it synchronously.
        if (Math.abs(time - lastPainted) > MASK_KNOT_S) clear()
        return
      }
      const shape = a.mask ?? b.mask
      if (!shape) { clear(); return }
      const mix = Math.max(0, Math.min(1, (time - fromTime) / MASK_KNOT_S))
      paintBoundary(output.data, a.mask ?? shape, b.mask ?? shape, mix,
        a.opacity * (1 - mix) + b.opacity * mix)
      context.putImageData(output, 0, 0)
      lastPainted = time
    }
    video.addEventListener('seeking', clear)
    handle = requestAnimationFrame(draw)
    return () => {
      disposed = true
      cancelAnimationFrame(handle)
      video.removeEventListener('seeking', clear)
      cache.clear()
      knots.clear()
    }
  }, [videoRef, width, height])

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
}
