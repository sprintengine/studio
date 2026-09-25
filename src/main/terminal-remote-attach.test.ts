import assert from 'node:assert/strict'
import { test } from 'vitest'

import { splitTerminalAttachFrame, TERMINAL_REMOTE_FRAME_CHUNK_CHARS } from './terminal-remote-attach'

// Text two and a half chunks long that ends in multi-byte characters, so the
// positions are counted in bytes and not in characters.
const printed = 'x'.repeat(Math.floor(TERMINAL_REMOTE_FRAME_CHUNK_CHARS * 2.5)) + 'é😀'
const printedBytes = Buffer.byteLength(printed, 'utf8')

test('a frame under the chunk is sent as it is, position and all', () => {
  const frame = { type: 'output' as const, data: 'hello', position: 42 }
  assert.deepEqual(splitTerminalAttachFrame(frame), [frame])
})

test('sliced output carries, on every slice, the stream offset just past it', () => {
  const end = 10_000 + printedBytes
  const parts = splitTerminalAttachFrame({ type: 'output', data: printed, position: end })
  assert.ok(parts.length >= 3)
  let cursor = 10_000
  for (const part of parts) {
    assert.equal(part.type, 'output')
    if (part.type !== 'output') continue
    cursor += Buffer.byteLength(part.data, 'utf8')
    assert.equal(part.position, cursor)
  }
  assert.equal(cursor, end)
  assert.equal(parts.map((part) => (part.type === 'output' ? part.data : '')).join(''), printed)
})

test('a sliced replay names its stream first and its position only on the last slice', () => {
  const parts = splitTerminalAttachFrame({
    type: 'replay',
    data: printed,
    reason: 'resync',
    stream: 'stream-a',
    position: 5_000,
  })
  assert.ok(parts.length >= 3)
  assert.deepEqual(
    { ...parts[0], data: undefined },
    { type: 'replay', data: undefined, reason: 'resync', stream: 'stream-a' },
  )
  for (const part of parts.slice(1, -1)) assert.deepEqual(Object.keys(part).sort(), ['data', 'type'])
  const last = parts[parts.length - 1]
  assert.equal(last?.type, 'output')
  assert.equal(last?.type === 'output' ? last.position : null, 5_000)
})

test('frames from a host without positions are sliced without inventing any', () => {
  const parts = splitTerminalAttachFrame({ type: 'replay', data: printed, reason: 'attach' })
  for (const part of parts) {
    assert.equal('position' in part, false)
    assert.equal('stream' in part, false)
  }
})
