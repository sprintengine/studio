import assert from 'node:assert/strict'
import type { Terminal } from '@xterm/xterm'
import { TERMINAL_RECENT_REPLAY_BYTES } from '../../../shared/terminal-history'
import {
  createXtermOutputQueue,
  createXtermReplayGate,
  splitReplayIntoChunks,
  type XtermReplayProfile,
  type XtermReplayState,
} from './xtermOutputQueue'

const REPLAY_CHUNK_CHARS = 32 * 1024

void main()

function main(): void {
  installAnimationFrame()
  assertRecentReplaySizedPayloadIsNotTrimmed()
  assertOversizedPayloadIsStillThrottled()
  assertSplitReplayIntoChunks()
  assertReplayChunksAreWrittenInOrderAndReveal()
  assertLiveOutputIsBufferedUntilMultiChunkReplaySettles()
  assertEmptyReplayReleaseFlushesLiveOutput()
  assertDisposeCancelsRemainingReplayChunks()
  console.log('xtermOutputQueue.test.ts: ok')
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

function assertSplitReplayIntoChunks(): void {
  assert.deepEqual(splitReplayIntoChunks('', 10), [])
  assert.deepEqual(splitReplayIntoChunks('short', 10), ['short'])

  // Prefers the last newline inside the budget so lines stay intact.
  const lined = 'aaaa\nbbbb\ncccc\n'
  const chunks = splitReplayIntoChunks(lined, 6)
  assert.deepEqual(chunks, ['aaaa\n', 'bbbb\n', 'cccc\n'])
  assert.equal(chunks.join(''), lined)

  // A single line longer than the budget falls back to a hard split.
  const longLine = 'x'.repeat(25)
  const hard = splitReplayIntoChunks(longLine, 10)
  assert.deepEqual(hard, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  assert.equal(hard.join(''), longLine)
}

function assertReplayChunksAreWrittenInOrderAndReveal(): void {
  const writes: string[] = []
  const states: XtermReplayState[] = []
  let profile: XtermReplayProfile | null = null
  const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
  const gate = createXtermReplayGate(createTerminal(writes), queue, {
    onReplayStateChange: (state) => states.push(state),
    onReplayProfile: (next) => {
      profile = next
    },
  })

  gate.beginReplayWait()
  assert.equal(states.at(-1)?.visible, false)
  assert.equal(states.at(-1)?.phase, 'awaiting')

  // Two chunks worth of replay, split on a newline boundary.
  const replay = `${'a'.repeat(REPLAY_CHUNK_CHARS - 1)}\n${'b'.repeat(16)}`
  gate.handleReplay(replay)

  // Joined terminal content equals the original payload, in order.
  const writtenContent = writes.filter((value) => value !== '[scroll-bottom]').join('')
  assert.equal(writtenContent, replay)

  // Revealed (visible) by the time replay settled, and scrolled to bottom at
  // least twice (first reveal + settle).
  assert.equal(states.at(-1)?.visible, true)
  assert.equal(states.at(-1)?.phase, 'ready')
  assert.ok(writes.filter((value) => value === '[scroll-bottom]').length >= 2)

  const settled = profile as XtermReplayProfile | null
  assert.ok(settled)
  assert.equal(settled?.endedVia, 'replay')
  assert.equal(settled?.payloadChars, replay.length)
  assert.equal(settled?.writeCount, 2)
  gate.dispose()
  queue.dispose()
}

function assertLiveOutputIsBufferedUntilMultiChunkReplaySettles(): void {
  const writes: string[] = []
  const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
  const gate = createXtermReplayGate(createTerminal(writes), queue, {})

  gate.beginReplayWait()
  gate.handleLiveData('live-before-replay')
  assert.deepEqual(writes, [])

  const replay = `${'a'.repeat(REPLAY_CHUNK_CHARS - 1)}\n${'b'.repeat(REPLAY_CHUNK_CHARS - 1)}\n${'c'.repeat(8)}`
  gate.handleReplay(replay)

  const content = writes.filter((value) => value !== '[scroll-bottom]')
  // Retained replay (three chunks) lands first, buffered live output last.
  assert.equal(content.length, 4)
  assert.equal(content.at(-1), 'live-before-replay')
  assert.equal(content.slice(0, 3).join(''), replay)
  gate.dispose()
  queue.dispose()
}

function assertEmptyReplayReleaseFlushesLiveOutput(): void {
  const writes: string[] = []
  const states: XtermReplayState[] = []
  let profile: XtermReplayProfile | null = null
  const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
  const gate = createXtermReplayGate(createTerminal(writes), queue, {
    onReplayStateChange: (state) => states.push(state),
    onReplayProfile: (next) => {
      profile = next
    },
  })

  gate.beginReplayWait()
  gate.handleLiveData('queued-live')
  assert.deepEqual(writes, [])

  gate.finishReplayWait()
  assert.equal(states.at(-1)?.visible, true)
  assert.deepEqual(writes, ['queued-live'])

  const released = profile as XtermReplayProfile | null
  assert.equal(released?.endedVia, 'finish-wait')
  assert.equal(released?.payloadChars, 0)

  // A late finishReplayWait after a real replay must not re-fire or re-flush.
  const before = writes.length
  gate.finishReplayWait()
  assert.equal(writes.length, before)
  gate.dispose()
  queue.dispose()
}

function assertDisposeCancelsRemainingReplayChunks(): void {
  const writes: string[] = []
  const manual = createManualTerminal(writes)
  const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
  const gate = createXtermReplayGate(manual.term, queue, {})

  gate.beginReplayWait()
  const replay = `${'a'.repeat(REPLAY_CHUNK_CHARS - 1)}\n${'b'.repeat(REPLAY_CHUNK_CHARS - 1)}\n${'c'.repeat(REPLAY_CHUNK_CHARS - 1)}\n`
  gate.handleReplay(replay)

  // Only the first chunk has been dispatched to the terminal so far.
  assert.equal(writes.length, 1)
  gate.dispose()

  // Flushing the in-flight write callback after dispose must not drain the
  // remaining chunks.
  manual.flushAll()
  assert.equal(writes.length, 1)
  gate.dispose()
  queue.dispose()
}

function createTerminal(writes: string[]): Terminal {
  return {
    write: (data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    },
    scrollToBottom: () => {
      writes.push('[scroll-bottom]')
    },
  } as unknown as Terminal
}

// A terminal whose write callbacks are deferred until manually flushed, so a
// test can interleave dispose() between replay chunks.
function createManualTerminal(writes: string[]): {
  term: Terminal
  flushAll: () => void
} {
  const pending: Array<() => void> = []
  const term = {
    write: (data: string, callback?: () => void) => {
      writes.push(data)
      if (callback) pending.push(callback)
    },
    scrollToBottom: () => {
      writes.push('[scroll-bottom]')
    },
  } as unknown as Terminal
  return {
    term,
    flushAll: () => {
      while (pending.length > 0) {
        const callback = pending.shift()
        callback?.()
      }
    },
  }
}

function installAnimationFrame(): void {
  globalThis.window = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    },
  } as Window & typeof globalThis
}
