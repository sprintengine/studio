import assert from 'node:assert/strict'
import type { TerminalSessionSnapshot } from '../../../shared/electron-api'
import {
  deriveWorkspaceDisplayActivity,
  deriveWorkspaceLastInputAt,
  deriveWorkspaceTerminalActivity,
  describeExecutionTerminal,
  findLiveSession,
  getTerminalSessionsSignature,
  isLiveTerminal,
  pickAgentTabRecency,
  pickTerminalTabRecency,
  tabRecencyLabel,
} from './useTerminalSessions'
import { createTerminalSessionsStore } from './terminalSessionsStore'

void main()

async function main(): Promise<void> {
  assertProcessAliveHelpersUseLivenessOnly()
  assertSignatureIgnoresOutputTimingButTracksActivity()
  assertWorkspaceDisplayActivityPriority()
  assertWorkspaceTerminalActivityPriorityAndPersistedRecency()
  assertTerminalTabRecencyPrefersLastInputAt()
  assertAgentTabRecencyFallbackChain()
  await assertSharedStoreUsesOneUnderlyingSubscription()
  await assertSharedStoreDedupsSemanticUpdatesButKeepsLive()
  await assertSharedStoreHandlesDuplicateSubscriberCallbacks()
  await assertSharedStoreIgnoresDisconnectedInitialRefresh()
  await assertStaleLaunchFlagsClearWithoutLosingRecency()
  await assertClaudeSessionIdentitySurvivesStartupReconciliation()
  await assertClaudeCodeSessionIdentitySurvivesStartupReconciliation()
}

// The hook dedupes broadcasts by this signature: a snapshot that only bumps
// lastOutputAt must be considered unchanged (no re-render), while an activity or
// lifecycle change must produce a different signature (re-render).
function assertSignatureIgnoresOutputTimingButTracksActivity(): void {
  const base = [
    session({ sessionId: 'a', activity: { kind: 'working', since: 1 }, lastOutputAt: 100 }),
    session({ sessionId: 'b', activity: { kind: 'idle', since: 2 }, lastOutputAt: 200 }),
  ]
  // Same sessions, only lastOutputAt advanced -> identical signature.
  const outputOnly = [
    session({ sessionId: 'a', activity: { kind: 'working', since: 1 }, lastOutputAt: 999 }),
    session({ sessionId: 'b', activity: { kind: 'idle', since: 2 }, lastOutputAt: 888 }),
  ]
  assert.equal(getTerminalSessionsSignature(base), getTerminalSessionsSignature(outputOnly))

  // Order-independent: the signature sorts by sessionId first.
  assert.equal(
    getTerminalSessionsSignature(base),
    getTerminalSessionsSignature([base[1], base[0]])
  )

  // An activity-kind transition changes the signature.
  const activityChanged = [
    session({ sessionId: 'a', activity: { kind: 'idle', since: 1 }, lastOutputAt: 100 }),
    session({ sessionId: 'b', activity: { kind: 'idle', since: 2 }, lastOutputAt: 200 }),
  ]
  assert.notEqual(getTerminalSessionsSignature(base), getTerminalSessionsSignature(activityChanged))

  // Same activity kind but different activity payload still matters to normal UI
  // that renders failed/working timing and details.
  const activityDetailChanged = [
    session({ sessionId: 'a', activity: { kind: 'working', since: 9 }, lastOutputAt: 100 }),
    session({ sessionId: 'b', activity: { kind: 'idle', since: 2 }, lastOutputAt: 200 }),
  ]
  assert.notEqual(getTerminalSessionsSignature(base), getTerminalSessionsSignature(activityDetailChanged))

  // A lifecycle change (process death) changes the signature.
  const exited = [
    session({ sessionId: 'a', processAlive: false, activity: { kind: 'working', since: 1 } }),
    session({ sessionId: 'b', activity: { kind: 'idle', since: 2 } }),
  ]
  assert.notEqual(getTerminalSessionsSignature(base), getTerminalSessionsSignature(exited))

  // Execution identity is how Switchboard/Sprint Engine panels connect a running
  // task to its terminal.
  const executionChanged = [
    session({
      sessionId: 'a',
      activity: { kind: 'working', since: 1 },
      lastOutputAt: 100,
      agentSession: {
        ...base[0].agentSession!,
        executionId: 'exec_2',
      },
    }),
    session({ sessionId: 'b', activity: { kind: 'idle', since: 2 }, lastOutputAt: 200 }),
  ]
  assert.notEqual(getTerminalSessionsSignature(base), getTerminalSessionsSignature(executionChanged))
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
    // Recency keys off lastInputAt (last typed), not lastOutputAt; the high
    // lastOutputAt must be ignored so revealing a workspace never reads as "now".
    lastInputAt: 450,
    lastOutputAt: 9_999,
  })

  assert.deepEqual(
    deriveWorkspaceTerminalActivity('workspace_1', [failedOlder, failedNewer, idle], 500),
    { kind: 'failed', at: 300, exitCode: 2, message: 'new failure' }
  )
  assert.deepEqual(
    deriveWorkspaceTerminalActivity('workspace_1', [idle], 500),
    { kind: 'idle-recency', lastInputAt: 500 }
  )
  assert.equal(deriveWorkspaceLastInputAt('workspace_1', [idle], 425), 450)
  assert.deepEqual(
    deriveWorkspaceTerminalActivity('workspace_1', [], 500),
    { kind: 'idle-recency', lastInputAt: 500 }
  )
  assert.deepEqual(
    deriveWorkspaceTerminalActivity('workspace_1', [], null),
    { kind: 'quiet' }
  )
}

