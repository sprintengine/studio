/**
 * "Quit SprintEngine Studio? 3 agents are still working." — the question a
 * person's own quit is asked while agent turns are running, and the rules for
 * which quits are never asked.
 *
 * Only a quit the person started is asked about: Cmd+Q, the app menu's or
 * the tray's Quit, and closing the last window where that ends the process.
 * Everything the app or the OS starts goes straight through, marked with
 * `quitWithoutAsking()` before it quits: "Restart to update", a relaunch, a
 * logout or power-off. A question the OS's shutdown arrives under is taken
 * down and answered as Quit, so it can never hold up a logout.
 *
 * Electron is injected (the dialog, the count, the setting), so the rules run
 * headless under test; the dialog itself is `quit-confirmation-electron.ts`.
 */
import type { AgentPhase, TerminalSessionSnapshot } from '../shared/ipc/terminal'

export type QuitConfirmationAnswer = { quit: boolean; dontAskAgain: boolean }

export type QuitConfirmationDeps = {
  /** The Settings switch, read at quit time: it can change mid-session. */
  isEnabled(): boolean
  /** "Don't ask again" was ticked on a Quit. */
  stopAsking(): void
  /** Agent turns a quit would stop now. Asked only when the switch is on. */
  countWorkingAgents(): Promise<number>
  /** Show the question. `signal` aborting takes it down unanswered. */
  ask(input: { count: number; signal: AbortSignal }): Promise<QuitConfirmationAnswer>
  /** Test seam for the unasked window's timer; `setTimeout` otherwise. */
  setTimer?: (run: () => void, ms: number) => { unref?(): unknown }
  clearTimer?: (timer: { unref?(): unknown }) => void
}

/**
 * How long a quit nobody is asked about stays unasked when the process
 * outlives it. A logout the OS or another app cancels (Windows'
 * `query-session-end` with no `session-end` after it, a macOS logout another
 * app refused) leaves the app running, and the person's next Cmd+Q is theirs
 * again. Long enough for the windows the OS closes after it to be closed.
 */
export const QUIT_UNASKED_WINDOW_MS = 15_000

/**
 * - `quit`: go ahead.
 * - `stay`: the person pressed Cancel.
 * - `pending`: the question is already up for an earlier quit, whose answer
 *   decides; this one does nothing (Cmd+Q pressed twice is one question).
 */
export type QuitDecision = 'quit' | 'stay' | 'pending'

export type QuitConfirmation = ReturnType<typeof createQuitConfirmation>

export function createQuitConfirmation(deps: QuitConfirmationDeps) {
  // Set by a Quit the person answered: the `before-quit` that follows
  // closing the last window is the same quit, not a second one to ask about.
  // That quit exits, so it never needs to be unset.
  let answered = false
  // Set by a quit nobody should be asked about, for `QUIT_UNASKED_WINDOW_MS`.
  let unasked = false
  let unaskedTimer: { unref?(): unknown } | null = null
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
  const settled = () => answered || unasked
  let inFlight: Promise<QuitDecision> | null = null
  let question: AbortController | null = null

  async function decide(): Promise<'quit' | 'stay'> {
    if (settled() || !deps.isEnabled()) return 'quit'
    let count: number
    try {
      count = await deps.countWorkingAgents()
    } catch {
      // A count that cannot be had must not keep the person in the app.
      return 'quit'
    }
    if (settled() || !(count > 0)) return 'quit'
    question = new AbortController()
    let answer: QuitConfirmationAnswer
    try {
      answer = await deps.ask({ count, signal: question.signal })
    } catch {
      // No dialog could be shown: quit as the app did before it asked.
      return 'quit'
    } finally {
      question = null
    }
    // The OS's shutdown took the question down: it answered for the person.
    if (settled()) return 'quit'
    if (!answer.quit) return 'stay'
    answered = true
    if (answer.dontAskAgain) deps.stopAsking()
    return 'quit'
  }

  return {
    /** Whether this quit may go ahead; see `QuitDecision`. Never rejects. */
    confirm(): Promise<QuitDecision> {
      if (inFlight) return Promise.resolve('pending')
      const run = decide()
        .catch(() => 'quit' as const)
        .then((decision) => {
          inFlight = null
          return decision
        })
      inFlight = run
      return run
    },
    /**
     * The quit that follows is the app's or the OS's, not the person's: never
     * ask, and take down a question already up (answered as Quit). Should the
     * process still be here `QUIT_UNASKED_WINDOW_MS` later, the quit did not
     * happen, and asking comes back on.
     */
    quitWithoutAsking(): void {
      unasked = true
      question?.abort()
      if (unaskedTimer) clearTimer(unaskedTimer)
      unaskedTimer = setTimer(() => {
        unaskedTimer = null
        unasked = false
      }, QUIT_UNASKED_WINDOW_MS)
      // A pending reset must not keep a quitting process alive.
      unaskedTimer.unref?.()
    },
  }
}

