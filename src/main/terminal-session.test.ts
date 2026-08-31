import assert from 'node:assert/strict'
import {
  appendTerminalOutput,
  createFailedTerminalSession,
  createInitialTerminalActivity,
  getTerminalLastSeenAt,
  getTerminalSnapshot,
  isTerminalProcessAlive,
  isTerminalSessionStale,
  markTerminalExited,
  markTerminalFailed,
  materializeTerminalReplay,
  recordTerminalInput,
  recordTerminalVisibility,
  transitionTerminalActivity,
  STALE_TERMINAL_MAX_UNSEEN_MS,
  type TerminalSession,
} from './terminal-session'
import { createTerminalDiagnostics } from './terminal-diagnostics'
import {
  TERMINAL_RECENT_HISTORY_WINDOW_MS,
  TERMINAL_RECENT_REPLAY_BYTES,
  TERMINAL_STANDARD_REPLAY_BYTES,
} from '../shared/terminal-history'

void main()

function main(): void {
  assertSpawnSnapshotStartsWorking()
  assertOutputWhileWorkingUpdatesRecencyWithoutStateTransition()
  assertSilenceAndLaterOutputTransitionBetweenIdleAndWorking()
  assertInputRecordsRecencyWithoutChangingActivity()
  assertExitAndFailureClassificationClearTimers()
  assertFailedLaunchSnapshotIsVisible()
  assertActivityTransitionDiagnostics()
  assertRecentSessionsRetainExtendedReplay()
  assertColdSessionsCompactToStandardReplay()
  assertRecentInputKeepsSessionInExtendedReplayTier()
  assertColdSingleLargeChunkIsTrimmedNotDropped()
  assertColdSessionNewOutputUsesRecentReplayTier()
  assertVisibilityRecordingUpdatesRecency()
  assertStaleRuleExemptsVisibleSessionsWithLiveSender()
  assertStaleRuleUsesMostRecentUserSignal()
  assertSuspendedSessionIsNotAlive()
}

function assertSpawnSnapshotStartsWorking(): void {
  const session = createSession({ startedAt: 100 })
  const snapshot = getTerminalSnapshot(session)

  assert.equal(snapshot.processAlive, true)
  assert.equal(snapshot.lastOutputAt, 100)
  assert.equal(snapshot.lastInputAt, null)
  assert.deepEqual(snapshot.activity, { kind: 'working', since: 100 })
}

function assertOutputWhileWorkingUpdatesRecencyWithoutStateTransition(): void {
  const session = createSession({ startedAt: 100 })

  appendTerminalOutput(session, 'first output', 150)
  // Output advances recency; the activity transition is the runtime's call
  // (plain terminals only — agent activity is hook-bridged), and re-asserting
  // the same working state is a no-op.
  assert.equal(transitionTerminalActivity(session, { kind: 'working', since: 100 }), false)
  assert.equal(session.lastOutputAt, 150)
  assert.deepEqual(session.activity, { kind: 'working', since: 100 })
}

function assertSilenceAndLaterOutputTransitionBetweenIdleAndWorking(): void {
  const session = createSession({ startedAt: 100 })

  assert.equal(transitionTerminalActivity(session, { kind: 'idle', since: 3_200 }), true)
  assert.deepEqual(session.activity, { kind: 'idle', since: 3_200 })

  appendTerminalOutput(session, 'later output', 4_000)
  assert.equal(transitionTerminalActivity(session, { kind: 'working', since: 4_000 }), true)
  assert.equal(session.lastOutputAt, 4_000)
  assert.deepEqual(session.activity, { kind: 'working', since: 4_000 })
}

function assertInputRecordsRecencyWithoutChangingActivity(): void {
  const session = createSession({ startedAt: 100 })

  recordTerminalInput(session, 225)

  assert.equal(session.lastInputAt, 225)
  assert.equal(session.lastOutputAt, 100)
  assert.deepEqual(session.activity, { kind: 'working', since: 100 })
}

function assertExitAndFailureClassificationClearTimers(): void {
  const exited = createSession({ startedAt: 100, idleTimer: setTimeout(() => {}, 10_000) })
  markTerminalExited(exited, 0, 500)

  assert.equal(exited.hasExited, true)
  assert.equal(exited.idleTimer, undefined)
  assert.equal(getTerminalSnapshot(exited).processAlive, false)
  assert.deepEqual(exited.activity, { kind: 'exited', at: 500, exitCode: 0 })

  const failed = createSession({ startedAt: 100, idleTimer: setTimeout(() => {}, 10_000) })
  markTerminalFailed(failed, 1, 'write failed', 600)

  assert.equal(failed.hasExited, true)
  assert.equal(failed.idleTimer, undefined)
  assert.equal(getTerminalSnapshot(failed).processAlive, false)
  assert.deepEqual(failed.activity, { kind: 'failed', at: 600, exitCode: 1, message: 'write failed' })
}

