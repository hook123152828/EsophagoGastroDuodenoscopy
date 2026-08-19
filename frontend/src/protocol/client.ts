/**
 * Gateway client — the only way either page reaches the backend.
 *
 * Page 1 creates sessions; page 2 consumes them. They never call each other.
 */

import type {
  CgiPair,
  FrameRecord,
  GutCoreResult,
  SessionEvent,
  SessionManifest,
  Sampling,
  VideoFile,
} from './types'

export const GATEWAY_URL =
  import.meta.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8080'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status}`)
  }
  return response.json() as Promise<T>
}

/** Absolute URL for a `image_url` / `mask_url` coming out of a FrameRecord. */
export function fileUrl(path: string): string {
  return `${GATEWAY_URL}${path}`
}

export function health(): Promise<Record<string, boolean>> {
  return request('/api/health')
}

export async function listVideos(): Promise<VideoFile[]> {
  const { videos } = await request<{ videos: VideoFile[] }>('/api/videos')
  return videos
}

/**
 * Upload a video into the backend's VIDEO_DIR.
 *
 * XMLHttpRequest rather than fetch: a procedure recording is several GB and
 * fetch cannot report upload progress, which would leave the user staring at a
 * dead screen for minutes.
 */
export function uploadVideo(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<VideoFile> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${GATEWAY_URL}/api/videos`)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as VideoFile)
      } else {
        reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed: network error'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))

    xhr.send(form)
  })
}

export function listSessions(): Promise<SessionManifest[]> {
  return request('/api/sessions')
}

export function getSession(sessionId: string): Promise<SessionManifest> {
  return request(`/api/sessions/${sessionId}`)
}

export function createSession(
  videoPath: string,
  sampling?: Partial<Sampling>,
): Promise<SessionManifest> {
  return request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ video_path: videoPath, sampling }),
  })
}

export async function getFrames(
  sessionId: string,
  options: { fromT?: number; toT?: number; onlyScanned?: boolean } = {},
): Promise<FrameRecord[]> {
  const params = new URLSearchParams()
  if (options.fromT !== undefined) params.set('from_t', String(options.fromT))
  if (options.toT !== undefined) params.set('to_t', String(options.toT))
  if (options.onlyScanned) params.set('only_scanned', 'true')

  const query = params.toString()
  const { frames } = await request<{ frames: FrameRecord[] }>(
    `/api/sessions/${sessionId}/frames${query ? `?${query}` : ''}`,
  )
  return frames
}

/**
 * Subscribe to a session's lifecycle.
 *
 * The stream replays the current status and progress on connect, so a
 * subscriber that joins late still learns where things stand. Page 2 should
 * start its downstream work on the `ready` event.
 *
 * Returns an unsubscribe function.
 */
export function subscribeSession(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
): () => void {
  const source = new EventSource(`${GATEWAY_URL}/api/sessions/${sessionId}/events`)
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as SessionEvent)
  return () => source.close()
}

/**
 * Analyse the frame at `t` immediately, instead of waiting for the background
 * scan to reach it.
 *
 * Cheap and idempotent: an already-analysed frame is returned from the session
 * as-is, and a fresh result is written back so the scan skips it later.
 */
export function analyzeFrame(sessionId: string, t: number): Promise<FrameRecord> {
  return request(`/api/sessions/${sessionId}/analyze`, {
    method: 'POST',
    body: JSON.stringify({ t }),
  })
}

/**
 * Run CGI over three candidate pools of base64-encoded white-light images.
 * Choosing what goes in each pool is page 2's decision.
 */
export async function predictCgi(pools: {
  pool_A: string[]
  pool_B: string[]
  pool_C: string[]
}): Promise<CgiPair[]> {
  const { top_10_pairs } = await request<{ top_10_pairs: CgiPair[] }>(
    '/api/cgi/predict',
    { method: 'POST', body: JSON.stringify(pools) },
  )
  return top_10_pairs
}

/**
 * Run optional GutCore whole-examination gastric cancer analysis.
 *
 * Only session-owned frame indices cross the public API. The gateway resolves
 * local paths and caches a result for the exact selection on disk.
 */
export function predictGutCore(
  sessionId: string,
  frameIndices: number[],
): Promise<GutCoreResult> {
  return request(`/api/sessions/${sessionId}/gutcore`, {
    method: 'POST',
    body: JSON.stringify({ frame_indices: frameIndices }),
  })
}
