import assert from 'node:assert/strict'
import {
  AUTO_RUN_ROLE_CONTINUATION_GRACE_MS,
  agentNotificationDeliveryKey,
  architectTriageMessageKey,
  artifactApprovalMessageKey,
  buildAgentNotificationPrompt,
  buildArchitectNeedsInputTriagePrompt,
  buildSprintEngineDispatchPrompt,
  buildSprintEngineContinuationPrompt,
  buildSprintEngineGateContinuationPrompt,
  continuationMessageKey,
  getActiveSprintEngineAutoRunGateClaims,
  agentOwnsOpenSprintEngineImplementationWork,
  getArchitectActionableNeedsInputTasks,
  getAutoApprovalIntentArtifacts,
  getClaimableSprintEngineAutoRunGates,
  getPendingAgentNotificationEvents,
  getSprintEngineAutoRunOccupiedAgentIds,
  isSprintEngineAutoPendingSpawnStillRelevant,
  pickNextAutoRuns,
  shouldSkipExitedSprintEngineRosterAgent,
  sprintEngineDispatchDeliveryKey,
  sprintEngineAutoRunWorkKey,
  type AutoRunCandidate,
  type RoleContinuationGrace,
} from './sprintengineAutoRun'
import { getSprintEngineStartupCommandMode } from './agentPrompt'
import { useWorkspaceStore } from '../store/workspaceStore'
import type {
  AgentCli,
  SprintEngineArtifact,
  SprintEngineEvent,
  SprintEngineQualityGate,
  SprintEngineRole,
  SprintEngineRuntimeAgent,
  SprintEngineState,
  SprintEngineTask,
  Workspace,
} from '../types/workspace'

void main()

async function main(): Promise<void> {
  testWorkKeysSeparateTaskAndGateSpawns()
  testReviewPhaseOnlyExposesReviewGates()
  testPendingGateRelevanceIsGateSpecific()
  testActiveGateClaimCanBeResumed()
  testTestingPhaseExposesTesterAfterReviewApproval()
  testKeyHelpersAreStableAndScoped()
  testPromptBuildersIncludeAgentIdAndCommand()
  testDispatchPromptUsesJoinReconciliation()
  testDispatchAndContinuationPromptsWorkForRegistryKeyedRoles()
  testGetArchitectActionableNeedsInputTasksFiltersByKind()
  testGetAutoApprovalIntentArtifactsRespectsEligibility()
  testGetPendingAgentNotificationEventsFiltersDeliveredAndSent()
  testAgentOwnsOpenSprintEngineImplementationWorkDetectsRework()
  testShouldSkipExitedSprintEngineRosterAgentAllowsOwnedReworkRestart()
  testGetSprintEngineAutoRunOccupiedAgentIdsCountsChangesRequestedOwners()
  testPickNextAutoRunsSelectsReadyTaskForIdleRoleAgent()
  testPickNextAutoRunsSkipsRetiredRoleAgent()
  testPickNextAutoRunsSkipsRetiredOwnerRework()
  testPickNextAutoRunsHonoursContinuationGraceWindow()
  testPickNextAutoRunsResumesActiveGateClaim()
  testGetSprintEngineStartupCommandModePicksInitOnlyForEmptyArchitect()
  await testListTerminalSessionsThrowsTerminalListIpcErrorOnReject()
  await testListTerminalSessionsResolvesWithSessionsOnSuccess()
  await testAutoApprovalOnlyBranchSkipsTerminalListWhenNothingToApprove()
  await testDeliverAgentNotificationsSkipsRetiredTargets()
  await testDispatchPromptDeliveryUsesDispatchIdCooldown()
  await testSpawnAutoRunCandidateStartsMissingTerminalWithJoinPrompt()
  await testSuperviseRunnerCycleDoesNotMutateTaskOrGateState()
}

