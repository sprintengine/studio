#!/usr/bin/env node
/**
 * The night sky a nightly build wears: the splash plate, and the ground of the
 * nightly app icon (`scripts/generate-icons.js` imports `renderNightSky`).
 *
 * Generated, not painted, so the committed PNG has a source that reproduces it
 * byte for byte: every random choice comes from a seeded generator, and the
 * encoder is the shared one in `./png.js`. Run it directly to rewrite the plate:
 *
 *   node scripts/brand/night-sky.js
 *
 * Output: src/renderer/src/assets/backdrops/splash-night-sky.png (960 × 640,
 * the 480 × 320 splash window at 2×).
 *
 * The composition follows the creation-surface plates (the README beside the
 * output): a quiet centre that settles to the app ground, so the wordmark and
 * the bezelled mark sit on calm, and the art at the edges. The palette is a
 * deep navy that lifts toward a faint horizon, one diagonal band of denser
 * stars, and stars whose tint wanders between cool and warm white. There is no
 * moon, no landscape and nothing emblem-like — the mark in front is the only
 * figure on the plate.
 */

'use strict'
const fs = require('fs')
const path = require('path')
const { encodePNG } = require('./png')

// The app's dark ground (--sem-color-bg-app in the dark ramp, ref ink-950).
// The quiet centre fades to exactly this, so the plate meets the splash
// window's own background colour with no seam.
const APP_GROUND = [8, 8, 12]
// Zenith and horizon of the sky. Navy rather than black, so that even the
// icon at 16px, where no star survives, reads as a different card.
const ZENITH = [6, 9, 24]
const HORIZON = [16, 24, 52]
// The diagonal band's glow, added on top of the sky.
const BAND = [20, 22, 44]
// Star tints: mostly neutral white, some cool, a few warm.
const STAR_TINTS = [
  [255, 255, 255],
  [255, 255, 255],
  [214, 226, 255],
  [200, 216, 255],
  [255, 236, 212],
]

// mulberry32: small, fast, and the same sequence on every machine.
function createRandom(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Smooth value noise on an integer lattice, hashed rather than tabled.
function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x),
    y0 = Math.floor(y)
  const fx = x - x0,
    fy = y - y0
  const sx = fx * fx * (3 - 2 * fx),
    sy = fy * fy * (3 - 2 * fy)
  const a = hash2(x0, y0, seed),
    b = hash2(x0 + 1, y0, seed)
  const c = hash2(x0, y0 + 1, seed),
    d = hash2(x0 + 1, y0 + 1, seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

function fbm(x, y, seed) {
  let sum = 0,
    amp = 0.5,
    freq = 1
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o)
    amp *= 0.5
    freq *= 2
  }
  return sum
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/**
 * Render the sky into an RGB byte buffer.
 *
 * - `quietCentre`: settle the middle ~⅔ × ⅔ to APP_GROUND and thin the stars
 *   there (the splash plate). Off for the icon, whose centre is the mark.
 * - `starCount`, `starScale`: how many stars are tried, and their radius in
 *   output pixels at scale 1. The icon uses fewer, larger stars so that some
 *   survive down to the Dock's size.
 * - `seed`: change it to get a different sky; keep it to reproduce this one.
 */
