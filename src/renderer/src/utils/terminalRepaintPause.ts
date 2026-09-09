/**
 * "A covering surface is open" — the one signal terminal output queues watch so
 * they can stop writing, and therefore stop repainting, while a modal sits over
 * the app.
 *
 * ## Why this exists as a module-level store rather than a prop or context
 *
 * The cost this removes is `repaint rate x covered area`. A modal over a
 * streaming pane makes the compositor redo the covered region on every PTY
 * chunk, and a terminal produces chunks continuously. Silencing the writes for
 * the duration of the dialog takes that to zero.
 *
 * The seam that can do the silencing is `createXtermOutputQueue`
 * (`xtermOutputQueue.ts`), which already sits between PTY data and
 * `term.write()`. It is constructed inside a `useEffect` in three panel
 * components and has no React context above it that a dialog could publish
 * into without re-plumbing all three. A module-level store is what both ends
 * can reach: `Modal` acquires a hold on mount, the queue subscribes at
 * construction.
 *
 * ## v1 is GLOBAL, deliberately
 *
 * There is one signal for the whole window, so an open dialog pauses every
 * terminal, not only the ones physically underneath it. That is the right
 * trade for a modal (which covers the middle of the window, where the panes
 * are) and it is wrong for a future partial-cover surface — a drawer, an
 * inspector, a popover over one pane.
 *
 * The shape is chosen so that scoping later is additive rather than a rewrite:
 * a hold already carries a `scope`, queues already ask
 * `isTerminalRepaintPaused(scope)`, and today every hold takes the `'app'`
 * scope and every queue asks about `'app'`. Per-pane scoping means passing a
 * pane id at both ends and letting `'app'` keep meaning "everything".
 *
 * ## The stuck-open failure mode
 *
 * If a hold is never released, every terminal in the app freezes permanently.
 * That is far worse than the lag this fixes, so three independent things stop
 * it:
 *
 * 1. **Releases are idempotent tokens.** Calling a release twice cannot
 *    decrement someone else's hold, and a double release cannot underflow the
 *    count into a permanently-paused state.
 * 2. **Holds are liveness-probed.** A holder may pass `isAlive`; `Modal` passes
 *    `() => node.isConnected`. A watchdog prunes holds whose probe says the
 *    surface is gone, which covers every abnormal unmount path where a React
 *    cleanup never ran (thrown render, error boundary, parent torn down
 *    mid-commit).
 * 3. **Holds expire.** `MAX_HOLD_MS` is an absolute ceiling. If a hold outlives
 *    it, the hold is dropped and reported. Failing open costs frame rate for a
 *    dialog somebody left open for an hour; failing closed costs every terminal
 *    in the product, forever. Only one of those is recoverable by the user.
 */

/**
 * Which surface a hold covers. `'app'` is the whole window — the only scope a
 * modal can claim, and the scope every queue currently watches. Reserved for
 * the per-pane split described above.
 */
export type TerminalRepaintPauseScope = 'app'

export type TerminalRepaintPauseHoldOptions = {
  /** Names the holder in perf events. Not an identity — holds are tokens. */
  label?: string
  /** See `'app'` above. Defaults to `'app'`. */
  scope?: TerminalRepaintPauseScope
  /**
   * Liveness probe, polled by the watchdog. Return `false` once the surface
   * that took this hold is gone. Omit it and the hold is trusted until it
   * expires — which is why every UI holder should supply one.
   */
  isAlive?: () => boolean
}

type Hold = {
  id: number
  label: string
  scope: TerminalRepaintPauseScope
  acquiredAt: number
  isAlive: (() => boolean) | null
}

type PauseListener = (paused: boolean) => void

type PauseReporter = (scope: string, event: string, payload: Record<string, unknown>) => void

/**
 * How often the watchdog re-checks that every live hold still has a surface
 * behind it. One second is far below any threshold a person would notice as
 * "the terminal is stuck" and costs a single array scan of a list that is
 * almost always length 0 or 1.
 */
const WATCHDOG_INTERVAL_MS = 1_000

/**
 * Absolute lifetime of a hold. Two minutes comfortably outlasts any dialog
 * interaction (the longest real one is filling in Settings), and a hold older
 * than that is far more likely to be leaked than legitimately held. See the
 * fail-open argument in the module header.
 */
const MAX_HOLD_MS = 120_000

const holds: Hold[] = []
const listeners = new Set<PauseListener>()

let nextHoldId = 1
let paused = false
let watchdogId: ReturnType<typeof setInterval> | null = null
let reporter: PauseReporter | null = null
let pauseStartedAt = 0
let notifying = false
let settlePending = false

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function report(event: string, payload: Record<string, unknown>): void {
  // Best effort by construction: diagnostics must never be able to take the
  // pause down with them, or a throwing reporter becomes the stuck-open bug
  // this module exists to prevent.
  try {
    reporter?.('TerminalRepaintPause', event, payload)
  } catch {
    /* diagnostics only */
  }
}

/**
 * Point the module's perf events at `logPerfEvent`. Injected rather than
 * imported so this file stays dependency-free: it is pulled into the output
 * queue, which is bundled by tests that do not define `import.meta.env`.
 * Called once from the renderer entry (`main.tsx`).
 */