function task(overrides: Partial<SprintEngineTask> = {}): SprintEngineTask {
  return {
    id: 'T3',
    title: 'Scaffold site',
    description: '',
    role: 'developer',
    status: 'review',
    ownerAgentId: 'developer-1',
    dependsOn: [],
    ownedPaths: [],
    acceptanceCriteria: [],
    implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
    notes: [],
    comments: [],
    startedAt: null,
    completedAt: null,
    boardColumn: 'review',
    qualityGates: [
      { id: 'code_reviewer', phase: 'review', role: 'code_reviewer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
      { id: 'spec_reviewer', phase: 'review', role: 'spec_reviewer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
      { id: 'tester', phase: 'testing', role: 'tester', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
    ...overrides,
  }
}

function testWorkKeysSeparateTaskAndGateSpawns(): void {
  assert.equal(sprintEngineAutoRunWorkKey({ taskId: 'T3' }), 'task:T3')
  assert.equal(sprintEngineAutoRunWorkKey({ taskId: 'T3', gateId: 'code_reviewer' }), 'gate:T3:code_reviewer')
  assert.notEqual(
    sprintEngineAutoRunWorkKey({ taskId: 'T3', gateId: 'code_reviewer' }),
    sprintEngineAutoRunWorkKey({ taskId: 'T3', gateId: 'spec_reviewer' })
  )
}

function testReviewPhaseOnlyExposesReviewGates(): void {
  const gates = getClaimableSprintEngineAutoRunGates(task(), [task()])
  assert.deepEqual(gates.map((gate) => gate.id), ['code_reviewer', 'spec_reviewer'])
}

function testPendingGateRelevanceIsGateSpecific(): void {
  const reviewTask = task()
  assert.equal(
    isSprintEngineAutoPendingSpawnStillRelevant(
      { taskId: 'T3', gateId: 'code_reviewer', agentId: 'code_reviewer' },
      reviewTask,
      [reviewTask]
    ),
    true
  )
  assert.equal(
    isSprintEngineAutoPendingSpawnStillRelevant(
      { taskId: 'T3', gateId: 'tester', agentId: 'tester-1' },
      reviewTask,
      [reviewTask]
    ),
    false
  )
}

function testActiveGateClaimCanBeResumed(): void {
  const reviewTask = task({
    qualityGates: [
      {
        id: 'code_reviewer',
        phase: 'review',
        role: 'code_reviewer',
        status: 'in_progress',
        required: true,
        allowSelfReview: true,
        focus: '',
        attempts: [{ id: 'GA-001', status: 'in_progress', role: 'code_reviewer', claimedBy: 'code_reviewer', startedAt: '2026-05-17T14:03:34Z' }],
      },
      { id: 'spec_reviewer', phase: 'review', role: 'spec_reviewer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
  })
  const claims = getActiveSprintEngineAutoRunGateClaims(reviewTask, [reviewTask])
  assert.deepEqual(claims.map((claim) => [claim.gate.id, claim.claimedBy]), [['code_reviewer', 'code_reviewer']])
}

function testTestingPhaseExposesTesterAfterReviewApproval(): void {
  const testingTask = task({
    status: 'testing',
    boardColumn: 'testing',
    qualityGates: [
      { id: 'code_reviewer', phase: 'review', role: 'code_reviewer', status: 'approved', required: true, allowSelfReview: true, focus: '', attempts: [] },
      { id: 'spec_reviewer', phase: 'review', role: 'spec_reviewer', status: 'approved', required: true, allowSelfReview: true, focus: '', attempts: [] },
      { id: 'tester', phase: 'testing', role: 'tester', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
  })
  const gates = getClaimableSprintEngineAutoRunGates(testingTask, [testingTask])
  assert.deepEqual(gates.map((gate) => gate.id), ['tester'])
}

type TerminalListMock = {
  invocations: number
  impl: () => Promise<unknown[]>
}

type TestWindowApi = {
  terminalList: () => Promise<unknown[]>
  terminalWrite?: (sessionId: string, text: string) => Promise<unknown>
  logDiagnostic: (input: unknown) => Promise<unknown>
  platform?: string
  [key: string]: unknown
}

function installTestWindow(api: TestWindowApi): void {
  const storage = new Map<string, string>()
  const localStorage = {
    get length() { return storage.size },
    clear: () => { storage.clear() },
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => [...storage.keys()][index] ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  }
  const cryptoShim = globalThis.crypto ?? {
    randomUUID: () => `test-uuid-${Math.random().toString(36).slice(2)}`,
  }
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage, api, crypto: cryptoShim },
    configurable: true,
    writable: true,
  })
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: cryptoShim, configurable: true })
  }
}

function workspaceFixture(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    name: 'Auto-run workspace',
    mode: 'sprintengine',
    folderPath: '/tmp/workspace',
    sprintEngineContext: {
      teamSlug: 'team',
      teamRoot: '/tmp/workspace/.multi-code/sprintengine/team',
      statePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    },
    templateId: 'sprintengine',
    layoutModel: { global: {}, layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { entries: [] },
    memory: { relativeRoot: '', allowedFiles: [] },
    editorState: { openFiles: [], activeFile: null },
    sprintEngineState: null,
    sprintEngineAutoState: {
      enabled: false,
      autoApproveArtifacts: true,
      keepDoneAgentTerminals: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
    multiloopAutoState: {
      enabled: false,
      maxConcurrentAgents: 3,
      pendingSpawns: [],
    },
    createdAt: 1,
    ...overrides,
  } as Workspace
}

function sprintEngineStateFixture(overrides: Partial<SprintEngineState> = {}): SprintEngineState {
  return {
    name: 'team',
    goal: '',
    roleCounts: {} as SprintEngineState['roleCounts'],
    sprintEngineAgents: {},
    events: [],
    tasks: [],
    artifacts: [],
    ...overrides,
  } as SprintEngineState
}

function mutableRef<T>(initial: T): { current: T } {
  return { current: initial }
}

function installWorkspaceStore(workspace: Workspace): void {
  useWorkspaceStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  })
}

function makeTerminalListMock(impl: () => Promise<unknown[]>): TerminalListMock {
  const mock: TerminalListMock = { invocations: 0, impl }
  return mock
}

async function loadSupervisor(): Promise<typeof import('../components/workspace/SprintEngineAutoRunSupervisor')> {
  // The supervisor module reads window.api and uses crypto.randomUUID at evaluation paths
  // that the supervisor's React effect would normally drive. Tests install a stub window
  // and dynamically import the module so the store/notification singletons resolve.
  return await import('../components/workspace/SprintEngineAutoRunSupervisor')
}

async function testListTerminalSessionsThrowsTerminalListIpcErrorOnReject(): Promise<void> {
  const mock = makeTerminalListMock(() => Promise.reject(new Error('IPC channel closed')))
  installTestWindow({
    terminalList: async () => {
      mock.invocations += 1
      return mock.impl()
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  let raised: unknown = null
  try {
    await supervisor.listTerminalSessionsForAutoRun(workspaceFixture(), 'unit-test:reject')
  } catch (error) {
    raised = error
  }

  assert.ok(
    raised instanceof supervisor.TerminalListIpcError,
    'listTerminalSessionsForAutoRun must throw TerminalListIpcError on IPC reject'
  )
  const error = raised as InstanceType<typeof supervisor.TerminalListIpcError>
  assert.equal(error.workspaceId, 'workspace-1')
  assert.equal(error.workspaceName, 'Auto-run workspace')
  assert.equal(error.intent, 'unit-test:reject')
  assert.ok(error.cause instanceof Error)
  assert.equal((error.cause as Error).message, 'IPC channel closed')
  assert.equal(mock.invocations, 1, 'terminalList should have been called once before rejecting')
}

async function testListTerminalSessionsResolvesWithSessionsOnSuccess(): Promise<void> {
  const fakeSessions = [
    { sessionId: 's1', processAlive: true, kind: 'agent', agentId: 'developer-1' },
    { sessionId: 's2', processAlive: false, kind: 'terminal' },
  ]
  const mock = makeTerminalListMock(() => Promise.resolve(fakeSessions))
  installTestWindow({
    terminalList: async () => {
      mock.invocations += 1
      return mock.impl()
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const sessions = await supervisor.listTerminalSessionsForAutoRun(workspaceFixture(), 'unit-test:resolve')
  assert.equal(mock.invocations, 1)
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].sessionId, 's1')
}

async function testAutoApprovalOnlyBranchSkipsTerminalListWhenNothingToApprove(): Promise<void> {
  const terminalListMock = makeTerminalListMock(() => {
    throw new Error('terminalList must not be called when there are no eligible artifacts')
  })
  let diagnosticCount = 0
  installTestWindow({
    terminalList: async () => {
      terminalListMock.invocations += 1
      return terminalListMock.impl()
    },
    logDiagnostic: async (input) => {
      diagnosticCount += 1
      return input
    },
  })

  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    sprintEngineAutoState: {
      enabled: false,
      autoApproveArtifacts: true,
      keepDoneAgentTerminals: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
  })
  const sprintEngineState = sprintEngineStateFixture({
    artifacts: [] as SprintEngineArtifact[],
  })

  const result = await supervisor.sendApprovalToNextEligibleArtifactProducer(
    workspace,
    sprintEngineState,
    mutableRef(new Map<string, number>()),
    mutableRef(new Map<string, number>())
  )

  assert.equal(result, 'none', 'auto-approval should return none when nothing is eligible')
  assert.equal(
    terminalListMock.invocations,
    0,
    'auto-approval-only branch must not query terminalList when no artifact needs approval'
  )
  void diagnosticCount
}

async function testDeliverAgentNotificationsSkipsRetiredTargets(): Promise<void> {
  const terminalListMock = makeTerminalListMock(() => {
    throw new Error('terminalList must not be called for retired notification targets')
  })
  installTestWindow({
    terminalList: async () => {
      terminalListMock.invocations += 1
      return terminalListMock.impl()
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const sentNotifications = mutableRef(new Set<string>())
  const workspace = workspaceFixture({
    sprintEngineAutoState: {
      enabled: true,
      autoApproveArtifacts: false,
      keepDoneAgentTerminals: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
  })
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'retired' }),
    },
    events: [{
      id: 'EV-retired',
      timestamp: '2026-05-19T00:00:00Z',
      type: 'agent_notification_requested',
      actor: 'system',
      message: 'Task reopened.',
      targetAgentId: 'developer-1',
      taskId: 'T-rework',
      notificationKind: 'task_resume_requested',
    }],
  })
  const retiredEvent = state.events[0]
  const deliveryKey = agentNotificationDeliveryKey(workspace, retiredEvent)

  const result = await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set<string>(),
    {},
    {},
    mutableRef(new Set<string>()),
    sentNotifications
  )

  assert.equal(result, 'none')
  assert.equal(terminalListMock.invocations, 0, 'retired notification targets are skipped before terminal lookup')
  assert.equal(sentNotifications.current.has(deliveryKey), true, 'retired notification skip is recorded for this supervisor cycle')
}

async function testDispatchPromptDeliveryUsesDispatchIdCooldown(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  const mutations: string[] = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend-3',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
      },
    ],
    terminalWrite: async (sessionId, text) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    readySprintEngineTask: async () => {
      mutations.push('readySprintEngineTask')
      return { ok: true }
    },
    updateSprintEngineTask: async () => {
      mutations.push('updateSprintEngineTask')
      return { ok: true }
    },
    createSprintEngineTask: async () => {
      mutations.push('createSprintEngineTask')
      return { ok: true }
    },
    commentSprintEngineTask: async () => {
      mutations.push('commentSprintEngineTask')
      return { ok: true }
    },
    approveSprintEngineArtifact: async () => {
      mutations.push('approveSprintEngineArtifact')
      return { ok: true }
    },
    autoApproveSprintEngineArtifact: async () => {
      mutations.push('autoApproveSprintEngineArtifact')
      return { ok: true }
    },
    requestSprintEngineArtifactChanges: async () => {
      mutations.push('requestSprintEngineArtifactChanges')
      return { ok: true }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const sent = mutableRef(new Map<string, { sentAt: number }>())
  const workspace = workspaceFixture({
    agents: {
      'frontend-3': {
        id: 'frontend-3',
        name: 'Reagan',
        role: 'frontend',
        cli: 'codex',
        kind: 'sprintengine',
      },
    } as Workspace['agents'],
  })
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-3': runtimeAgent('frontend', {
        status: 'running',
        currentTaskId: 'T4',
        currentDispatch: {
          dispatchId: 'DISP-6ed51f5daa40b4bd',
          targetKind: 'task',
          role: 'frontend',
          taskId: 'T4',
          reason: 'task_claimed',
        },
      }),
    },
  })

  await supervisor.sendDispatchPromptsToRunningAgents(
    workspace,
    state,
    new Set(['frontend-3']),
    sent
  )
  await supervisor.sendDispatchPromptsToRunningAgents(
    workspace,
    state,
    new Set(['frontend-3']),
    sent
  )

  assert.equal(writes.length, 1, 'duplicate dispatch observations are suppressed inside the retry cooldown')
  assert.equal(writes[0].sessionId, 'session-frontend')
  assert.ok(writes[0].text.includes('\x1b[200~'), 'existing terminal receives bracketed paste')
  assert.ok(writes[0].text.includes('Dispatch: DISP-6ed51f5daa40b4bd'))
  assert.ok(writes[0].text.includes('sprintengine join --role frontend --id frontend-3 --watch'))
  assert.deepEqual(mutations, [], 'dispatch prompt delivery must not call task/gate/artifact mutation IPC')
}

