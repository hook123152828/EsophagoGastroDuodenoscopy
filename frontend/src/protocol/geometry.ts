/**
 * Overlay alignment.
 *
 * The frames and masks the backend produces are cropped to the endoscope
 * viewport (the ROI) out of the 1920x1080 console output. The <video> element
 * plays the *uncropped* original. Putting a mask on top therefore needs one
 * mapping: ROI pixels -> on-screen pixels.
 *
 * Do not re-derive this anywhere else. Both pages call it from here so an
 * alignment fix lands in one place.
 */

import type { Roi } from './types'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where the video's *content* actually sits inside its element.
 *
 * `object-fit: contain` letterboxes: the element is rarely the same aspect
 * ratio as the video, and the difference is padding that must not be counted.
 */
export function videoContentRect(video: HTMLVideoElement): Rect {
  const { videoWidth, videoHeight, clientWidth, clientHeight } = video
  if (!videoWidth || !videoHeight) {
    return { left: 0, top: 0, width: clientWidth, height: clientHeight }
  }

  const scale = Math.min(clientWidth / videoWidth, clientHeight / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale

  return {
    left: (clientWidth - width) / 2,
    top: (clientHeight - height) / 2,
    width,
    height,
  }
}

/**
 * The ROI's position within the video element, in CSS pixels relative to the
 * element's own box — i.e. ready to drop into an absolutely positioned overlay.
 *
 * Use this when the whole console frame is on screen.
 */
export function roiRectInVideo(video: HTMLVideoElement, roi: Roi): Rect {
  const content = videoContentRect(video)
  const scale = content.width / (video.videoWidth || 1)

  return {
    left: content.left + roi.x * scale,
    top: content.top + roi.y * scale,
    width: roi.width * scale,
    height: roi.height * scale,
  }
}

/**
 * Styles that blow the ROI up to fill its container, hiding the rest of the
 * console frame — which is also where the patient identifiers are printed.
 *
 * The container must be `position: relative; overflow: hidden` and have the
 * ROI's aspect ratio. A mask then simply fills that container, because the
 * container *is* the ROI.
 */
export function roiCropStyle(
  roi: Roi,
  containerWidth: number,
  videoWidth: number,
  videoHeight: number,
): { width: number; height: number; left: number; top: number } {
  const scale = containerWidth / roi.width

  return {
    width: videoWidth * scale,
    height: videoHeight * scale,
    left: -roi.x * scale,
    top: -roi.y * scale,
  }
}