/**
 * The signals a POSIX system ends a process with: `kill`/`pkill` and a
 * systemd stop (SIGTERM), Ctrl+C in the terminal that started the app
 * (SIGINT), and the terminal or session going away (SIGHUP). Electron turns
 * each into an ordinary quit, which would put the question up with nobody
 * to answer it and leave the shutdown to the kill that follows.
 */
export const QUIT_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

/**
 * How long after the first signal another is the same quit. A logout sends
 * SIGHUP and SIGTERM together; a second Ctrl+C seconds later, or a second
 * `kill`, is someone saying the shutdown has taken too long.
 */
export const QUIT_SIGNAL_SAME_QUIT_MS = 2_000

/**
 * Wire the quits the OS starts to `quitWithoutAsking()`, so none is asked
 * about and a question already up comes down:
 * - Windows' logout, restart or power-off, said on every window
 *   (`query-session-end` first, then `session-end`);
 * - macOS and Linux's, through `powerMonitor`'s `shutdown` once the app is
 *   ready;
 * - a process signal, except on Windows, which has none to send. A signal is
 *   also the quit itself: `quit()` runs the app's one ordered shutdown, as a
 *   confirmed Cmd+Q does. The signals within `QUIT_SIGNAL_SAME_QUIT_MS` of
 *   the first (a logout sends SIGHUP and SIGTERM together) join the shutdown
 *   under way; one after that exits at once, so a shutdown that hangs can
 *   still be stopped the way it was started.
 *
 * Electron is injected so this runs headless under test.
 */
export function registerUnaskedQuits(input: {
  platform: NodeJS.Platform
  quitConfirmation: Pick<QuitConfirmation, 'quitWithoutAsking'> | undefined
  quit(): void
  /** Leave now, without the ordered shutdown: `app.exit(1)`. */
  exit(): void
  /** Test seam for the clock; `Date.now` otherwise. */
  now?: () => number
  onWindowCreated(
    listener: (win: { on(event: 'query-session-end' | 'session-end', run: () => void): unknown }) => void,
  ): void
  onSystemShutdown(listener: () => void): void
  onSignal(signal: (typeof QUIT_SIGNALS)[number], listener: () => void): void
}): void {
  const quitWithoutAsking = () => input.quitConfirmation?.quitWithoutAsking()
  input.onWindowCreated((win) => {
    win.on('query-session-end', quitWithoutAsking)
    win.on('session-end', quitWithoutAsking)
  })
  input.onSystemShutdown(quitWithoutAsking)
  if (input.platform === 'win32') return
  const now = input.now ?? Date.now
  let firstSignalAt: number | null = null
  const quitFromSignal = () => {
    if (firstSignalAt === null) {
      firstSignalAt = now()
      quitWithoutAsking()
      input.quit()
      return
    }
    if (now() - firstSignalAt > QUIT_SIGNAL_SAME_QUIT_MS) input.exit()
  }
  for (const signal of QUIT_SIGNALS) input.onSignal(signal, quitFromSignal)
}

// A terminal agent's phases in which a turn is under way. `stalled` is the
// watchdog's word for a turn that has gone quiet, which is still a turn.
const TERMINAL_TURN_PHASES = new Set<AgentPhase>(['starting', 'thinking', 'tool_use', 'awaiting_input', 'stalled'])

/**
 * Terminal agents with a turn under way: a live, unsuspended agent process
 * whose hooks put it mid-turn or waiting on the person. A CLI without hooks
 * reports no phase, and its `activity` is the only word on it.
 */
export function countWorkingTerminalAgents(
  sessions: ReadonlyArray<
    Pick<TerminalSessionSnapshot, 'kind' | 'processAlive' | 'suspended' | 'agentState' | 'activity'>
  >,
): number {
  return sessions.filter((session) => {
    if (session.kind !== 'agent' || !session.processAlive || session.suspended) return false
    if (session.agentState) return TERMINAL_TURN_PHASES.has(session.agentState.phase)
    return session.activity.kind === 'working'
  }).length
}

/** The question's words. `count` is at least one. */
export function quitConfirmationDetail(count: number): string {
  return count === 1
    ? '1 agent is still working. Quitting stops it.'
    : `${count} agents are still working. Quitting stops them.`
}
