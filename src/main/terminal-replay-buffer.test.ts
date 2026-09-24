import assert from 'node:assert/strict'
import { test } from 'vitest'
import { REPLAY_BLOCK_BYTES, TerminalReplayBuffer } from './terminal-replay-buffer'

test('small writes share blocks and report their UTF-8 length', () => {
  const buffer = new TerminalReplayBuffer()
  assert.equal(buffer.append('abc', 1024 * 1024), 3)
  // Box drawing and a braille spinner: three bytes each, one UTF-16 unit each.
  assert.equal(buffer.append('╭─⠋', 1024 * 1024), 9)
  // Outside the BMP: four bytes, two UTF-16 units.
  assert.equal(buffer.append('🙂', 1024 * 1024), 4)
  assert.equal(buffer.retainedBytes, 16)
  assert.equal(buffer.retainedUnits, 'abc╭─⠋🙂'.length)
  assert.equal(buffer.materialize(), 'abc╭─⠋🙂')
  assert.equal(buffer.endOffset, 16)
  assert.equal(buffer.startOffset, 0)
  assert.equal(buffer.truncated, false)
})

test('evicts whole blocks from the head and says it was cut', () => {
  const buffer = new TerminalReplayBuffer()
  const limit = REPLAY_BLOCK_BYTES * 2
  const chunk = 'x'.repeat(1_000)
  for (let index = 0; index < 400; index += 1) buffer.append(chunk, limit)
  assert.ok(buffer.retainedBytes <= limit, 'never above the budget')
  assert.ok(buffer.retainedBytes > limit - REPLAY_BLOCK_BYTES, 'and at most one block under it')
  assert.equal(buffer.endOffset, 400_000, 'the stream offset counts every byte ever appended')
  assert.equal(buffer.truncated, true)
  assert.equal(buffer.materialize().length, buffer.retainedUnits)
})

test('a lone block over the budget is cut on a code point boundary', () => {
  const buffer = new TerminalReplayBuffer()
  // One block: 'é' is two bytes, so a byte budget of 5 lands mid code point.
  buffer.append('éééééé', 1024)
  buffer.evict(5)
  assert.equal(buffer.materialize(), 'éé', 'no U+FFFD at the head')
  assert.equal(buffer.retainedBytes, 4)
  assert.equal(buffer.retainedUnits, 2)
  assert.equal(buffer.truncated, true)
})

test('a single write larger than the budget keeps its newest bytes', () => {
  const buffer = new TerminalReplayBuffer()
  buffer.append('head', 1024)
  const big = `${'a'.repeat(2_000)}TAIL`
  assert.equal(buffer.append(big, 1_000), big.length)
  assert.equal(buffer.retainedBytes, 1_000)
  assert.ok(buffer.materialize().endsWith('TAIL'))
  assert.equal(buffer.endOffset, 4 + big.length)
  assert.equal(buffer.truncated, true)
})

test('readFrom hands back exactly what arrived since an offset, or null once it is cut', () => {
  const buffer = new TerminalReplayBuffer()
  const limit = REPLAY_BLOCK_BYTES * 2
  buffer.append('seen by the pane\r\n', limit)
  const delivered = buffer.endOffset
  buffer.append('missed ─ one\r\n', limit)
  buffer.append('missed two\r\n', limit)
  assert.equal(buffer.readFrom(delivered), 'missed ─ one\r\nmissed two\r\n')
  assert.equal(buffer.readFrom(buffer.endOffset), '', 'caught up: nothing to send')

  for (let index = 0; index < 300; index += 1) buffer.append('y'.repeat(1_000), limit)
  assert.equal(buffer.readFrom(delivered), null, 'the missed bytes fell off the head')
})

test('tail returns the newest bytes on a code point boundary', () => {
  const buffer = new TerminalReplayBuffer()
  buffer.append('ab', 1024)
  buffer.append('ééé', 1024)
  const tail = buffer.tail(3)
  assert.equal(tail.cut, true)
  assert.equal(tail.text, 'é', 'starts after the continuation byte the cut landed on')
  assert.deepEqual(buffer.tail(1024), { text: 'abééé', cut: false })
})

test('clear drops every byte but keeps the stream offset, so a stale reader still misses', () => {
  const buffer = new TerminalReplayBuffer()
  buffer.append('painted', 1024)
  const delivered = buffer.endOffset
  buffer.append(' more', 1024)
  buffer.clear()
  assert.equal(buffer.retainedBytes, 0)
  assert.equal(buffer.retainedUnits, 0)
  assert.equal(buffer.materialize(), '')
  assert.equal(buffer.endOffset, 12)
  assert.equal(buffer.readFrom(delivered), null)
})

test('a block left behind by a large write gives back its unused capacity', () => {
  const buffer = new TerminalReplayBuffer()
  buffer.append('small', 10 * REPLAY_BLOCK_BYTES)
  // Larger than the open block's free space: a new block opens and the first
  // one is sealed, compacted to what it holds.
  buffer.append('z'.repeat(REPLAY_BLOCK_BYTES * 2), 10 * REPLAY_BLOCK_BYTES)
  buffer.append('!', 10 * REPLAY_BLOCK_BYTES)
  assert.equal(buffer.materialize(), `small${'z'.repeat(REPLAY_BLOCK_BYTES * 2)}!`)
})
