import assert from 'node:assert/strict'
import type { Terminal } from '@xterm/xterm'
import { beforeEach, test } from 'vitest'
import { acquireTerminalRepaintPause, resetTerminalRepaintPauseForTests } from './terminalRepaintPause'
import { ACK_BATCH_UNITS, ACK_FLUSH_DELAY_MS, createTerminalAckReporter } from './terminalOutputAck'
import { createXtermOutputQueue } from './xtermOutputQueue'

beforeEach(() => {
  resetTerminalRepaintPauseForTests()
  globalThis.window = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    },
  } as Window & typeof globalThis
})

// A terminal whose write callbacks run only when the test says xterm has parsed.
function manualTerminal() {
  const pending: Array<() => void> = []
  const term = {
    write: (_data: string, callback?: () => void) => {
      if (callback) pending.push(callback)
    },
  } as unknown as Terminal
  return {
    term,
    parseOne: () => pending.shift()?.(),
    parseAll: () => {
      while (pending.length > 0) pending.shift()?.()
    },
  }
}

test('live output is acknowledged when xterm has parsed it, not when it arrives', () => {
  const manual = manualTerminal()
  const consumed: number[] = []
  const queue = createXtermOutputQueue(manual.term, {
    recordWrite: () => {},
    onConsumed: (units) => consumed.push(units),
  })
  queue.enqueue('a'.repeat(100))
  assert.deepEqual(consumed, [], 'written to xterm, not yet parsed')
  manual.parseOne()
  queue.enqueue('b'.repeat(50))
  manual.parseAll()
  assert.equal(
    consumed.reduce((total, units) => total + units, 0),
    150,
    'every unit enqueued is acknowledged exactly once',
  )
  queue.dispose()
})

test('output the pane throws away is acknowledged too, so the pty is never left waiting', () => {
  const manual = manualTerminal()
  const consumed: number[] = []
  const queue = createXtermOutputQueue(manual.term, {
    recordWrite: () => {},
    onConsumed: (units) => consumed.push(units),
  })
  queue.enqueue('a'.repeat(10))
  queue.enqueue('b'.repeat(20))
  // A replay resync clears what is queued; dispose drops the rest.
  queue.clear()
  queue.enqueue('c'.repeat(5))
  queue.dispose()
  manual.parseAll()
  assert.equal(
    consumed.reduce((total, units) => total + units, 0),
    35,
  )
})

test('a covering dialog does not stall the agent behind it', () => {
  const manual = manualTerminal()
  const consumed: number[] = []
  const queue = createXtermOutputQueue(manual.term, {
    recordWrite: () => {},
    onConsumed: (units) => consumed.push(units),
  })
  queue.enqueue('a'.repeat(30))
  const release = acquireTerminalRepaintPause()
  assert.equal(
    consumed.reduce((total, units) => total + units, 0),
    30,
    'what was queued counts as taken the moment the pane stops parsing',
  )
  queue.enqueue('b'.repeat(40))
  assert.equal(
    consumed.reduce((total, units) => total + units, 0),
    70,
    'and so does what arrives while the dialog is up',
  )
  release()
  manual.parseAll()
  assert.equal(
    consumed.reduce((total, units) => total + units, 0),
    70,
    'nothing is acknowledged twice',
  )
  queue.dispose()
})

test('acks are batched: one message per few thousand units, or one frame after the first', async () => {
  const sent: number[] = []
  const reporter = createTerminalAckReporter((units) => sent.push(units))
  reporter.ack(1_000)
  reporter.ack(1_000)
  assert.deepEqual(sent, [])
  reporter.ack(ACK_BATCH_UNITS)
  assert.deepEqual(sent, [2_000 + ACK_BATCH_UNITS], 'a full batch goes at once')
  reporter.ack(10)
  await new Promise((resolve) => setTimeout(resolve, ACK_FLUSH_DELAY_MS * 3))
  assert.deepEqual(sent, [2_000 + ACK_BATCH_UNITS, 10], 'a partial batch goes on the timer')
  reporter.ack(7)
  reporter.dispose()
  assert.deepEqual(sent, [2_000 + ACK_BATCH_UNITS, 10, 7], 'dispose sends what is pending')
  reporter.ack(5)
  assert.equal(sent.length, 3, 'and nothing after')
})
