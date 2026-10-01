/**
 * The safety net under the terminal-session push channel.
 *
 * Main pushes every session change to every window, so a window that is
 * listening already has the list. This used to be backed by a thirty-second
 * `terminalList` poll that ran for as long as the window was open, whether or
 * not a push had ever gone missing — two IPC round trips a minute, and a full
 * signature pass over every session on each, for nothing.
 *
 * Now the list is only checked when a person comes back to the window (it
 * turns visible or takes focus), which is when a stale list would be seen. If
 * that check finds the pushes had not delivered what main holds, a push was
 * missed, and only then does the poll run — until a check agrees with the
 * pushes again. A check that fails outright counts as missed.
 */

export const TERMINAL_SESSION_RECOVERY_POLL_MS = 30_000
// Focus can bounce between this window and the browser pane's guest several
// times a second; one check per this long is plenty.
const RECOVERY_CHECK_MIN_GAP_MS = 5_000

export type TerminalSessionRecoveryDeps = {
  reconcile: () => Promise<'in-sync' | 'missed'>
  /** Calls back whenever the window becomes visible or takes focus. */
  subscribeReturn: (listener: () => void) => () => void
  now?: () => number
  timers?: {
    setInterval(handler: () => void, ms: number): unknown
    clearInterval(handle: unknown): void
  }
}

export function startTerminalSessionRecovery(deps: TerminalSessionRecoveryDeps): () => void {
  const now = deps.now ?? Date.now
  const timers = deps.timers ?? {
    setInterval: (handler: () => void, ms: number) => window.setInterval(handler, ms),
    clearInterval: (handle: unknown) => window.clearInterval(handle as number),
  }
  let poll: unknown = null
  let disposed = false
  let checking = false
  let lastCheckAt = Number.NEGATIVE_INFINITY

  const stopPolling = (): void => {
    if (poll === null) return
    timers.clearInterval(poll)
    poll = null
  }

  const check = async (): Promise<void> => {
    if (disposed || checking) return
    checking = true
    lastCheckAt = now()
    let outcome: 'in-sync' | 'missed'
    try {
      outcome = await deps.reconcile()
    } catch {
      outcome = 'missed'
    } finally {
      checking = false
    }
    if (disposed) return
    if (outcome === 'in-sync') {
      stopPolling()
      return
    }
    if (poll === null) poll = timers.setInterval(() => void check(), TERMINAL_SESSION_RECOVERY_POLL_MS)
  }

  const unsubscribe = deps.subscribeReturn(() => {
    if (now() - lastCheckAt < RECOVERY_CHECK_MIN_GAP_MS) return
    void check()
  })

  return () => {
    disposed = true
    unsubscribe()
    stopPolling()
  }
}
