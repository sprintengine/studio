#!/usr/bin/env node
/**
 * Generates app icon files for electron-builder using only Node.js built-ins.
 * Output: resources/icon.png (256px), resources/icon.ico (16+32+256px), resources/icon.icns (16+32+128+256px)
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

// ── Pixel functions ───────────────────────────────────────────────────────────
const BG     = [9,   9,   11,  255]  // zinc-950
const INDIGO = [99,  102, 241, 255]  // indigo-500 (orchestrator cell)
const SKY    = [56,  189, 248, 255]  // sky-400    (worker cells)

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

function makeGridPixel(size, pad, gap, radius) {
  return function pixel(x, y) {
    const cellSize = (size - pad * 2 - gap) / 2
    const x2 = pad + cellSize,       y2 = pad + cellSize
    const x3 = pad + cellSize + gap, y3 = pad + cellSize + gap
    const x4 = x3 + cellSize,        y4 = y3 + cellSize
    if (inRoundedRect(x, y, pad, pad, x2, y2, radius)) return INDIGO
    if (inRoundedRect(x, y, x3,  pad, x4, y2, radius)) return SKY
    if (inRoundedRect(x, y, pad, y3,  x2, y4, radius)) return SKY
    if (inRoundedRect(x, y, x3,  y3,  x4, y4, radius)) return SKY
    return BG
  }
}

// ── ICO format (PNG-inside-ICO, Vista+) ──────────────────────────────────────
function buildICO(images) {
  // images: array of { size: number, png: Buffer }
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
// OSType codes: icp4=16, icp5=32, ic07=128, ic08=256
function buildICNS(icons) {
  // icons: array of { ostype: string, png: Buffer }
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

process.stdout.write('Generating icons…\n')

const png16  = buildPNG(16,  makeGridPixel(16,  2,  2, 1))
const png32  = buildPNG(32,  makeGridPixel(32,  4,  2, 2))
const png128 = buildPNG(128, makeGridPixel(128, 16, 8, 8))
const png256 = buildPNG(256, makeGridPixel(256, 32, 12, 14))

// Linux — single 256px PNG
fs.writeFileSync(path.join(outDir, 'icon.png'), png256)
process.stdout.write('  ✓ resources/icon.png  (256×256)\n')

// Windows — ICO containing 16, 32, 256
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildICO([
  { size: 16,  png: png16  },
  { size: 32,  png: png32  },
  { size: 256, png: png256 },
]))
process.stdout.write('  ✓ resources/icon.ico  (16, 32, 256px)\n')

// macOS — ICNS containing 16, 32, 128, 256
fs.writeFileSync(path.join(outDir, 'icon.icns'), buildICNS([
  { ostype: 'icp4', png: png16  },
  { ostype: 'icp5', png: png32  },
  { ostype: 'ic07', png: png128 },
  { ostype: 'ic08', png: png256 },
]))
process.stdout.write('  ✓ resources/icon.icns (16, 32, 128, 256px)\n')

process.stdout.write('Done.\n')