function assertFailedLaunchSnapshotIsVisible(): void {
  const failed = createFailedTerminalSession({
    sessionId: 'session_failed_launch',
    message: 'MCP sync failed',
    at: 700,
    kind: 'agent',
    workspaceId: 'workspace_1',
    agentId: 'developer-1',
    sprintEngineStatePath: '.multi-code/sprintengine/status-dots/state.yaml',
    visible: true,
  })
  const snapshot = getTerminalSnapshot(failed)

  assert.equal(snapshot.sessionId, 'session_failed_launch')
  assert.equal(snapshot.processAlive, false)
  assert.equal(snapshot.lastOutputAt, 700)
  assert.equal(snapshot.lastInputAt, null)
  assert.equal(snapshot.workspaceId, 'workspace_1')
  assert.equal(snapshot.agentId, 'developer-1')
  assert.deepEqual(snapshot.activity, {
    kind: 'failed',
    at: 700,
    exitCode: 1,
    message: 'MCP sync failed',
  })
}

function assertActivityTransitionDiagnostics(): void {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []
  const diagnostics = createTerminalDiagnostics({
    enabled: true,
    logMainPerfEvent: (_scope, event, payload) => {
      events.push({ event, payload })
    },
  })
  const session = createSession({ startedAt: 100 })
  recordTerminalInput(session, 125)

  for (const next of [
    { kind: 'idle' as const, since: 200 },
    { kind: 'working' as const, since: 300 },
    { kind: 'exited' as const, at: 400, exitCode: 0 },
  ]) {
    const previous = session.activity
    const changed = transitionTerminalActivity(session, next)
    assert.equal(changed, true)
    diagnostics.recordActivityTransition(session, previous, session.activity)
  }

  const failed = createSession({ startedAt: 500 })
  const previous = failed.activity
  assert.equal(
    transitionTerminalActivity(failed, { kind: 'failed', at: 600, exitCode: 1, message: 'spawn failed' }),
    true
  )
  diagnostics.recordActivityTransition(failed, previous, failed.activity)

  assert.deepEqual(
    events.map((entry) => entry.event),
    ['activity-transition', 'activity-transition', 'activity-transition', 'activity-transition']
  )
  assert.deepEqual(
    events.map((entry) => [
      entry.payload.sessionId,
      entry.payload.previousKind,
      entry.payload.nextKind,
      entry.payload.lastOutputAt,
      entry.payload.lastInputAt,
      entry.payload.exitCode,
      entry.payload.message,
    ]),
    [
      ['session_1', 'working', 'idle', 100, 125, undefined, undefined],
      ['session_1', 'idle', 'working', 100, 125, undefined, undefined],
      ['session_1', 'working', 'exited', 100, 125, 0, undefined],
      ['session_1', 'working', 'failed', 500, null, 1, 'spawn failed'],
    ]
  )
}

function assertRecentSessionsRetainExtendedReplay(): void {
  const session = createSession({ startedAt: Date.now() })
  const chunk = 'r'.repeat(TERMINAL_STANDARD_REPLAY_BYTES)

  for (let index = 0; index < 5; index += 1) {
    appendTerminalOutput(session, chunk, Date.now())
  }

  assert.equal(session.outputBytes, TERMINAL_RECENT_REPLAY_BYTES)
  assert.equal(getTerminalSnapshot(session).historyTier, 'recent')
  assert.equal(materializeTerminalReplay(session).length, TERMINAL_RECENT_REPLAY_BYTES)
}

function assertColdSessionsCompactToStandardReplay(): void {
  const coldAt = Date.now() - TERMINAL_RECENT_HISTORY_WINDOW_MS - 1_000
  const session = createSession({ startedAt: coldAt })
  const chunk = 's'.repeat(TERMINAL_STANDARD_REPLAY_BYTES)

  for (let index = 0; index < 5; index += 1) {
    appendTerminalOutput(session, chunk, coldAt)
  }

  const replay = materializeTerminalReplay(session)
  assert.equal(getTerminalSnapshot(session).historyTier, 'standard')
  assert.equal(session.outputBytes, TERMINAL_STANDARD_REPLAY_BYTES)
  assert.equal(replay.length, TERMINAL_STANDARD_REPLAY_BYTES)
}

function assertRecentInputKeepsSessionInExtendedReplayTier(): void {
  const coldAt = Date.now() - TERMINAL_RECENT_HISTORY_WINDOW_MS - 1_000
  const session = createSession({ startedAt: coldAt })
  recordTerminalInput(session, Date.now())

  appendTerminalOutput(session, 'i'.repeat(TERMINAL_RECENT_REPLAY_BYTES), coldAt)

  assert.equal(getTerminalSnapshot(session).historyTier, 'recent')
  assert.equal(session.outputBytes, TERMINAL_RECENT_REPLAY_BYTES)
}

function assertColdSingleLargeChunkIsTrimmedNotDropped(): void {
  const coldAt = Date.now() - TERMINAL_RECENT_HISTORY_WINDOW_MS - 1_000
  const session = createSession({ startedAt: coldAt })

  appendTerminalOutput(session, 'x'.repeat(TERMINAL_RECENT_REPLAY_BYTES), coldAt)

  const replay = materializeTerminalReplay(session)
  assert.equal(replay.length, TERMINAL_STANDARD_REPLAY_BYTES)
  assert.equal(session.outputBytes, TERMINAL_STANDARD_REPLAY_BYTES)
  assert.equal(replay, 'x'.repeat(TERMINAL_STANDARD_REPLAY_BYTES))
}

