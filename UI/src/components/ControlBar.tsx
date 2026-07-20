import { useRef, useState, type CSSProperties } from 'react'
import type { CameraDevice } from '../hooks/useUsbCamera'

interface Props {
  fps: number
  onFpsChange: (fps: number) => void
  windowN: number
  onWindowChange: (n: number) => void
  onVideoSelected: (file: File) => void
  sourceMode: 'file' | 'usb'
  onSourceModeChange: (mode: 'file' | 'usb') => void
  devices: CameraDevice[]
  usbActive: boolean
  usbError: string | null
  onStartUsb: (deviceId?: string) => void
  onStopUsb: () => void
  capturing: boolean
  frameCount: number
  keptCount: number
  queueDepth: number
  onOpenReview: () => void
  reviewReady: boolean
}

function fillStyle(value: number, min: number, max: number): CSSProperties {
  const pct = ((value - min) / (max - min)) * 100
  return { ['--fill' as string]: `${pct}%` }
}

export function ControlBar({
  fps,
  onFpsChange,
  windowN,
  onWindowChange,
  onVideoSelected,
  sourceMode,
  onSourceModeChange,
  devices,
  usbActive,
  usbError,
  onStartUsb,
  onStopUsb,
  capturing,
  frameCount,
  keptCount,
  queueDepth,
  onOpenReview,
  reviewReady,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState('')

  const handleFile = (file: File | undefined) => {
    if (!file) return
    setFileName(file.name)
    onVideoSelected(file)
  }

  const onPickDevice = (id: string) => {
    setDeviceId(id)
    if (usbActive) onStartUsb(id || undefined) // switch device live
  }

  const window_s = windowN / fps

  return (
    <div className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface/60 px-5">
      {/* Source mode toggle */}
      <div className="flex shrink-0 rounded-lg border border-line bg-sunken p-0.5" role="tablist">
        {(['file', 'usb'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={sourceMode === m}
            onClick={() => onSourceModeChange(m)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              sourceMode === m ? 'bg-surface text-ink shadow-sm' : 'text-inkSoft hover:text-ink'
            }`}
          >
            {m === 'file' ? '檔案' : 'USB 擷取'}
          </button>
        ))}
      </div>

      {sourceMode === 'file' ? (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="group flex shrink-0 items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-2 text-sm text-ink shadow-sm transition hover:border-brand/50 hover:bg-brandTint/40"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brandTint text-brand transition group-hover:bg-brand group-hover:text-white">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 16V4m0 0L7 9m5-5 5 5M5 20h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            {fileName ? (
              <span className="max-w-[180px] truncate font-mono text-xs text-inkSoft">{fileName}</span>
            ) : (
              <span className="font-medium">載入內視鏡影片</span>
            )}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          <select
            value={deviceId}
            onChange={(e) => onPickDevice(e.target.value)}
            className="max-w-[220px] rounded-xl border border-line bg-surface px-3 py-2 text-xs text-ink shadow-sm focus-visible:border-brand"
          >
            <option value="">預設擷取裝置</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => (usbActive ? onStopUsb() : onStartUsb(deviceId || undefined))}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium shadow-sm transition ${
              usbActive
                ? 'border border-im/40 bg-im/10 text-im hover:bg-im/20'
                : 'border border-line bg-surface text-ink hover:border-brand/50 hover:bg-brandTint/40'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${usbActive ? 'animate-rec bg-im' : 'bg-brand'}`}
              aria-hidden
            />
            {usbActive ? '停止擷取' : '開始擷取'}
          </button>
          {usbError && <span className="max-w-[180px] truncate text-xs text-im">{usbError}</span>}
        </div>
      )}

      <span className="h-6 w-px shrink-0 bg-line" aria-hidden />

      {/* Sample rate */}
      <label className="flex shrink-0 items-center gap-2.5" htmlFor="fps">
        <span className="eyebrow whitespace-nowrap">取樣</span>
        <input
          id="fps"
          type="range"
          min={1}
          max={30}
          step={1}
          value={fps}
          onChange={(e) => onFpsChange(Number(e.target.value))}
          style={fillStyle(fps, 1, 30)}
          className="w-20 [touch-action:manipulation]"
        />
        <span className="w-14 font-mono text-xs font-medium text-ink">{fps} fps</span>
      </label>

      {/* Stability */}
      <label className="flex shrink-0 items-center gap-2.5" htmlFor="stability">
        <span className="eyebrow whitespace-nowrap">穩定度</span>
        <input
          id="stability"
          type="range"
          min={1}
          max={30}
          step={1}
          value={windowN}
          onChange={(e) => onWindowChange(Number(e.target.value))}
          style={fillStyle(windowN, 1, 30)}
          className="w-20 [touch-action:manipulation]"
        />
        <span className="w-20 font-mono text-xs font-medium text-ink">
          {windowN}
          <span className="text-inkFaint"> · {window_s.toFixed(window_s < 1 ? 2 : 1)}s</span>
        </span>
      </label>

      {/* Live status */}
      <div className="ml-auto flex items-center gap-3" aria-live="polite">
        {capturing && (
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-rec rounded-full bg-im" aria-hidden />
            <span className="font-mono text-[11px] uppercase tracking-wide text-im">REC</span>
          </span>
        )}
        {frameCount > 0 && (
          <span className="font-mono text-xs text-inkSoft">
            {frameCount} 取樣 · {keptCount} 保留
            {queueDepth > 0 && <span className="text-inkFaint"> · {queueDepth} 待分析</span>}
          </span>
        )}
        <button
          type="button"
          onClick={onOpenReview}
          className="flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brandDeep disabled:cursor-not-allowed disabled:bg-inkFaint"
        >
          判讀與報告
          {reviewReady && <span className="h-1.5 w-1.5 rounded-full bg-white/90" aria-hidden />}
        </button>
      </div>
    </div>
  )
}