function assertTerminalTabRecencyPrefersLastInputAt(): void {
  const exitedWithOlderInput = session({
    sessionId: 'session_exited_with_input',
    processAlive: false,
    activity: { kind: 'exited', at: 5_000, exitCode: 0 },
    // A high lastOutputAt must not win: recency is "last typed", from lastInputAt.
    lastInputAt: 1_000,
    lastOutputAt: 9_999,
    exitedAt: 5_000,
  })
  const exitedRecency = pickTerminalTabRecency(exitedWithOlderInput)
  assert.deepEqual(exitedRecency, { at: 1_000, source: 'input' })
  assert.equal(tabRecencyLabel(exitedRecency!.source), 'Last typed')

  const exitedWithoutInput = session({
    sessionId: 'session_exited_no_input',
    processAlive: false,
    activity: { kind: 'exited', at: 7_000, exitCode: 0 },
    lastInputAt: null,
    lastOutputAt: 6_500,
    exitedAt: 7_000,
  })
  assert.deepEqual(pickTerminalTabRecency(exitedWithoutInput), { at: 7_000, source: 'exited' })

  const liveIdleWithInput = session({
    sessionId: 'session_live_idle',
    processAlive: true,
    activity: { kind: 'idle', since: 2_500 },
    lastInputAt: 2_400,
  })
  assert.deepEqual(pickTerminalTabRecency(liveIdleWithInput), { at: 2_400, source: 'input' })

  const blankSession = session({
    sessionId: 'session_blank',
    processAlive: true,
    activity: { kind: 'idle', since: 0 },
    lastInputAt: null,
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
    // High lastOutputAt is ignored; recency comes from lastInputAt (last typed).
    lastInputAt: 7_950,
    lastOutputAt: 9_999,
    exitedAt: null,
  })
  assert.deepEqual(
    pickAgentTabRecency(liveAgent, 6_000, 5_000),
    { at: 7_950, source: 'input' }
  )

  const exitedAgent = session({
    sessionId: 'session_exited_agent',
    processAlive: false,
    activity: { kind: 'exited', at: 9_000, exitCode: 0 },
    lastInputAt: 4_000,
    exitedAt: 9_000,
  })
  assert.deepEqual(
    pickAgentTabRecency(exitedAgent, null, null),
    { at: 4_000, source: 'input' }
  )

  const exitedAgentMissingInput = session({
    sessionId: 'session_exited_no_input',
    processAlive: false,
    activity: { kind: 'exited', at: 9_500, exitCode: 0 },
    lastInputAt: null,
    lastOutputAt: 8_000,
    exitedAt: 9_500,
  })
  assert.deepEqual(
    pickAgentTabRecency(exitedAgentMissingInput, null, null),
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
  assert.equal(tabRecencyLabel('persisted'), 'Last activity')
  assert.equal(tabRecencyLabel('exited'), 'Exited')
}

async function assertSharedStoreUsesOneUnderlyingSubscription(): Promise<void> {
  const ipcListeners = new Set<(sessions: TerminalSessionSnapshot[]) => void>()
  let terminalListCalls = 0
  let unsubscribeCalls = 0
  const store = createTerminalSessionsStore(() => ({
    terminalList: async () => {
      terminalListCalls += 1
      return [session({ sessionId: 'session_initial' })]
    },
    onTerminalSessionsChanged: (listener) => {
      ipcListeners.add(listener)
      return () => {
        unsubscribeCalls += 1
        ipcListeners.delete(listener)
      }
    },
  }))

  const unsubscribers = Array.from({ length: 12 }, () => store.subscribeSemantic(() => undefined))
  assert.equal(ipcListeners.size, 1, 'many semantic subscribers must share one IPC listener')
  await flushPromises()
  assert.equal(terminalListCalls, 1, 'shared store performs one initial terminalList refresh')
  assert.deepEqual(store.getSemanticSnapshot().map((item) => item.sessionId), ['session_initial'])

  await store.refresh()
  assert.equal(ipcListeners.size, 1, 'manual refresh must not add another IPC listener')

  unsubscribers.forEach((unsubscribe) => unsubscribe())
  assert.equal(ipcListeners.size, 0, 'last unsubscribe removes the shared IPC listener')
  assert.equal(unsubscribeCalls, 1)
}

async function assertSharedStoreDedupsSemanticUpdatesButKeepsLive(): Promise<void> {
  let ipcListener: ((sessions: TerminalSessionSnapshot[]) => void) | null =
    null as ((sessions: TerminalSessionSnapshot[]) => void) | null
  const store = createTerminalSessionsStore(() => ({
    terminalList: async () => [
      session({ sessionId: 'session_a', activity: { kind: 'idle', since: 1 }, lastOutputAt: 100 }),
    ],
    onTerminalSessionsChanged: (listener) => {
      ipcListener = listener
      return () => {
        ipcListener = null
      }
    },
  }))
  let semanticNotifications = 0
  let liveNotifications = 0
  const liveSnapshots: TerminalSessionSnapshot[][] = []

  const unsubscribeSemantic = store.subscribeSemantic(() => {
    semanticNotifications += 1
  })
  const unsubscribeLive = store.subscribeLive(() => {
    liveNotifications += 1
  })
  const unsubscribeLiveSnapshot = store.subscribeLiveSnapshot((sessions) => {
    liveSnapshots.push(sessions)
  })
  await flushPromises()
  assert.equal(semanticNotifications, 1)
  assert.equal(liveNotifications, 1)
  assert.equal(liveSnapshots.length, 1)

  semanticNotifications = 0
  liveNotifications = 0
  liveSnapshots.length = 0
  ipcListener?.([
    session({ sessionId: 'session_a', activity: { kind: 'idle', since: 1 }, lastOutputAt: 999 }),
  ])
  assert.equal(semanticNotifications, 0, 'semantic subscribers skip output-only churn')
  assert.equal(liveNotifications, 1, 'live subscribers receive output-only churn')
  assert.equal(liveSnapshots[0]?.[0]?.lastOutputAt, 999)

  ipcListener?.([
    session({ sessionId: 'session_a', activity: { kind: 'working', since: 2 }, lastOutputAt: 1000 }),
  ])
  assert.equal(semanticNotifications, 1, 'semantic subscribers receive lifecycle/activity changes')
  assert.equal(liveNotifications, 2)

  unsubscribeSemantic()
  unsubscribeLive()
  unsubscribeLiveSnapshot()
}

async function assertSharedStoreHandlesDuplicateSubscriberCallbacks(): Promise<void> {
  let ipcListener: ((sessions: TerminalSessionSnapshot[]) => void) | null =
    null as ((sessions: TerminalSessionSnapshot[]) => void) | null
  let unsubscribeCalls = 0
  const store = createTerminalSessionsStore(() => ({
    terminalList: async () => [],
    onTerminalSessionsChanged: (listener) => {
      ipcListener = listener
      return () => {
        unsubscribeCalls += 1
        ipcListener = null
      }
    },
  }))
  let calls = 0
  const listener = () => {
    calls += 1
  }
  const unsubscribeFirst = store.subscribeSemantic(listener)
  const unsubscribeSecond = store.subscribeSemantic(listener)
  await flushPromises()

  ipcListener?.([session({ sessionId: 'session_duplicate_a' })])
  assert.equal(calls, 2, 'the same callback subscribed twice represents two subscriptions')

  unsubscribeFirst()
  ipcListener?.([session({ sessionId: 'session_duplicate_b' })])
  assert.equal(calls, 3, 'unsubscribing one duplicate leaves the other active')
  assert.equal(unsubscribeCalls, 0)

  unsubscribeSecond()
  assert.equal(unsubscribeCalls, 1, 'underlying IPC listener is removed after the last duplicate unsubscribe')
}

async function assertSharedStoreIgnoresDisconnectedInitialRefresh(): Promise<void> {
  const pendingTerminalLists: Array<(sessions: TerminalSessionSnapshot[]) => void> = []
  const store = createTerminalSessionsStore(() => ({
    terminalList: () => new Promise<TerminalSessionSnapshot[]>((resolve) => {
      pendingTerminalLists.push(resolve)
    }),
    onTerminalSessionsChanged: () => () => undefined,
  }))

  const unsubscribeFirst = store.subscribeSemantic(() => undefined)
  const manualRefresh = store.refresh()
  unsubscribeFirst()
  pendingTerminalLists[0]?.([session({ sessionId: 'session_stale_after_disconnect' })])
  pendingTerminalLists[1]?.([session({ sessionId: 'session_manual_stale_after_disconnect' })])
  await manualRefresh
  await flushPromises()
  assert.deepEqual(
    store.getSemanticSnapshot(),
    [],
    'late initial refresh from a disconnected subscription must not repopulate the store',
  )

  const liveSnapshots: TerminalSessionSnapshot[][] = []
  const unsubscribeSecond = store.subscribeLiveSnapshot((sessions) => {
    liveSnapshots.push(sessions)
  })
  assert.deepEqual(
    liveSnapshots,
    [] as TerminalSessionSnapshot[][],
    'new subscriber must not receive stale disconnected snapshot',
  )

  pendingTerminalLists[2]?.([session({ sessionId: 'session_fresh_after_reconnect' })])
  await flushPromises()
  assert.deepEqual(liveSnapshots.map((sessions) => sessions.map((item) => item.sessionId)), [
    ['session_fresh_after_reconnect'],
  ])
  unsubscribeSecond()
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
            cli: 'unsupported-cli',
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

async function assertClaudeSessionIdentitySurvivesStartupReconciliation(): Promise<void> {
  installTestLocalStorage()
  const { useWorkspaceStore } = await import('../store/workspaceStore')
  const previousState = useWorkspaceStore.getState()
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'workspace_1',
        agents: {
          'developer-claude': {
            cli: 'claude-code',
            cliStartRequested: true,
            cliHasLaunched: true,
            cliSessionId: 'claude_original_session',
            cliResumeAvailable: true,
          },
        },
      },
    ],
  } as never)

  useWorkspaceStore.getState().reconcileWorkspaceAgentLaunchFlags([])

  const agent = useWorkspaceStore.getState().workspaces[0].agents['developer-claude']
  assert.equal(agent.cliStartRequested, true)
  assert.equal(agent.cliHasLaunched, true)
  assert.equal(agent.cliSessionId, 'claude_original_session')
  assert.equal(agent.cliResumeAvailable, true)

  useWorkspaceStore.setState({
    workspaces: previousState.workspaces,
    activeWorkspaceId: previousState.activeWorkspaceId,
  })
}

