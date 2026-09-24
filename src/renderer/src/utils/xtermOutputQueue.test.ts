import assert from 'node:assert/strict'
import type { Terminal } from '@xterm/xterm'
import { TERMINAL_RECENT_REPLAY_BYTES } from '../../../shared/terminal-history'
import {
  acquireTerminalRepaintPause,
  resetTerminalRepaintPauseForTests,
  setTerminalRepaintPauseReporter,
  terminalRepaintPauseDebugState,
} from './terminalRepaintPause'
import {
  createXtermOutputQueue,
  createXtermReplayGate,
  splitReplayIntoChunks,
  type XtermReplayProfile,
  type XtermReplayState,
} from './xtermOutputQueue'
import { composeResumeSwap, type ResumeHoldRelease, type ResumeHoldTimers } from './terminalResumeHold'
import { test } from 'vitest'

test('xtermOutputQueue', async () => {
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
    assertRevisibleReplayResetsBeforeReplayingButInitialDoesNot()
    assertResumeHoldSwapsTheFrozenViewInOneWrite()
    assertResumeHoldReleasesOnExitWithoutSwapping()
    assertResumeHoldAppendsForAFreshRelaunch()
    assertResumeRevealDefersWhileReplayDraining()
    assertModalPauseWithholdsEveryChunkAndFlushesInOrder()
    assertModalPauseKeepsTheNewestWindowWhenTheCapIsHit()
    assertModalPauseStopsAfterTheInFlightWrite()
    assertNestedModalsResumeOnlyWhenTheLastOneCloses()
    assertQueueBuiltDuringAPauseStartsPaused()
    assertDisposeWhilePausedDropsBufferAndSubscription()
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
    // The shipped banner, verbatim. It was shortened in `5912ed928` (2026-07-29)
    // and this expectation was left on the old wording, so the suite has been red
    // since — the notice is user-visible copy, and the test is what pins it.
    const output = '\r\n[Terminal output throttled to keep the UI responsive]\r\n'

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

  // A hidden terminal that becomes visible again gets a fresh retained-window
  // replay from main. The gate must reset the stale screen before replaying it
  // (so pre-hide content is not duplicated) — but ONLY on this resync, never on
  // the initial attach which writes onto an empty xterm.
  function assertRevisibleReplayResetsBeforeReplayingButInitialDoesNot(): void {
    const writes: string[] = []
    const term = createTerminal(writes)
    const queue = createXtermOutputQueue(term, { recordWrite: () => {} })
    const gate = createXtermReplayGate(term, queue, {})

    // Initial attach: awaiting → replay onto an empty terminal, no reset.
    gate.beginReplayWait()
    gate.handleReplay('first-window\n')
    assert.ok(!writes.includes('[reset]'), 'initial attach must not reset the terminal')
    assert.ok(writes.includes('first-window\n'))

    // Revisible resync: a replay arrives with no preceding beginReplayWait, on a
    // terminal that has already revealed content. It must reset first, then write
    // the new window exactly once.
    const resetAt = writes.length
    gate.handleReplay('second-window\n')
    const afterResync = writes.slice(resetAt)
    assert.ok(afterResync.includes('[reset]'), 'revisible resync must reset before replaying')
    assert.equal(afterResync.indexOf('[reset]') < afterResync.indexOf('second-window\n'), true)
    // The pre-hide window is not re-written after the reset.
    assert.ok(!afterResync.includes('first-window\n'))
    gate.dispose()
    queue.dispose()
  }

  // A clock driven by hand for the resume hold, so a release happens when the
  // test says so.
  function createHoldClock(): { timers: ResumeHoldTimers; fireAll: () => void } {
    const pending = new Map<number, () => void>()
    let nextId = 1
    return {
      timers: {
        set: (callback) => {
          const id = nextId++
          pending.set(id, callback)
          return id
        },
        clear: (handle) => {
          pending.delete(handle as number)
        },
      },
      fireAll: () => {
        while (pending.size > 0) {
          const [id, callback] = [...pending.entries()][0]!
          pending.delete(id)
          callback()
        }
      },
    }
  }

  // Resume: the relaunched CLI's output is held while the frozen view stays up,
  // then goes to the screen as ONE write that clears the frozen view and paints
  // the CLI's first frame inside a synchronized update. Nothing is written
  // before that, nothing is written twice, and live output flows after it.
  function assertResumeHoldSwapsTheFrozenViewInOneWrite(): void {
    const writes: string[] = []
    const clock = createHoldClock()
    const releases: ResumeHoldRelease[] = []
    const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
    const gate = createXtermReplayGate(createTerminal(writes), queue, {
      resumeHoldTimers: clock.timers,
      onResumeRelease: (release) => releases.push(release),
    })
    const content = (): string[] => writes.filter((value) => value !== '[scroll-bottom]')

    gate.armResumeHold({ replaceFrozenView: true })
    const chunks = ['\x1b[?2004h\x1b[c', 'banner\r\r\nhistory\r\r\n', '\u276f \r\r\n']
    for (const chunk of chunks) gate.handleLiveData(chunk)
    assert.deepEqual(content(), [], 'held while the frozen view stays up')

    clock.fireAll()
    assert.deepEqual(content(), [composeResumeSwap(chunks.join(''))], 'one write: clear and frame together')
    assert.equal(releases.length, 1)
    assert.equal(releases[0]!.replaceFrozenView, true)

    gate.handleLiveData('post-resume')
    assert.equal(content().at(-1), 'post-resume')
    assert.equal(content().length, 2)
    gate.dispose()
    queue.dispose()
  }

  // A relaunch that dies during start-up leaves its error UNDER the frozen
  // view: the exit lets go of the hold without clearing anything.
  function assertResumeHoldReleasesOnExitWithoutSwapping(): void {
    const writes: string[] = []
    const clock = createHoldClock()
    const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
    const gate = createXtermReplayGate(createTerminal(writes), queue, { resumeHoldTimers: clock.timers })

    gate.armResumeHold({ replaceFrozenView: true })
    gate.handleLiveData('boot error: command not found\n')
    assert.deepEqual(writes, [], 'output is withheld while holding')

    gate.releaseResumeHoldForExit()
    assert.deepEqual(writes, ['boot error: command not found\n'])
    gate.releaseResumeHoldForExit()
    clock.fireAll()
    assert.deepEqual(writes, ['boot error: command not found\n'], 'released once')
    gate.dispose()
    queue.dispose()
  }

  // A relaunch that starts fresh (the CLI cannot resume a conversation) has no
  // copy of the history to replace the frozen one, so its output is written
  // after the frozen view, unchanged.
  function assertResumeHoldAppendsForAFreshRelaunch(): void {
    const writes: string[] = []
    const clock = createHoldClock()
    const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
    const gate = createXtermReplayGate(createTerminal(writes), queue, { resumeHoldTimers: clock.timers })

    gate.armResumeHold({ replaceFrozenView: false })
    gate.handleLiveData('fresh prompt $ ')
    clock.fireAll()
    assert.deepEqual(writes, ['fresh prompt $ '])
    gate.dispose()
    queue.dispose()
  }

  // If the hold lets go while a snapshot replay is still draining (resume
  // clicked over a frozen view mid-paint), the swap must NOT interleave with the
  // remaining replay chunks — its clear would land before the snapshot's tail.
  // It is routed through liveBuffer and flushed in order only after the replay
  // fully settles. Uses a manual terminal so the drain stays in flight.
  function assertResumeRevealDefersWhileReplayDraining(): void {
    const writes: string[] = []
    const clock = createHoldClock()
    const manual = createManualTerminal(writes)
    const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
    const gate = createXtermReplayGate(manual.term, queue, { resumeHoldTimers: clock.timers })

    gate.beginReplayWait()
    const replay = `${'a'.repeat(REPLAY_CHUNK_CHARS - 1)}\n${'b'.repeat(REPLAY_CHUNK_CHARS - 1)}\n`
    gate.handleReplay(replay)
    assert.equal(writes.length, 1, 'replay is mid-drain (first chunk only)')

    gate.armResumeHold({ replaceFrozenView: true })
    gate.handleLiveData('banner\r\nrepaint')
    clock.fireAll()
    assert.equal(writes.length, 1, 'the swap is deferred while the replay drains')

    manual.flushAll()
    const content = writes.filter((value) => value !== '[scroll-bottom]')
    assert.equal(content.length, 3, 'two replay chunks then the swap')
    assert.equal(content.slice(0, 2).join(''), replay)
    assert.equal(content.at(-1), composeResumeSwap('banner\r\nrepaint'))
    gate.dispose()
    queue.dispose()
  }

  // ---------------------------------------------------------------------------
  // Modal repaint pause. A covering dialog takes a hold on `terminalRepaintPause`;
  // the output queue watches it and stops draining, so the region under the
  // dialog is not invalidated and the compositor has nothing to redo.
  // ---------------------------------------------------------------------------

  // Nothing reaches the terminal while a dialog is up, and everything produced in
  // that window lands on close, in arrival order and with no duplication. This is
  // also where the win is MEASURED rather than asserted: `writesAvoided` in the
  // reported pause window is the count of PTY chunks that produced no `term.write`
  // and therefore no painted frame behind the dialog.
  function assertModalPauseWithholdsEveryChunkAndFlushesInOrder(): void {
    resetTerminalRepaintPauseForTests()
    const events: Array<{ event: string; payload: Record<string, unknown> }> = []
    setTerminalRepaintPauseReporter((_scope, event, payload) => events.push({ event, payload }))

    const writes: string[] = []
    const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })

    queue.enqueue('before-modal\n')
    assert.equal(writes.join(''), 'before-modal\n', 'output flows normally with no dialog open')

    const release = acquireTerminalRepaintPause({ label: 'test-modal' })
    const during = ['one\n', 'two\n', 'three\n', '\x1b[32mfour\x1b[0m\n']
    for (const chunk of during) queue.enqueue(chunk)
    assert.equal(writes.length, 1, 'no write — and therefore no repaint — while the dialog is open')

    release()
    assert.equal(writes.join(''), `before-modal\n${during.join('')}`, 'every withheld chunk lands on close, in order')

    const withheld = events.find((entry) => entry.event === 'output-withheld')
    assert.ok(withheld, 'the pause window is reported, not assumed')
    assert.equal(withheld?.payload.writesAvoided, during.length)
    assert.equal(withheld?.payload.droppedChars, 0)
    console.log(
      `ok - modal pause avoided ${String(withheld?.payload.writesAvoided)} terminal writes ` +
        `(${String(withheld?.payload.heldChars)} chars withheld, ` +
        `${String(withheld?.payload.droppedChars)} dropped)`,
    )

    queue.dispose()
    setTerminalRepaintPauseReporter(null)
    resetTerminalRepaintPauseForTests()
  }

  // Growth policy: a pane that streams megabytes behind an open dialog is capped
  // at the queue's existing retained window, discarding from the OLDEST end and
  // announcing the discard once. The newest state — the only part of a terminal
  // anyone reads after the fact — always survives.
  function assertModalPauseKeepsTheNewestWindowWhenTheCapIsHit(): void {
    resetTerminalRepaintPauseForTests()
    const writes: string[] = []
    const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
    const banner = '\r\n[Terminal output throttled to keep the UI responsive]\r\n'

    const release = acquireTerminalRepaintPause({ label: 'test-modal' })
    // Ten chunks well past the cap, so the buffer is trimmed repeatedly rather
    // than once — the growth bound has to hold across trims, not just at one.
    const chunkChars = Math.ceil(TERMINAL_RECENT_REPLAY_BYTES / 5)
    for (let index = 0; index < 10; index += 1) {
      queue.enqueue(String(index).repeat(chunkChars))
    }
    assert.equal(writes.length, 0, 'still nothing painted, however much arrives')

    release()
    const written = writes.join('')
    assert.equal(written.length, TERMINAL_RECENT_REPLAY_BYTES, 'buffer growth is bounded by the cap')
    assert.equal(written.startsWith(banner), true, 'the discard is announced, not silent')
    assert.equal(written.endsWith('9'.repeat(1024)), true, 'the newest output is what survives')
    assert.equal(written.includes('0'), false, 'the oldest output is what goes')

    queue.dispose()
    resetTerminalRepaintPauseForTests()
  }

  // A dialog that opens mid-drain lets the write already handed to xterm finish —
  // abandoning its callback would strand the queue's `writing` flag — and stops
  // there. At most one more frame paints after the dialog appears, and the drain
  // resumes at the exact chunk it stopped on.
  function assertModalPauseStopsAfterTheInFlightWrite(): void {
    resetTerminalRepaintPauseForTests()
    const writes: string[] = []
    const manual = createManualTerminal(writes)
    const queue = createXtermOutputQueue(manual.term, { recordWrite: () => {} })

    queue.enqueue('first\n')
    queue.enqueue('second\n')
    queue.enqueue('third\n')
    assert.deepEqual(writes, ['first\n'], 'the first write is in flight, the rest are queued')

    const release = acquireTerminalRepaintPause({ label: 'test-modal' })
    manual.flushAll()
    assert.deepEqual(writes, ['first\n'], 'the in-flight callback does not continue the drain')

    release()
    manual.flushAll()
    assert.deepEqual(writes, ['first\n', 'second\n', 'third\n'], 'resumes at the chunk it stopped on')

    queue.dispose()
    resetTerminalRepaintPauseForTests()
  }

  // Stacked dialogs (a confirm over a workbench) hold the pause independently.
  // Closing the inner one must not resume the panes under the outer one, and a
  // release called twice must not decrement the other dialog's hold.
  function assertNestedModalsResumeOnlyWhenTheLastOneCloses(): void {
    resetTerminalRepaintPauseForTests()
    const writes: string[] = []
    const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })

    const releaseOuter = acquireTerminalRepaintPause({ label: 'workbench' })
    const releaseInner = acquireTerminalRepaintPause({ label: 'confirm' })
    queue.enqueue('stacked\n')
    assert.equal(writes.length, 0)

    releaseInner()
    releaseInner()
    assert.equal(terminalRepaintPauseDebugState().holdCount, 1, 'a double release frees one hold')
    assert.equal(writes.length, 0, 'the outer dialog still holds the pause')

    releaseOuter()
    assert.equal(writes.join(''), 'stacked\n')
    assert.equal(terminalRepaintPauseDebugState().paused, false)

    queue.dispose()
    resetTerminalRepaintPauseForTests()
  }

  // A pane revealed while a dialog is already open (workspace switched behind it,
  // a panel mounted) must come up paused rather than streaming under the overlay.
  function assertQueueBuiltDuringAPauseStartsPaused(): void {
    resetTerminalRepaintPauseForTests()
    const release = acquireTerminalRepaintPause({ label: 'test-modal' })

    const writes: string[] = []
    const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
    queue.enqueue('late-pane\n')
    assert.equal(writes.length, 0, 'a queue built during a pause starts paused')

    release()
    assert.equal(writes.join(''), 'late-pane\n')

    queue.dispose()
    resetTerminalRepaintPauseForTests()
  }

  // A terminal torn down while the dialog is still open must leave nothing
  // behind: not the buffered output, and not the subscription that retains it.
  // Without the unsubscribe the store would hold a disposed queue's closure — and
  // its whole withheld buffer — for the life of the window.
  function assertDisposeWhilePausedDropsBufferAndSubscription(): void {
    resetTerminalRepaintPauseForTests()
    const writes: string[] = []
    const before = terminalRepaintPauseDebugState().listenerCount
    const queue = createXtermOutputQueue(createTerminal(writes), { recordWrite: () => {} })
    assert.equal(terminalRepaintPauseDebugState().listenerCount, before + 1)

    const release = acquireTerminalRepaintPause({ label: 'test-modal' })
    queue.enqueue('withheld\n')
    queue.dispose()
    assert.equal(terminalRepaintPauseDebugState().listenerCount, before, 'dispose unsubscribes from the pause signal')

    release()
    assert.equal(writes.length, 0, 'a disposed terminal writes nothing on resume')

    // Post-dispose enqueues stay inert whether or not a dialog is open.
    queue.enqueue('after-dispose\n')
    assert.equal(writes.length, 0)
    resetTerminalRepaintPauseForTests()
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
      reset: () => {
        writes.push('[reset]')
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
})
