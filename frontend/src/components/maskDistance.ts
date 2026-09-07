/** Small signed-distance masks let playback morph one boundary instead of drawing two. */
export interface DistanceMask {
  width: number
  height: number
  field: Float32Array
  color: [number, number, number]
  center: [number, number]
}

export function distanceMask(pixels: Uint8ClampedArray, width: number, height: number): DistanceMask {
  const size = width * height
  const inside = new Uint8Array(size)
  const field = new Float32Array(size).fill(width + height)
  let color: [number, number, number] = [180, 100, 240]
  let total = 0
  let sumX = 0
  let sumY = 0
  for (let i = 0; i < size; i++) {
    inside[i] = pixels[i * 4 + 3] > 8 ? 1 : 0
    if (inside[i]) {
      color = [pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]]
      total++
      sumX += i % width
      sumY += Math.floor(i / width)
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if ((x > 0 && inside[i] !== inside[i - 1]) ||
          (x + 1 < width && inside[i] !== inside[i + 1]) ||
          (y > 0 && inside[i] !== inside[i - width]) ||
          (y + 1 < height && inside[i] !== inside[i + width]) ||
          (inside[i] && (x === 0 || y === 0 || x === width - 1 || y === height - 1))) field[i] = 0.5
    }
  }
  // Two-pass chamfer distance; diagonal steps preserve rounded contours.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (x) field[i] = Math.min(field[i], field[i - 1] + 1)
      if (y) {
        field[i] = Math.min(field[i], field[i - width] + 1)
        if (x) field[i] = Math.min(field[i], field[i - width - 1] + Math.SQRT2)
        if (x + 1 < width) field[i] = Math.min(field[i], field[i - width + 1] + Math.SQRT2)
      }
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      if (x + 1 < width) field[i] = Math.min(field[i], field[i + 1] + 1)
      if (y + 1 < height) {
        field[i] = Math.min(field[i], field[i + width] + 1)
        if (x) field[i] = Math.min(field[i], field[i + width - 1] + Math.SQRT2)
        if (x + 1 < width) field[i] = Math.min(field[i], field[i + width + 1] + Math.SQRT2)
      }
    }
  }
  for (let i = 0; i < size; i++) if (!inside[i]) field[i] = -field[i]
  return { width, height, field, color, center: total ? [sumX / total, sumY / total] : [width / 2, height / 2] }
}

/** Render the zero contour of the interpolated field, with a soft one-pixel edge. */
export function paintBoundary(output: Uint8ClampedArray, a: DistanceMask, b: DistanceMask, mix: number, opacity = 1) {
  for (let i = 0; i < a.field.length; i++) {
    // Stay in video coordinates. A new disconnected patch must not drag every
    // existing contour around by changing the global centroid.
    const distance = a.field[i] * (1 - mix) + b.field[i] * mix
    output[i * 4] = a.color[0] * (1 - mix) + b.color[0] * mix
    output[i * 4 + 1] = a.color[1] * (1 - mix) + b.color[1] * mix
    output[i * 4 + 2] = a.color[2] * (1 - mix) + b.color[2] * mix
    output[i * 4 + 3] = Math.max(0, Math.min(1, 1.25 - Math.abs(distance))) * 255 * opacity
  }
}

/** Robust temporal shape estimate in ROI coordinates. A distant, transient patch
 * contributes a bounded vote instead of pulling the whole contour towards it. */
export function stabilizeMasks(inputs: { mask: DistanceMask; weight: number }[]): DistanceMask {
  const first = inputs[0].mask
  const accumulated = new Float32Array(first.field.length)
  const pixels = new Uint8ClampedArray(first.field.length * 4)
  for (const { mask, weight } of inputs) {
    for (let i = 0; i < accumulated.length; i++) {
      accumulated[i] += Math.max(-6, Math.min(6, mask.field[i])) * weight
    }
  }
  for (let i = 0; i < accumulated.length; i++) {
    if (accumulated[i] <= 0) continue
    pixels[i * 4] = first.color[0]
    pixels[i * 4 + 1] = first.color[1]
    pixels[i * 4 + 2] = first.color[2]
    pixels[i * 4 + 3] = 255
  }
  // Re-distance once per temporal knot to keep the stroke width constant.
  return distanceMask(pixels, first.width, first.height)
}