async function assertClaudeCodeSessionIdentitySurvivesStartupReconciliation(): Promise<void> {
  installTestLocalStorage()
  const { useWorkspaceStore } = await import('../store/workspaceStore')
  const previousState = useWorkspaceStore.getState()
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'workspace_1',
        agents: {
          'developer-claude-code': {
            cli: 'claude-code',
            cliStartRequested: true,
            cliHasLaunched: true,
            cliSessionId: 'claude_code_original_session',
            cliResumeAvailable: true,
          },
        },
      },
    ],
  } as never)

  useWorkspaceStore.getState().reconcileWorkspaceAgentLaunchFlags([])

  const agent = useWorkspaceStore.getState().workspaces[0].agents['developer-claude-code']
  assert.equal(agent.cliStartRequested, true)
  assert.equal(agent.cliHasLaunched, true)
  assert.equal(agent.cliSessionId, 'claude_code_original_session')
  assert.equal(agent.cliResumeAvailable, true)

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
    suspended: input.suspended ?? false,
    startedAt: input.startedAt ?? 0,
    lastOutputAt: input.lastOutputAt ?? null,
    lastInputAt: input.lastInputAt ?? null,
    lastVisibleAt: input.lastVisibleAt ?? null,
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

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
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
    value: {
      localStorage,
      location: { href: 'http://localhost/?windowId=primary' },
      addEventListener: () => {},
    },
    configurable: true,
  })
}
