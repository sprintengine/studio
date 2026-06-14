import assert from 'node:assert/strict'
import {
  computeScrollbackFootprint,
  ESTIMATED_BYTES_PER_CELL,
  type ScrollbackEntry,
} from './terminalInstanceRegistry'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

run('totals lines and estimates bytes, sorted by lines desc', () => {
  const entries: ScrollbackEntry[] = [
    { sessionId: 'small', lines: 100, cols: 80 },
    { sessionId: 'big', lines: 25_000, cols: 120 },
  ]
  const footprint = computeScrollbackFootprint(entries)
  assert.equal(footprint.instanceCount, 2)
  assert.equal(footprint.totalLines, 25_100)
  assert.equal(footprint.perSession[0].sessionId, 'big', 'largest scrollback first')
  const expected = 100 * 80 * ESTIMATED_BYTES_PER_CELL + 25_000 * 120 * ESTIMATED_BYTES_PER_CELL
  assert.equal(footprint.estimatedBytes, expected)
})

run('empty registry yields zeroes', () => {
  const footprint = computeScrollbackFootprint([])
  assert.equal(footprint.instanceCount, 0)
  assert.equal(footprint.totalLines, 0)
  assert.equal(footprint.estimatedBytes, 0)
})

console.log('terminal instance registry tests passed')
