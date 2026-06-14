import assert from 'node:assert/strict'
import { summarizeTerminalThroughput, type TerminalWriteSample } from './terminalThroughputStore'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOW = 1_700_000_000_000

function write(sessionId: string, bytes: number, recordedAt: number): TerminalWriteSample {
  return { sessionId, bytes, recordedAt }
}

run('splits recent bytes into hidden vs visible per-second', () => {
  const samples = [
    write('hidden-1', 5_000, NOW - 1_000),
    write('hidden-1', 5_000, NOW - 500),
    write('visible-1', 2_000, NOW - 500),
  ]
  const summary = summarizeTerminalThroughput(samples, {
    hiddenSessionIds: new Set(['hidden-1']),
    windowMs: 5_000,
    now: NOW,
  })
  // 10,000 hidden + 2,000 visible over a 5s window → /5 per second.
  assert.equal(summary.hiddenBytesPerSec, 2_000)
  assert.equal(summary.visibleBytesPerSec, 400)
  assert.equal(summary.totalBytesPerSec, 2_400)
})

run('drops samples outside the window', () => {
  const samples = [write('a', 50_000, NOW - 60_000), write('a', 5_000, NOW - 100)]
  const summary = summarizeTerminalThroughput(samples, {
    hiddenSessionIds: new Set<string>(),
    windowMs: 5_000,
    now: NOW,
  })
  assert.equal(summary.totalBytesPerSec, 1_000, 'only the in-window 5000 bytes count')
})

console.log('terminal throughput store tests passed')
