/**
 * A PNG encoder and decoder on Node built-ins alone, shared by the brand
 * generators (`scripts/generate-icons.js`, `scripts/brand/night-sky.js`).
 *
 * The brand assets are generated rather than exported from an editor so that
 * every committed binary has a source that reproduces it, and a dependency on
 * an image library would make that source harder to run than the asset is to
 * look at. So: zlib for the compression, and the rest is the format.
 */

'use strict'
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

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.allocUnsafe(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.allocUnsafe(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([lenBuf, t, data, crcBuf])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// One scanline under one of the five PNG filters.
function filterLine(type, line, prev, bpp) {
  const out = Buffer.allocUnsafe(line.length)
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0
    const b = prev ? prev[i] : 0
    const c = prev && i >= bpp ? prev[i - bpp] : 0
    const predictor = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c)
    out[i] = (line[i] - predictor) & 0xff
  }
  return out
}

// The usual heuristic for choosing a filter: the one whose output has the
// smallest sum of absolute (signed) bytes compresses best, more often than not.
function adaptiveLine(line, prev, bpp) {
  let best = null
  let bestScore = Infinity
  for (let type = 0; type <= 4; type++) {
    const filtered = filterLine(type, line, prev, bpp)
    let score = 0
    for (let i = 0; i < filtered.length; i++) score += filtered[i] < 128 ? filtered[i] : 256 - filtered[i]
    if (score < bestScore) {
      bestScore = score
      best = { type, filtered }
    }
  }
  return best
}

/**
 * Encode 8-bit pixels. `channels` is 3 (RGB) or 4 (RGBA). `filter: 'none'` is
 * what the icon ladder has always written, and is kept so that its bytes do not
 * move; `'adaptive'` picks a filter per row, which is what makes a smooth
 * gradient (the night-sky plate) small.
 */
function encodePNG(width, height, pixels, { channels = 4, filter = 'none', level = 6 } = {}) {
  const stride = width * channels
  const rows = []
  for (let y = 0; y < height; y++) {
    const line = pixels.subarray(y * stride, (y + 1) * stride)
    if (filter === 'adaptive') {
      const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
      const { type, filtered } = adaptiveLine(line, prev, channels)
      rows.push(Buffer.from([type]), filtered)
    } else {
      rows.push(Buffer.from([0]), line)
    }
  }
  const compressed = zlib.deflateSync(Buffer.concat(rows), { level })

  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
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

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG. */
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

module.exports = { encodePNG, decodePNG }
