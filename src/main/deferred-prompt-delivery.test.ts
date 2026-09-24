import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  CLI_EXITED_SENTINEL,
  createDeferredPromptDelivery,
  DEFERRED_PROMPT_FALLBACK_MS,
  DEFERRED_PROMPT_QUIET_MS,
  deferredPromptSubmitDelayMs,
  sanitizeTypedPrompt,
  type DeferredPromptOutcome,
} from './deferred-prompt-delivery'

const PASTE_ON = '\x1b[?2004h'

/** A clock and timer queue the test advances by hand. */
function fakeTimers() {
  let now = 0
  let nextId = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    setTimeout(callback: () => void, ms: number): unknown {
      const id = nextId++
      pending.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout(handle: unknown): void {
      pending.delete(handle as number)
    },
    advance(ms: number): void {
      const until = now + ms
      for (;;) {
        let due: [number, { at: number; callback: () => void }] | undefined
        for (const entry of pending) if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) due = entry
        if (!due) break
        pending.delete(due[0])
        now = due[1].at
        due[1].callback()
      }
      now = until
    },
  }
}

function harness(text = 'fix the build') {
  const timers = fakeTimers()
  const writes: string[] = []
  const outcomes: DeferredPromptOutcome[] = []
  const delivery = createDeferredPromptDelivery({
    text,
    write: (data) => writes.push(data),
    onSettled: (outcome) => outcomes.push(outcome),
    timers,
  })
  return { timers, writes, outcomes, delivery, text }
}

const pasteOf = (text: string) => `\x1b[200~${text}\x1b[201~`

test('waits for the line editor and a quiet screen, then pastes once and presses Enter once', () => {
  const { timers, writes, outcomes, delivery, text } = harness()
  delivery.observeOutput('banner…')
  timers.advance(2_000)
  assert.deepEqual(writes, [], 'nothing before the CLI turns bracketed paste on')

  delivery.observeOutput(`${PASTE_ON}first frame`)
  timers.advance(DEFERRED_PROMPT_QUIET_MS - 100)
  delivery.observeOutput('still drawing')
  timers.advance(DEFERRED_PROMPT_QUIET_MS - 100)
  assert.deepEqual(writes, [], 'output inside the quiet window holds the paste back')

  timers.advance(200)
  assert.deepEqual(writes, [pasteOf(text)], 'the paste goes once the screen has been quiet')
  timers.advance(deferredPromptSubmitDelayMs(text))
  assert.deepEqual(writes, [pasteOf(text), '\r'], 'then one Enter, as its own write')
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0]?.kind, 'delivered')
  assert.equal(delivery.settled, true)

  // Nothing afterwards can send it again.
  delivery.observeOutput(PASTE_ON)
  delivery.observeHookFrame()
  timers.advance(DEFERRED_PROMPT_FALLBACK_MS * 2)
  assert.deepEqual(writes, [pasteOf(text), '\r'], 'exactly once')
  assert.equal(outcomes.length, 1)
})

test('sees the bracketed-paste sequence split across two chunks', () => {
  const { timers, writes, delivery, text } = harness()
  delivery.observeOutput('drawing\x1b[?20')
  delivery.observeOutput('04hready')
  timers.advance(DEFERRED_PROMPT_QUIET_MS)
  assert.deepEqual(writes, [pasteOf(text)])
})

test('a lifecycle hook frame counts as ready, still behind the quiet window', () => {
  const { timers, writes, delivery, text } = harness()
  delivery.observeOutput('a CLI that never turns the mode on')
  delivery.observeHookFrame()
  timers.advance(DEFERRED_PROMPT_QUIET_MS - 1)
  assert.deepEqual(writes, [])
  timers.advance(1)
  assert.deepEqual(writes, [pasteOf(text)])
})

test('a CLI that exits before it is ready is never written to', () => {
  const { timers, writes, outcomes, delivery } = harness()
  delivery.observeOutput('error: not logged in')
  delivery.observeExit()
  timers.advance(DEFERRED_PROMPT_FALLBACK_MS * 2)
  assert.deepEqual(writes, [])
  assert.deepEqual(outcomes, [{ kind: 'abandoned', reason: 'exited' }])
})

test('an exit between the paste and its Enter sends no Enter', () => {
  const { timers, writes, outcomes, delivery, text } = harness()
  delivery.observeOutput(PASTE_ON)
  timers.advance(DEFERRED_PROMPT_QUIET_MS)
  delivery.observeExit()
  timers.advance(5_000)
  assert.deepEqual(writes, [pasteOf(text)])
  assert.deepEqual(outcomes, [{ kind: 'abandoned', reason: 'exited' }])
})

test('the fallback delivers once to a CLI that never says it is reading', () => {
  const { timers, writes, outcomes, delivery, text } = harness()
  delivery.observeOutput('plain output, no line editor')
  timers.advance(DEFERRED_PROMPT_FALLBACK_MS - 1)
  assert.deepEqual(writes, [])
  timers.advance(1)
  assert.deepEqual(writes, [pasteOf(text)])
  timers.advance(deferredPromptSubmitDelayMs(text))
  assert.deepEqual(writes, [pasteOf(text), '\r'])
  assert.equal(outcomes[0]?.kind, 'delivered')
  assert.equal(outcomes[0]?.kind === 'delivered' && outcomes[0].via, 'fallback')
})