async function testSpawnAutoRunCandidateStartsMissingTerminalWithJoinPrompt(): Promise<void> {
  const spawns: Array<{
    sessionId: string
    cwd?: string
    statePath?: string
    cli?: AgentCli
    initialPrompt?: string
    metadata?: { agentSession?: { workId?: string; role?: string }; visible?: boolean }
  }> = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (
      sessionId: string,
      _cols: number,
      _rows: number,
      cwd?: string,
      _resume?: boolean,
      statePath?: string,
      cli?: AgentCli,
      initialPrompt?: string,
      _cliRuntimes?: unknown,
      _shellOnly?: boolean,
      metadata?: { agentSession?: { workId?: string; role?: string }; visible?: boolean },
    ) => {
      spawns.push({ sessionId, cwd, statePath, cli, initialPrompt, metadata })
      return { ok: true, sessionId }
    },
    logDiagnostic: async (input) => input,
    readySprintEngineTask: async () => {
      throw new Error('renderer must not ready Sprint Engine tasks while spawning')
    },
    updateSprintEngineTask: async () => {
      throw new Error('renderer must not update Sprint Engine tasks while spawning')
    },
    createSprintEngineTask: async () => {
      throw new Error('renderer must not create Sprint Engine tasks while spawning')
    },
    commentSprintEngineTask: async () => {
      throw new Error('renderer must not comment Sprint Engine tasks while spawning')
    },
  })

  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    agents: {
      'code_reviewer': {
        id: 'code_reviewer',
        name: 'Code Reviewer',
        role: 'code_reviewer',
        cli: 'codex',
        kind: 'sprintengine',
      },
    } as Workspace['agents'],
    sprintEngineAutoState: {
      enabled: true,
      autoApproveArtifacts: false,
      keepDoneAgentTerminals: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
  })
  const state = sprintEngineStateFixture({
    goal: 'Ship registry-driven runtime renderer integration',
    sprintEngineAgents: {
      'code_reviewer': runtimeAgent('code_reviewer'),
    },
  })
  installWorkspaceStore({ ...workspace, sprintEngineState: state })

  const result = await supervisor.spawnAutoRunCandidate(
    workspace,
    state,
    {
      agentId: 'code_reviewer',
      label: 'Code Reviewer',
      role: 'code_reviewer',
      taskId: 'T4',
      gateId: 'code_reviewer',
    },
    { codex: { command: 'codex', useWsl: false }, claude: { command: 'claude', useWsl: false } },
    {},
    mutableRef(new Set<string>()),
  )

  assert.equal(result, 'started')
  assert.equal(spawns.length, 1, 'missing terminal spawn path calls terminalSpawn once')
  assert.equal(spawns[0].cwd, '/tmp/workspace')
  assert.equal(spawns[0].statePath, '/tmp/workspace/.multi-code/sprintengine/team/run.yaml')
  assert.equal(spawns[0].cli, 'codex')
  assert.equal(spawns[0].metadata?.agentSession?.workId, 'T4')
  assert.equal(spawns[0].metadata?.agentSession?.role, 'code_reviewer')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine join --role code_reviewer --id code_reviewer --watch'))
  assert.ok(spawns[0].initialPrompt?.includes('CLI owns polling'))
}

