import { useCallback, useRef, useState } from 'react'

export interface CameraDevice {
  deviceId: string
  label: string
}

// Live capture from a USB video device (a capture card or USB endoscope shows up
// as a normal video input). getUserMedia needs a secure context — localhost
// counts, so it works in dev; on a LAN IP it would need HTTPS.
export function useUsbCamera() {
  const [devices, setDevices] = useState<CameraDevice[]>([])
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const listDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const all = await navigator.mediaDevices.enumerateDevices()
    const cams = all
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `攝影裝置 ${i + 1}` }))
    setDevices(cams)
  }, [])

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStream(null)
  }, [])

  const start = useCallback(
    async (deviceId?: string) => {
      setError(null)
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('此瀏覽器不支援即時擷取')
        return null
      }
      // Release any previous stream before opening a new device.
      streamRef.current?.getTracks().forEach((t) => t.stop())
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : true,
          audio: false,
        })
        streamRef.current = s
        setStream(s)
        // Labels are only populated once permission is granted.
        await listDevices()
        return s
      } catch (err) {
        setError(err instanceof Error ? err.message : '無法開啟擷取裝置')
        streamRef.current = null
        setStream(null)
        return null
      }
    },
    [listDevices],
  )

  return { devices, stream, error, start, stop, listDevices }
}
