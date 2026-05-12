import assert from 'node:assert/strict'
import type { TerminalSessionSnapshot } from '../../../shared/electron-api'
import {
  deriveWorkspaceDisplayActivity,
  deriveWorkspaceLastOutputAt,
  deriveWorkspaceTerminalActivity,
  describeExecutionTerminal,
  findLiveSession,
  isLiveTerminal,
  pickAgentTabRecency,
  pickTerminalTabRecency,
  tabRecencyLabel,
} from './useTerminalSessions'

void main()

async function main(): Promise<void> {
  assertProcessAliveHelpersUseLivenessOnly()
  assertWorkspaceDisplayActivityPriority()
  assertWorkspaceTerminalActivityPriorityAndPersistedRecency()
  assertTerminalTabRecencyPrefersLastOutputAt()
  assertAgentTabRecencyFallbackChain()
  await assertStaleLaunchFlagsClearWithoutLosingRecency()
}

function assertProcessAliveHelpersUseLivenessOnly(): void {
  const exitedWorking = session({
    sessionId: 'session_exited_working',
    processAlive: false,
    activity: { kind: 'working', since: 10 },
  })
  const liveIdle = session({
    sessionId: 'session_live_idle',
    processAlive: true,
    activity: { kind: 'idle', since: 20 },
  })

  assert.equal(isLiveTerminal(exitedWorking), false)
  assert.equal(isLiveTerminal(liveIdle), true)
  assert.equal(findLiveSession([exitedWorking, liveIdle], () => true)?.sessionId, 'session_live_idle')
  assert.deepEqual(
    describeExecutionTerminal([liveIdle], 'workspace_1', 'exec_1'),
    { kind: 'running', sessionId: 'session_live_idle', agentId: 'developer-1' }
  )
}

function assertWorkspaceDisplayActivityPriority(): void {
  const sessions = [
    session({
      sessionId: 'session_working',
      activity: { kind: 'working', since: 100 },
    }),
    session({
      sessionId: 'session_failed',
      activity: { kind: 'failed', at: 200, exitCode: 1 },
    }),
  ]

  assert.equal(deriveWorkspaceDisplayActivity('workspace_1', sessions, true), 'needs-input')
  assert.equal(deriveWorkspaceDisplayActivity('workspace_1', sessions, false), 'working')
  assert.equal(
    deriveWorkspaceDisplayActivity('workspace_1', [sessions[1]], false),
    'failed'
  )
  assert.equal(
    deriveWorkspaceDisplayActivity('workspace_1', [
      session({ sessionId: 'session_idle', activity: { kind: 'idle', since: 300 } }),
    ], false),
    'idle'
  )
}

function assertWorkspaceTerminalActivityPriorityAndPersistedRecency(): void {
  const failedOlder = session({
    sessionId: 'session_failed_old',
    activity: { kind: 'failed', at: 200, exitCode: 1, message: 'old failure' },
  })
  const failedNewer = session({
    sessionId: 'session_failed_new',
    activity: { kind: 'failed', at: 300, exitCode: 2, message: 'new failure' },
  })
  const idle = session({
    sessionId: 'session_idle',
    activity: { kind: 'idle', since: 400 },
    lastOutputAt: 450,
  })

  assert.deepEqual(
    deriveWorkspaceTerminalActivity('workspace_1', [failedOlder, failedNewer, idle], 500),
    { kind: 'failed', at: 300, exitCode: 2, message: 'new failure' }
  )
  assert.deepEqual(
    deriveWorkspaceTerminalActivity('workspace_1', [idle], 500),
    { kind: 'idle-recency', lastOutputAt: 500 }
  )
  assert.equal(deriveWorkspaceLastOutputAt('workspace_1', [idle], 425), 450)
  assert.deepEqual(
    deriveWorkspaceTerminalActivity('workspace_1', [], 500),
    { kind: 'idle-recency', lastOutputAt: 500 }
  )
  assert.deepEqual(
    deriveWorkspaceTerminalActivity('workspace_1', [], null),
    { kind: 'quiet' }
  )
}

function assertTerminalTabRecencyPrefersLastOutputAt(): void {
  const exitedWithOlderOutput = session({
    sessionId: 'session_exited_with_output',
    processAlive: false,
    activity: { kind: 'exited', at: 5_000, exitCode: 0 },
    lastOutputAt: 1_000,
    exitedAt: 5_000,
  })
  const exitedRecency = pickTerminalTabRecency(exitedWithOlderOutput)
  assert.deepEqual(exitedRecency, { at: 1_000, source: 'output' })
  assert.equal(tabRecencyLabel(exitedRecency!.source), 'Last output')

  const exitedWithoutOutput = session({
    sessionId: 'session_exited_no_output',
    processAlive: false,
    activity: { kind: 'exited', at: 7_000, exitCode: 0 },
    lastOutputAt: null,
    exitedAt: 7_000,
  })
  assert.deepEqual(pickTerminalTabRecency(exitedWithoutOutput), { at: 7_000, source: 'exited' })

  const liveIdleWithOutput = session({
    sessionId: 'session_live_idle',
    processAlive: true,
    activity: { kind: 'idle', since: 2_500 },
    lastOutputAt: 2_400,
  })
  assert.deepEqual(pickTerminalTabRecency(liveIdleWithOutput), { at: 2_400, source: 'output' })

  const blankSession = session({
    sessionId: 'session_blank',
    processAlive: true,
    activity: { kind: 'idle', since: 0 },
    lastOutputAt: null,
    exitedAt: null,
  })
  assert.equal(pickTerminalTabRecency(blankSession), null)
  assert.equal(pickTerminalTabRecency(null), null)
  assert.equal(pickTerminalTabRecency(undefined), null)
}

