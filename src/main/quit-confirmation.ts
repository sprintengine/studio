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
}

/**
 * - `quit`: go ahead.
 * - `stay`: the person pressed Cancel.
 * - `pending`: the question is already up for an earlier quit, whose answer
 *   decides; this one does nothing (Cmd+Q pressed twice is one question).
 */
export type QuitDecision = 'quit' | 'stay' | 'pending'

export type QuitConfirmation = ReturnType<typeof createQuitConfirmation>

export function createQuitConfirmation(deps: QuitConfirmationDeps) {
  // Set by a quit nobody should be asked about, and by a Quit the person
  // already answered: the `before-quit` that follows closing the last window
  // is the same quit, not a second one to ask about.
  let settled = false
  let inFlight: Promise<QuitDecision> | null = null
  let question: AbortController | null = null

  async function decide(): Promise<'quit' | 'stay'> {
    if (settled || !deps.isEnabled()) return 'quit'
    let count: number
    try {
      count = await deps.countWorkingAgents()
    } catch {
      // A count that cannot be had must not keep the person in the app.
      return 'quit'
    }
    if (settled || !(count > 0)) return 'quit'
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
    if (settled) return 'quit'
    if (!answer.quit) return 'stay'
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
          if (decision === 'quit') settled = true
          return decision
        })
      inFlight = run
      return run
    },
    /**
     * The quit that follows is the app's or the OS's, not the person's: never
     * ask, and take down a question already up (answered as Quit).
     */
    quitWithoutAsking(): void {
      settled = true
      question?.abort()
    },
  }
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
