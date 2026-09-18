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
 *         resources/icon.icns (16…1024px).
 */

'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ── CRC32 ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ── PNG builder ───────────────────────────────────────────────────────────────
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.allocUnsafe(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.allocUnsafe(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([lenBuf, t, data, crcBuf])
}

function buildPNG(size, getPixel) {
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.allocUnsafe(1 + size * 4)
    row[0] = 0 // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = getPixel(x, y, size)
      const i = 1 + x * 4
      row[i] = r
      row[i + 1] = g
      row[i + 2] = b
      row[i + 3] = a
    }
    rows.push(row)
  }
  const rawData = Buffer.concat(rows)
  const compressed = zlib.deflateSync(rawData, { level: 6 })

  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ── PNG reader (8-bit, non-interlaced, RGB or RGBA) ───────────────────────────
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0
  const idat = []
  let off = 8
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} is not supported`)
  if (colorType !== 2 && colorType !== 6) throw new Error(`colour type ${colorType} is not supported`)

  const bpp = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= bpp ? prev[i - bpp] : 0
      const v = line[i]
      cur[i] =
        (filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : v + paeth(a, b, c)) & 0xff
    }
  }
  return { width, height, bpp, pixels: out }
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

// ── Main ──────────────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'resources')
const srcPng = path.join(outDir, 'brand', 'sprintengine-se-mark-1024.png')
fs.mkdirSync(outDir, { recursive: true })

process.stdout.write(`Generating icons from ${path.relative(path.join(__dirname, '..'), srcPng)}…\n`)
const master = buildMaster(srcPng)

const png = {}
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  png[s] = resample(master, s)
}

// Linux / generic: a crisp 512px master (electron-builder upsamples from here).
fs.writeFileSync(path.join(outDir, 'icon.png'), png[512])
process.stdout.write('  ✓ resources/icon.png  (512×512)\n')

// Windows .ico — PNG-compressed entries; 256 is the format ceiling.
fs.writeFileSync(
  path.join(outDir, 'icon.ico'),
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
process.stdout.write('  ✓ resources/icon.ico  (16, 24, 32, 48, 64, 128, 256px)\n')

// macOS .icns — full modern ladder up to 1024 so Retina/Finder never upscales.
fs.writeFileSync(
  path.join(outDir, 'icon.icns'),
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
process.stdout.write('  ✓ resources/icns ladder (16, 32, 64, 128, 256, 512, 1024px)\n')

process.stdout.write('Done.\n')
