// What `node:crypto` is in the web client's build (vite.web.config.ts swaps
// the module for this one), for the canvas service the web tab runs in the
// page (phase 9 spec, 3.8). The service hashes a board's text synchronously
// to tell its own writes from someone else's, and Web Crypto's digest is
// asynchronous, so SHA-256 is computed here; the ids it mints come from
// `getRandomValues`, which, unlike `randomUUID`, a browser offers outside a
// secure context too. Only the members the canvas modules call exist.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])

/** SHA-256 of bytes, as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const bitLength = bytes.length * 8
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6) >>> 0)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]
      const b = w[i - 2]
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    hash[0] += a
    hash[1] += b
    hash[2] += c
    hash[3] += d
    hash[4] += e
    hash[5] += f
    hash[6] += g
    hash[7] += h
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('')
}

type Hash = { update(data: string | Uint8Array): Hash; digest(encoding: 'hex'): string }

export function createHash(algorithm: string): Hash {
  if (algorithm !== 'sha256') throw new Error(`Only sha256 is available in a browser tab, not ${algorithm}.`)
  const parts: Uint8Array[] = []
  const hash: Hash = {
    update(data) {
      parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data)
      return hash
    },
    digest() {
      const total = parts.reduce((sum, part) => sum + part.length, 0)
      const all = new Uint8Array(total)
      let at = 0
      for (const part of parts) {
        all.set(part, at)
        at += part.length
      }
      return sha256Hex(all)
    },
  }
  return hash
}

export function randomUUID(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** An integer in [0, max), or [min, max) with two arguments, as Node's. */
export function randomInt(minOrMax: number, max?: number): number {
  const low = max === undefined ? 0 : minOrMax
  const high = max === undefined ? minOrMax : max
  const range = high - low
  if (!Number.isInteger(range) || range <= 0 || range > 2 ** 32)
    throw new RangeError('randomInt needs a range up to 2^32.')
  const limit = Math.floor(2 ** 32 / range) * range
  const word = new Uint32Array(1)
  do crypto.getRandomValues(word)
  while (word[0] >= limit)
  return low + (word[0] % range)
}