function renderNightSky({ width, height, seed = 20260922, quietCentre = true, starCount = 1400, starScale = 1 }) {
  const random = createRandom(seed)
  const sky = new Float32Array(width * height * 3)

  // Distance from the band's axis, which runs from the lower left to the upper
  // right, in plate-normalised units.
  const bx0 = 0.02,
    by0 = 0.98,
    bx1 = 0.98,
    by1 = 0.06
  const blen = Math.hypot(bx1 - bx0, by1 - by0)
  const bandDistance = (u, v) => Math.abs((by1 - by0) * u - (bx1 - bx0) * v + bx1 * by0 - by1 * bx0) / blen

  // 0 at the centre of the stage, 1 outside it.
  const stage = (u, v) => {
    if (!quietCentre) return 1
    const e = Math.hypot((u - 0.5) / 0.36, (v - 0.47) / 0.34)
    return smoothstep(0.3, 1.4, e)
  }

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1)
    const lift = Math.pow(v, 1.4)
    const horizon = Math.exp(-Math.pow((1 - v) / 0.2, 2)) * 0.35
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1)
      const band = Math.exp(-Math.pow(bandDistance(u, v) / 0.12, 2)) * 1.6 * Math.pow(fbm(u * 9, v * 6, seed), 2.2)
      const q = stage(u, v)
      const o = (y * width + x) * 3
      for (let c = 0; c < 3; c++) {
        const base = ZENITH[c] + (HORIZON[c] - ZENITH[c]) * lift + HORIZON[c] * horizon + BAND[c] * band
        sky[o + c] = APP_GROUND[c] + (base - APP_GROUND[c]) * (0.2 + 0.8 * q)
      }
    }
  }

  // Stars. Each is tried at a random place and kept with a probability that
  // falls off in the quiet centre and rises inside the band, so the field
  // gathers at the edges and along the diagonal.
  for (let i = 0; i < starCount; i++) {
    const u = random(),
      v = random()
    const q = stage(u, v)
    const inBand = Math.exp(-Math.pow(bandDistance(u, v) / 0.1, 2))
    const keep = (0.06 + 0.94 * q) * (0.45 + 0.55 * inBand + 0.3)
    const brightnessRoll = random()
    const sizeRoll = random()
    const tint = STAR_TINTS[Math.floor(random() * STAR_TINTS.length)]
    if (random() > keep) continue

    const brightness = (0.18 + 0.82 * Math.pow(brightnessRoll, 3)) * (0.35 + 0.65 * q)
    const radius = (0.55 + 1.3 * Math.pow(sizeRoll, 5)) * starScale
    const sigma = radius * 0.6
    const halo = brightness > 0.6 ? sigma * 3.5 : 0
    const reach = Math.ceil(Math.max(sigma * 3, halo * 2.5))
    const cx = u * width,
      cy = v * height
    for (let py = Math.max(0, Math.floor(cy - reach)); py <= Math.min(height - 1, Math.ceil(cy + reach)); py++) {
      for (let px = Math.max(0, Math.floor(cx - reach)); px <= Math.min(width - 1, Math.ceil(cx + reach)); px++) {
        const d2 = (px + 0.5 - cx) ** 2 + (py + 0.5 - cy) ** 2
        let k = Math.exp(-d2 / (2 * sigma * sigma))
        if (halo) k += 0.07 * Math.exp(-d2 / (2 * halo * halo))
        const w = brightness * k
        if (w < 0.002) continue
        const o = (py * width + px) * 3
        for (let c = 0; c < 3; c++) sky[o + c] += tint[c] * w
      }
    }
  }

  // Quantise with a small ordered dither, so the long dark gradient does not
  // band into visible steps. Ordered rather than random: it is deterministic,
  // and its repeating pattern costs the compressor far less than noise would.
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
  const out = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const threshold = (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5
      const o = (y * width + x) * 3
      for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, Math.round(sky[o + c] + threshold)))
    }
  }
  return out
}

const SPLASH_WIDTH = 960
const SPLASH_HEIGHT = 640
const SPLASH_OUTPUT = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'assets',
  'backdrops',
  'splash-night-sky.png',
)

if (require.main === module) {
  const pixels = renderNightSky({ width: SPLASH_WIDTH, height: SPLASH_HEIGHT })
  const png = encodePNG(SPLASH_WIDTH, SPLASH_HEIGHT, pixels, { channels: 3, filter: 'adaptive', level: 9 })
  fs.writeFileSync(SPLASH_OUTPUT, png)
  process.stdout.write(
    `  ✓ ${path.relative(path.join(__dirname, '..', '..'), SPLASH_OUTPUT)}  (${SPLASH_WIDTH}×${SPLASH_HEIGHT}, ${Math.round(png.length / 1024)} KB)\n`,
  )
}

module.exports = { renderNightSky, APP_GROUND }
