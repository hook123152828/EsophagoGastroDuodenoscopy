export type GnsMode = 'WL' | 'NBI' | 'neutral'

export interface GnsResult {
  class_name: string
  confidence: number
  probs: Record<string, number>
  filename?: string
}

export interface GimResult {
  filename?: string
  score: 0 | 1 | 2
  area: number
  mask_b64: string | null
}

export interface CgiPair {
  probability: number
  img1: string
  img2: string
  img3: string
}

// url is an object URL for display. Base64 is deliberately not held here: at
// 30 fps a long procedure runs to tens of thousands of frames, and keeping an
// encoded copy of every one costs more memory than the browser has. CGI needs
// it for only a handful of frames, so it is encoded on demand.
export interface ExtractedFrame {
  id: string
  timestamp: number
  blob: Blob
  url: string
}

export function modeOf(className: string): GnsMode {
  if (className.endsWith('_WL')) return 'WL'
  if (className.endsWith('_NBI')) return 'NBI'
  return 'neutral'
}
