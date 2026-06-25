#!/usr/bin/env node
/**
 * Generates app icon files for electron-builder using only Node.js built-ins.
 * Renders the Multicode brand mark: a rounded-square charcoal background with
 * a two-faced angular glyph (light-grey left face, mid-grey right face).
 * Edges are anti-aliased via 4× supersampling (premultiplied-alpha downsample),
 * so no rasterizer dependency is needed.
 * Output: resources/icon.png (512px), resources/icon.ico (16…256px),
 *         resources/icon.icns (16…1024px).
 */

'use strict'
const fs   = require('fs')
const path = require('path')
const zlib = require('zlib')

// ── CRC32 ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
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
      row[i] = r; row[i + 1] = g; row[i + 2] = b; row[i + 3] = a
    }
    rows.push(row)
  }
  const rawData   = Buffer.concat(rows)
  const compressed = zlib.deflateSync(rawData, { level: 6 })

  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// Anti-aliased PNG: render the mark at `ss`× resolution and box-downsample,
// averaging in PREMULTIPLIED alpha so edges against transparency (the rounded
// corners and the glyph faces over the gradient) stay clean instead of dark-
// fringed. Pure-Node, no rasterizer dependency — just supersampling.
function buildPNGAA(size, ss = 4) {
  const hi = size * ss
  const px = makeMarkPixel(hi)
  const samples = ss * ss
  return buildPNG(size, (x, y) => {
    let sr = 0, sg = 0, sb = 0, sa = 0
    for (let sy = 0; sy < ss; sy++) {
      for (let sx = 0; sx < ss; sx++) {
        const [r, g, b, a] = px(x * ss + sx, y * ss + sy)
        const af = a / 255
        sr += r * af; sg += g * af; sb += b * af; sa += af
      }
    }
    if (sa <= 0) return [0, 0, 0, 0]
    // Un-premultiply the colour; alpha is the mean coverage.
    return [
      Math.round(sr / sa),
      Math.round(sg / sa),
      Math.round(sb / sa),
      Math.round((sa / samples) * 255),
    ]
  })
}

// ── Brand palette ─────────────────────────────────────────────────────────────
const BG_TOP    = [22, 22, 28]
const BG_BOTTOM = [5,  5,  7 ]
const LEFT_TOP    = [244, 244, 245]
const LEFT_BOTTOM = [122, 122, 130]
const RIGHT_TOP    = [154, 154, 162]
const RIGHT_BOTTOM = [58,  58,  68 ]

function lerp(a, b, t) { return a + (b - a) * t }
function lerpRGB(c0, c1, t) {
  return [Math.round(lerp(c0[0], c1[0], t)),
          Math.round(lerp(c0[1], c1[1], t)),
          Math.round(lerp(c0[2], c1[2], t))]
}

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

// Point-in-triangle via sign of edge cross products.
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

// Point in quad (4 vertices in order) — split into two triangles.
function pointInQuad(px, py, q) {
  return (
    pointInTriangle(px, py, q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1]) ||
    pointInTriangle(px, py, q[0][0], q[0][1], q[2][0], q[2][1], q[3][0], q[3][1])
  )
}

function makeMarkPixel(size) {
  const radius = Math.round(size * 0.22)
  // Glyph occupies an inner rect roughly 60% wide, 64% tall, centered.
  const gx0 = Math.round(size * 0.20)
  const gx1 = Math.round(size * 0.80)
  const gy0 = Math.round(size * 0.18)
  const gy1 = Math.round(size * 0.84)
  const cx  = Math.round(size * 0.50)
  const cyTop = Math.round(size * 0.44) // valley meeting point (top of inner V)

  // Left quad: TopLeft, TopRight (slope down to valley), BottomRight, BottomLeft
  const leftQuad = [
    [gx0, gy0],
    [cx,  cyTop],
    [cx,  gy1],
    [gx0, gy1],
  ]
  // Right quad mirror
  const rightQuad = [
    [cx,  cyTop],
    [gx1, gy0],
    [gx1, gy1],
    [cx,  gy1],
  ]

  return function pixel(x, y) {
    // Outside the rounded square: transparent.
    if (!inRoundedRect(x, y, 0, 0, size - 1, size - 1, radius)) {
      return [0, 0, 0, 0]
    }
    // Background: vertical gradient charcoal.
    const ty = y / (size - 1)
    const bg = lerpRGB(BG_TOP, BG_BOTTOM, ty)

    if (pointInQuad(x, y, leftQuad)) {
      const t = (y - gy0) / Math.max(1, gy1 - gy0)
      const [r, g, b] = lerpRGB(LEFT_TOP, LEFT_BOTTOM, t)
      return [r, g, b, 255]
    }
    if (pointInQuad(x, y, rightQuad)) {
      const t = (y - gy0) / Math.max(1, gy1 - gy0)
      const [r, g, b] = lerpRGB(RIGHT_TOP, RIGHT_BOTTOM, t)
      return [r, g, b, 255]
    }
    return [bg[0], bg[1], bg[2], 255]
  }
}

// ── ICO format (PNG-inside-ICO, Vista+) ──────────────────────────────────────
function buildICO(images) {
  const count      = images.length
  const entryBytes = 16
  const dataStart  = 6 + count * entryBytes

  const header = Buffer.allocUnsafe(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4)

  const parts = [header]
  let offset = dataStart
  for (const { size, png } of images) {
    const e = Buffer.allocUnsafe(entryBytes)
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size
    e[2] = 0; e[3] = 0
    e.writeUInt16LE(1,  4)
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
  const body    = Buffer.concat(chunks)
  const magic   = Buffer.from('icns', 'ascii')
  const fileLen = Buffer.allocUnsafe(4)
  fileLen.writeUInt32BE(8 + body.length, 0)
  return Buffer.concat([magic, fileLen, body])
}

// ── Main ──────────────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'resources')
fs.mkdirSync(outDir, { recursive: true })

process.stdout.write('Generating icons (anti-aliased, supersampled)…\n')

// Render each size anti-aliased once, then reuse across the container formats.
const png = {}
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  png[s] = buildPNGAA(s)
}

// Linux / generic: a crisp 512px master (electron-builder upsamples from here).
fs.writeFileSync(path.join(outDir, 'icon.png'), png[512])
process.stdout.write('  ✓ resources/icon.png  (512×512)\n')

// Windows .ico — PNG-compressed entries; 256 is the format ceiling.
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildICO([
  { size: 16,  png: png[16]  },
  { size: 24,  png: png[24]  },
  { size: 32,  png: png[32]  },
  { size: 48,  png: png[48]  },
  { size: 64,  png: png[64]  },
  { size: 128, png: png[128] },
  { size: 256, png: png[256] },
]))
process.stdout.write('  ✓ resources/icon.ico  (16, 24, 32, 48, 64, 128, 256px)\n')

// macOS .icns — full modern ladder up to 1024 so Retina/Finder never upscales.
fs.writeFileSync(path.join(outDir, 'icon.icns'), buildICNS([
  { ostype: 'icp4', png: png[16]   },
  { ostype: 'icp5', png: png[32]   },
  { ostype: 'icp6', png: png[64]   },
  { ostype: 'ic07', png: png[128]  },
  { ostype: 'ic08', png: png[256]  },
  { ostype: 'ic09', png: png[512]  },
  { ostype: 'ic10', png: png[1024] },
]))
process.stdout.write('  ✓ resources/icon.icns (16, 32, 64, 128, 256, 512, 1024px)\n')

process.stdout.write('Done.\n')
