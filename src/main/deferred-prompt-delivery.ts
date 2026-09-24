import { bracketedTerminalPaste } from '../shared/terminal-paste'

// Delivering a first message the launch's command line could not carry.
//
// `planAgentLaunch` moves a prompt that is too long for the platform's argv off
// the command line, and the CLI starts without it. This types it in: one
// bracketed paste and one Enter, written into the pty once the CLI is ready for
// input — exactly once, and never after the CLI has gone.
//
// "Ready" is read from the CLI's own output, because every agent CLI the app
// drives says so the same way: its line editor turns on bracketed paste
// (`ESC[?2004h`) when it starts reading. That is necessary but not sufficient —
// verified against the installed CLIs, Claude Code turns it on ~200 ms in but
// drops a paste that arrives before it has finished drawing its first screen,
// ~1 s in; a paste written once output had been quiet for half a second after
// the mode came on landed every time, in Claude Code, Codex and Cursor alike.
// So the paste waits for the mode AND a quiet screen. A lifecycle hook frame
// (SessionStart) counts as the mode for a CLI that reports one without drawing
// a line editor the mode test would recognise.
//
// Two ways out that are not a delivery: the CLI exits first (nothing is written;
// there is nobody left to read it), or the delivery is cancelled with the
// session. And one fallback: a CLI that never turns the mode on still gets the
// message once the fallback window has passed, because a prompt that never
// arrives is the failure this exists to prevent.

/** The sequence a line editor writes when it starts accepting bracketed pastes. */
const BRACKETED_PASTE_ON = '\x1b[?2004h'
/** How long output must have been quiet, once the CLI is reading, before the paste goes. */
export const DEFERRED_PROMPT_QUIET_MS = 500
/** From spawn: past this, the message goes whatever the CLI has or has not said. */
export const DEFERRED_PROMPT_FALLBACK_MS = 20_000
/**
 * Between the paste and the Enter. The Enter is a separate write because an
 * Enter inside the bracketed block is text, not a submit; the gap grows with the
 * paste so a CLI still consuming a large one sees the Enter after it, not in it.
 */
export function deferredPromptSubmitDelayMs(text: string): number {
  return Math.min(1_500, Math.max(150, Math.round(text.length / 1_000)))
}

const POLL_MS = 50

type Timers = {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type DeferredPromptOutcome =
  | { kind: 'delivered'; via: 'ready' | 'fallback'; atMs: number }
  | { kind: 'abandoned'; reason: 'exited' | 'cancelled' | 'write-failed' }

export type DeferredPromptDelivery = {
  /** Every chunk the CLI writes, in order. */
  observeOutput(data: string): void
  /** A lifecycle hook frame arrived for this session. */
  observeHookFrame(): void
  /** The CLI exited: nothing more will be written. */
  observeExit(): void
  /** The session is being torn down. */
  cancel(): void
  /** True once the message has been written or given up on. */
  readonly settled: boolean
}

export function createDeferredPromptDelivery(input: {
  text: string
  /** Writes into the session's pty. May throw when the pty is gone. */
  write(data: string): void
  /** Told once, when the delivery settles either way. */
  onSettled?(outcome: DeferredPromptOutcome): void
  timers?: Timers
}): DeferredPromptDelivery {
  const timers = input.timers ?? realTimers
  const startedAt = timers.now()
  let lastOutputAt = startedAt
  let reading = false
  // The tail of the previous chunk, so the mode sequence split across two
  // chunks is still seen.
  let carry = ''
  let settled = false
  let pasted = false
  let readyPoll: unknown = null
  let submitTimer: unknown = null
  const fallbackTimer = timers.setTimeout(() => deliver('fallback'), DEFERRED_PROMPT_FALLBACK_MS)

  const clearTimers = (): void => {
    timers.clearTimeout(fallbackTimer)
    if (readyPoll !== null) timers.clearTimeout(readyPoll)
    readyPoll = null
  }

  const settle = (outcome: DeferredPromptOutcome): void => {
    if (settled) return
    settled = true
    clearTimers()
    if (submitTimer !== null) timers.clearTimeout(submitTimer)
    submitTimer = null
    input.onSettled?.(outcome)
  }

  const deliver = (via: 'ready' | 'fallback'): void => {
    if (settled || pasted) return
    pasted = true
    clearTimers()
    try {
      input.write(bracketedTerminalPaste(input.text))
    } catch {
      settle({ kind: 'abandoned', reason: 'write-failed' })
      return
    }
    submitTimer = timers.setTimeout(() => {
      submitTimer = null
      if (settled) return
      try {
        input.write('\r')
      } catch {
        settle({ kind: 'abandoned', reason: 'write-failed' })
        return
      }
      settle({ kind: 'delivered', via, atMs: timers.now() - startedAt })
    }, deferredPromptSubmitDelayMs(input.text))
  }

  const pollForQuiet = (): void => {
    readyPoll = null
    if (settled || pasted) return
    const quietFor = timers.now() - lastOutputAt
    if (quietFor >= DEFERRED_PROMPT_QUIET_MS) {
      deliver('ready')
      return
    }
    readyPoll = timers.setTimeout(pollForQuiet, Math.max(POLL_MS, DEFERRED_PROMPT_QUIET_MS - quietFor))
  }

  const markReading = (): void => {
    if (reading || settled || pasted) return
    reading = true
    readyPoll = timers.setTimeout(pollForQuiet, DEFERRED_PROMPT_QUIET_MS)
  }

  return {
    observeOutput(data: string): void {
      if (settled || pasted) return
      lastOutputAt = timers.now()
      if (reading) return
      const window = carry + data
      if (window.includes(BRACKETED_PASTE_ON)) markReading()
      else carry = window.slice(-(BRACKETED_PASTE_ON.length - 1))
    },
    observeHookFrame(): void {
      markReading()
    },
    observeExit(): void {
      // An exit after the paste but before its Enter still abandons: the text
      // went nowhere a person will see submitted.
      settle({ kind: 'abandoned', reason: 'exited' })
    },
    cancel(): void {
      settle({ kind: 'abandoned', reason: 'cancelled' })
    },
    get settled(): boolean {
      return settled
    },
  }
}
