#!/usr/bin/env node
/**
 * Generates app icon files for electron-builder using only Node.js built-ins.
 *
 * Renders the SprintEngine Studio mark: the "se" pair (paper `s`, green `e`)
 * on the app's dark card. The mark itself is NOT drawn here — text needs a font
 * rasterizer, which this script deliberately does not depend on. It is read
 * from `resources/brand/sprintengine-se-mark-1024.png`, the committed master
 * exported from `sprintengine-se-mark.source.html` beside it.
 *
 * The master is RGB with the card's rounded corners sitting on the source
 * HTML's `#888` page background — an app icon needs real transparency there, or
 * macOS shows a grey square in the Dock. So the rounded rect is re-cut here:
 * coverage is supersampled 4×, fully-inside pixels keep the master's colour,
 * boundary pixels take the card colour at partial alpha, and outside goes fully
 * transparent. The corners are solid card everywhere the mask bites, so no grey
 * fringe survives.
 *
 * Sizes are area-averaged down from the 1024 master in PREMULTIPLIED alpha, so
 * the corner edges stay clean instead of dark-fringed at 16px.
 *
 * Output: resources/icon.png (512px), resources/icon.ico (16…256px),
 *         resources/icon.icns (16…1024px), and the same three again as
 *         resources/icon-nightly.* — the mark on a night sky, for the nightly
 *         channel (see buildNightlyMaster).
 */

'use strict'
const fs = require('fs')
const path = require('path')
const { decodePNG, encodePNG } = require('./brand/png')
const { renderNightSky } = require('./brand/night-sky')

// ── PNG ───────────────────────────────────────────────────────────────────────
// Unfiltered rows at zlib level 6, which is what this script has always
// written, so regenerating the stable ladder leaves its bytes alone. (Per-row
// filtering was tried for the nightly ladder and came out larger: the area
// averaging leaves no row-to-row regularity for a filter to find.)
function buildPNG(size, getPixel) {
  const rgba = Buffer.allocUnsafe(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      const [r, g, b, a] = getPixel(x, y, size)
      rgba[o] = r
      rgba[o + 1] = g
      rgba[o + 2] = b
      rgba[o + 3] = a
    }
  }
  return encodePNG(size, size, rgba, { channels: 4 })
}

// ── Geometry ──────────────────────────────────────────────────────────────────
function inRoundedRect(x, y, x1, y1, x2, y2, r) {
  if (x < x1 || x > x2 || y < y1 || y > y2) return false
  const corners = [
    [x < x1 + r && y < y1 + r, x1 + r, y1 + r],
    [x > x2 - r && y < y1 + r, x2 - r, y1 + r],
    [x < x1 + r && y > y2 - r, x1 + r, y2 - r],
    [x > x2 - r && y > y2 - r, x2 - r, y2 - r],
  ]
  for (const [inCorner, cx, cy] of corners) {
    if (inCorner) return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  }
  return true
}

// ── Master: the brand PNG with real rounded-corner alpha ──────────────────────
// The card colour, matching `#0c0c10` in the mark's source HTML. Boundary
// pixels are painted with this rather than the master's own, whose corner
// anti-aliasing is blended toward the source page's #888.
const CARD = [0x0c, 0x0c, 0x10]
const RADIUS_RATIO = 236 / 1024 // border-radius from the mark's source HTML
const SS = 4 // coverage supersampling

function buildMaster(srcPath) {
  const { width, height, bpp, pixels } = decodePNG(fs.readFileSync(srcPath))
  if (width !== height) throw new Error(`master must be square, got ${width}×${height}`)
  const n = width
  const r = RADIUS_RATIO * n
  const rgba = Buffer.alloc(n * n * 4)

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let covered = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          if (inRoundedRect(px, py, 0, 0, n, n, r)) covered++
        }
      }
      const o = (y * n + x) * 4
      if (covered === 0) {
        rgba[o] = 0
        rgba[o + 1] = 0
        rgba[o + 2] = 0
        rgba[o + 3] = 0
        continue
      }
      if (covered === SS * SS) {
        const i = (y * n + x) * bpp
        rgba[o] = pixels[i]
        rgba[o + 1] = pixels[i + 1]
        rgba[o + 2] = pixels[i + 2]
        rgba[o + 3] = 255
      } else {
        rgba[o] = CARD[0]
        rgba[o + 1] = CARD[1]
        rgba[o + 2] = CARD[2]
        rgba[o + 3] = Math.round((covered / (SS * SS)) * 255)
      }
    }
  }
  return { size: n, rgba }
}

// Area-average down to `size`, in premultiplied alpha. Handles sizes that do
// not divide the master evenly (24, 48) by weighting partial source pixels.
function resample(master, size) {
  const { size: n, rgba } = master
  const scale = n / size
  return buildPNG(size, (x, y) => {
    const x0 = x * scale,
      x1 = (x + 1) * scale
    const y0 = y * scale,
      y1 = (y + 1) * scale
    let sr = 0,
      sg = 0,
      sb = 0,
      sa = 0,
      sw = 0
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
      const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
      for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
        const wx = Math.min(x1, sx + 1) - Math.max(x0, sx)
        const w = wx * wy
        if (w <= 0) continue
        const o = (sy * n + sx) * 4
        const af = (rgba[o + 3] / 255) * w
        sr += rgba[o] * af
        sg += rgba[o + 1] * af
        sb += rgba[o + 2] * af
        sa += af
        sw += w
      }
    }
    if (sa <= 0) return [0, 0, 0, 0]
    return [Math.round(sr / sa), Math.round(sg / sa), Math.round(sb / sa), Math.round((sa / sw) * 255)]
  })
}

