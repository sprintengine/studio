import assert from 'node:assert/strict'
import type { Terminal } from '@xterm/xterm'
import { TERMINAL_RECENT_REPLAY_BYTES } from '../../../shared/terminal-history'
import { createXtermOutputQueue } from './xtermOutputQueue'

void main()

function main(): void {
  installAnimationFrame()
  assertRecentReplaySizedPayloadIsNotTrimmed()
  assertOversizedPayloadIsStillThrottled()
}

function assertRecentReplaySizedPayloadIsNotTrimmed(): void {
  const writes: string[] = []
  const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
  const payload = 'r'.repeat(TERMINAL_RECENT_REPLAY_BYTES)

  queue.enqueue(payload)

  assert.equal(writes.join(''), payload)
  queue.dispose()
}

function assertOversizedPayloadIsStillThrottled(): void {
  const writes: string[] = []
  const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
  const payload = 'x'.repeat(TERMINAL_RECENT_REPLAY_BYTES + 1024)
  const output = '\r\n[Multicode: renderer terminal output throttled to keep the UI responsive]\r\n'

  queue.enqueue(payload)

  const written = writes.join('')
  assert.equal(written.startsWith(output), true)
  assert.equal(written.length, TERMINAL_RECENT_REPLAY_BYTES)
  assert.equal(written.endsWith('x'.repeat(1024)), true)
  queue.dispose()
}

function createTerminal(writes: string[]): Terminal {
  return {
    write: (data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    },
  } as unknown as Terminal
}

function installAnimationFrame(): void {
  globalThis.window = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    },
  } as Window & typeof globalThis
}