async function testSuperviseRunnerCycleDoesNotMutateTaskOrGateState(): Promise<void> {
  const mutations: string[] = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (sessionId: string) => ({ ok: true, sessionId }),
    logDiagnostic: async (input) => input,
    readySprintEngineTask: async () => {
      mutations.push('readySprintEngineTask')
      return { ok: true }
    },
    updateSprintEngineTask: async () => {
      mutations.push('updateSprintEngineTask')
      return { ok: true }
    },
    createSprintEngineTask: async () => {
      mutations.push('createSprintEngineTask')
      return { ok: true }
    },
    commentSprintEngineTask: async () => {
      mutations.push('commentSprintEngineTask')
      return { ok: true }
    },
    approveSprintEngineArtifact: async () => {
      mutations.push('approveSprintEngineArtifact')
      return { ok: true }
    },
    autoApproveSprintEngineArtifact: async () => {
      mutations.push('autoApproveSprintEngineArtifact')
      return { ok: true }
    },
    requestSprintEngineArtifactChanges: async () => {
      mutations.push('requestSprintEngineArtifactChanges')
      return { ok: true }
    },
  })

  const supervisor = await loadSupervisor()
  const reviewTask = task({
    id: 'T-review',
    status: 'review',
    boardColumn: 'review',
    role: 'developer',
    ownerAgentId: 'developer-1',
    qualityGates: [
      { id: 'code_reviewer', phase: 'review', role: 'code_reviewer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
  })
  const state = sprintEngineStateFixture({
    roleCounts: { code_reviewer: 1 } as SprintEngineState['roleCounts'],
    sprintEngineAgents: {
      'code_reviewer': runtimeAgent('code_reviewer'),
    },
    tasks: [reviewTask],
  })
  const workspace = workspaceFixture({
    sprintEngineState: state,
    agents: {
      'code_reviewer': {
        id: 'code_reviewer',
        name: 'Code Reviewer',
        role: 'code_reviewer',
        cli: 'codex',
        kind: 'sprintengine',
      },
    } as Workspace['agents'],
    sprintEngineAutoState: {
      enabled: true,
      autoApproveArtifacts: false,
      keepDoneAgentTerminals: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState: state,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: { codex: { command: 'codex', useWsl: false }, claude: { command: 'claude', useWsl: false } },
    mcpSettings: {},
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    continuationGraceByTask: mutableRef(new Map()),
  })

  assert.deepEqual(mutations, [], 'auto-run dispatch/gate paths must not call renderer task/gate mutation APIs')
}

function testKeyHelpersAreStableAndScoped(): void {
  const workspace = workspaceFixture()
  const artifact: SprintEngineArtifact = {
    id: 'AR-001',
    taskId: 'T3',
    kind: 'design_notes',
    title: 'Notes',
    status: 'ready_for_review',
    path: 'docs/notes.md',
    createdBy: 'frontend',
    createdAt: '2026-05-18T00:00:00Z',
    fingerprint: 'abc',
    updatedAt: '2026-05-18T00:00:01Z',
  } as SprintEngineArtifact

  assert.equal(
    artifactApprovalMessageKey(workspace, artifact),
    'workspace-1:AR-001:abc:2026-05-18T00:00:01Z',
    'approval key combines workspace, artifact id, fingerprint, updatedAt'
  )
  assert.equal(
    continuationMessageKey(workspace, 'T3', 'developer-1'),
    'workspace-1:/tmp/workspace/.multi-code/sprintengine/team/run.yaml:T3:developer-1'
  )
  assert.equal(
    architectTriageMessageKey(workspace, ['T2', 'T1'], 'architect'),
    'workspace-1:/tmp/workspace/.multi-code/sprintengine/team/run.yaml:architect:T1,T2',
    'triage key sorts task ids so order does not produce duplicate notifications'
  )

  const event: SprintEngineEvent = {
    id: 'EV-001',
    timestamp: '2026-05-18T00:00:00Z',
    type: 'agent_notification_requested',
    actor: 'system',
    message: 'resume',
    targetAgentId: 'developer-1',
    taskId: 'T3',
  }
  assert.equal(
    agentNotificationDeliveryKey(workspace, event),
    '/tmp/workspace/.multi-code/sprintengine/team/run.yaml:EV-001'
  )
  assert.equal(
    sprintEngineDispatchDeliveryKey(workspace, 'developer-1', {
      dispatchId: 'DISP-1',
      targetKind: 'task',
      taskId: 'T3',
    }),
    '/tmp/workspace/.multi-code/sprintengine/team/run.yaml:developer-1:DISP-1',
    'dispatch delivery prefers durable dispatch id'
  )
  assert.equal(
    sprintEngineDispatchDeliveryKey(workspace, 'developer-1', {
      dispatchId: null,
      targetKind: 'gate',
      taskId: 'T3',
      gateId: 'tester',
      reason: 'gate_claimed',
    }),
    '/tmp/workspace/.multi-code/sprintengine/team/run.yaml:developer-1:gate:T3:tester:::gate_claimed',
    'dispatch delivery has a stable target fallback when dispatch id is unavailable'
  )
}

function testPromptBuildersIncludeAgentIdAndCommand(): void {
  const readyTask = task({ id: 'T3', title: 'Build feature', role: 'developer' })
  const continuation = buildSprintEngineContinuationPrompt(readyTask, 'developer-1')
  assert.ok(continuation.includes('sprintengine join --role developer --id developer-1 --watch'))
  assert.ok(continuation.includes('T3 - Build feature'))

  const gateTask = task({ id: 'T3', title: 'Build feature' })
  const gate = gateTask.qualityGates[0]
  const claimed = buildSprintEngineGateContinuationPrompt(gateTask, gate, 'code_reviewer', true)
  assert.ok(claimed.includes('already claimed by this terminal'))
  const ready = buildSprintEngineGateContinuationPrompt(gateTask, gate, 'code_reviewer', false)
  assert.ok(ready.includes('ready for this terminal'))
  assert.ok(ready.includes('sprintengine join --role code_reviewer --id code_reviewer --watch'))

  const notif = buildAgentNotificationPrompt({
    id: 'EV-001',
    timestamp: '2026-05-18T00:00:00Z',
    type: 'agent_notification_requested',
    actor: 'system',
    message: 'Your task was resolved.',
    targetAgentId: 'developer-1',
    taskId: 'T3',
    notificationKind: 'task_completed_after_artifact_approval',
  })
  assert.ok(notif.includes('Your Sprint Engine task is complete.'))
  assert.ok(notif.includes('Task: T3'))

  const triage = buildArchitectNeedsInputTriagePrompt({
    workspaceFolderPath: '/tmp/workspace',
    sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    taskIds: ['T5', 'T6'],
  })
  assert.ok(triage.includes('sprintengine --state'))
  assert.ok(triage.includes('triage needs-input --id architect'))
  assert.ok(triage.includes('T5, T6'))
}

function testDispatchPromptUsesJoinReconciliation(): void {
  const prompt = buildSprintEngineDispatchPrompt({
    role: 'frontend',
    agentId: 'frontend-3',
    dispatch: {
      dispatchId: 'DISP-123',
      targetKind: 'task',
      role: 'frontend',
      taskId: 'T4',
      reason: 'task_claimed',
    },
  })

  assert.ok(prompt.includes('Dispatch: DISP-123'))
  assert.ok(prompt.includes('Task: T4'))
  assert.ok(prompt.includes('Reason: task_claimed'))
  assert.ok(prompt.includes('sprintengine join --role frontend --id frontend-3 --watch'))
  assert.ok(prompt.includes('CLI owns polling, task/gate claims, and completion routing'))
}

function testDispatchAndContinuationPromptsWorkForRegistryKeyedRoles(): void {
  // Registry-keyed custom role (workspace-defined marketer). The wake-up
  // path must reproduce the role id verbatim in the join command so the
  // CLI binds the running terminal to its registry-discovered Soul. No
  // bundled-role label lookup or hardcoded role list should intercept the
  // value.
  const dispatchPrompt = buildSprintEngineDispatchPrompt({
    role: 'marketer',
    agentId: 'marketer-1',
    dispatch: {
      dispatchId: 'DISP-MK-1',
      targetKind: 'task',
      role: 'marketer',
      taskId: 'M2',
      reason: 'task_claimed',
    },
  })
  assert.ok(dispatchPrompt.includes('Dispatch: DISP-MK-1'))
  assert.ok(dispatchPrompt.includes('Task: M2'))
  assert.ok(dispatchPrompt.includes('sprintengine join --role marketer --id marketer-1 --watch'))

  const continuationPrompt = buildSprintEngineContinuationPrompt(
    task({ id: 'M3', title: 'Campaign brief', role: 'marketer' }),
    'marketer-1',
  )
  assert.ok(continuationPrompt.includes('ready marketer task'))
  assert.ok(continuationPrompt.includes('sprintengine join --role marketer --id marketer-1 --watch'))

  const gateTask = task({ id: 'M4', title: 'Campaign QA', role: 'marketer' })
  const customGate: SprintEngineQualityGate = {
    id: 'marketer_review',
    phase: 'review',
    role: 'marketer',
    status: 'pending',
    required: true,
    allowSelfReview: true,
    attempts: [],
  }
  const gatePrompt = buildSprintEngineGateContinuationPrompt(gateTask, customGate, 'marketer-2', false)
  assert.ok(gatePrompt.includes('Gate: marketer_review (review / marketer)'))
  assert.ok(gatePrompt.includes('sprintengine join --role marketer --id marketer-2 --watch'))
}

function testGetArchitectActionableNeedsInputTasksFiltersByKind(): void {
  const tasks: SprintEngineTask[] = [
    task({ id: 'T1', status: 'needs_input', needsInput: { kind: 'architect' } as SprintEngineTask['needsInput'] }),
    task({ id: 'T2', status: 'needs_input', needsInput: { kind: 'user' } as SprintEngineTask['needsInput'] }),
    task({ id: 'T3', status: 'needs_input', needsInput: { kind: 'verification' } as SprintEngineTask['needsInput'] }),
    task({ id: 'T4', status: 'in_progress' }),
  ]
  const state = sprintEngineStateFixture({ tasks })
  const filtered = getArchitectActionableNeedsInputTasks(state).map((task) => task.id)
  assert.deepEqual(filtered.sort(), ['T1', 'T3'], 'architect-routed kinds include architect/artifact/tooling/verification/other')
}

function testGetAutoApprovalIntentArtifactsRespectsEligibility(): void {
  const ownedTask = task({ id: 'T3', ownerAgentId: 'frontend', status: 'review' })
  const blockedTask = task({ id: 'T4', ownerAgentId: 'developer-1', status: 'needs_input' })
  const tasks = [ownedTask, blockedTask]

  const reviewArtifact: SprintEngineArtifact = {
    id: 'AR-001',
    taskId: 'T3',
    kind: 'design_notes',
    title: 'Notes',
    status: 'ready_for_review',
    path: 'docs/notes.md',
    createdBy: 'frontend',
    createdAt: '2026-05-18T00:00:00Z',
  } as SprintEngineArtifact
  const draftArtifact: SprintEngineArtifact = {
    id: 'AR-002',
    taskId: 'T4',
    kind: 'design_notes',
    title: 'Draft',
    status: 'draft',
    path: 'docs/draft.md',
    createdBy: 'developer-1',
    createdAt: '2026-05-18T00:00:01Z',
  } as SprintEngineArtifact
  const orphanArtifact: SprintEngineArtifact = {
    id: 'AR-003',
    taskId: 'T999',
    kind: 'design_notes',
    title: 'Orphan',
    status: 'ready_for_review',
    path: 'docs/orphan.md',
    createdBy: 'frontend',
    createdAt: '2026-05-18T00:00:02Z',
  } as SprintEngineArtifact

  const state = sprintEngineStateFixture({
    tasks,
    artifacts: [reviewArtifact, draftArtifact, orphanArtifact],
  })
  const eligibleIds = getAutoApprovalIntentArtifacts(state).map((artifact) => artifact.id)
  // The review artifact is eligible because the artifact passes the eligibility predicate
  // OR because its task has a sibling in needs_input that allows draft/ready_for_review/changes_requested.
  assert.ok(eligibleIds.includes('AR-001'), 'ready_for_review artifact on review task is eligible')
  assert.ok(eligibleIds.includes('AR-002'), 'draft artifact whose sibling task is in needs_input is eligible')
  assert.ok(!eligibleIds.includes('AR-003'), 'orphan artifact without a matching task is not eligible')
}

function testGetPendingAgentNotificationEventsFiltersDeliveredAndSent(): void {
  const workspace = workspaceFixture()
  const baseEvent = (id: string): SprintEngineEvent => ({
    id,
    timestamp: '2026-05-18T00:00:00Z',
    type: 'agent_notification_requested',
    actor: 'system',
    message: `event ${id}`,
    targetAgentId: 'developer-1',
  })
  const state = sprintEngineStateFixture({
    events: [
      baseEvent('EV-A'),
      baseEvent('EV-B'),
      baseEvent('EV-C'),
      { ...baseEvent('EV-D'), type: 'other' },
      { ...baseEvent('EV-E'), targetAgentId: undefined },
    ],
  })
  const delivered = new Set([agentNotificationDeliveryKey(workspace, baseEvent('EV-A'))])
  const sent = new Set([agentNotificationDeliveryKey(workspace, baseEvent('EV-B'))])
  const pending = getPendingAgentNotificationEvents(workspace, state, delivered, sent).map((event) => event.id)
  assert.deepEqual(
    pending,
    ['EV-C'],
    'delivered, sent, mistyped, and untargeted events are filtered out'
  )
}

function runtimeAgent(role: SprintEngineRole, overrides: Partial<SprintEngineRuntimeAgent> = {}): SprintEngineRuntimeAgent {
  return { role, status: 'idle', currentTaskId: null, ...overrides }
}

function pickInput(overrides: Partial<{
  limit: number
  pendingSpawns: AutoRunCandidate[]
  runningAgentIds: Set<string>
  inFlightSpawns: Set<string>
  continuationCapacityByRole: Map<SprintEngineRole, number>
  continuationGraceByTask: Map<string, RoleContinuationGrace>
}> = {}): Parameters<typeof pickNextAutoRuns>[2] {
  return {
    limit: 3,
    pendingSpawns: [],
    runningAgentIds: new Set<string>(),
    inFlightSpawns: new Set<string>(),
    continuationCapacityByRole: new Map(),
    continuationGraceByTask: new Map(),
    ...overrides,
  } as Parameters<typeof pickNextAutoRuns>[2]
}

function testAgentOwnsOpenSprintEngineImplementationWorkDetectsRework(): void {
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T1', status: 'changes_requested', ownerAgentId: 'frontend', role: 'frontend' }),
      task({ id: 'T2', status: 'needs_input', ownerAgentId: 'developer-1', role: 'developer' }),
      task({ id: 'T3', status: 'done', ownerAgentId: 'tester', role: 'tester' }),
    ],
  })

  assert.equal(agentOwnsOpenSprintEngineImplementationWork(state, 'frontend'), true)
  assert.equal(agentOwnsOpenSprintEngineImplementationWork(state, 'developer-1'), false)
  assert.equal(agentOwnsOpenSprintEngineImplementationWork(state, 'tester'), false)
}