function assertAgentTabRecencyFallbackChain(): void {
  const liveAgent = session({
    sessionId: 'session_live_agent',
    processAlive: true,
    activity: { kind: 'idle', since: 8_000 },
    lastOutputAt: 7_950,
    exitedAt: null,
  })
  assert.deepEqual(
    pickAgentTabRecency(liveAgent, 6_000, 5_000),
    { at: 7_950, source: 'output' }
  )

  const exitedAgent = session({
    sessionId: 'session_exited_agent',
    processAlive: false,
    activity: { kind: 'exited', at: 9_000, exitCode: 0 },
    lastOutputAt: 4_000,
    exitedAt: 9_000,
  })
  assert.deepEqual(
    pickAgentTabRecency(exitedAgent, null, null),
    { at: 4_000, source: 'output' }
  )

  const exitedAgentMissingOutput = session({
    sessionId: 'session_exited_no_output',
    processAlive: false,
    activity: { kind: 'exited', at: 9_500, exitCode: 0 },
    lastOutputAt: null,
    exitedAt: 9_500,
  })
  assert.deepEqual(
    pickAgentTabRecency(exitedAgentMissingOutput, null, null),
    { at: 9_500, source: 'exited' }
  )

  assert.deepEqual(
    pickAgentTabRecency(null, 6_000, 5_000),
    { at: 6_000, source: 'persisted' }
  )

  assert.deepEqual(
    pickAgentTabRecency(null, null, 5_000),
    { at: 5_000, source: 'exited' }
  )

  assert.equal(pickAgentTabRecency(null, null, null), null)
  assert.equal(tabRecencyLabel('persisted'), 'Last terminal activity')
  assert.equal(tabRecencyLabel('exited'), 'Exited')
}

async function assertStaleLaunchFlagsClearWithoutLosingRecency(): Promise<void> {
  installTestLocalStorage()
  const { useWorkspaceStore } = await import('../store/workspaceStore')
  const previousState = useWorkspaceStore.getState()
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'workspace_1',
        agents: {
          'developer-1': {
            cliStartRequested: true,
            cliHasLaunched: true,
            cliSessionId: 'session_stale',
          },
          'developer-2': {
            cliStartRequested: true,
            cliHasLaunched: true,
            cliSessionId: 'session_live',
          },
        },
        lastTerminalActivityAt: 1_000,
      },
    ],
  } as never)

  useWorkspaceStore.getState().reconcileWorkspaceAgentLaunchFlags([
    session({
      sessionId: 'session_live',
      agentId: 'developer-2',
      processAlive: true,
    }),
  ])

  const workspace = useWorkspaceStore.getState().workspaces[0]
  assert.equal(workspace.lastTerminalActivityAt, 1_000)
  assert.equal(workspace.agents['developer-1'].cliStartRequested, false)
  assert.equal(workspace.agents['developer-1'].cliHasLaunched, false)
  assert.equal(workspace.agents['developer-1'].cliSessionId, undefined)
  assert.equal(workspace.agents['developer-2'].cliStartRequested, true)
  assert.equal(workspace.agents['developer-2'].cliHasLaunched, true)
  assert.equal(workspace.agents['developer-2'].cliSessionId, 'session_live')

  useWorkspaceStore.setState({
    workspaces: previousState.workspaces,
    activeWorkspaceId: previousState.activeWorkspaceId,
  })
}

function session(
  input: Partial<TerminalSessionSnapshot> & { sessionId: string }
): TerminalSessionSnapshot {
  return {
    sessionId: input.sessionId,
    processAlive: input.processAlive ?? true,
    kind: input.kind ?? 'agent',
    workspaceId: input.workspaceId ?? 'workspace_1',
    agentId: input.agentId ?? 'developer-1',
    visible: input.visible ?? true,
    startedAt: input.startedAt ?? 0,
    lastOutputAt: input.lastOutputAt ?? null,
    lastInputAt: input.lastInputAt ?? null,
    activity: input.activity ?? { kind: 'idle', since: 0 },
    exitedAt: input.exitedAt ?? null,
    outputBufferLength: input.outputBufferLength ?? 0,
    retainedOutputBytes: input.retainedOutputBytes ?? 0,
    agentSession: input.agentSession ?? {
      sessionId: input.sessionId,
      executionId: 'exec_1',
      system: 'sprintengine',
      workspaceId: input.workspaceId ?? 'workspace_1',
      workspaceRoot: '/workspace',
      workId: 'work_1',
      role: 'developer',
      displayName: 'Developer',
    },
  }
}

function installTestLocalStorage(): void {
  const storage = new Map<string, string>()
  const localStorage = {
    get length() {
      return storage.size
    },
    clear: () => {
      storage.clear()
    },
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => [...storage.keys()][index] ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
    removeItem: (key: string) => {
      storage.delete(key)
    },
  }
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
  })
}