// ── ICO format (PNG-inside-ICO, Vista+) ──────────────────────────────────────
function buildICO(images) {
  const count = images.length
  const entryBytes = 16
  const dataStart = 6 + count * entryBytes

  const header = Buffer.allocUnsafe(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)

  const parts = [header]
  let offset = dataStart
  for (const { size, png } of images) {
    const e = Buffer.allocUnsafe(entryBytes)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0
    e[3] = 0
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    parts.push(e)
    offset += png.length
  }
  for (const { png } of images) parts.push(png)
  return Buffer.concat(parts)
}

// ── ICNS format ───────────────────────────────────────────────────────────────
function buildICNS(icons) {
  const chunks = icons.map(({ ostype, png }) => {
    const t = Buffer.from(ostype, 'ascii')
    const l = Buffer.allocUnsafe(4)
    l.writeUInt32BE(8 + png.length, 0)
    return Buffer.concat([t, l, png])
  })
  const body = Buffer.concat(chunks)
  const magic = Buffer.from('icns', 'ascii')
  const fileLen = Buffer.allocUnsafe(4)
  fileLen.writeUInt32BE(8 + body.length, 0)
  return Buffer.concat([magic, fileLen, body])
}

// ── Nightly: the same mark on a night sky ────────────────────────────────────
// A nightly build updates itself several times a day and can sit on the same
// machine as a stable one, so it is worth telling apart in the Dock or the
// taskbar at a glance. The mark, the silhouette and the icon grid are the
// stable icon's, untouched; only the card's ground changes, from the flat ink
// card to the night sky the nightly splash opens on (scripts/brand/night-sky.js).
//
// The master is the mark's letters anti-aliased onto the flat card, so each
// pixel is `card + a·(ink − card)` for one of the two inks. Recovering `a`
// lets the card be swapped for the sky without re-rasterising the letters:
// `out = pixel + (1 − a)·(sky − card)`, which leaves a letter's solid pixels
// exactly as they were and moves an edge pixel by the share of card in it.
const PAPER_INK = [0xec, 0xec, 0xec] // the `s`, paper-100
const GREEN_INK = [0x3f, 0x94, 0x68] // the `e`, green-500

function letterCoverage(r, g, b) {
  const dr = r - CARD[0],
    dg = g - CARD[1],
    db = b - CARD[2]
  if (dr <= 0 && dg <= 0 && db <= 0) return 0
  // The green ink lifts green well past red; the paper ink lifts all three.
  const green = dg > 4 && dg - dr > 0.35 * dg
  const coverage = green
    ? dg / (GREEN_INK[1] - CARD[1])
    : (dr + dg + db) / (PAPER_INK[0] - CARD[0] + PAPER_INK[1] - CARD[1] + PAPER_INK[2] - CARD[2])
  return Math.min(1, Math.max(0, coverage))
}

function buildNightlyMaster(master) {
  const { size: n, rgba } = master
  // Fewer, larger stars than the splash plate: at 1024 they are a sky, and the
  // brightest still leave a point at the Dock's 128px.
  const sky = renderNightSky({ width: n, height: n, quietCentre: false, starCount: 320, starScale: 4.5 })
  const out = Buffer.from(rgba)
  for (let i = 0; i < n * n; i++) {
    const o = i * 4
    if (out[o + 3] === 0) continue
    const s = i * 3
    const share = 1 - letterCoverage(out[o], out[o + 1], out[o + 2])
    for (let c = 0; c < 3; c++) {
      out[o + c] = Math.max(0, Math.min(255, Math.round(out[o + c] + share * (sky[s + c] - CARD[c]))))
    }
  }
  return { size: n, rgba: out }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'resources')
const srcPng = path.join(outDir, 'brand', 'sprintengine-se-mark-1024.png')
fs.mkdirSync(outDir, { recursive: true })

// One ladder: `<name>.png` (512, Linux and the tray), `<name>.ico` (Windows,
// PNG-compressed entries; 256 is the format ceiling) and `<name>.icns` (macOS,
// the full modern ladder up to 1024 so Retina/Finder never upscales).
function writeIconSet(master, name) {
  const png = {}
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    png[s] = resample(master, s)
  }

  fs.writeFileSync(path.join(outDir, `${name}.png`), png[512])
  process.stdout.write(`  ✓ resources/${name}.png  (512×512)\n`)

  fs.writeFileSync(
    path.join(outDir, `${name}.ico`),
    buildICO([
      { size: 16, png: png[16] },
      { size: 24, png: png[24] },
      { size: 32, png: png[32] },
      { size: 48, png: png[48] },
      { size: 64, png: png[64] },
      { size: 128, png: png[128] },
      { size: 256, png: png[256] },
    ]),
  )
  process.stdout.write(`  ✓ resources/${name}.ico  (16, 24, 32, 48, 64, 128, 256px)\n`)

  fs.writeFileSync(
    path.join(outDir, `${name}.icns`),
    buildICNS([
      { ostype: 'icp4', png: png[16] },
      { ostype: 'icp5', png: png[32] },
      { ostype: 'icp6', png: png[64] },
      { ostype: 'ic07', png: png[128] },
      { ostype: 'ic08', png: png[256] },
      { ostype: 'ic09', png: png[512] },
      { ostype: 'ic10', png: png[1024] },
    ]),
  )
  process.stdout.write(`  ✓ resources/${name}.icns  (16, 32, 64, 128, 256, 512, 1024px)\n`)
}

process.stdout.write(`Generating icons from ${path.relative(path.join(__dirname, '..'), srcPng)}…\n`)
const master = buildMaster(srcPng)
writeIconSet(master, 'icon')
// The nightly channel's set. The release workflow puts it in place of the
// stable set before it packages a nightly (scripts/release/use-channel-icons.mjs).
writeIconSet(buildNightlyMaster(master), 'icon-nightly')

process.stdout.write('Done.\n')