function testShouldSkipExitedSprintEngineRosterAgentAllowsOwnedReworkRestart(): void {
  const exitedAgent = {
    kind: 'sprintengine' as const,
    cliLastExitedAt: Date.now(),
    cliStartRequested: false,
    cliHasLaunched: false,
  }

  assert.equal(
    shouldSkipExitedSprintEngineRosterAgent(exitedAgent, false),
    true,
    'exited idle roster agents without owned work remain skipped'
  )
  assert.equal(
    shouldSkipExitedSprintEngineRosterAgent(exitedAgent, true),
    false,
    'exited owners with open implementation work are eligible for restart'
  )
  assert.equal(
    shouldSkipExitedSprintEngineRosterAgent({ ...exitedAgent, cliStartRequested: true }, true),
    false,
    'agents already requested for startup are not treated as skipped exited agents'
  )
}

function testGetSprintEngineAutoRunOccupiedAgentIdsCountsChangesRequestedOwners(): void {
  const occupiedAgentIds = getSprintEngineAutoRunOccupiedAgentIds({
    tasks: [
      task({ id: 'T1', status: 'changes_requested', ownerAgentId: 'frontend', role: 'frontend' }),
      task({ id: 'T2', status: 'in_progress', ownerAgentId: 'developer-1', role: 'developer' }),
      task({ id: 'T3', status: 'review', ownerAgentId: 'code-reviewer', role: 'developer' }),
    ],
    pendingSpawns: [{ taskId: 'T4', agentId: 'tester', startedAt: 1 }],
    inFlightSpawnKeys: new Set(['workspace-1:spec-reviewer', 'other-workspace:security']),
    workspaceId: 'workspace-1',
  })

  assert.deepEqual(
    [...occupiedAgentIds].sort(),
    ['developer-1', 'frontend', 'spec-reviewer', 'tester'],
    'changes_requested owners occupy global auto-run concurrency slots'
  )
}

