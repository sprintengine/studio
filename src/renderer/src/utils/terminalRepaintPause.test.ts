import assert from 'node:assert/strict'
import {
  TERMINAL_REPAINT_PAUSE_MAX_HOLD_MS,
  acquireTerminalRepaintPause,
  isTerminalRepaintPaused,
  resetTerminalRepaintPauseForTests,
  runTerminalRepaintPauseWatchdogForTests,
  setTerminalRepaintPauseReporter,
  subscribeTerminalRepaintPause,
  terminalRepaintPauseDebugState,
} from './terminalRepaintPause'
import { test } from 'vitest'

test('terminalRepaintPause', async () => {
  void main()

  function main(): void {
    assertRefcountedAcrossStackedHolders()
    assertReleaseIsAnIdempotentToken()
    assertListenersSeeTransitionsOnlyAndUnsubscribe()
    assertADeadSurfaceCannotHoldThePauseOpen()
    assertAThrowingLivenessProbeIsTreatedAsGone()
    assertAHoldCannotOutliveTheCeiling()
    assertAThrowingSubscriberCannotStrandTheOthers()
    assertWatchdogStopsWhenNothingHoldsThePause()
    console.log('terminalRepaintPause.test.ts: ok')
  }

  // Stacked dialogs each hold the signal. The pause lifts on the LAST release,
  // never the first — closing a confirm over a workbench must not start every
  // terminal painting again under the workbench that is still there.
  function assertRefcountedAcrossStackedHolders(): void {
    resetTerminalRepaintPauseForTests()
    assert.equal(isTerminalRepaintPaused(), false)

    const releaseOuter = acquireTerminalRepaintPause({ label: 'workbench' })
    assert.equal(isTerminalRepaintPaused(), true)
    const releaseInner = acquireTerminalRepaintPause({ label: 'confirm' })
    assert.equal(terminalRepaintPauseDebugState().holdCount, 2)

    releaseOuter()
    assert.equal(isTerminalRepaintPaused(), true, 'the inner dialog still covers the panes')
    releaseInner()
    assert.equal(isTerminalRepaintPaused(), false)
    resetTerminalRepaintPauseForTests()
  }

  // A release is a token for ONE hold, not a decrement. Calling it twice — a
  // double-invoked effect cleanup, a defensive caller — must not free somebody
  // else's hold, and must not underflow the count into a permanent pause.
  function assertReleaseIsAnIdempotentToken(): void {
    resetTerminalRepaintPauseForTests()
    const releaseFirst = acquireTerminalRepaintPause({ label: 'first' })
    const releaseSecond = acquireTerminalRepaintPause({ label: 'second' })

    releaseFirst()
    releaseFirst()
    releaseFirst()
    assert.equal(terminalRepaintPauseDebugState().holdCount, 1, 'only its own hold is freed')
    assert.equal(isTerminalRepaintPaused(), true)

    releaseSecond()
    assert.equal(isTerminalRepaintPaused(), false)

    // And a stale release after everything is gone stays inert rather than
    // leaving the count negative — which would read as "paused" forever.
    releaseSecond()
    releaseFirst()
    assert.equal(terminalRepaintPauseDebugState().holdCount, 0)
    assert.equal(isTerminalRepaintPaused(), false)
    resetTerminalRepaintPauseForTests()
  }

  function assertListenersSeeTransitionsOnlyAndUnsubscribe(): void {
    resetTerminalRepaintPauseForTests()
    const seen: boolean[] = []
    const unsubscribe = subscribeTerminalRepaintPause((paused) => seen.push(paused))

    const releaseOuter = acquireTerminalRepaintPause({ label: 'a' })
    const releaseInner = acquireTerminalRepaintPause({ label: 'b' })
    releaseInner()
    releaseOuter()
    assert.deepEqual(seen, [true, false], 'a second hold is not a second notification')

    unsubscribe()
    const release = acquireTerminalRepaintPause({ label: 'c' })
    release()
    assert.deepEqual(seen, [true, false], 'unsubscribe detaches')
    assert.equal(terminalRepaintPauseDebugState().listenerCount, 0)
    resetTerminalRepaintPauseForTests()
  }

  // THE dangerous failure mode. If a dialog's cleanup never runs — a throwing
  // render, an error boundary swallowing the subtree, a parent torn down
  // mid-commit — a naive refcount would leave every terminal in the product
  // frozen with no way back short of a reload. The hold is tied to a liveness
  // probe instead, and the watchdog reclaims it once the surface is gone.
  function assertADeadSurfaceCannotHoldThePauseOpen(): void {
    resetTerminalRepaintPauseForTests()
    const reported: string[] = []
    setTerminalRepaintPauseReporter((_scope, event) => reported.push(event))

    let surfaceMounted = true
    acquireTerminalRepaintPause({ label: 'Modal', isAlive: () => surfaceMounted })
    assert.equal(isTerminalRepaintPaused(), true)

    runTerminalRepaintPauseWatchdogForTests()
    assert.equal(isTerminalRepaintPaused(), true, 'a live surface keeps its hold')

    // The dialog is gone from the document but its release was never called.
    surfaceMounted = false
    runTerminalRepaintPauseWatchdogForTests()
    assert.equal(isTerminalRepaintPaused(), false, 'the watchdog reclaims an orphaned hold')
    assert.equal(reported.includes('hold-reclaimed'), true)

    setTerminalRepaintPauseReporter(null)
    resetTerminalRepaintPauseForTests()
  }

  function assertAThrowingLivenessProbeIsTreatedAsGone(): void {
    resetTerminalRepaintPauseForTests()
    acquireTerminalRepaintPause({
      label: 'Modal',
      isAlive: () => {
        throw new Error('detached')
      },
    })
    assert.equal(isTerminalRepaintPaused(), true)

    runTerminalRepaintPauseWatchdogForTests()
    assert.equal(isTerminalRepaintPaused(), false, 'a probe that throws fails open, not closed')
    resetTerminalRepaintPauseForTests()
  }

  // The last line of defence, for a holder that supplies no probe at all: holds
  // expire. Failing open costs frame rate under a dialog somebody left open for
  // hours; failing closed costs every terminal, permanently.
  function assertAHoldCannotOutliveTheCeiling(): void {
    resetTerminalRepaintPauseForTests()
    const reported: string[] = []
    setTerminalRepaintPauseReporter((_scope, event) => reported.push(event))

    const realNow = performance.now.bind(performance)
    let clock = realNow()
    performance.now = () => clock

    try {
      acquireTerminalRepaintPause({ label: 'no-probe' })
      assert.equal(isTerminalRepaintPaused(), true)

      clock += TERMINAL_REPAINT_PAUSE_MAX_HOLD_MS - 1
      runTerminalRepaintPauseWatchdogForTests()
      assert.equal(isTerminalRepaintPaused(), true, 'still inside the ceiling')

      clock += 2
      runTerminalRepaintPauseWatchdogForTests()
      assert.equal(isTerminalRepaintPaused(), false, 'a hold past the ceiling is dropped')
      assert.equal(reported.includes('hold-expired'), true)
    } finally {
      performance.now = realNow
      setTerminalRepaintPauseReporter(null)
      resetTerminalRepaintPauseForTests()
    }
  }

  // One wedged terminal is a bug; all of them is the freeze. A subscriber that
  // throws on notify must not stop the rest of the queues being told to resume.
  function assertAThrowingSubscriberCannotStrandTheOthers(): void {
    resetTerminalRepaintPauseForTests()
    const seen: boolean[] = []
    subscribeTerminalRepaintPause(() => {
      throw new Error('a disposed queue with a bad closure')
    })
    subscribeTerminalRepaintPause((paused) => seen.push(paused))

    const release = acquireTerminalRepaintPause({ label: 'Modal' })
    release()
    assert.deepEqual(seen, [true, false])
    resetTerminalRepaintPauseForTests()
  }

  // The watchdog is only worth a timer while something is actually held; leaving
  // it ticking for the life of the window would be a background cost paid by
  // every user who never opens a dialog.
  function assertWatchdogStopsWhenNothingHoldsThePause(): void {
    resetTerminalRepaintPauseForTests()
    assert.equal(terminalRepaintPauseDebugState().watchdogRunning, false)

    const release = acquireTerminalRepaintPause({ label: 'Modal' })
    assert.equal(terminalRepaintPauseDebugState().watchdogRunning, true)

    release()
    assert.equal(terminalRepaintPauseDebugState().watchdogRunning, false)
    resetTerminalRepaintPauseForTests()
  }
})
