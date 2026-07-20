import type { GnsResult, GimResult, CgiPair } from '../types'

// Empty by default so requests go to the same origin as the page (`/api/...`)
// and Vite's dev proxy forwards them to the gateway. This is what lets an
// external device reach the backend: it only ever talks to the one port the
// site is served on, never to `localhost` (which, from another device, would be
// that device itself). Override with VITE_GATEWAY_URL only for a split deploy.
const GATEWAY = import.meta.env.VITE_GATEWAY_URL ?? ''

export async function getHealth(): Promise<{ gns: boolean; gim: boolean; cgi: boolean }> {
  const res = await fetch(`${GATEWAY}/api/health`)
  if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}`)
  return res.json()
}

export async function classifyGns(files: Blob[]): Promise<GnsResult[]> {
  const form = new FormData()
  files.forEach((blob, i) => form.append('files', blob, `frame_${i}.jpg`))
  const res = await fetch(`${GATEWAY}/api/gns/classify`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`GNS classify failed: HTTP ${res.status}`)
  const data: { results: GnsResult[] } = await res.json()
  return data.results
}

export async function segmentGim(files: Blob[]): Promise<GimResult[]> {
  const form = new FormData()
  files.forEach((blob, i) => form.append('files', blob, `frame_${i}.jpg`))
  const res = await fetch(`${GATEWAY}/api/gim/segment`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`GIM segment failed: HTTP ${res.status}`)
  const data: { results: GimResult[] } = await res.json()
  return data.results
}

export async function analyzeCgi(
  poolA: string[],
  poolB: string[],
  poolC: string[],
): Promise<CgiPair[]> {
  const res = await fetch(`${GATEWAY}/api/cgi/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pool_A: poolA, pool_B: poolB, pool_C: poolC }),
  })
  if (!res.ok) throw new Error(`CGI analyze failed: HTTP ${res.status}`)
  const data: { top_10_pairs: CgiPair[] } = await res.json()
  return data.top_10_pairs
}