function testPickNextAutoRunsSelectsReadyTaskForIdleRoleAgent(): void {
  const readyTask = task({
    id: 'T-ready',
    status: 'todo',
    boardColumn: 'ready',
    role: 'developer',
    ownerAgentId: undefined as unknown as string,
    dependsOn: [],
    qualityGates: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [readyTask],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer') },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 1, 'one ready developer task → one candidate')
  assert.equal(candidates[0].agentId, 'developer-1')
  assert.equal(candidates[0].role, 'developer')
  assert.equal(candidates[0].taskId, 'T-ready')
  assert.equal(candidates[0].gateId, undefined)
}

function testPickNextAutoRunsSkipsRetiredRoleAgent(): void {
  const readyTask = task({
    id: 'T-ready',
    status: 'todo',
    boardColumn: 'ready',
    role: 'developer',
    ownerAgentId: undefined as unknown as string,
    dependsOn: [],
    qualityGates: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [readyTask],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { status: 'retired' }) },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 0, 'retired agents are not reusable auto-run candidates')
}

function testPickNextAutoRunsSkipsRetiredOwnerRework(): void {
  const reworkTask = task({
    id: 'T-rework',
    status: 'changes_requested',
    boardColumn: 'changes_requested',
    role: 'developer',
    ownerAgentId: 'developer-1',
    dependsOn: [],
    qualityGates: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [reworkTask],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { status: 'retired' }) },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 0, 'retired owners are not spawned for reopened changes_requested work')
}

