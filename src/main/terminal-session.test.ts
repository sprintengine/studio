import assert from 'node:assert/strict'
import {
  appendTerminalOutput,
  createFailedTerminalSession,
  createInitialTerminalActivity,
  getTerminalSnapshot,
  markTerminalExited,
  markTerminalFailed,
  markTerminalIdle,
  markTerminalWorking,
  recordTerminalInput,
  transitionTerminalActivity,
  type TerminalSession,
} from './terminal-session'
import { createTerminalDiagnostics } from './terminal-diagnostics'

void main()

function main(): void {
  assertSpawnSnapshotStartsWorking()
  assertOutputWhileWorkingUpdatesRecencyWithoutStateTransition()
  assertSilenceAndLaterOutputTransitionBetweenIdleAndWorking()
  assertInputRecordsRecencyWithoutChangingActivity()
  assertExitAndFailureClassificationClearTimers()
  assertFailedLaunchSnapshotIsVisible()
  assertActivityTransitionDiagnostics()
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
  const changedToWorking = markTerminalWorking(session, 150)

  assert.equal(changedToWorking, false)
  assert.equal(session.lastOutputAt, 150)
  assert.deepEqual(session.activity, { kind: 'working', since: 100 })
}

function assertSilenceAndLaterOutputTransitionBetweenIdleAndWorking(): void {
  const session = createSession({ startedAt: 100 })

  assert.equal(markTerminalIdle(session, 3_200), true)
  assert.deepEqual(session.activity, { kind: 'idle', since: 3_200 })

  appendTerminalOutput(session, 'later output', 4_000)
  assert.equal(markTerminalWorking(session, 4_000), true)
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

function createSession(input: {
  startedAt: number
  idleTimer?: ReturnType<typeof setTimeout>
}): TerminalSession {
  return {
    sessionId: 'session_1',
    process: {
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as TerminalSession['process'],
    sender: {} as TerminalSession['sender'],
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
    visible: true,
    startedAt: input.startedAt,
    lastOutputAt: input.startedAt,
    lastInputAt: null,
  }
}
