// A QR Code encoder, in the slice this product needs and no more.
//
// Why hand-written rather than a dependency: the same reason the tailnet
// listener hand-writes its WebSocket framing. The app ships no QR library, the
// needed slice is one mode (byte) at one error-correction level (M), and the
// format is fully specified by ISO/IEC 18004. Pulling a package in to draw one
// pairing square would add a supply-chain surface to a security feature.
//
// What it does NOT do, deliberately: no numeric/alphanumeric/kanji modes, no
// ECI, no structured append, no level L/Q/H. Byte mode encodes any UTF-8 string
// correctly, which is the whole requirement — a pairing URL. Level M is the
// standard middle grade (~15% recovery), enough for a square scanned off a
// screen at arm's length.
//
// Over-capacity is an explicit null, never a truncated or "best effort" square:
// a QR that scans to half a pairing URL is worse than no QR, because the person
// holding the phone cannot tell the difference. See the callers — they show the
// copyable URL and say why the square is absent.

/** Error-correction level this encoder emits. Fixed at M by design (see above). */
const QR_ECC_LEVEL_M = 0

/** The largest version (177×177) the format defines. */
const MAX_VERSION = 40

/**
 * ECC codewords per block, level M, indexed by version (index 0 unused).
 * Table 13-22 of ISO/IEC 18004.
 */
const ECC_CODEWORDS_PER_BLOCK_M: readonly number[] = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
]

/** Error-correction block count, level M, indexed by version (index 0 unused). */
const ECC_BLOCKS_M: readonly number[] = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33,
  35, 37, 38, 40, 43, 45, 47, 49,
]

/** A rendered symbol: a square grid where true is a dark module. */
export type QrMatrix = {
  version: number
  /** Modules per side, `version * 4 + 17`. */
  size: number
  /** Row-major; `modules[y][x]`. */
  modules: boolean[][]
}

/**
 * Encode `text` as a QR symbol, or null when it does not fit in any version.
 *
 * Null is reachable only for inputs over ~2.3 KB, which no pairing URL
 * approaches — it is the honest answer rather than a thrown error because the
 * caller's response is to render the text form instead, not to fail.
 */
export function encodeQrCode(text: string): QrMatrix | null {
  const data = utf8Bytes(text)
  const version = smallestVersionFor(data.length)
  if (version === null) return null

  const codewords = addEccAndInterleave(buildDataCodewords(data, version), version)
  const symbol = new QrSymbol(version)
  symbol.drawFunctionPatterns()
  symbol.drawCodewords(codewords)
  symbol.applyBestMask()
  return { version, size: symbol.size, modules: symbol.modules }
}

/** Bytes a version holds in byte mode at level M — exported for callers that size input. */
export function qrByteCapacity(version: number): number {
  const dataBits = dataCodewordCount(version) * 8
  return Math.floor((dataBits - 4 - charCountBits(version)) / 8)
}

function smallestVersionFor(byteLength: number): number | null {
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (qrByteCapacity(version) >= byteLength) return version
  }
  return null
}

/** Byte-mode character-count field width: 8 bits through version 9, 16 above. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16
}

/**
 * Total codewords a version carries, derived rather than tabled.
 *
 * The count follows from the symbol's geometry: the full module area, less the
 * function patterns (finders with separators, timing, alignment, format, and
 * version blocks). Deriving it keeps one 40-row table out of the file and makes
 * a transcription error impossible.
 */
function rawCodewordCount(version: number): number {
  let modules = (16 * version + 128) * version + 64
  if (version >= 2) {
    const alignmentCount = Math.floor(version / 7) + 2
    modules -= (25 * alignmentCount - 10) * alignmentCount - 55
    if (version >= 7) modules -= 36
  }
  return Math.floor(modules / 8)
}

function dataCodewordCount(version: number): number {
  return rawCodewordCount(version) - ECC_CODEWORDS_PER_BLOCK_M[version] * ECC_BLOCKS_M[version]
}

/**
 * The version's block geometry at level M. Exported so a reader (the test's
 * decoder) can de-interleave a symbol without restating the tables; the tables
 * themselves are pinned by the published byte capacities, not by that reader.
 */
export function qrBlockGeometry(version: number): {
  eccPerBlock: number
  blocks: number
  rawCodewords: number
} {
  return {
    eccPerBlock: ECC_CODEWORDS_PER_BLOCK_M[version],
    blocks: ECC_BLOCKS_M[version],
    rawCodewords: rawCodewordCount(version),
  }
}

// ── Data encoding ────────────────────────────────────────────────────────────

function utf8Bytes(text: string): number[] {
  // TextEncoder is present in both the renderer and the main process; this file
  // is shared, so it must not reach for Buffer.
  return Array.from(new TextEncoder().encode(text))
}

