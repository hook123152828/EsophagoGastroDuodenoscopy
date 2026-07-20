import type { GnsMode } from '../types'

// Domain colours carry meaning, not decoration: white-light imaging is warm
// amber, narrow-band is cyan, and an IM finding is the alert magenta.
export const MODE_COLOR: Record<GnsMode, string> = {
  WL: 'var(--wl)',
  NBI: 'var(--nbi)',
  neutral: 'var(--ink-faint)',
}

export const MODE_LABEL: Record<GnsMode, string> = {
  WL: '白光',
  NBI: 'NBI 窄頻',
  neutral: '—',
}

// GIM score 0/1/2 -> none / present / extensive.
export const SCORE_COLOR = ['var(--ink-faint)', 'var(--wl)', 'var(--im)']