test('cancelling (the session is disposed) writes nothing', () => {
  const { timers, writes, outcomes, delivery } = harness()
  delivery.observeOutput(PASTE_ON)
  delivery.cancel()
  timers.advance(DEFERRED_PROMPT_FALLBACK_MS * 2)
  assert.deepEqual(writes, [])
  assert.deepEqual(outcomes, [{ kind: 'abandoned', reason: 'cancelled' }])
})

test('a write that throws (the pty is gone) settles without a second try', () => {
  const timers = fakeTimers()
  const outcomes: DeferredPromptOutcome[] = []
  let attempts = 0
  const delivery = createDeferredPromptDelivery({
    text: 'x',
    write: () => {
      attempts += 1
      throw new Error('EPIPE')
    },
    onSettled: (outcome) => outcomes.push(outcome),
    timers,
  })
  delivery.observeOutput(PASTE_ON)
  timers.advance(DEFERRED_PROMPT_FALLBACK_MS * 2)
  assert.equal(attempts, 1)
  assert.deepEqual(outcomes, [{ kind: 'abandoned', reason: 'write-failed' }])
})

test('a multi-line prompt is one paste with LF line ends, and the Enter waits longer for a large one', () => {
  const big = 'line\r\n'.repeat(50_000)
  const { timers, writes, delivery } = harness(big)
  delivery.observeOutput(PASTE_ON)
  timers.advance(DEFERRED_PROMPT_QUIET_MS)
  assert.equal(writes.length, 1)
  assert.ok(!writes[0]?.includes('\r'), 'a CR inside the paste would read as a submit')
  assert.ok(deferredPromptSubmitDelayMs(big) > deferredPromptSubmitDelayMs('short'))
  timers.advance(deferredPromptSubmitDelayMs(sanitizeTypedPrompt(big)) - 1)
  assert.equal(writes.length, 1)
  timers.advance(1)
  assert.deepEqual(writes.slice(1), ['\r'])
})

test('a CLI that dies at startup never has the message typed into the shell that follows it', () => {
  const { timers, writes, outcomes, delivery } = harness()
  delivery.observeOutput('Error: invalid settings\r\n')
  // The startup script prints the sentinel, split here across two chunks,
  // then execs a shell that turns bracketed paste on and goes quiet.
  delivery.observeOutput(CLI_EXITED_SENTINEL.slice(0, 5))
  delivery.observeOutput(`${CLI_EXITED_SENTINEL.slice(5)}${PASTE_ON}$ `)
  timers.advance(DEFERRED_PROMPT_FALLBACK_MS * 2)
  assert.deepEqual(writes, [])
  assert.deepEqual(outcomes, [{ kind: 'abandoned', reason: 'exited' }])
})

test('the sentinel between the paste and its Enter stops the Enter', () => {
  const { timers, writes, outcomes, delivery, text } = harness()
  delivery.observeOutput(PASTE_ON)
  timers.advance(DEFERRED_PROMPT_QUIET_MS)
  delivery.observeOutput(CLI_EXITED_SENTINEL)
  timers.advance(5_000)
  assert.deepEqual(writes, [pasteOf(text)])
  assert.deepEqual(outcomes, [{ kind: 'abandoned', reason: 'exited' }])
})

test('text that would break the paste frame or read as keys is typed as text', () => {
  const hostile = 'a\x1b[201~b\rc\r\nd\x03e\tf\x1b[31mred\x1b[0m\x1b[200~'
  assert.equal(sanitizeTypedPrompt(hostile), 'ab\nc\nde\tf\x1b[31mred\x1b[0m')
  const { timers, writes, delivery } = harness(hostile)
  delivery.observeOutput(PASTE_ON)
  timers.advance(DEFERRED_PROMPT_QUIET_MS)
  assert.deepEqual(writes, [pasteOf(sanitizeTypedPrompt(hostile))])
  assert.equal(writes[0]?.split('\x1b[201~').length, 2, 'exactly one end marker: the frame itself')
})

test('a paste written while the message is pending goes after its Enter, never into it', () => {
  const { timers, writes, delivery, text } = harness()
  const prefill = '\x1b[200~/review \x1b[201~'
  assert.equal(delivery.holdPaste(prefill), true)
  delivery.observeOutput(PASTE_ON)
  timers.advance(DEFERRED_PROMPT_QUIET_MS)
  assert.equal(delivery.holdPaste(prefill), true, 'still held between the paste and its Enter')
  timers.advance(deferredPromptSubmitDelayMs(text))
  assert.deepEqual(writes, [pasteOf(text), '\r', prefill, prefill])
  assert.equal(delivery.holdPaste(prefill), false, 'once settled the caller writes it itself')
})

test('a held paste is dropped when the CLI is gone', () => {
  const { timers, writes, delivery } = harness()
  delivery.holdPaste('\x1b[200~/review \x1b[201~')
  delivery.observeOutput(CLI_EXITED_SENTINEL)
  timers.advance(DEFERRED_PROMPT_FALLBACK_MS * 2)
  assert.deepEqual(writes, [])
})