function buildDataCodewords(data: readonly number[], version: number): number[] {
  const bits: number[] = []
  appendBits(bits, 0b0100, 4) // byte mode
  appendBits(bits, data.length, charCountBits(version))
  for (const byte of data) appendBits(bits, byte, 8)

  const capacityBits = dataCodewordCount(version) * 8
  // Terminator, then pad to a byte boundary, then the specified alternating
  // pad bytes. All three are spec-mandated; none of them is filler we chose.
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length))
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8)

  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    codewords.push(byte)
  }
  return codewords
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
}

/**
 * Split data into blocks, append each block's ECC, and interleave.
 *
 * Interleaving is what makes the level's recovery rate mean anything: a smudge
 * covering one region of the symbol then damages a few codewords in every
 * block, rather than destroying one block outright.
 */
function addEccAndInterleave(data: readonly number[], version: number): number[] {
  const blockCount = ECC_BLOCKS_M[version]
  const eccLength = ECC_CODEWORDS_PER_BLOCK_M[version]
  const rawCount = rawCodewordCount(version)
  const shortBlockCount = blockCount - (rawCount % blockCount)
  const shortBlockLength = Math.floor(rawCount / blockCount)

  const divisor = reedSolomonDivisor(eccLength)
  const blocks: number[][] = []
  for (let i = 0, offset = 0; i < blockCount; i++) {
    const dataLength = shortBlockLength - eccLength + (i < shortBlockCount ? 0 : 1)
    const block = data.slice(offset, offset + dataLength)
    offset += dataLength
    const ecc = reedSolomonRemainder(block, divisor)
    // Short blocks carry a placeholder so every block is the same length here;
    // the interleave below skips that column, so it never reaches the symbol.
    if (i < shortBlockCount) block.push(0)
    blocks.push([...block, ...ecc])
  }

  const result: number[] = []
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLength - eccLength || j >= shortBlockCount) result.push(blocks[j][i])
    }
  }
  return result
}

// ── Reed-Solomon over GF(256) ────────────────────────────────────────────────
//
// The field is GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11d), as the format
// specifies. Multiplication is the Russian-peasant loop rather than log tables:
// the symbol needs a few thousand products, so the table would be setup cost
// for no measurable gain, and the loop is the definition written out.

/** Coefficients of the degree-`degree` generator polynomial, highest term implicit. */
function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  // Multiply by (x - r^i) for i = 0 .. degree-1, where r = 0x02 generates the field.
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number)
    result.push(0)
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor)
  }
  return result
}

export function gfMultiply(a: number, b: number): number {
  let result = 0
  for (let i = 7; i >= 0; i--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d)
    result ^= ((b >>> i) & 1) * a
  }
  return result & 0xff
}

// ── Symbol drawing ───────────────────────────────────────────────────────────

class QrSymbol {
  readonly size: number
  readonly modules: boolean[][]
  /** Modules owned by function patterns; the data walk steps over them. */
  private readonly reserved: boolean[][]

  constructor(private readonly version: number) {
    this.size = version * 4 + 17
    this.modules = grid(this.size)
    this.reserved = grid(this.size)
  }

  drawFunctionPatterns(): void {
    // Timing patterns: alternating modules along row and column 6.
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0)
      this.setFunction(i, 6, i % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(this.size - 4, 3)
    this.drawFinder(3, this.size - 4)

    const positions = alignmentPositions(this.version)
    for (let i = 0; i < positions.length; i++) {
      for (let j = 0; j < positions.length; j++) {
        // The three finder corners already own these centres.
        const isFinderCorner =
          (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0)
        if (!isFinderCorner) this.drawAlignment(positions[i], positions[j])
      }
    }

    // Format bits are written for real once a mask is chosen; this reserves
    // their modules so the data walk does not claim them.
    this.drawFormatBits(0)
    this.drawVersionBits()
  }

