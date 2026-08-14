import { useRef, useState } from 'react'

import { uploadVideo, type VideoFile } from '@/protocol'

interface Props {
  disabled?: boolean
  onUploaded: (video: VideoFile) => void
}

/** Drop or pick a video file; it lands in the backend's VIDEO_DIR. */
export default function UploadPanel({ disabled, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const uploading = progress !== null

  async function send(file: File) {
    setError(null)
    setProgress(0)
    try {
      onUploaded(await uploadVideo(file, setProgress))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setProgress(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div>
      <div
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled && !uploading) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (disabled || uploading) return
          const file = event.dataTransfer.files[0]
          if (file) send(file)
        }}
        className={`rounded-lg border border-dashed p-6 text-center transition-colors ${
          dragging
            ? 'border-scope-accent bg-scope-accent/5'
            : 'border-console-line bg-console-panel/30'
        }`}
      >
        {uploading ? (
          <div className="space-y-3">
            <p className="text-sm text-console-text">
              Uploading… {Math.round(progress * 100)}%
            </p>
            <span className="block h-1.5 overflow-hidden rounded-full bg-console-line">
              <span
                className="block h-full rounded-full bg-scope-accent transition-all"
                style={{ width: `${progress * 100}%` }}
              />
            </span>
            <p className="text-xs text-console-muted">
              Multi-gigabyte recordings take a while. Leave this tab open.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-console-muted">
              Drop a video here, or{' '}
              <button
                type="button"
                disabled={disabled}
                onClick={() => inputRef.current?.click()}
                className="text-scope-accent underline underline-offset-2 transition hover:text-console-text disabled:opacity-40"
              >
                choose a file
              </button>
            </p>
            <p className="mt-1.5 text-xs text-console-muted">
              .mp4 .avi .mov .mkv — uploaded into the backend's video directory
            </p>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/x-msvideo,video/quicktime,video/x-matroska,.mp4,.avi,.mov,.mkv"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) send(file)
        }}
      />

      {error && <p className="mt-2 text-sm text-scope-alert">{error}</p>}
    </div>
  )
}