function assertColdSessionNewOutputUsesRecentReplayTier(): void {
  const coldAt = Date.now() - TERMINAL_RECENT_HISTORY_WINDOW_MS - 1_000
  const session = createSession({ startedAt: coldAt })

  appendTerminalOutput(session, 'n'.repeat(TERMINAL_RECENT_REPLAY_BYTES), Date.now())

  assert.equal(getTerminalSnapshot(session).historyTier, 'recent')
  assert.equal(session.outputBytes, TERMINAL_RECENT_REPLAY_BYTES)
}

function assertVisibilityRecordingUpdatesRecency(): void {
  const session = createSession({ startedAt: 100, visible: false })
  assert.equal(session.lastVisibleAt, null)

  recordTerminalVisibility(session, true, 500)
  assert.equal(session.visible, true)
  assert.equal(session.lastVisibleAt, 500)

  recordTerminalVisibility(session, false, 900)
  assert.equal(session.visible, false)
  assert.equal(session.lastVisibleAt, 900, 'hiding still records lastVisibleAt for the snapshot, even though it no longer feeds the idle clock')

  const snapshot = getTerminalSnapshot(session)
  assert.equal(snapshot.lastVisibleAt, 900)
}

function assertStaleRuleExemptsVisibleSessionsWithLiveSender(): void {
  const startedAt = 1_000
  const wellPastStale = startedAt + STALE_TERMINAL_MAX_UNSEEN_MS * 2

  const visible = createSession({ startedAt, visible: true })
  assert.equal(isTerminalSessionStale(visible, wellPastStale), false)

  const visibleButWindowGone = createSession({ startedAt, visible: true, senderDestroyed: true })
  assert.equal(isTerminalSessionStale(visibleButWindowGone, wellPastStale), true)

  const hidden = createSession({ startedAt, visible: false })
  assert.equal(isTerminalSessionStale(hidden, wellPastStale), true)

  const disposed = createSession({ startedAt, visible: false })
  disposed.isDisposed = true
  assert.equal(isTerminalSessionStale(disposed, wellPastStale), false, 'disposed sessions are already gone')
}

function assertStaleRuleUsesMostRecentUserSignal(): void {
  const startedAt = 1_000
  const session = createSession({ startedAt, visible: false })
  session.lastOutputAt = startedAt

  recordTerminalInput(session, 5_000)
  appendTerminalOutput(session, 'output', 9_000)
  // Becoming visible/hidden must NOT extend the idle clock — only real input and
  // output count, so merely looking at a terminal can never keep it alive.
  recordTerminalVisibility(session, false, 12_000)
  assert.equal(
    getTerminalLastSeenAt(session),
    9_000,
    'visibility does not count toward last-seen; the last real output (9_000) wins over the later visibility timestamp (12_000)',
  )

  assert.equal(isTerminalSessionStale(session, 9_000 + STALE_TERMINAL_MAX_UNSEEN_MS), false)
  assert.equal(isTerminalSessionStale(session, 9_000 + STALE_TERMINAL_MAX_UNSEEN_MS + 1), true)
}

// Freeze-the-view: a suspended session's pty is killed, so it reports not-alive
// (un-bolds, drops out of resident memory, is not re-reaped) while staying a
// resumable, painted session — distinct from exited/disposed.
function assertSuspendedSessionIsNotAlive(): void {
  const session = createSession({ startedAt: 1_000 })
  assert.equal(isTerminalProcessAlive(session), true)
  assert.equal(getTerminalSnapshot(session).suspended, false)

  session.suspended = true
  assert.equal(
    isTerminalProcessAlive(session),
    false,
    'a suspended session is not alive even though it has not exited or been disposed',
  )
  assert.equal(getTerminalSnapshot(session).suspended, true)
}

function createSession(input: {
  startedAt: number
  idleTimer?: ReturnType<typeof setTimeout>
  visible?: boolean
  senderDestroyed?: boolean
}): TerminalSession {
  const visible = input.visible ?? true
  return {
    sessionId: 'session_1',
    process: {
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as TerminalSession['process'],
    sender: {
      isDestroyed: () => input.senderDestroyed ?? false,
    } as TerminalSession['sender'],
    isReady: true,
    hasExited: false,
    exitedAt: null,
    isDisposed: false,
    idleTimer: input.idleTimer,
    activity: createInitialTerminalActivity(input.startedAt),
    outputChunks: [],
    outputChunkBytes: [],
    outputChunkStart: 0,
    outputBytes: 0,
    outputLength: 0,
    kind: 'agent',
    workspaceId: 'workspace_1',
    agentId: 'developer-1',
    visible,
    startedAt: input.startedAt,
    lastOutputAt: input.startedAt,
    lastInputAt: null,
    lastVisibleAt: visible ? input.startedAt : null,
  }
}