  private drawFinder(centerX: number, centerY: number): void {
    // 5×5 of concentric rings, plus the separator ring outside it.
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        const x = centerX + dx
        const y = centerY + dy
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunction(x, y, distance !== 2 && distance !== 4)
        }
      }
    }
  }

  private drawAlignment(centerX: number, centerY: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  /** The 15 format bits (level + mask), BCH-protected, written in both copies. */
  drawFormatBits(mask: number): void {
    // Level M is 0b00; the mask index follows in the low three bits.
    const data = (QR_ECC_LEVEL_M << 3) | mask
    let remainder = data
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
    const bits = (((data << 10) | remainder) ^ 0x5412) & 0x7fff

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bitAt(bits, i))
    this.setFunction(8, 7, bitAt(bits, 6))
    this.setFunction(8, 8, bitAt(bits, 7))
    this.setFunction(7, 8, bitAt(bits, 8))
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bitAt(bits, i))

    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bitAt(bits, i))
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bitAt(bits, i))
    // The always-dark module below the top-left format strip.
    this.setFunction(8, this.size - 8, true)
  }

  private drawVersionBits(): void {
    if (this.version < 7) return
    let remainder = this.version
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
    const bits = (this.version << 12) | remainder

    for (let i = 0; i < 18; i++) {
      const bit = bitAt(bits, i)
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunction(a, b, bit)
      this.setFunction(b, a, bit)
    }
  }

  /** Lay codewords along the upward/downward zigzag of two-module columns. */
  drawCodewords(codewords: readonly number[]): void {
    let bitIndex = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      // Column 6 is the vertical timing pattern; the pairing shifts past it.
      if (right === 6) right = 5
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vertical : vertical
          if (!this.reserved[y][x] && bitIndex < codewords.length * 8) {
            this.modules[y][x] = bitAt(codewords[bitIndex >>> 3], 7 - (bitIndex & 7))
            bitIndex++
          }
          // Remaining modules stay light: the format's remainder bits are
          // defined as zero, not as leftover data.
        }
      }
    }
  }

  /**
   * Try all eight masks, keep the one with the lowest penalty.
   *
   * Masking is not cosmetic — it is what stops a payload from producing large
   * blank runs or finder-lookalikes that a scanner would misread. The penalty
   * rules are the format's, so "best" here means "most scannable", not
   * "prettiest".
   */
  applyBestMask(): void {
    let bestMask = 0
    let bestPenalty = Number.POSITIVE_INFINITY
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask)
      this.drawFormatBits(mask)
      const penalty = this.penalty()
      if (penalty < bestPenalty) {
        bestPenalty = penalty
        bestMask = mask
      }
      this.applyMask(mask) // XOR is its own inverse; undo before the next trial.
    }
    this.applyMask(bestMask)
    this.drawFormatBits(bestMask)
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.reserved[y][x] && maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  /** The format's four penalty rules, summed. Lower is more scannable. */
  private penalty(): number {
    let score = 0

    // Rule 1: runs of five or more same-coloured modules in a line.
    for (let i = 0; i < this.size; i++) {
      score += runPenalty(this.modules[i])
      score += runPenalty(this.modules.map((row) => row[i]))
    }

    // Rule 2: 2×2 blocks of one colour.
    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const value = this.modules[y][x]
        if (
          value === this.modules[y][x + 1] &&
          value === this.modules[y + 1][x] &&
          value === this.modules[y + 1][x + 1]
        ) {
          score += 3
        }
      }
    }

    // Rule 3: finder-lookalike patterns, which a scanner may lock onto.
    for (let i = 0; i < this.size; i++) {
      score += finderLikePenalty(this.modules[i])
      score += finderLikePenalty(this.modules.map((row) => row[i]))
    }

    // Rule 4: deviation from an even dark/light split, per 5% step.
    let dark = 0
    for (const row of this.modules) for (const module of row) if (module) dark++
    const total = this.size * this.size
    const deviationSteps = Math.floor((Math.abs(dark * 20 - total * 10) * 10) / total)
    score += deviationSteps * 10

    return score
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark
    this.reserved[y][x] = true
  }
}

/** Alignment-pattern centres for a version, derived from the format's spacing rule. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  // Version 32 is the format's one exception to the even-spacing rule.
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const positions = [6]
  for (let pos = version * 4 + 10; positions.length < count; pos -= step) positions.splice(1, 0, pos)
  return positions
}

export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

function runPenalty(line: readonly boolean[]): number {
  let score = 0
  let runLength = 1
  for (let i = 1; i < line.length; i++) {
    if (line[i] === line[i - 1]) {
      runLength++
      if (runLength === 5) score += 3
      else if (runLength > 5) score += 1
    } else {
      runLength = 1
    }
  }
  return score
}

/** The 1:1:3:1:1 finder ratio with four light modules on either side. */
function finderLikePenalty(line: readonly boolean[]): number {
  const pattern = [true, false, true, true, true, false, true]
  const quiet = [false, false, false, false]
  let score = 0
  for (let i = 0; i + pattern.length <= line.length; i++) {
    if (!pattern.every((value, offset) => line[i + offset] === value)) continue
    const before = quiet.every((_, offset) => line[i - 1 - offset] === false)
    const after = quiet.every((_, offset) => line[i + pattern.length + offset] === false)
    if (before || after) score += 40
  }
  return score
}

function grid(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
}

function bitAt(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}