function testPickNextAutoRunsHonoursContinuationGraceWindow(): void {
  const readyTask = task({
    id: 'T-ready',
    status: 'todo',
    boardColumn: 'ready',
    role: 'developer',
    ownerAgentId: undefined as unknown as string,
    dependsOn: [],
    qualityGates: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [readyTask],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer') },
  })

  // With continuation capacity 1 and a fresh grace window, the task is reserved
  // for the currently-idle agent and is NOT immediately spawned.
  const continuationGraceByTask = new Map<string, RoleContinuationGrace>()
  const continuationCapacityByRole = new Map<SprintEngineRole, number>([['developer', 1]])
  const candidates = pickNextAutoRuns(
    workspaceFixture(),
    state,
    pickInput({ continuationCapacityByRole, continuationGraceByTask })
  )
  assert.equal(candidates.length, 0, 'fresh grace window reserves the ready task for the idle agent')
  assert.equal(continuationGraceByTask.size, 1, 'grace entry was recorded')

  // After the grace window expires, the same task is offered as a candidate.
  const expiredGrace = new Map<string, RoleContinuationGrace>([
    [
      `workspace-1:/tmp/workspace/.multi-code/sprintengine/team/run.yaml:T-ready`,
      { startedAt: Date.now() - AUTO_RUN_ROLE_CONTINUATION_GRACE_MS - 1 },
    ],
  ])
  const expiredCandidates = pickNextAutoRuns(
    workspaceFixture(),
    state,
    pickInput({
      continuationCapacityByRole,
      continuationGraceByTask: expiredGrace,
    })
  )
  assert.equal(expiredCandidates.length, 1, 'after grace expires the task becomes a candidate')
  assert.equal(expiredCandidates[0].taskId, 'T-ready')
}

