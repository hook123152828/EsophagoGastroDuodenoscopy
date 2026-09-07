import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'

// Vite loads the actual TypeScript modules and their aliases without another runner.
const server = await createServer({ server: { middlewareMode: true, hmr: false } })
after(() => server.close())
const { distanceMask, stabilizeMasks, paintBoundary } = await server.ssrLoadModule('/src/components/maskDistance.ts')
const { maskWindowAt, maskPresence, temporalWeight } = await server.ssrLoadModule('/src/components/maskPlayback.ts')

function shape(extraPatch = false) {
  const pixels = new Uint8ClampedArray(100 * 100 * 4)
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) {
      if ((x - 25) ** 2 + (y - 25) ** 2 < 15 ** 2 ||
          (extraPatch && x > 55 && x < 95 && y > 55 && y < 95)) {
        const i = (y * 100 + x) * 4
        pixels[i] = 180
        pixels[i + 2] = 240
        pixels[i + 3] = 100
      }
    }
  }
  return distanceMask(pixels, 100, 100)
}
const frame = (index, t, src = 'mask.png', modality = 'NBI', region = 'antrum') => ({
  index, t, gns: { modality, region }, gim: { mask_url: src }, polyp: { mask_url: src },
})

test('a transient distant island cannot move a persistent contour', () => {
  const stable = shape(), outlier = shape(true)
  const result = stabilizeMasks([
    { mask: stable, weight: 1 }, { mask: outlier, weight: 1 }, { mask: stable, weight: 1 },
  ])
  assert.ok(result.field[75 * 100 + 75] < 0, 'transient island removed')
  assert.ok(result.field[25 * 100 + 25] > 0, 'persistent region remains')
  assert.ok(Math.abs(result.center[0] - stable.center[0]) < 1)
  assert.ok(Math.abs(result.center[1] - stable.center[1]) < 1)
})

test('interpolation does not drag the original region when another component appears', () => {
  const stable = shape(), outlier = shape(true)
  const pixels = new Uint8ClampedArray(40000)
  paintBoundary(pixels, stable, outlier, 0.25)
  assert.ok(pixels[(25 * 100 + 10) * 4 + 3] > 0, 'original left boundary stays in place')
  paintBoundary(pixels, stable, stable, 0, 0)
  assert.equal(pixels.some((value, i) => i % 4 === 3 && value > 0), false)
})

test('one missing sample is not an immediate hide command', () => {
  const samples = Array.from({ length: 13 }, (_, i) => ({ t: i / 15, src: i === 6 ? null : 'mask.png' }))
  assert.ok(maskPresence(samples, 0.4) > 0.9)
  assert.equal(maskPresence(samples.map(sample => ({ ...sample, src: null })), 0.4), 0)
})

test('an isolated positive is suppressed and sparse evidence expires', () => {
  const samples = Array.from({ length: 13 }, (_, i) => ({ t: i / 15, src: i === 6 ? 'mask.png' : null }))
  assert.equal(maskPresence(samples, 0.4), 0)
  assert.equal(maskPresence([{ t: 0, src: 'a' }, { t: 0.1, src: 'b' }], 0.6), 0)
  assert.equal(temporalWeight(0, 0.4), 0)
  assert.ok(temporalWeight(0, 0.3999) < 0.000001)
})

test('video1 10:38–10:40 detection pattern fades through dropouts instead of blinking', () => {
  // Positive GIM sample offsets (15 Hz) observed in the reported two-second stretch.
  const positive = new Set([0, 3, 4, 5, 6, 7, 8, 9, 12, 17, 19, 20, 21, 22, 23])
  const samples = Array.from({ length: 46 }, (_, i) => ({ t: 638 + (i - 7) / 15, src: positive.has(i - 7) ? 'mask.png' : null }))
  const opacity = Array.from({ length: 61 }, (_, i) => maskPresence(samples, 638 + i / 30))
  assert.ok(maskPresence(samples, 638.9) > 0, 'brief dropout remains continuous')
  assert.equal(maskPresence(samples, 640), 0, 'sustained negative still clears')
  assert.ok(Math.max(...opacity.slice(1).map((value, i) => Math.abs(value - opacity[i]))) < 0.25, 'opacity changes by less than a quarter per video frame')
})

test('temporal context preserves negatives and stays within half a second', () => {
  const frames = Array.from({ length: 31 }, (_, i) => frame(i, i / 10, i === 10 ? null : 'mask.png'))
  const window = maskWindowAt(frames, 1, 'gim', null)
  assert.ok(window.samples.some(sample => sample.t === 1 && sample.src === null))
  assert.ok(window.samples.every(sample => Math.abs(sample.t - 1) <= 0.5))
})

test('modality and region changes cut the smoothing context', () => {
  for (const boundary of [frame(2, 1.2, null, 'WL'), frame(2, 1.2, null, 'NBI', 'body')]) {
    const frames = [frame(0, 1), frame(1, 1.1), boundary, frame(3, 1.3)]
    const window = maskWindowAt(frames, 1.05, 'gim', null)
    assert.equal(window.to, 1.2)
    assert.ok(window.samples.every(sample => sample.t < 1.2))
  }
})

test('inapplicable or stale windows are empty; live results fill missing samples', () => {
  assert.deepEqual(maskWindowAt([frame(0, 1)], 1, 'polyp', null).samples, [])
  assert.deepEqual(maskWindowAt([frame(0, 1)], 3, 'gim', null).samples, [])
  const cached = { ...frame(0, 1), gim: null }
  assert.equal(maskWindowAt([cached], 1, 'gim', frame(0, 1)).samples.length, 1)
})
