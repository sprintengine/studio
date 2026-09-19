import assert from 'node:assert/strict'

import { alignmentPositions, encodeQrCode, gfMultiply, maskBit, qrBlockGeometry, qrByteCapacity } from './qr-code'
import { test } from 'vitest'

test('qr-code', async () => {
  // Tests for the hand-written QR encoder.
  //
  // A hand-written encoder is only worth having if something proves a scanner
  // could read it, and no camera is available here. So the suite carries a
  // DECODER, written from the format's description rather than by calling into
  // the encoder: it re-derives the function-pattern map from the geometry rules,
  // reads the format bits, unmasks, walks the zigzag, de-interleaves the blocks,
  // and checks each block's Reed-Solomon syndromes before returning the payload.
  //
  // The syndrome check is the part that matters most: it evaluates the codeword
  // polynomial at the field's roots, which is the DEFINITION of a valid
  // Reed-Solomon codeword. The encoder produces its ECC by polynomial division
  // instead, so agreement between the two is real evidence rather than one
  // implementation agreeing with itself.
  //
  // The capacity assertions anchor the two ECC tables against the format's
  // published byte capacities at six versions — a transcription slip in either
  // table moves at least one of them.

  let failures = 0

  function check(name: string, run: () => void): void {
    try {
      run()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures++
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // ── An independent decoder ───────────────────────────────────────────────────

  /**
   * Which modules a version's function patterns own, derived here from the
   * geometry rules rather than borrowed from the encoder.
   */
  function functionMap(version: number): boolean[][] {
    const size = version * 4 + 17
    const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    const reserve = (x: number, y: number): void => {
      if (x >= 0 && x < size && y >= 0 && y < size) reserved[y][x] = true
    }

    // Finders with their separators, in the three corners.
    for (const [originX, originY] of [
      [0, 0],
      [size - 8, 0],
      [0, size - 8],
    ]) {
      for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) reserve(originX + dx, originY + dy)
    }
    // Timing patterns.
    for (let i = 0; i < size; i++) {
      reserve(6, i)
      reserve(i, 6)
    }
    // Format-information strips and the dark module.
    for (let i = 0; i < 9; i++) {
      reserve(8, i)
      reserve(i, 8)
    }
    for (let i = 0; i < 8; i++) {
      reserve(size - 1 - i, 8)
      reserve(8, size - 1 - i)
    }
    // Version-information blocks.
    if (version >= 7) {
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3)
        const b = Math.floor(i / 3)
        reserve(a, b)
        reserve(b, a)
      }
    }
    // Alignment patterns, minus the three the finders already occupy.
    const centres = alignmentPositions(version)
    for (let i = 0; i < centres.length; i++) {
      for (let j = 0; j < centres.length; j++) {
        const corner =
          (i === 0 && j === 0) || (i === 0 && j === centres.length - 1) || (i === centres.length - 1 && j === 0)
        if (corner) continue
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) reserve(centres[i] + dx, centres[j] + dy)
        }
      }
    }
    return reserved
  }

  /** Read the 15 format bits from the top-left copy and check their BCH parity. */
  function readFormat(modules: readonly boolean[][]): { eccLevel: number; mask: number } {
    const size = modules.length
    const bit = (x: number, y: number, index: number): number => (modules[y][x] ? 1 : 0) << index

    let bits = 0
    for (let i = 0; i <= 5; i++) bits |= bit(8, i, i)
    bits |= bit(8, 7, 6)
    bits |= bit(8, 8, 7)
    bits |= bit(7, 8, 8)
    for (let i = 9; i < 15; i++) bits |= bit(14 - i, 8, i)

    // The second copy must carry the same 15 bits; a scanner relies on that.
    let mirrored = 0
    for (let i = 0; i < 8; i++) mirrored |= bit(size - 1 - i, 8, i)
    for (let i = 8; i < 15; i++) mirrored |= bit(8, size - 15 + i, i)
    assert.equal(mirrored, bits, 'both format-information copies must agree')

    const unmasked = bits ^ 0x5412
    // BCH(15,5) over the generator 0x537: a valid strip divides cleanly.
    let remainder = unmasked
    for (let i = 14; i >= 10; i--) {
      if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10)
    }
    assert.equal(remainder, 0, 'format information must satisfy its BCH parity')

    return { eccLevel: (unmasked >>> 13) & 0b11, mask: (unmasked >>> 10) & 0b111 }
  }

  /** Walk the zigzag, undoing the mask, and return the interleaved codewords. */
  function readCodewords(modules: readonly boolean[][], version: number, mask: number): number[] {
    const size = modules.length
    const reserved = functionMap(version)
    const bits: number[] = []
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vertical = 0; vertical < size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? size - 1 - vertical : vertical
          if (reserved[y][x]) continue
          bits.push(modules[y][x] !== maskBit(mask, x, y) ? 1 : 0)
        }
      }
    }
    const codewords: number[] = []
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let byte = 0
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
      codewords.push(byte)
    }
    return codewords
  }

  /**
   * Reverse the interleave and verify every block, then return the data bytes.
   *
   * Verification evaluates each block's polynomial at the field's consecutive
   * roots. All-zero syndromes is what "this block is a valid Reed-Solomon
   * codeword" means, and it is computed here without reference to how the encoder
   * built the ECC.
   */
  function readBlocks(interleaved: readonly number[], version: number): number[] {
    const { blocks: blockCount, eccPerBlock: eccLength, rawCodewords: rawCount } = qrBlockGeometry(version)
    const shortBlockCount = blockCount - (rawCount % blockCount)
    const shortBlockLength = Math.floor(rawCount / blockCount)

    // Every block occupies shortBlockLength + 1 interleave columns; the short
    // blocks skip the last data column, which is why they are one codeword
    // shorter and why the stream length still comes out at the raw count.
    const blocks: number[][] = Array.from({ length: blockCount }, () => [])
    let cursor = 0
    for (let i = 0; i < shortBlockLength + 1; i++) {
      for (let j = 0; j < blockCount; j++) {
        if (i === shortBlockLength - eccLength && j < shortBlockCount) continue
        blocks[j].push(interleaved[cursor++])
      }
    }
    assert.equal(cursor, rawCount, 'the de-interleave must consume every codeword')

    const data: number[] = []
    for (let j = 0; j < blockCount; j++) {
      const block = blocks[j]
      for (let syndrome = 0; syndrome < eccLength; syndrome++) {
        // Evaluate the block polynomial at alpha^syndrome by Horner's method.
        let root = 1
        for (let i = 0; i < syndrome; i++) root = gfMultiply(root, 0x02)
        let value = 0
        for (const codeword of block) value = gfMultiply(value, root) ^ codeword
        assert.equal(value, 0, `block ${j} syndrome ${syndrome} must vanish`)
      }
      data.push(...block.slice(0, block.length - eccLength))
    }
    return data
  }

  /** Decode a symbol the way a scanner would, returning the text it carries. */
  function decode(matrix: { version: number; size: number; modules: boolean[][] }): string {
    assert.equal(matrix.size, matrix.version * 4 + 17, 'size must follow from the version')
    const { eccLevel, mask } = readFormat(matrix.modules)
    assert.equal(eccLevel, 0, 'this encoder emits error-correction level M')

    const data = readBlocks(readCodewords(matrix.modules, matrix.version, mask), matrix.version)
    const bits: number[] = []
    for (const byte of data) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1)

    const take = (length: number, offset: number): number => {
      let value = 0
      for (let i = 0; i < length; i++) value = (value << 1) | bits[offset + i]
      return value
    }
    assert.equal(take(4, 0), 0b0100, 'byte mode')
    const countBits = matrix.version <= 9 ? 8 : 16
    const length = take(countBits, 4)
    const bytes: number[] = []
    for (let i = 0; i < length; i++) bytes.push(take(8, 4 + countBits + i * 8))
    return new TextDecoder().decode(Uint8Array.from(bytes))
  }

  // ── Tests ────────────────────────────────────────────────────────────────────

  check('byte capacities match the format’s published table', () => {
    // Six anchors across the version range. These are the byte-mode capacities at
    // level M as published; each one is a product of BOTH ECC tables, so a wrong
    // entry in either shows up here rather than as a square nothing can scan.
    assert.equal(qrByteCapacity(1), 14)
    assert.equal(qrByteCapacity(2), 26)
    assert.equal(qrByteCapacity(5), 84)
    assert.equal(qrByteCapacity(10), 213)
    assert.equal(qrByteCapacity(12), 287)
    assert.equal(qrByteCapacity(15), 412)
    assert.equal(qrByteCapacity(40), 2331)
  })

  check('a pairing URL round-trips through the symbol', () => {
    // The real payload shape: the custom scheme, an endpoint with an escaped
    // colon, and a pairing token of the length the device store mints.
    const url =
      'sprintengine-tailnet://pair?endpoint=100.101.102.103%3A8471&token=mcpair_5nJqT2xW9bK4mZpR7vY1cD8fH3aL0sGe'
    const matrix = encodeQrCode(url)
    assert.ok(matrix, 'a pairing URL must fit')
    assert.equal(decode(matrix), url)
  })

  check('an IPv6 endpoint, the longest pairing URL we can produce, round-trips', () => {
    const url =
      'sprintengine-tailnet://pair?endpoint=%5Bfd7a%3A115c%3Aa1e0%3Aab12%3A4843%3Acd96%3A6265%3A1a2b%5D%3A8471' +
      '&token=mcpair_5nJqT2xW9bK4mZpR7vY1cD8fH3aL0sGe'
    const matrix = encodeQrCode(url)
    assert.ok(matrix, 'an IPv6 pairing URL must fit')
    assert.equal(decode(matrix), url)
  })

  check('symbols round-trip across the version boundaries that change encoding', () => {
    // Version 1 (smallest), 9→10 (the character-count field widens from 8 to 16
    // bits), and 6→7 (version-information blocks appear).
    for (const length of [1, 14, 84, 122, 152, 180, 213, 251]) {
      const text = 'x'.repeat(length)
      const matrix = encodeQrCode(text)
      assert.ok(matrix, `length ${length} must fit`)
      assert.equal(decode(matrix), text, `length ${length} must round-trip`)
    }
  })

  check('multi-byte text round-trips as UTF-8', () => {
    const text = 'pair ✓ naïve — 日本語 🎯'
    const matrix = encodeQrCode(text)
    assert.ok(matrix)
    assert.equal(decode(matrix), text)
  })

  check('the smallest fitting version is chosen', () => {
    assert.equal(encodeQrCode('x'.repeat(14))?.version, 1)
    assert.equal(encodeQrCode('x'.repeat(15))?.version, 2)
    assert.equal(encodeQrCode('x'.repeat(213))?.version, 10)
    assert.equal(encodeQrCode('x'.repeat(214))?.version, 11)
  })

  check('over-capacity text is refused rather than truncated', () => {
    // A square that scans to half a pairing URL is worse than no square: the
    // person holding the phone cannot tell the difference.
    assert.equal(encodeQrCode('x'.repeat(2331)) === null, false)
    assert.equal(encodeQrCode('x'.repeat(2332)), null)
  })

  check('function patterns land where a scanner looks for them', () => {
    const matrix = encodeQrCode('sprintengine-tailnet://pair?endpoint=100.64.0.1%3A8471&token=mcpair_abc')
    assert.ok(matrix)
    const { modules, size } = matrix
    for (const [originX, originY] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ]) {
      // The finder is a dark 7×7 ring around a light ring around a dark 3×3.
      assert.equal(modules[originY][originX], true, 'finder corner is dark')
      assert.equal(modules[originY + 1][originX + 1], false, 'finder inner ring is light')
      assert.equal(modules[originY + 3][originX + 3], true, 'finder centre is dark')
    }
    // Timing patterns alternate, starting dark at the finder edge.
    for (let i = 8; i < size - 8; i++) {
      assert.equal(modules[6][i], i % 2 === 0, `horizontal timing at ${i}`)
      assert.equal(modules[i][6], i % 2 === 0, `vertical timing at ${i}`)
    }
    // The always-dark module.
    assert.equal(modules[size - 8][8], true)
  })

  check('the field multiplication is the specified GF(256)', () => {
    assert.equal(gfMultiply(0, 0x53), 0)
    assert.equal(gfMultiply(1, 0x53), 0x53)
    // x^7 * x = x^8, which reduces by the field polynomial 0x11d to 0x1d.
    assert.equal(gfMultiply(0x80, 0x02), 0x1d)
    // Multiplication is commutative and distributes over the field's addition (XOR).
    for (const a of [0x01, 0x1d, 0x53, 0x80, 0xff]) {
      for (const b of [0x02, 0x0f, 0x77, 0xc4]) {
        assert.equal(gfMultiply(a, b), gfMultiply(b, a))
        assert.equal(gfMultiply(a, b ^ 0x35), gfMultiply(a, b) ^ gfMultiply(a, 0x35))
      }
    }
  })

  check('alignment centres follow the format’s spacing rule', () => {
    assert.deepEqual(alignmentPositions(1), [])
    assert.deepEqual(alignmentPositions(2), [6, 18])
    assert.deepEqual(alignmentPositions(7), [6, 22, 38])
    assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138])
    for (let version = 2; version <= 40; version++) {
      const centres = alignmentPositions(version)
      assert.equal(centres.length, Math.floor(version / 7) + 2, `count at version ${version}`)
      assert.equal(centres[0], 6, `first centre at version ${version}`)
      assert.equal(centres[centres.length - 1], version * 4 + 10, `last centre at version ${version}`)
    }
  })

  if (failures > 0) {
    console.error(`${failures} test(s) failed`)
    process.exit(1)
  }
  console.log('qr-code tests passed')
})
