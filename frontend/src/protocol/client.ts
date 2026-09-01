/**
 * Gateway client — the only way either page reaches the backend.
 *
 * Page 1 creates sessions; page 2 consumes them. They never call each other.
 */

import type {
  CgiPair,
  FrameRecord,
  SessionEvent,
  SessionManifest,
  Sampling,
  VideoFile,
} from './types'

/**
 * Base for every gateway call — empty by default, i.e. same origin.
 *
 * The dev server proxies `/api`, `/files` and `/media` through to the gateway,
 * so the page works unchanged whether it is opened at localhost, over a LAN
 * address or through a tunnel. Set `VITE_GATEWAY_URL` only to point a build at
 * a gateway somewhere else, and add that origin to the backend's
 * `FRONTEND_ORIGINS` when you do.
 */
export const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ?? ''

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
/**
 * Largest chunk to try first, and the smallest worth falling back to.
 *
 * Whatever proxy sits between the browser and the gateway decides how big a
 * request may be, and it does not say so until one is refused — a VS Code dev
 * tunnel fronts this with an nginx that answers 413 and never passes the
 * request on. So the size is discovered rather than configured: start large,
 * halve on refusal, and stop calling it a size problem below the floor.
 */
const CHUNK_MAX = 8 * 1024 * 1024
const CHUNK_MIN = 256 * 1024

interface UploadProgress {
  upload_id: string
  received_bytes: number
  size_bytes: number
}

/**
 * Send a video to the backend's VIDEO_DIR, in pieces.
 *
 * Resumable by construction: the upload is identified by the file's name and
 * length, so asking to start one that was interrupted returns how many bytes
 * survived, and sending continues from there. Reloading the page and picking
 * the same file again resumes it.
 */
export async function uploadVideo(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<VideoFile> {
  const opened = await request<UploadProgress>('/api/videos/uploads', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, size_bytes: file.size }),
  })

  let sent = opened.received_bytes
  let chunkSize = CHUNK_MAX
  onProgress?.(file.size ? sent / file.size : 0)

  while (sent < file.size) {
    const end = Math.min(sent + chunkSize, file.size)
    const response = await fetch(
      `${GATEWAY_URL}/api/videos/uploads/${opened.upload_id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.slice(sent, end),
      },
    )

    if (response.status === 413) {
      // Refused for size, by something that is not the gateway. Try smaller.
      if (chunkSize <= CHUNK_MIN) {
        throw new Error(
          `Upload failed: a proxy rejected even ${CHUNK_MIN / 1024} KB as too large`,
        )
      }
      chunkSize = Math.max(CHUNK_MIN, Math.floor(chunkSize / 2))
      continue
    }
    if (!response.ok) {
      throw new Error(`Upload failed (${response.status}): ${await response.text()}`)
    }

    // Trusted over the local count: the server says what it actually holds,
    // which is what a resume would continue from.
    sent = ((await response.json()) as UploadProgress).received_bytes
    onProgress?.(file.size ? sent / file.size : 1)
  }

  return request<VideoFile>(
    `/api/videos/uploads/${opened.upload_id}/complete`,
    { method: 'POST' },
  )
}

export function listSessions(): Promise<SessionManifest[]> {
  return request('/api/sessions')
}

export function getSession(sessionId: string): Promise<SessionManifest> {
  return request(`/api/sessions/${sessionId}`)
}

/**
 * Delete a session and everything it wrote to disk.
 *
 * Irreversible, and it takes the extracted frames with it — several GB for a
 * full procedure. A session that is still scanning is stopped first.
 */
export function deleteSession(sessionId: string): Promise<{ deleted: string }> {
  return request(`/api/sessions/${sessionId}`, { method: 'DELETE' })
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
 *
 * `polyp` opts into the detection-plus-segmentation pass, which nothing runs in
 * the background. It is an order of magnitude dearer than the rest of the
 * frame — a round trip near 200ms rather than 25 — so ask for it only when the
 * result is about to be shown or recorded.
 */
export function analyzeFrame(
  sessionId: string,
  t: number,
  options: { polyp?: boolean } = {},
): Promise<FrameRecord> {
  return request(`/api/sessions/${sessionId}/analyze`, {
    method: 'POST',
    body: JSON.stringify({ t, polyp: options.polyp ?? false }),
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