function testGetSprintEngineStartupCommandModePicksInitOnlyForEmptyArchitect(): void {
  const empty = sprintEngineStateFixture({ tasks: [] })
  const populated = sprintEngineStateFixture({ tasks: [task({ id: 'T1' })] })

  assert.equal(getSprintEngineStartupCommandMode('architect', 'architect', empty), 'init')
  assert.equal(
    getSprintEngineStartupCommandMode('architect', 'architect', populated),
    'join',
    'architect uses join once a task graph exists'
  )
  assert.equal(
    getSprintEngineStartupCommandMode('architect', 'architect-2', empty),
    'join',
    'only the canonical architect id ever initializes; others always join'
  )
  assert.equal(getSprintEngineStartupCommandMode('developer', 'developer-1', empty), 'join')
  assert.equal(getSprintEngineStartupCommandMode('architect', 'architect', null), 'init')
}

function testPickNextAutoRunsResumesActiveGateClaim(): void {
  const reviewTask = task({
    id: 'T-review',
    status: 'review',
    boardColumn: 'review',
    role: 'developer',
    ownerAgentId: 'developer-1',
    qualityGates: [
      {
        id: 'code_reviewer',
        phase: 'review',
        role: 'code_reviewer',
        status: 'in_progress',
        required: true,
        allowSelfReview: true,
        focus: '',
        attempts: [{ id: 'GA-001', status: 'in_progress', role: 'code_reviewer', claimedBy: 'code_reviewer', startedAt: '2026-05-18T00:00:00Z' }],
      },
    ],
  })
  const state = sprintEngineStateFixture({
    tasks: [reviewTask],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'in_progress', currentTaskId: 'T-review' }),
      'code_reviewer': runtimeAgent('code_reviewer'),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  const gateCandidate = candidates.find((candidate) => candidate.gateId === 'code_reviewer')
  assert.ok(gateCandidate, 'active gate claim is surfaced for the reviewer')
  assert.equal(gateCandidate?.agentId, 'code_reviewer')
  assert.equal(gateCandidate?.role, 'code_reviewer')
}