export function setTerminalRepaintPauseReporter(next: PauseReporter | null): void {
  reporter = next
}

function stopWatchdog(): void {
  if (watchdogId === null) return
  clearInterval(watchdogId)
  watchdogId = null
}

function startWatchdog(): void {
  if (watchdogId !== null) return
  if (typeof setInterval !== 'function') return
  watchdogId = setInterval(runWatchdog, WATCHDOG_INTERVAL_MS)
  // Never hold a Node test process (or an Electron teardown) open on the
  // watchdog alone.
  ;(watchdogId as unknown as { unref?: () => void }).unref?.()
}

function runWatchdog(): void {
  const at = now()
  for (let index = holds.length - 1; index >= 0; index -= 1) {
    const hold = holds[index]
    if (!hold) continue

    const ageMs = at - hold.acquiredAt
    if (ageMs >= MAX_HOLD_MS) {
      holds.splice(index, 1)
      report('hold-expired', { label: hold.label, ageMs: Math.round(ageMs) })
      continue
    }

    let alive = true
    try {
      alive = hold.isAlive ? hold.isAlive() !== false : true
    } catch {
      // A probe that throws is a surface that has come apart. Treat it as gone
      // — the fail-open direction.
      alive = false
    }
    if (!alive) {
      holds.splice(index, 1)
      report('hold-reclaimed', { label: hold.label, ageMs: Math.round(ageMs) })
    }
  }
  settle()
}

function applySettleOnce(): void {
  const next = holds.length > 0
  if (next === paused) {
    if (!next) stopWatchdog()
    return
  }

  paused = next
  if (paused) {
    pauseStartedAt = now()
    startWatchdog()
    report('paused', { holdCount: holds.length, labels: holds.map((hold) => hold.label) })
  } else {
    stopWatchdog()
    report('resumed', { elapsedMs: Math.round(now() - pauseStartedAt) })
    pauseStartedAt = 0
  }

  // A listener that throws must not strand the other queues mid-notify: one
  // wedged terminal is a bug, all of them is the freeze.
  for (const listener of Array.from(listeners)) {
    try {
      listener(paused)
    } catch {
      /* a subscriber's failure is its own */
    }
  }
}

/**
 * Recompute the signal from the holds and notify on a transition.
 *
 * Re-entrant by design rather than by accident: a subscriber is free to acquire
 * or release from inside its own notification, and if it does, the state it
 * caused is applied by the outermost `settle` after the current notify pass
 * finishes. Letting the inner call notify immediately would deliver `false`
 * before `true` to every listener after it in the set.
 */
function settle(): void {
  if (notifying) {
    settlePending = true
    return
  }

  notifying = true
  try {
    do {
      settlePending = false
      applySettleOnce()
    } while (settlePending)
  } finally {
    notifying = false
    settlePending = false
  }
}

/**
 * Claim the pause. Returns the release, which is safe to call more than once
 * and safe to call after the watchdog has already reclaimed the hold.
 */
export function acquireTerminalRepaintPause(
  options: TerminalRepaintPauseHoldOptions = {}
): () => void {
  const hold: Hold = {
    id: nextHoldId++,
    label: options.label ?? 'unlabelled',
    scope: options.scope ?? 'app',
    acquiredAt: now(),
    isAlive: options.isAlive ?? null,
  }
  holds.push(hold)
  settle()

  let released = false
  return () => {
    if (released) return
    released = true
    const index = holds.findIndex((candidate) => candidate.id === hold.id)
    if (index >= 0) holds.splice(index, 1)
    settle()
  }
}

/** Whether output for `scope` should currently be withheld. */
export function isTerminalRepaintPaused(_scope: TerminalRepaintPauseScope = 'app'): boolean {
  return paused
}

/**
 * Watch the signal. The listener is called only on transitions, with the new
 * value. Returns the unsubscribe — every caller must run it on teardown or the
 * store retains a disposed queue's closure.
 */
export function subscribeTerminalRepaintPause(listener: PauseListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * What one output queue withheld across one pause, reported when it resumes.
 * This is the measurement the item asks for: `writesAvoided` is PTY chunks that
 * produced no `term.write` and therefore no paint behind the dialog, and
 * `droppedChars` is what the queue's cap had to discard to stay bounded.
 */
export function reportTerminalRepaintPauseWindow(payload: Record<string, unknown>): void {
  report('output-withheld', payload)
}

/** Introspection for tests and the diagnostics panel. */
export function terminalRepaintPauseDebugState(): {
  paused: boolean
  holdCount: number
  listenerCount: number
  watchdogRunning: boolean
} {
  return {
    paused,
    holdCount: holds.length,
    listenerCount: listeners.size,
    watchdogRunning: watchdogId !== null,
  }
}

/** Drop every hold and listener. Tests only — nothing in the app calls this. */
export function resetTerminalRepaintPauseForTests(): void {
  holds.length = 0
  listeners.clear()
  stopWatchdog()
  paused = false
  pauseStartedAt = 0
  notifying = false
  settlePending = false
}

/** Run the watchdog now instead of waiting for its interval. Tests only. */
export function runTerminalRepaintPauseWatchdogForTests(): void {
  runWatchdog()
}

export const TERMINAL_REPAINT_PAUSE_MAX_HOLD_MS = MAX_HOLD_MS
