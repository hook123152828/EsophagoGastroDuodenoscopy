import { useEffect, useState } from 'react'

import {
  createSession,
  deleteSession,
  listSessions,
  listVideos,
  type SessionManifest,
  type VideoFile,
} from '@/protocol'

import UploadPanel from './UploadPanel'

const GB = 1024 ** 3

interface Props {
  onOpen: (sessionId: string) => void
}

/** Pick a video to scan, or reopen a session that was scanned earlier. */
export default function SessionPicker({ onOpen }: Props) {
  const [videos, setVideos] = useState<VideoFile[]>([])
  const [sessions, setSessions] = useState<SessionManifest[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Deleting throws away several GB of extracted frames and cannot be undone,
  // so the button asks once before it does anything.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    listVideos().then(setVideos).catch((cause) => setError(String(cause)))
    listSessions().then(setSessions).catch(() => undefined)
  }, [])

  async function start(video: VideoFile) {
    setBusy(true)
    setError(null)
    try {
      onOpen((await createSession(video.path)).session_id)
    } catch (cause) {
      setError(String(cause))
      setBusy(false)
    }
  }

  async function remove(sessionId: string) {
    setDeleting(sessionId)
    setError(null)
    try {
      await deleteSession(sessionId)
      setSessions((current) =>
        current.filter((session) => session.session_id !== sessionId),
      )
    } catch (cause) {
      setError(String(cause))
    } finally {
      setDeleting(null)
      setConfirming(null)
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-10 p-10">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-console-text">
          Upper GI Endoscopy AI Console
        </h1>
        <p className="mt-2 text-sm text-console-muted">
          Pick a video to scan. Frame extraction and GNS/GIM inference run in the
          background; the report page takes over automatically once they finish.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-xs font-medium tracking-widest text-console-muted uppercase">
          Upload
        </h2>
        <UploadPanel
          disabled={busy}
          onUploaded={(video) => {
            setVideos((current) => [...current, video])
            start(video)
          }}
        />
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium tracking-widest text-console-muted uppercase">
          Videos
        </h2>
        <ul className="divide-y divide-console-line rounded-lg border border-console-line">
          {videos.map((video) => (
            <li key={video.path}>
              <button
                type="button"
                disabled={busy}
                onClick={() => start(video)}
                className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-console-panel disabled:opacity-40"
              >
                <span className="text-sm text-console-text">{video.filename}</span>
                <span className="text-xs text-console-muted">
                  {(video.size_bytes / GB).toFixed(2)} GB
                </span>
              </button>
            </li>
          ))}
          {videos.length === 0 && (
            <li className="px-4 py-6 text-sm text-console-muted">
              No videos in VIDEO_DIR.
            </li>
          )}
        </ul>
      </section>

      {sessions.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-medium tracking-widest text-console-muted uppercase">
            Existing sessions
          </h2>
          <ul className="divide-y divide-console-line rounded-lg border border-console-line">
            {sessions.slice(0, 8).map((session) => (
              <li key={session.session_id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => onOpen(session.session_id)}
                  className="flex min-w-0 flex-1 items-center justify-between px-4 py-3 text-left transition hover:bg-console-panel"
                >
                  <span className="text-sm text-console-text">
                    {session.video.filename}
                  </span>
                  <span className="flex items-center gap-3 text-xs text-console-muted">
                    <span>{session.frame_count} frames</span>
                    <StatusChip status={session.status} />
                  </span>
                </button>
                <button
                  type="button"
                  disabled={deleting === session.session_id}
                  onClick={() =>
                    confirming === session.session_id
                      ? remove(session.session_id)
                      : setConfirming(session.session_id)
                  }
                  onBlur={() =>
                    setConfirming((current) =>
                      current === session.session_id ? null : current,
                    )
                  }
                  title="Delete this session and the frames it extracted"
                  className={`shrink-0 px-4 py-3 text-xs transition disabled:opacity-40 ${
                    confirming === session.session_id
                      ? 'font-medium text-scope-alert'
                      : 'text-console-muted hover:text-scope-alert'
                  }`}
                >
                  {deleting === session.session_id
                    ? 'deleting…'
                    : confirming === session.session_id
                      ? 'confirm'
                      : 'delete'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="text-sm text-scope-alert">{error}</p>}
    </div>
  )
}

function StatusChip({ status }: { status: SessionManifest['status'] }) {
  const tone =
    status === 'ready'
      ? 'text-emerald-400'
      : status === 'failed'
        ? 'text-scope-alert'
        : 'text-amber-400'
  return <span className={`font-medium ${tone}`}>{status}</span>
}
