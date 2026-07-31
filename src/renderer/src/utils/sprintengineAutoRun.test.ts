import assert from 'node:assert/strict'
import { Model, type IJsonModel } from 'flexlayout-react'
import {
  applyAgentTerminalRevealPolicy,
  registerModel,
  unregisterModel,
} from './modelRegistry'
import {
  AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS,
  AUTO_RUN_ACTIVE_ASSIGNMENT_MAX_PROMPTS,
  AUTO_RUN_ACTIVE_ASSIGNMENT_PROMPT,
  AUTO_RUN_IDLE_RETIREMENT_MS,
  AUTO_RUN_TASK_SCOPED_RETIREMENT_COOLDOWN_MS,
  findSprintEngineWakeCandidateTaskForAgent,
  sprintEngineWakeRestrictionTaskId,
  agentNotificationDeliveryKey,
  architectTriageMessageKey,
  artifactApprovalMessageKey,
  buildAgentNotificationPrompt,
  buildArchitectNeedsInputTriagePrompt,
  buildSprintEngineDispatchPrompt,
  buildSprintEngineContinuationPrompt,
  continuationMessageKey,
  describeSprintEngineExternalInputAutoRunBlock,
  getArchitectActionableNeedsInputTasks,
  getAutoApprovalIntentArtifacts,
  getPendingAgentNotificationEvents,
  getSprintEngineAutoRunOccupiedAgentIds,
  getSprintEngineWakeCandidateTasks,
  isSprintEngineRunBlockedOnExternalInput,
  pickNextAutoRuns,
  pickSprintEngineBootstrapCandidate,
  planSprintEngineDispatch,
  sprintEngineDispatchDeliveryKey,
  sprintEngineActiveAssignmentLedgerKey,
  sprintEngineIdleClockKey,
  sprintEngineRespawnLedgerKey,
  AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES,
  type SprintEngineDispatchAttempt,
  type SprintEngineDispatchPath,
} from './sprintengineAutoRun'
import { normalizeSprintEngineState, normalizeSprintEngineProjection } from './sprintengine'
import { buildSprintEngineStartupPrompt, getSprintEngineStartupCommandMode } from './agentPrompt'
import { deriveSprintEngineAutomationMode } from './sprintengineAutomation'
import {
  SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE,
  countUnreadSprintEngineAutomationNotifications,
} from './sprintengineNotifications'
import { useWorkspaceStore } from '../store/workspaceStore'
import type {
  AgentCli,
  AppNotification,
  SprintEngineArtifact,
  SprintEngineEvent,
  SprintEngineRoleId,
  SprintEngineRuntimeAgent,
  SprintEngineState,
  SprintEngineTask,
  Workspace,
  McpSettings,
} from '../types/workspace'
import { defaultAgent } from '../store/slices/agentsSlice'
import { getTimerRegistrations } from './diagnostics/timerRegistry'

const emptyMcpSettings: McpSettings = { syncEnabled: false, servers: {} }

void main()

async function main(): Promise<void> {
  testKeyHelpersAreStableAndScoped()
  testStartupPromptIsMcpNative()
  testArchitectInitStartupPromptIsMcpNative()
  testGeneralStartupPromptIsMcpNative()
  testArchitectWakeStartupPromptCarriesConfiguredRoles()
  testPromptBuildersIncludeAgentIdAndCommand()
  testAgentNotificationPromptCompactsLongResolutionText()
  testTaskWakeSkipsAgentAssignedToNeedsInputTask()
  testSprintEngineAutomationNotificationCountIsWorkspaceScoped()
  testDispatchPromptUsesDirectClaim()
  testDispatchAndContinuationPromptsWorkForRegistryKeyedRoles()
  testGetArchitectActionableNeedsInputTasksFiltersByKind()
  testRunBlockedOnExternalInputDetectsBlockedDependencyTail()
  testDescribeExternalInputBlockNamesBlockingTask()
  testRunBlockedOnExternalInputKeepsAutoRunWhenWorkExists()
  testRunBlockedOnExternalInputKeepsAutoRunWithActiveDispatch()
  testRunBlockedOnExternalInputKeepsAutoRunWithReadyApproval()
  testGetAutoApprovalIntentArtifactsRespectsEligibility()
  testGetAutoApprovalIntentArtifactsExcludesSameFileDuplicateVeto()
  testGetPendingAgentNotificationEventsFiltersDeliveredAndSent()
  testBootstrapSpawnsArchitectForFreshRunWithoutTasks()
  testBootstrapDeliversUndeliveredArchitectStartupPromptEvenWithTasks()
  testBootstrapDoesNothingOncePlanTasksExist()
  testBootstrapSkipsRunningInFlightAndRetiredArchitect()
  testBootstrapStallsInsteadOfSpawningWithoutArchitectOrAfterPrePlanExit()
  testGetSprintEngineAutoRunOccupiedAgentIdsDoesNotCountDeadNeedsInputOwner()
  testPickNextAutoRunsSelectsReadyTaskForIdleRoleAgent()
  testPickNextAutoRunsSkipsUnresolvedNeedsInputOwner()
  testPickNextAutoRunsSkipsRetiredRoleAgent()
  testPickNextAutoRunsSpawnsReadyWorkImmediatelyWithoutReservation()
  testGetSprintEngineStartupCommandModePicksInitOnlyForEmptyArchitect()
  testDeriveAutomationModeTrustsLocalAutoStateOverRunnerPolicy()
  testAgentTerminalBackgroundPolicyDoesNotSelectOrCreateTabs()
  await testListTerminalSessionsThrowsTerminalListIpcErrorOnReject()
  await testListTerminalSessionsResolvesWithSessionsOnSuccess()
  await testAutoApprovalOnlyBranchSkipsTerminalListWhenNothingToApprove()
  await testAutoApprovalAppliesReturnedProjectionWithoutDiskFallback()
  await testAutoApprovalFallsBackToDiskRefreshWhenProjectionMalformed()
  await testAutoApprovalCooldownBlocksRepeatApprovalWithinRetryWindow()
  await testDeliverAgentNotificationsSkipsRetiredTargets()
  await testDeliverApprovalCompletionWakesOwnerOnceWithoutFocus()
  await testDeliverRequestChangesWakesOwnerWithJoinDirectiveWithoutReveal()
  await testDeliverRequestChangesSkipsBusyDifferentTaskTerminal()
  await testDeliverNotificationsSuppressDuplicateObservations()
  await testDeliverNotificationSpawnsAgentWhenMissingTerminal()
  await testDeliverNotificationLeavesPendingWhenSupervisorDisabledAndNoTerminal()
  await testDispatchPromptDeliveryUsesDispatchIdCooldown()
  await testDispatchPromptStopsAfterRetryLimit()
  await testWakeCandidatePromptStopsAfterSmallRetryLimit()
  await testWakeCandidateCleanupPreservesNamespacedRetryKeys()
  await testDispatchPromptSkipsBusyDifferentTaskTerminal()
  await testDispatchPromptSkipsAgentAlreadyWorkingDispatchTask()
  await testDispatchPromptSkipsNeedsInputAgent()
  testActiveAssignmentRescueSendsMinimalPromptAfterSprintEngineInactivity()
  testActiveAssignmentRescueUsesSprintEngineActivityAndResetsBudget()
  testTaskScopedRetirementFiresOnTerminalStateDespiteReadyQueue()
  testTaskScopedRetirementNeverFiresMidReviewWindow()
  testTaskScopedWakeRestrictionBlocksCrossTaskReuse()
  testTaskScopedLifecycleExemptsPlanningRoles()
  testTaskScopedRetirementHonorsShortCooldown()
  testWindowDisposalMarksRetainResumeStateAndTerminalStateDoesNot()
  testALiveAgentOnlyCoversItsOwnReposWork()
  testWakeOnlyOffersWorkTheSessionCanClaim()
  testPickNextAutoRunsDefersBoundOwnerReworkToRevival()
  testPickNextAutoRunsDoesNotRespawnDepartedOwnerWhileRevivalThrottles()
  await testSpawnAutoRunCandidateResumesPreviousOwnerConversation()
  await testWindowDisposalRetainsResumeStateInStore()
  testTaskScopedRetirementStormBoundFallsBackToSlowCadence()
  testGenericPickAvoidsReworkReservedOwners()
  testPickNextAutoRunsNeverReusesSpentIdForNewClaim()
  testPickNextAutoRunsReusesPlanningIdAcrossSequentialTasks()
  testPickNextAutoRunsDefersReworkToLiveBoundOwner()
  testNeedsInputHoldRetainsResumeState()
  testReconcileLaunchFlagsPreservesRetainedResumeShape()
  await testSpawnResumeBlockedForCrashedLiveFlags()
  await testWindowDisposalWithoutTokenFullyClears()
  await testStaleRetainedResumeStateClearedOnceTaskDone()
  testActiveAssignmentRescueStopsAfterTwoPromptsWithDiagnostic()
  await testActiveAssignmentExhaustionDiagnosticMarksLedger()
  await testSpawnAutoRunCandidateStartsMissingTerminalWithJoinPrompt()
  await testSuperviseRunnerCycleMintsWorkerForUncoveredReadyTask()
  await testSuperviseRunnerCycleRestartsExitedRoleForReadyTask()
  await testSuperviseRunnerCycleBootstrapsOnlyArchitectForFreshRun()
  await testSuperviseRunnerCycleDoesNotRestartUnresolvedNeedsInputOwner()
  await testSuperviseRunnerCycleDoesNotMutateTaskState()
  await testSuperviseRunnerCycleReengagesStalledLiveIdleAgentForReadyTask()
  await testRespawnsDeadTaskClaimantAfterRestart()
  await testRespawnSkipsLiveCappedNeedsInputAndCoolingClaimants()
  testRevivesDepartedWorkerForOwnTask()
  testRevivesDepartedPlanningAgentForNewReadyTask()
  testLegacyLeftDeadAgentStatusCoercesToIdle()
  await testSuperviseRunnerCycleRespawnsDeadClaimantsAtFullOccupancy()
  await testAllPathsPlanNeverPastesAndKillsSameAgentInOnePass()
  await testNotificationPasteSuppressesSamePassDispatchPaste()
  await testIdleRetirementClosesParkedTerminalPastWindow()
  await testIdleRetirementCooldownSuppressesRespawnStorm()
  await testIdleRetirementSparesClaimHoldersFreshIdlersAndVisibleTabs()
  await testIdleRetirementSparesArchitectWithTriageWork()
  await testIdleRetirementResetsRetiredAgentLaunchState()
  await testNotificationSpawnFailureAbortsRemainingPlanActions()
  await testSecondNotificationForSameAgentDefersToNextPass()
  await testTriageDefersWhenPlanEngagedArchitectThisPass()
  await testHardCompletionGateEntersDormancyExactlyOnceViaHelper()
  await testHardCompletionGateIgnoresIncompleteRun()
  await testAutoRunPollerControllerArmsOnlyWhenNeededAndReArms()
}

function testAgentTerminalBackgroundPolicyDoesNotSelectOrCreateTabs(): void {
  const workspaceId = 'policy-workspace'
  const layout: IJsonModel = {
    global: {},
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          id: 'main',
          selected: 0,
          children: [
            { type: 'tab', id: 'board', name: 'Sprint', component: 'sprintengine' },
            { type: 'tab', id: 'agent-existing', name: 'Old Agent', component: 'agent', config: { agentId: 'agent-1' } },
          ],
        },
      ],
    },
  }
  const model = Model.fromJson(layout)
  registerModel(workspaceId, model)
  try {
    const updatedExisting = applyAgentTerminalRevealPolicy(
      workspaceId,
      'agent-1',
      'Renamed Agent',
      'background',
      { sessionId: 'session-1' }
    )
    const untouchedMissing = applyAgentTerminalRevealPolicy(
      workspaceId,
      'agent-2',
      'Missing Agent',
      'background',
      { sessionId: 'session-2' }
    )
    const json = model.toJson() as IJsonModel
    const tabset = (((json.layout as unknown) as Record<string, unknown>).children as Array<Record<string, unknown>>)[0]
    const children = tabset.children as Array<Record<string, unknown>>
    const existingAgent = children.find((child) => child.id === 'agent-existing')!

    assert.equal(updatedExisting, true, 'background policy updates an existing tab')
    assert.equal(untouchedMissing, false, 'background policy does not create a missing tab')
    assert.notEqual(tabset.selected, 1, 'background policy does not select the existing agent tab')
    assert.equal(children.length, 2, 'background policy does not add a new tab')
    assert.equal(existingAgent.name, 'Renamed Agent', 'existing tab labels can still be refreshed')
    assert.deepEqual(existingAgent.config, { agentId: 'agent-1', sessionId: 'session-1' })
  } finally {
    unregisterModel(workspaceId)
  }
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
    repo: 'primary',
    ...overrides,
  }
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
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: '' },
    editorState: { openFiles: [], activeFilePath: null },
    sprintEngineState: null,
    sprintEngineAutoState: {
      desiredMode: 'run_agents_and_approve_artifacts',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
    createdAt: 1,
    ...overrides,
  } as Workspace
}

function sprintAgent(id: string, name: string, cli: AgentCli = 'codex'): Workspace['agents'][string] {
  return {
    ...defaultAgent(id, name, 'sprintengine'),
    cli,
  }
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

async function loadSupervisor(): Promise<typeof import('./sprintengineAutoRunRendererHost')> {
  // The supervisor module reads window.api and uses crypto.randomUUID at evaluation paths
  // that the supervisor's React effect would normally drive. Tests install a stub window
  // and dynamically import the module so the store/notification singletons resolve.
  return await import('./sprintengineAutoRunRendererHost')
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
      desiredMode: 'run_agents_and_approve_artifacts',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
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
    mutableRef(new Map<string, number>()),
    mutableRef(new Map<string, string>())
  )

  assert.equal(result, 'none', 'auto-approval should return none when nothing is eligible')
  assert.equal(
    terminalListMock.invocations,
    0,
    'auto-approval-only branch must not query terminalList when no artifact needs approval'
  )
  void diagnosticCount
}

function autoApprovalFixture(): {
  workspace: Workspace
  sprintEngineState: SprintEngineState
  artifact: SprintEngineArtifact
  mutatedProjection: Record<string, unknown>
} {
  const reviewTask = task({
    id: 'T-design',
    status: 'review',
    boardColumn: 'review',
    role: 'frontend',
    ownerAgentId: 'frontend',
  })
  const artifact: SprintEngineArtifact = {
    id: 'AR-001',
    taskId: 'T-design',
    kind: 'design_notes',
    title: 'Design notes',
    status: 'ready_for_review',
    path: 'designs/notes.md',
    createdBy: 'frontend',
    createdAt: '2026-05-22T00:00:00Z',
    fingerprint: 'fp-1',
    updatedAt: '2026-05-22T00:00:01Z',
  } as SprintEngineArtifact
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [reviewTask],
    artifacts: [artifact],
    sprintEngineAgents: {
      'frontend': runtimeAgent('frontend', { status: 'idle' }),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    sprintEngineAutoState: {
      desiredMode: 'run_agents_and_approve_artifacts',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  // Approved projection that Sprint Engine would return inside autoApprove result.data.
  const mutatedProjection = {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: '2026-05-22T00:00:02Z',
    updatedAt: '2026-05-22T00:00:02Z',
    run: {
      id: 'run-id',
      name: 'team',
      goal: '',
      status: 'executing',
      rosterConfigured: true,
      runner: { cliWatchPolling: 'enabled' },
    },
    roleCounts: { frontend: 1 },
    roster: {
      'frontend': { role: 'frontend', status: 'idle', currentTaskId: null },
    },
    tasks: [
      {
        id: 'T-design',
        title: 'Scaffold site',
        description: '',
        role: 'frontend',
        status: 'review',
        ownerAgentId: 'frontend',
        dependsOn: [],
        ownedPaths: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        notes: [],
        comments: [],
        startedAt: null,
        completedAt: null,
        boardColumn: 'review',
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
      },
    ],
    artifacts: [
      {
        ...artifact,
        status: 'approved',
        updatedAt: '2026-05-22T00:00:02Z',
        fingerprint: 'fp-2',
      },
    ],
    activity: [],
  }
  return { workspace, sprintEngineState, artifact, mutatedProjection }
}

async function testAutoApprovalAppliesReturnedProjectionWithoutDiskFallback(): Promise<void> {
  const { workspace, sprintEngineState, artifact, mutatedProjection } = autoApprovalFixture()
  let autoApproveCount = 0
  let readProjectionCount = 0
  installTestWindow({
    terminalList: async () => [],
    autoApproveSprintEngineArtifact: async (statePath: string, artifactId: string) => {
      autoApproveCount += 1
      assert.equal(statePath, workspace.sprintEngineContext?.statePath)
      assert.equal(artifactId, artifact.id)
      return { ok: true, data: { projectionContent: JSON.stringify(mutatedProjection), projectionToken: 'projection-token-2' } }
    },
    readSprintEngineProjection: async () => {
      readProjectionCount += 1
      return { ok: true, data: mutatedProjection }
    },
    logDiagnostic: async (input) => input,
  })
  installWorkspaceStore(workspace)

  const supervisor = await loadSupervisor()
  const cooldown = mutableRef(new Map<string, number>())
  const lastContentByWorkspace = mutableRef(new Map<string, string>())
  const result = await supervisor.sendApprovalToNextEligibleArtifactProducer(
    workspace,
    sprintEngineState,
    cooldown,
    mutableRef(new Map<string, number>()),
    lastContentByWorkspace
  )

  assert.equal(result, 'sent', 'successful auto-approval returns sent')
  assert.equal(autoApproveCount, 1, 'auto-approval invokes the MCP/IPC mutation exactly once')
  assert.equal(
    readProjectionCount,
    0,
    'returned projectionContent is applied before refreshAutoWorkspaceState falls back to disk'
  )

  const updatedState = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)?.sprintEngineState
  const approvedArtifact = updatedState?.artifacts.find((candidate) => candidate.id === artifact.id)
  assert.ok(approvedArtifact, 'workspace store received the mutated projection artifact')
  assert.equal(approvedArtifact?.status, 'approved', 'applied state reflects the Sprint Engine mutation outcome')

  assert.equal(
    lastContentByWorkspace.current.get(workspace.id),
    'projection-token-2',
    'projection-watcher token is kept in sync so disk re-read does not re-apply the same state'
  )
  assert.equal(cooldown.current.size, 1, 'cooldown key is reserved before the IPC call to prevent re-issue')
}

async function testAutoApprovalFallsBackToDiskRefreshWhenProjectionMalformed(): Promise<void> {
  const { workspace, sprintEngineState, artifact, mutatedProjection } = autoApprovalFixture()
  let autoApproveCount = 0
  let readProjectionCount = 0
  installTestWindow({
    terminalList: async () => [],
    autoApproveSprintEngineArtifact: async () => {
      autoApproveCount += 1
      // Returned projection is not a string; the apply path must reject it and refresh from disk.
      return { ok: true, data: { projectionContent: { not: 'a string' } } }
    },
    readSprintEngineProjection: async () => {
      readProjectionCount += 1
      return { ok: true, data: mutatedProjection }
    },
    logDiagnostic: async (input) => input,
  })
  installWorkspaceStore(workspace)

  const supervisor = await loadSupervisor()
  const lastContentByWorkspace = mutableRef(new Map<string, string>())
  const result = await supervisor.sendApprovalToNextEligibleArtifactProducer(
    workspace,
    sprintEngineState,
    mutableRef(new Map<string, number>()),
    mutableRef(new Map<string, number>()),
    lastContentByWorkspace
  )

  assert.equal(result, 'sent', 'fallback refresh that succeeds still reports sent')
  assert.equal(autoApproveCount, 1)
  assert.equal(
    readProjectionCount,
    1,
    'malformed projectionContent triggers a single refreshAutoWorkspaceState read from projection.json'
  )

  const updatedState = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)?.sprintEngineState
  const approvedArtifact = updatedState?.artifacts.find((candidate) => candidate.id === artifact.id)
  assert.equal(approvedArtifact?.status, 'approved', 'workspace state is refreshed from disk on fallback')
}

async function testAutoApprovalCooldownBlocksRepeatApprovalWithinRetryWindow(): Promise<void> {
  const { workspace, sprintEngineState, artifact, mutatedProjection } = autoApprovalFixture()
  let autoApproveCount = 0
  installTestWindow({
    terminalList: async () => [],
    autoApproveSprintEngineArtifact: async () => {
      autoApproveCount += 1
      return { ok: true, data: { projectionContent: JSON.stringify(mutatedProjection) } }
    },
    readSprintEngineProjection: async () => ({ ok: true, data: mutatedProjection }),
    logDiagnostic: async (input) => input,
  })
  installWorkspaceStore(workspace)

  const supervisor = await loadSupervisor()
  const cooldown = mutableRef(new Map<string, number>())
  const lastContentByWorkspace = mutableRef(new Map<string, string>())

  const first = await supervisor.sendApprovalToNextEligibleArtifactProducer(
    workspace,
    sprintEngineState,
    cooldown,
    mutableRef(new Map<string, number>()),
    lastContentByWorkspace
  )
  // Second tick observes the same eligible artifact (e.g., projection refresh is still in flight).
  // The cooldown reservation must block a duplicate mutation request.
  const second = await supervisor.sendApprovalToNextEligibleArtifactProducer(
    workspace,
    sprintEngineState,
    cooldown,
    mutableRef(new Map<string, number>()),
    lastContentByWorkspace
  )

  assert.equal(first, 'sent', 'first tick approves through Sprint Engine')
  assert.equal(second, 'none', 'cooldown reservation blocks the second tick before any IPC mutation')
  assert.equal(autoApproveCount, 1, 'auto-approval IPC is called exactly once while the cooldown is active')
  assert.equal(
    cooldown.current.get(artifactApprovalMessageKey(workspace, artifact)) !== undefined,
    true,
    'cooldown key is keyed by the artifact identity from artifactApprovalMessageKey'
  )
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
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
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
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    sentNotifications
  )

  assert.equal(result, 'none')
  assert.equal(terminalListMock.invocations, 0, 'retired notification targets are skipped before terminal lookup')
  assert.equal(sentNotifications.current.has(deliveryKey), true, 'retired notification skip is recorded for this supervisor cycle')
}

function reworkNotificationWorkspaceFixture(): Workspace {
  return workspaceFixture({
    agents: {
      'frontend-2': sprintAgent('frontend-2', 'Reagan'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
}

function reworkNotificationEvent(overrides: Partial<SprintEngineEvent> = {}): SprintEngineEvent {
  return {
    id: 'EV-rework-1',
    timestamp: '2026-05-22T00:00:00Z',
    type: 'agent_notification_requested',
    actor: 'user-1',
    message: 'Changes were requested for artifact AR-9 by user-1.',
    targetAgentId: 'frontend-2',
    taskId: 'T-rework',
    artifactId: 'AR-9',
    notificationKind: 'task_changes_requested_after_artifact_review',
    ...overrides,
  }
}

function completionNotificationEvent(overrides: Partial<SprintEngineEvent> = {}): SprintEngineEvent {
  return {
    id: 'EV-complete-1',
    timestamp: '2026-05-22T00:00:00Z',
    type: 'agent_notification_requested',
    actor: 'user-1',
    message: 'Artifact AR-9 was approved by user-1. Your task is complete.',
    targetAgentId: 'frontend-2',
    taskId: 'T-complete',
    artifactId: 'AR-9',
    notificationKind: 'task_completed_after_artifact_approval',
    ...overrides,
  }
}

async function testDeliverApprovalCompletionWakesOwnerOnceWithoutFocus(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  const mutations: string[] = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend-2',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
      },
    ],
    terminalWrite: async (sessionId, text) => {
      writes.push({ sessionId, text })
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
  const workspace = reworkNotificationWorkspaceFixture()
  const event = completionNotificationEvent()
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', { status: 'running', currentTaskId: 'T-complete' }),
    },
    events: [event],
  })
  installWorkspaceStore(workspace)
  const sent = mutableRef(new Set<string>())

  const first = await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set(['frontend-2']),
    {},
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    sent
  )
  const second = await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set(['frontend-2']),
    {},
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    sent
  )

  assert.equal(first, 'none', 'deliver returns none when no spawn was triggered')
  assert.equal(second, 'none')
  assert.equal(writes.length, 2, 'completion notification produces one pasted directive plus submit per event id')
  assert.equal(writes[0].sessionId, 'session-frontend')
  assert.ok(writes[0].text.includes('Your sprint task is complete.'))
  assert.ok(
    !writes[0].text.includes('sprintengine join'),
    'completion notification does not direct the agent to re-run any sprintengine CLI command'
  )
  assert.ok(
    !writes[0].text.includes('sprintengine.agent.next_directive'),
    'completion notification does not direct the agent to re-call the directive tool'
  )
  assert.equal(sent.current.size, 1, 'in-memory delivery cache records the event id once')
  assert.deepEqual(mutations, [], 'completion notification delivery does not perform Sprint Engine mutations')
}

async function testDeliverRequestChangesWakesOwnerWithJoinDirectiveWithoutReveal(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  const mutations: string[] = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend-2',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
      },
    ],
    terminalWrite: async (sessionId, text) => {
      writes.push({ sessionId, text })
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
  const workspace = reworkNotificationWorkspaceFixture()
  const event = reworkNotificationEvent()
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', { status: 'running', currentTaskId: 'T-rework' }),
    },
    events: [event],
  })
  installWorkspaceStore(workspace)

  const result = await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set(['frontend-2']),
    {},
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    mutableRef(new Set<string>())
  )

  assert.equal(result, 'none')
  assert.equal(writes.length, 2, 'rework notification writes one pasted directive plus submit')
  assert.equal(writes[0].sessionId, 'session-frontend')
  assert.ok(writes[0].text.includes('\x1b[200~'), 'rework prompt uses bracketed paste')
  assert.ok(
    writes[0].text.includes('sprintengine.task.next'),
    'rework prompt directs the agent at the MCP claim tool directly'
  )
  assert.ok(
    !writes[0].text.includes('"statePath"'),
    'rework prompt must not embed statePath; the managed MCP server resolves it from run context'
  )
  assert.ok(
    writes[0].text.includes('"role": "frontend"') && writes[0].text.includes('"id": "frontend-2"'),
    'rework prompt embeds the claim payload for this role and agent'
  )
  assert.ok(
    !writes[0].text.includes('sprintengine join'),
    'rework prompt does not instruct the agent to run any sprintengine CLI command'
  )
  assert.ok(writes[0].text.includes('Re-read the current task card'))
  assert.ok(writes[0].text.includes('sprintengine.task.get'), 'rework prompt names the MCP task read tool')
  assert.ok(writes[0].text.includes('Artifact: AR-9'))
  assert.deepEqual(mutations, [], 'rework notification delivery never invokes mutation IPC; Sprint Engine state is already recorded')
}

async function testDeliverRequestChangesSkipsBusyDifferentTaskTerminal(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend-2',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
      },
    ],
    terminalWrite: async (sessionId, text) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const workspace = reworkNotificationWorkspaceFixture()
  const sent = mutableRef(new Set<string>())
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', { status: 'running', currentTaskId: 'T-other' }),
    },
    events: [reworkNotificationEvent()],
  })
  installWorkspaceStore(workspace)

  const result = await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set(['frontend-2']),
    {},
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    sent
  )

  assert.equal(result, 'none')
  assert.equal(writes.length, 0, 'busy terminals are not interrupted for another task rework notification')
  assert.equal(sent.current.size, 0, 'skipped busy-terminal notifications remain pending for a later idle pass')
}

async function testDeliverNotificationsSuppressDuplicateObservations(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend-2',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
      },
    ],
    terminalWrite: async (sessionId, text) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const workspace = reworkNotificationWorkspaceFixture()
  const event = reworkNotificationEvent()
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', { status: 'running', currentTaskId: 'T-rework' }),
    },
    // Duplicate event observations: the same event id appears twice in projection
    // (e.g., projection watcher fires before our delivery cache prunes it).
    events: [event, { ...event, timestamp: '2026-05-22T00:00:01Z' }],
  })
  installWorkspaceStore(workspace)
  const sent = mutableRef(new Set<string>())

  await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set(['frontend-2']),
    {},
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    sent
  )
  // Subsequent tick observes the same projection: persisted delivery key blocks re-send.
  await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set(['frontend-2']),
    {},
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    sent
  )

  assert.equal(
    writes.length,
    2,
    'event id is the idempotency key: duplicate projection/event observations send one prompt plus submit at most once'
  )
}

async function testDeliverNotificationSpawnsAgentWhenMissingTerminal(): Promise<void> {
  const spawns: Array<{ initialPrompt?: string; agentId?: string; role?: string; visible?: boolean }> = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (
      sessionId: string,
      _cols: number,
      _rows: number,
      _cwd?: string,
      _resume?: boolean,
      _statePath?: string,
      _cli?: AgentCli,
      initialPrompt?: string,
      _cliRuntimes?: unknown,
      _shellOnly?: boolean,
      metadata?: { agentId?: string; agentSession?: { role?: string }; visible?: boolean },
    ) => {
      spawns.push({ initialPrompt, agentId: metadata?.agentId, role: metadata?.agentSession?.role, visible: metadata?.visible })
      return { ok: true, sessionId }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const workspace = reworkNotificationWorkspaceFixture()
  const event = reworkNotificationEvent()
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', { status: 'idle' }),
    },
    events: [event],
  })
  installWorkspaceStore(workspace)
  const sent = mutableRef(new Set<string>())

  const result = await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set<string>(),
    { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    sent
  )

  assert.equal(result, 'started', 'spawn-when-missing path reports started for spawnable rework kinds')
  assert.equal(spawns.length, 1, 'spawn-when-missing path spawns exactly one agent terminal')
  assert.equal(spawns[0].agentId, 'frontend-2')
  assert.equal(spawns[0].role, 'frontend')
  assert.equal(spawns[0].visible, false, 'automatic rework spawns stay background unless explicitly revealed')
  assert.ok(
    spawns[0].initialPrompt?.includes('sprintengine.task.next'),
    'spawned agent receives the MCP claim call as its startup prompt override'
  )
  assert.ok(
    !spawns[0].initialPrompt?.includes('sprintengine join'),
    'spawned rework prompt does not embed any sprintengine CLI command'
  )
  assert.ok(
    spawns[0].initialPrompt?.includes('Re-read the current task card'),
    'spawned agent receives the rework instruction'
  )
  assert.equal(sent.current.size, 1, 'spawn-when-missing path records the delivery key once')
}

async function testDeliverNotificationLeavesPendingWhenSupervisorDisabledAndNoTerminal(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  let spawnCount = 0
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async () => {
      spawnCount += 1
      throw new Error('terminalSpawn must not be called when supervisor is disabled')
    },
    terminalWrite: async (sessionId, text) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    sprintEngineAutoState: {
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  const event = reworkNotificationEvent()
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', { status: 'idle' }),
    },
    events: [event],
  })
  installWorkspaceStore(workspace)
  const sent = mutableRef(new Set<string>())

  const result = await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set<string>(),
    { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    sent
  )

  assert.equal(result, 'none', 'no spawn occurs when auto mode is off and there is no terminal')
  assert.equal(spawnCount, 0, 'auto mode off prevents fake terminal success: no spawn is attempted')
  assert.equal(writes.length, 0, 'no terminal write happens when auto mode is off and there is no terminal')
  assert.equal(sent.current.size, 0, 'notification stays pending; will retry once auto mode is enabled')
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
      'frontend-3': sprintAgent('frontend-3', 'Reagan'),
    },
  })
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-3': runtimeAgent('frontend', {
        status: 'running',
        currentTaskId: null,
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

  assert.equal(writes.length, 2, 'duplicate dispatch observations are suppressed inside the retry cooldown')
  assert.equal(writes[0].sessionId, 'session-frontend')
  assert.ok(writes[0].text.includes('\x1b[200~'), 'existing terminal receives bracketed paste')
  assert.ok(writes[0].text.includes('Dispatch: DISP-6ed51f5daa40b4bd'))
  assert.ok(writes[0].text.includes('sprintengine.task.next'), 'dispatch prompt names the MCP claim tool directly')
  assert.ok(
    !writes[0].text.includes('sprintengine.agent.next_directive'),
    'dispatch prompt does not route through the directive hop'
  )
  assert.ok(
    !writes[0].text.includes('"statePath"'),
    'dispatch prompt must not embed statePath; the managed MCP server resolves it from run context'
  )
  assert.ok(
    writes[0].text.includes('"role": "frontend"') && writes[0].text.includes('"id": "frontend-3"'),
    'dispatch prompt embeds the claim payload for this dispatch target'
  )
  assert.ok(!writes[0].text.includes('sprintengine join'), 'dispatch prompt does not instruct the agent to run a sprintengine CLI command')
  assert.deepEqual(mutations, [], 'dispatch prompt delivery must not call task/gate/artifact mutation IPC')
}

async function testDispatchPromptStopsAfterRetryLimit(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
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
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    agents: {
      'frontend-3': sprintAgent('frontend-3', 'Reagan'),
    },
  })
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-3': runtimeAgent('frontend', {
        status: 'running',
        currentTaskId: null,
        currentDispatch: {
          dispatchId: 'DISP-retry-limit',
          targetKind: 'task',
          role: 'frontend',
          taskId: 'T4',
          reason: 'task_claimed',
        },
      }),
    },
  })
  const key = sprintEngineDispatchDeliveryKey(
    workspace,
    'frontend-3',
    state.sprintEngineAgents['frontend-3'].currentDispatch
  )
  const sent = mutableRef(new Map<string, { sentAt: number; attempts?: number }>([
    [key, { sentAt: Date.now() - 360_000, attempts: supervisor.AUTO_RUN_MAX_PROMPT_RETRIES - 1 }],
  ]))

  await supervisor.sendDispatchPromptsToRunningAgents(
    workspace,
    state,
    new Set(['frontend-3']),
    sent
  )
  assert.equal(writes.length, 2, 'dispatch prompt is still pasted and submitted for the final allowed retry')
  assert.equal(sent.current.get(key)?.attempts, supervisor.AUTO_RUN_MAX_PROMPT_RETRIES)

  sent.current.set(key, { sentAt: Date.now() - 360_000, attempts: supervisor.AUTO_RUN_MAX_PROMPT_RETRIES })
  await supervisor.sendDispatchPromptsToRunningAgents(
    workspace,
    state,
    new Set(['frontend-3']),
    sent
  )

  assert.equal(writes.length, 2, 'dispatch prompt is not pasted again after the retry cap is reached')
  assert.equal(sent.current.get(key)?.attempts, supervisor.AUTO_RUN_MAX_PROMPT_RETRIES)
}

async function testWakeCandidatePromptStopsAfterSmallRetryLimit(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend-2',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
      },
    ],
    terminalWrite: async (sessionId, text) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    agents: {
      'frontend-2': sprintAgent('frontend-2', 'Zion'),
    },
  })
  const readyTask = task({
    id: 'T12',
    title: 'Build member home',
    status: 'todo',
    boardColumn: 'ready',
    role: 'frontend',
    ownerAgentId: null,
  })
  const state = sprintEngineStateFixture({
    tasks: [readyTask],
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', { status: 'idle' }),
    },
  })
  const key = continuationMessageKey(workspace, 'T12', 'frontend-2')
  const sent = mutableRef(new Map<string, { sentAt: number; attempts?: number }>([
    [key, { sentAt: Date.now() - 120_000, attempts: supervisor.AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES - 1 }],
  ]))

  await supervisor.sendContinuationPromptsToIdleAgents(
    workspace,
    state,
    new Set(['frontend-2']),
    sent
  )
  assert.equal(writes.length, 2, 'wake-candidate prompt is still pasted and submitted for the final allowed retry')
  assert.equal(sent.current.get(key)?.attempts, supervisor.AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES)

  sent.current.set(key, { sentAt: Date.now() - 120_000, attempts: supervisor.AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES })
  await supervisor.sendContinuationPromptsToIdleAgents(
    workspace,
    state,
    new Set(['frontend-2']),
    sent
  )

  assert.equal(writes.length, 2, 'wake-candidate prompt is not pasted again after the small retry cap is reached')
  assert.equal(sent.current.get(key)?.attempts, supervisor.AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES)
}

function testTaskWakeSkipsAgentAssignedToNeedsInputTask(): void {
  const workspace = workspaceFixture({
    agents: {
      'frontend-1': sprintAgent('frontend-1', 'Fia'),
      'frontend-2': sprintAgent('frontend-2', 'Finn'),
    },
  })
  const blockedTask = task({
    id: 'T11',
    title: 'Finish settings PIN copy',
    status: 'needs_input',
    boardColumn: 'needs_input',
    role: 'frontend',
    ownerAgentId: 'frontend-2',
  })
  const readyTask = task({
    id: 'T7',
    title: 'Convert bottom sheets to PIN minimal',
    status: 'todo',
    boardColumn: 'ready',
    role: 'frontend',
    ownerAgentId: null,
  })
  const state = sprintEngineStateFixture({
    tasks: [blockedTask, readyTask],
    sprintEngineAgents: {
      'frontend-1': runtimeAgent('frontend', { status: 'idle', currentTaskId: null }),
      'frontend-2': runtimeAgent('frontend', { status: 'needs_input', currentTaskId: 'T11' }),
    },
  })

  const plan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: state,
    now: 1,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(['frontend-2', 'frontend-1']),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['task_wake']),
  })

  assert.deepEqual(
    plan.pastes.map((paste) => paste.agentId),
    ['frontend-1'],
    'a stale available-agent set does not paste a T7 wake into the frontend-2 terminal assigned to blocked T11'
  )
  assert.equal(plan.pastes[0].data.taskId, 'T7')
  assert.ok(
    plan.skips.some((skip) =>
      skip.event === 'continuation-prompt-skipped-agent-assigned'
      && skip.data.agentId === 'frontend-2'
      && skip.data.currentTaskId === 'T11'
    ),
    'the planner records that the stale wake candidate was skipped because the agent is assigned'
  )
}

async function testWakeCandidateCleanupPreservesNamespacedRetryKeys(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend-2',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
      },
    ],
    terminalWrite: async (sessionId, text) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    agents: {
      'frontend-2': sprintAgent('frontend-2', 'Zion'),
    },
  })
  const readyTask = task({
    id: 'T12',
    title: 'Build member home',
    status: 'todo',
    boardColumn: 'ready',
    role: 'frontend',
    ownerAgentId: null,
  })
  const state = sprintEngineStateFixture({
    tasks: [readyTask],
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', { status: 'idle' }),
    },
  })
  const staleTaskKey = continuationMessageKey(workspace, 'T-old', 'frontend-2')
  const respawnKey = sprintEngineRespawnLedgerKey(workspace, { taskId: 'T6' }, 'tester-1')
  const sent = mutableRef(new Map<string, { sentAt: number; attempts?: number }>([
    [staleTaskKey, { sentAt: Date.now() - 120_000, attempts: 1 }],
    [respawnKey, { sentAt: Date.now() - 120_000, attempts: 1 }],
  ]))

  await supervisor.sendContinuationPromptsToIdleAgents(
    workspace,
    state,
    new Set(['frontend-2']),
    sent
  )

  assert.equal(writes.length, 2, 'ready task wake candidate is still sent and submitted')
  assert.equal(sent.current.has(staleTaskKey), false, 'stale task wake-candidate retry state is pruned')
  assert.equal(sent.current.has(respawnKey), true, 'namespaced respawn retry state is not pruned by task wake cleanup')
}

async function testDispatchPromptSkipsBusyDifferentTaskTerminal(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
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
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const sent = mutableRef(new Map<string, { sentAt: number }>())
  const workspace = workspaceFixture({
    agents: {
      'frontend-3': sprintAgent('frontend-3', 'Reagan'),
    },
  })
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-3': runtimeAgent('frontend', {
        status: 'running',
        currentTaskId: 'T-active',
        currentDispatch: {
          dispatchId: 'DISP-rework',
          targetKind: 'task',
          role: 'frontend',
          taskId: 'T-rework',
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

  assert.equal(writes.length, 0, 'dispatch prompts do not interrupt terminals working a different active task')
  assert.equal(sent.current.size, 0, 'skipped dispatch prompts are not marked delivered')
}

async function testDispatchPromptSkipsAgentAlreadyWorkingDispatchTask(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
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
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const sent = mutableRef(new Map<string, { sentAt: number }>())
  const workspace = workspaceFixture({
    agents: {
      'frontend-3': sprintAgent('frontend-3', 'Reagan'),
    },
  })
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-3': runtimeAgent('frontend', {
        status: 'running',
        currentTaskId: 'T-active',
        currentDispatch: {
          dispatchId: 'DISP-active-task',
          targetKind: 'task',
          role: 'frontend',
          taskId: 'T-active',
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

  assert.equal(writes.length, 0, 'dispatch prompts do not interrupt an agent already working the same task')
  assert.equal(sent.current.size, 0, 'skipped active task dispatch prompts are not marked delivered')
}

async function testDispatchPromptSkipsNeedsInputAgent(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-developer',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'developer-1',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
      },
    ],
    terminalWrite: async (sessionId, text) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    agents: {
      'developer-1': sprintAgent('developer-1', 'Dana'),
    },
  })
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', {
        status: 'needs_input',
        currentTaskId: 'T-needs-input',
        currentDispatch: {
          dispatchId: 'DISP-needs-input',
          targetKind: 'task',
          role: 'developer',
          taskId: 'T-needs-input',
          reason: 'task_claimed',
        },
      }),
    },
  })
  const key = sprintEngineDispatchDeliveryKey(
    workspace,
    'developer-1',
    state.sprintEngineAgents['developer-1'].currentDispatch
  )
  const sent = mutableRef(new Map<string, { sentAt: number }>([
    [key, { sentAt: Date.now() }],
  ]))

  await supervisor.sendDispatchPromptsToRunningAgents(
    workspace,
    state,
    new Set(['developer-1']),
    sent
  )

  assert.equal(writes.length, 0, 'needs_input agents are not repeatedly prompted with their stale task dispatch')
  assert.equal(sent.current.size, 0, 'skipped needs_input dispatch prompts clear stale delivery cooldown')
}

function testActiveAssignmentRescueSendsMinimalPromptAfterSprintEngineInactivity(): void {
  const now = Date.parse('2026-06-17T12:00:00Z')
  const startedAt = new Date(now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS - 1_000).toISOString()
  const workspace = workspaceFixture()
  const claimedTask = task({
    id: 'T-active',
    title: 'Render haunted house shell',
    role: 'developer',
    status: 'in_progress',
    boardColumn: 'in_progress',
    ownerAgentId: 'developer-1',
    startedAt,
  })
  const state = sprintEngineStateFixture({
    tasks: [claimedTask],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'running', currentTaskId: 'T-active' }),
    },
  })

  const plan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: state,
    now,
    runningAgentIds: new Set(['developer-1']),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['active_assignment']),
  })

  assert.equal(plan.pastes.length, 1, 'stale owned in-progress work gets one continuation paste')
  assert.equal(plan.pastes[0].prompt, AUTO_RUN_ACTIVE_ASSIGNMENT_PROMPT)
  assert.equal(plan.pastes[0].prompt, 'Continue.', 'active-assignment rescue prompt stays intentionally minimal')
  assert.equal(plan.pastes[0].key, sprintEngineActiveAssignmentLedgerKey(workspace, { taskId: 'T-active' }, 'developer-1'))
  assert.equal(plan.pastes[0].event, 'active-assignment-continuation-prompt-sent')
}

function testActiveAssignmentRescueUsesSprintEngineActivityAndResetsBudget(): void {
  const now = Date.parse('2026-06-17T12:00:00Z')
  const workspace = workspaceFixture()
  const startedAt = new Date(now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS * 2).toISOString()
  const artifactActivityAt = new Date(now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS + 30_000).toISOString()
  const claimedTask = task({
    id: 'T-active',
    title: 'Render haunted house shell',
    role: 'developer',
    status: 'in_progress',
    boardColumn: 'in_progress',
    ownerAgentId: 'developer-1',
    startedAt,
  })
  const key = sprintEngineActiveAssignmentLedgerKey(workspace, { taskId: 'T-active' }, 'developer-1')
  const state = sprintEngineStateFixture({
    tasks: [claimedTask],
    artifacts: [{
      id: 'A1',
      kind: 'implementation',
      title: 'Partial render evidence',
      path: 'task.log.json',
      status: 'draft',
      createdBy: 'developer-1',
      taskId: 'T-active',
      fingerprint: null,
      reviewHistory: [],
      recommendedTasks: [],
      createdAt: artifactActivityAt,
      updatedAt: artifactActivityAt,
    }],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'running', currentTaskId: 'T-active' }),
    },
  })

  const plan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: state,
    now,
    runningAgentIds: new Set(['developer-1']),
    idleAgentIds: new Set(),
    continuationLedger: new Map([[key, { sentAt: now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS * 2, attempts: 1 }]]),
    dispatchLedger: new Map(),
    paths: new Set(['active_assignment']),
  })

  assert.equal(plan.pastes.length, 0, 'fresh Sprint Engine artifact activity prevents a continuation paste')
  assert.deepEqual(plan.ledgerDeletes, [{ ledger: 'continuation', key }], 'new Sprint Engine activity clears the old rescue budget')
}

// --- Task-scoped worker lifecycle (MC-1444) ---

function taskScopedPlanInput(input: {
  workspace: Workspace
  state: SprintEngineState
  now: number
  idleAgentIds: string[]
  paths: SprintEngineDispatchPath[]
  idleClock?: Map<string, number>
  retirementCooldown?: Map<string, number>
  taskScopedRetirementTaskIds?: Map<string, string>
}): ReturnType<typeof planSprintEngineDispatch> {
  return planSprintEngineDispatch({
    workspace: input.workspace,
    sprintEngineState: input.state,
    now: input.now,
    runningAgentIds: new Set(input.idleAgentIds),
    idleAgentIds: new Set(input.idleAgentIds),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(input.paths),
    ...(input.idleClock ? { idleClock: input.idleClock } : {}),
    ...(input.retirementCooldown ? { retirementCooldown: input.retirementCooldown } : {}),
    ...(input.taskScopedRetirementTaskIds ? { taskScopedRetirementTaskIds: input.taskScopedRetirementTaskIds } : {}),
  })
}

function testTaskScopedRetirementFiresOnTerminalStateDespiteReadyQueue(): void {
  // The core MC-1444 inversion: a worker whose own task is done retires
  // immediately — no 5-minute idle window, and a full ready queue for its role
  // no longer parks it for reuse. Fresh sessions take the queue.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null }),
      task({ id: 'T-next', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-finished' }),
    },
  })
  // Idle for one second only — far inside the idle window.
  const idleClock = new Map([[sprintEngineIdleClockKey(workspace, 'developer-1'), now - 1_000]])

  const plan = taskScopedPlanInput({ workspace, state, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock })

  assert.equal(plan.retirements.length, 1, 'the completed worker retires without waiting out the idle window')
  assert.equal(plan.retirements[0].agentId, 'developer-1')
  assert.equal(plan.retirements[0].data.reason, 'task_scoped_terminal_state')
  assert.equal(plan.retirements[0].data.taskId, 'T-finished')
}

function testTaskScopedRetirementNeverFiresMidReviewWindow(): void {
  // The publish→done tail is NOT terminal: single-owner tasks keep their owner
  // through `review`, so the worker stays on the ordinary idle-window path (a
  // fast resume lands in the warm terminal) and its disposal retains the
  // conversation.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const inReviewState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'review', boardColumn: 'review', ownerAgentId: 'developer-1' })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  const freshClock = new Map([[sprintEngineIdleClockKey(workspace, 'developer-1'), now - 1_000]])
  const freshPlan = taskScopedPlanInput({ workspace, state: inReviewState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: freshClock })
  assert.equal(freshPlan.retirements.length, 0, 'a worker still reviewing its own diff is not retired inside the idle window')

  const parkedClock = new Map([[sprintEngineIdleClockKey(workspace, 'developer-1'), now - AUTO_RUN_IDLE_RETIREMENT_MS - 60_000]])
  const parkedPlan = taskScopedPlanInput({ workspace, state: inReviewState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(parkedPlan.retirements.length, 1, 'past the idle window the parked publisher is still reclaimed (production behavior)')
  assert.equal(parkedPlan.retirements[0].data.reason, 'idle_window')

  // Human "send back for rework" re-binds the task to its previous owner as
  // `in_progress`. No wake handout can steal it (an owned task is never a wake
  // candidate), and the owner's own disposal keeps its resume state.
  const reopenedState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'in_progress', boardColumn: 'in_progress', ownerAgentId: 'developer-1' })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
      'developer-2': runtimeAgent('developer'),
    },
  })
  const reopenedWake = taskScopedPlanInput({ workspace, state: reopenedState, now, idleAgentIds: ['developer-1', 'developer-2'], paths: ['task_wake'] })
  assert.equal(reopenedWake.pastes.length, 0, 'a re-opened owned task is never handed to any agent by the wake path')
  const reopenedRetire = taskScopedPlanInput({ workspace, state: reopenedState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(reopenedRetire.retirements.length, 1, 'past the idle window the parked owner is still reclaimed')
  assert.equal(reopenedRetire.retirements[0].retainResumeState, true, 'the owner still holds its task, so the conversation is retained')
}

function testTaskScopedWakeRestrictionBlocksCrossTaskReuse(): void {
  // A used live terminal never receives a different task; a fresh agent of the
  // same role does.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null }),
      task({ id: 'T-next', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-finished' }),
      'developer-2': runtimeAgent('developer'),
    },
  })
  const plan = taskScopedPlanInput({ workspace, state, now, idleAgentIds: ['developer-1', 'developer-2'], paths: ['task_wake'] })
  assert.equal(plan.pastes.length, 1, 'exactly one wake paste is planned for the ready task')
  assert.equal(plan.pastes[0].agentId, 'developer-2', 'the fresh agent gets the task; the used terminal is never reused')
}

function testTaskScopedLifecycleExemptsPlanningRoles(): void {
  // General owns a whole sprint solo; architect orchestrates. Both keep
  // today's reuse-preferring lifecycle.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-finished', role: 'general', status: 'done', boardColumn: 'done', ownerAgentId: null }),
      task({ id: 'T-next', role: 'general', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      'general-1': runtimeAgent('general', { lastOwnedTaskId: 'T-finished' }),
    },
  })
  const wakePlan = taskScopedPlanInput({ workspace, state, now, idleAgentIds: ['general-1'], paths: ['task_wake'] })
  assert.equal(wakePlan.pastes.length, 1, 'a General is rewoken for the next task in the same terminal')
  assert.equal(wakePlan.pastes[0].agentId, 'general-1')

  const freshClock = new Map([[sprintEngineIdleClockKey(workspace, 'general-1'), now - 1_000]])
  const retirePlan = taskScopedPlanInput({ workspace, state, now, idleAgentIds: ['general-1'], paths: ['idle_retire'], idleClock: freshClock })
  assert.equal(retirePlan.retirements.length, 0, 'a General with claimable work is never task-scope retired')

  assert.equal(
    sprintEngineWakeRestrictionTaskId(runtimeAgent('architect', { lastOwnedTaskId: 'T-x' })),
    null,
    'architect carries no wake restriction'
  )
  assert.equal(
    sprintEngineWakeRestrictionTaskId(runtimeAgent('developer')),
    null,
    'an implementation agent that never owned a task carries no restriction'
  )
  assert.equal(
    sprintEngineWakeRestrictionTaskId(runtimeAgent('developer', { lastOwnedTaskId: 'T-x' })),
    'T-x',
    'a used implementation agent is restricted to its own task'
  )
  assert.equal(
    findSprintEngineWakeCandidateTaskForAgent(
      [task({ id: 'T-other', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
      'developer',
      'developer-1',
      new Set(),
      'T-x',
      'primary'
    ),
    undefined,
    'the restriction excludes every task but the agent\'s own'
  )
}

function testTaskScopedRetirementHonorsShortCooldown(): void {
  // Storm guard: the short task-scoped cooldown still suppresses immediate
  // re-retirement, but does not park the role for the full 15-minute idle
  // cooldown between back-to-back small tasks.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null }),
      // The run must still be mid-flight: an all-tasks-done run skips the
      // idle_retire path entirely (completion teardown owns those terminals).
      task({ id: 'T-elsewhere', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-finished' }),
    },
  })
  const clockKey = sprintEngineIdleClockKey(workspace, 'developer-1')
  const idleClock = new Map([[clockKey, now - 1_000]])

  const insideCooldown = taskScopedPlanInput({
    workspace, state, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock,
    retirementCooldown: new Map([[clockKey, now - 30_000]]),
  })
  assert.equal(insideCooldown.retirements.length, 0, 'a retirement inside the short cooldown is suppressed')

  const pastCooldown = taskScopedPlanInput({
    workspace, state, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock,
    retirementCooldown: new Map([[clockKey, now - AUTO_RUN_TASK_SCOPED_RETIREMENT_COOLDOWN_MS - 1_000]]),
  })
  assert.equal(pastCooldown.retirements.length, 1, 'past the short cooldown the completed worker retires')
}

function testWindowDisposalMarksRetainResumeStateAndTerminalStateDoesNot(): void {
  // MC-1444 Phase 2: an idle-window disposal of a worker that still holds its
  // own task (single-owner tasks stay with their owner through `review`) carries
  // retainResumeState (the executor keeps the resume token); a terminal-state
  // retirement never does (the next task must get a fresh session).
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const parkedClock = new Map([[sprintEngineIdleClockKey(workspace, 'developer-1'), now - AUTO_RUN_IDLE_RETIREMENT_MS - 60_000]])

  const inReviewState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'review', boardColumn: 'review', ownerAgentId: 'developer-1' })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  const windowPlan = taskScopedPlanInput({ workspace, state: inReviewState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(windowPlan.retirements.length, 1)
  assert.equal(windowPlan.retirements[0].retainResumeState, true, 'window disposal keeps the resume token while the owner still holds its task')

  const doneState = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-mine', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null }),
      task({ id: 'T-open', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  const terminalPlan = taskScopedPlanInput({ workspace, state: doneState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(terminalPlan.retirements.length, 1)
  assert.equal(terminalPlan.retirements[0].retainResumeState, undefined, 'terminal-state retirement clears resume state — fresh session per task')

  // A parked agent with NO owned task also gets a plain disposal: nothing to
  // resume toward.
  const neverOwnedState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-open', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer'),
    },
  })
  const plainPlan = taskScopedPlanInput({ workspace, state: neverOwnedState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(plainPlan.retirements.length, 1)
  assert.equal(plainPlan.retirements[0].retainResumeState, undefined)
}

function testALiveAgentOnlyCoversItsOwnReposWork(): void {
  // MC-1610 starvation regression. The revival pass skips a role that has a live
  // agent, on the reasoning that the live agent will claim the work. Once
  // `task.next` filters by the session's repo that reasoning holds only WITHIN a
  // repo: a live desktop developer can never claim a mobile task. With the
  // picker deferring the mobile task to its bound owner and the revival pass
  // suppressed by the unrelated desktop session, nothing would ever spawn for
  // it — the task starves until the desktop session happens to die.
  const mobileTask = task({
    id: 'T-mobile',
    role: 'developer',
    repo: 'mobile',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
  })
  const state = sprintEngineStateFixture({
    tasks: [
      mobileTask,
      task({ id: 'T-desktop', role: 'developer', repo: 'primary', status: 'in_progress', boardColumn: 'in_progress', ownerAgentId: 'developer-1' }),
    ],
    sprintEngineAgents: {
      // Live, working the desktop tree.
      'developer-1': runtimeAgent('developer', { status: 'running', currentTaskId: 'T-desktop', lastOwnedTaskId: 'T-desktop' }),
      // Departed owner of the mobile task, still bound to it.
      'developer-2': runtimeAgent('developer', { lastOwnedTaskId: 'T-mobile' }),
    },
    workers: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T-desktop', repo: 'primary' },
    },
  } as Partial<SprintEngineState>)

  const picked = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.ok(
    !picked.some((candidate) => candidate.taskId === 'T-mobile'),
    `the picker still defers the mobile task to its bound owner; picked=${JSON.stringify(picked)}`,
  )

  const plan = planSprintEngineDispatch({
    workspace: workspaceFixture({ agents: { 'developer-2': sprintAgent('developer-2', 'Mo') } }),
    sprintEngineState: state,
    now: Date.parse('2026-07-16T22:00:00Z'),
    runningAgentIds: new Set(['developer-1']),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(plan.respawns.length, 1, 'the live desktop session does not cover mobile work, so the mobile owner is revived')
  assert.equal(plan.respawns[0].agentId, 'developer-2')
  assert.equal(plan.respawns[0].taskId, 'T-mobile')

  // A LIVE id is never a revival target, whatever repo its next work is in.
  // Revival respawns a terminal; doing that to a live session would dispose the
  // one it is working in. A planner is the sharp case: it is persistent, so it
  // is revivable for the NEXT ready task of its role — which may be in another
  // repo, i.e. a group its own session does not cover.
  const livePlannerState = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-plan-mobile', role: 'architect', repo: 'mobile', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      architect: runtimeAgent('architect', { status: 'running', currentTaskId: 'T-plan-desktop', lastOwnedTaskId: 'T-plan-desktop' }),
    },
    workers: { architect: { role: 'architect', status: 'running', currentTaskId: 'T-plan-desktop', repo: 'primary' } },
  } as Partial<SprintEngineState>)
  const livePlannerPlan = planSprintEngineDispatch({
    workspace: workspaceFixture({ agents: { architect: sprintAgent('architect', 'Archie') } }),
    sprintEngineState: livePlannerState,
    now: Date.parse('2026-07-16T22:00:00Z'),
    runningAgentIds: new Set(['architect']),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(
    livePlannerPlan.respawns.length,
    0,
    'a live planner is never respawned, even for ready work in a repo its session does not cover',
  )

  // The control: a live agent IN THAT TREE does cover it, so no revival — the
  // single-repo behavior, unchanged.
  const coveredState = sprintEngineStateFixture({
    tasks: [mobileTask],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'running', currentTaskId: 'T-other', lastOwnedTaskId: 'T-other' }),
      'developer-2': runtimeAgent('developer', { lastOwnedTaskId: 'T-mobile' }),
    },
    workers: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T-other', repo: 'mobile' },
    },
  } as Partial<SprintEngineState>)
  const coveredPlan = planSprintEngineDispatch({
    workspace: workspaceFixture({ agents: { 'developer-2': sprintAgent('developer-2', 'Mo') } }),
    sprintEngineState: coveredState,
    now: Date.parse('2026-07-16T22:00:00Z'),
    runningAgentIds: new Set(['developer-1']),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(coveredPlan.respawns.length, 0, 'a live agent in the same tree covers the work; no revival')
}

function testWakeOnlyOffersWorkTheSessionCanClaim(): void {
  // A wake paste tells a LIVE session to call `task.next`, which serves only its
  // own tree's work — so waking a desktop session for a mobile task produces an
  // agent that reports "no ready tasks" while the board shows work.
  const wakeTasks = [
    task({ id: 'T-mobile', role: 'developer', repo: 'mobile', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    task({ id: 'T-desktop', role: 'developer', repo: 'primary', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
  ]
  assert.equal(
    findSprintEngineWakeCandidateTaskForAgent(wakeTasks, 'developer', 'developer-1', new Set(), null, 'mobile')?.id,
    'T-mobile',
  )
  assert.equal(
    findSprintEngineWakeCandidateTaskForAgent(wakeTasks, 'developer', 'developer-1', new Set(), null, 'primary')?.id,
    'T-desktop',
  )
  // A tree with no work for the role offers nothing, rather than another tree's task.
  assert.equal(
    findSprintEngineWakeCandidateTaskForAgent([wakeTasks[0]], 'developer', 'developer-1', new Set(), null, 'primary'),
    undefined,
  )
}

function testPickNextAutoRunsDefersBoundOwnerReworkToRevival(): void {
  // Single-authority owner respawn (T2 review finding): a departed owner now
  // reads as `idle`, so the picker must NOT respawn it — that would be a second,
  // unthrottled authority racing the retry-limited revival pass. The picker
  // DEFERS a task whose previous owner is still bound to it; the revival pass in
  // planSprintEngineDispatch is the sole (throttled) spawner. Owner affinity is
  // preserved because the revival respawn resumes the owner's conversation.
  const boundTask = task({
    id: 'T-mine',
    role: 'developer',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
  })
  const state = sprintEngineStateFixture({
    tasks: [boundTask],
    sprintEngineAgents: {
      'developer-0': runtimeAgent('developer'),
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 0, 'the picker defers the bound owner\'s task — it does not fresh-dispatch or respawn it')

  // The revival pass is the one authority that respawns the departed owner, and
  // it is retry-limited so a crash-looping owner cannot spawn-storm.
  const revivalWorkspace = workspaceFixture({ agents: { 'developer-1': sprintAgent('developer-1', 'Devin') } })
  const revivalPlan = planSprintEngineDispatch({
    workspace: revivalWorkspace,
    sprintEngineState: state,
    now: Date.parse('2026-07-04T22:00:00Z'),
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(revivalPlan.respawns.length, 1, 'the revival pass respawns the departed owner')
  assert.equal(revivalPlan.respawns[0].agentId, 'developer-1', 'owner affinity preserved: the id that owned the task is revived')
  assert.equal(revivalPlan.respawns[0].taskId, 'T-mine')

  // Without a previous owner bound to the task, the picker hands it to fresh
  // never-owned capacity as usual (reused over the spent id, not minted anew).
  const noOwnerState = sprintEngineStateFixture({
    tasks: [boundTask],
    sprintEngineAgents: {
      'developer-0': runtimeAgent('developer'),
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-other' }),
    },
  })
  const fallback = pickNextAutoRuns(workspaceFixture(), noOwnerState, pickInput())
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].agentId, 'developer-0')
}

function testPickNextAutoRunsDoesNotRespawnDepartedOwnerWhileRevivalThrottles(): void {
  // Review requirement: the picker must not respawn a departed owner that the
  // revival ledger is throttling. The picker has no cross-cycle retry ledger, so
  // it defers the bound owner's task unconditionally — even mid-throttle,
  // there is no picker candidate to bypass the cap.
  const boundTask = task({
    id: 'T-rework',
    role: 'developer',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
  })
  const workspace = workspaceFixture({ agents: { 'developer-1': sprintAgent('developer-1', 'Devin') } })
  const state = sprintEngineStateFixture({
    tasks: [boundTask],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-rework' }) },
  })
  const candidates = pickNextAutoRuns(workspace, state, pickInput())
  assert.equal(candidates.length, 0, 'a departed owner gets no picker candidate — respawn stays the revival pass\'s throttled job')

  // And the revival pass itself honours its cap: once the shared respawn: key is
  // maxed, no respawn is planned this pass.
  const now = Date.parse('2026-07-04T22:00:00Z')
  const cappedKey = sprintEngineRespawnLedgerKey(workspace, { taskId: 'T-rework' }, 'developer-1')
  const cappedPlan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: state,
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map([[cappedKey, { sentAt: now - 120_000, attempts: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES }]]),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(cappedPlan.respawns.length, 0, 'a maxed revive ledger stops the only respawn authority — no spawn-storm')
}

async function testSpawnAutoRunCandidateResumesPreviousOwnerConversation(): Promise<void> {
  // MC-1444 Phase 2: respawning the previous owner onto its OWN task with
  // retained resume state relaunches the conversation (`resume: true` + the
  // retained token in metadata.cliSessionId). A different task spawns fresh.
  const spawns: Array<{ sessionId: string; resume?: boolean; metadata?: { cliSessionId?: string } }> = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (
      sessionId: string,
      _cols: number,
      _rows: number,
      _cwd?: string,
      resume?: boolean,
      _statePath?: string,
      _cli?: AgentCli,
      _initialPrompt?: string,
      _cliRuntimes?: unknown,
      _shellOnly?: boolean,
      metadata?: { cliSessionId?: string },
    ) => {
      spawns.push({ sessionId, resume, metadata })
      return { ok: true, sessionId }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const retainedAgent = {
    ...sprintAgent('developer-1', 'Dev One', 'claude-code'),
    cliSessionId: 'retained-conversation-token',
    cliResumeAvailable: true,
    cliStartRequested: false,
    cliHasLaunched: false,
  }
  const workspace = workspaceFixture({
    agents: { 'developer-1': retainedAgent },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  const state = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  installWorkspaceStore({ ...workspace, sprintEngineState: state })

  const cliRuntimes = { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } }
  const result = await supervisor.spawnAutoRunCandidate(
    workspace,
    state,
    { agentId: 'developer-1', label: 'Dev One', role: 'developer', taskId: 'T-mine' },
    cliRuntimes,
    emptyMcpSettings,
    mutableRef(new Set<string>()),
  )
  assert.equal(result, 'started')
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].resume, true, 'own-task rework respawn resumes the retained conversation')
  assert.equal(spawns[0].metadata?.cliSessionId, 'retained-conversation-token', 'the retained token rides metadata.cliSessionId')

  // Same retained state, DIFFERENT task: fresh conversation.
  spawns.length = 0
  const otherTaskState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-new', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  installWorkspaceStore({ ...workspace, sprintEngineState: otherTaskState })
  const freshResult = await supervisor.spawnAutoRunCandidate(
    workspace,
    otherTaskState,
    { agentId: 'developer-1', label: 'Dev One', role: 'developer', taskId: 'T-new' },
    cliRuntimes,
    emptyMcpSettings,
    mutableRef(new Set<string>()),
  )
  assert.equal(freshResult, 'started')
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].resume, false, 'a new task never resumes the old conversation')
  assert.equal(spawns[0].metadata?.cliSessionId, undefined, 'no resume token is passed for a fresh session')
}

function testTaskScopedRetirementStormBoundFallsBackToSlowCadence(): void {
  // Review finding: a respawn that fails to claim keeps its stale done
  // lastOwnedTaskId; without a bound it would be killed every 60s forever.
  // A repeat retirement for the SAME done task must use the slow idle-window
  // cadence; a new completion keeps the prompt path.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null }),
      task({ id: 'T-open', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-finished' }),
    },
  })
  const clockKey = sprintEngineIdleClockKey(workspace, 'developer-1')
  const freshClock = new Map([[clockKey, now - 1_000]])
  const repeatLedger = new Map([[clockKey, 'T-finished']])

  const repeatPlan = taskScopedPlanInput({
    workspace, state, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'],
    idleClock: freshClock, taskScopedRetirementTaskIds: repeatLedger,
  })
  assert.equal(repeatPlan.retirements.length, 0, 'a repeat for the same done task waits out the idle window (no 60s churn)')

  const differentTaskLedger = new Map([[clockKey, 'T-previous']])
  const freshCompletionPlan = taskScopedPlanInput({
    workspace, state, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'],
    idleClock: freshClock, taskScopedRetirementTaskIds: differentTaskLedger,
  })
  assert.equal(freshCompletionPlan.retirements.length, 1, 'a genuinely new completion keeps the prompt path')
  assert.equal(freshCompletionPlan.retirements[0].data.reason, 'task_scoped_terminal_state')

  const slowPathPlan = taskScopedPlanInput({
    workspace, state, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'],
    idleClock: new Map([[clockKey, now - AUTO_RUN_IDLE_RETIREMENT_MS - 60_000]]),
    taskScopedRetirementTaskIds: repeatLedger,
  })
  assert.equal(slowPathPlan.retirements.length, 1, 'past the full idle window the repeat still reclaims the terminal')
  assert.equal(slowPathPlan.retirements[0].data.reason, 'idle_window')
}

function testGenericPickAvoidsReworkReservedOwners(): void {
  // Review finding: iteration order must not burn a rework owner (and its
  // retained conversation) on an unrelated earlier task. Post-T2 the owner is
  // reserved by DEFERRAL — the picker never selects a bound owner (its rework is
  // the revival pass's throttled job), so the fresh (reusable) agent takes only
  // the new task and the owner is never pulled onto the unrelated one.
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-new', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
      task({ id: 'T-rework', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      // Previous owner of the bound task sorts FIRST — the generic pick must skip it.
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-rework' }),
      'developer-2': runtimeAgent('developer'),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  const byTask = new Map(candidates.map((candidate) => [candidate.taskId, candidate.agentId]))
  assert.equal(byTask.get('T-new'), 'developer-2', 'the unreserved agent takes the new task')
  assert.equal(byTask.has('T-rework'), false, 'the bound owner\'s rework is deferred to the revival pass, not picked here')
  assert.ok(
    !candidates.some((candidate) => candidate.agentId === 'developer-1'),
    'the rework owner is never burned on another task by the picker',
  )
}

function testPickNextAutoRunsNeverReusesSpentIdForNewClaim(): void {
  // MC-1591 leases: a NEW claim (a ready task with no owner) never reuses a
  // spent id (one that has ever owned a task, even after it is done). It reuses
  // an eligible never-owned idle worker when one exists; otherwise the spawner
  // MINTS a fresh id that the engine binds to the task at claim.
  const spentOnlyState = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-done', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null }),
      task({ id: 'T-new', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      // Spent (finished a prior task) — the spent id is skipped and the next
      // free id is minted for the new claim.
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-done' }),
    },
  })
  const spentOnly = pickNextAutoRuns(workspaceFixture(), spentOnlyState, pickInput())
  assert.equal(spentOnly.length, 1)
  assert.equal(spentOnly[0].taskId, 'T-new')
  assert.equal(spentOnly[0].agentId, 'developer-2', 'the spent id is skipped; a fresh developer-2 is minted')

  // With a never-owned idle id present alongside the spent one, the new claim
  // reuses that reusable capacity rather than minting — only the spent id is
  // off limits.
  const withFreshState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-new', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-done' }),
      'developer-2': runtimeAgent('developer'),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), withFreshState, pickInput())
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].taskId, 'T-new')
  assert.equal(candidates[0].agentId, 'developer-2', 'the never-owned idle id takes the new claim over the spent id')
}

function testPickNextAutoRunsReusesPlanningIdAcrossSequentialTasks(): void {
  // Persistent planning identity (MC-1454): planning roles are NOT task-scoped.
  // The seated architect that already owned (and finished) a prior task must be
  // REUSED for the next architect task — the task-scoped mint would hand it a
  // fresh id, so planning roles route through the persistent-planner pick, and
  // without it a sequential architect task stalls or mints architect-N.
  const readyArchitectTask = task({
    id: 'T-plan-2',
    role: 'architect',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
    dependsOn: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [readyArchitectTask],
    sprintEngineAgents: {
      architect: runtimeAgent('architect', { lastOwnedTaskId: 'T0' }),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 1, 'the second architect task is picked up, not stalled')
  assert.equal(candidates[0].agentId, 'architect', 'the persistent architect id is reused across sequential tasks')
  assert.equal(candidates[0].role, 'architect')
  assert.equal(candidates[0].taskId, 'T-plan-2')
  assert.ok(
    !candidates.some((candidate) => /^architect-\d+$/.test(candidate.agentId)),
    'no architect-N is ever minted for a sequential architect task',
  )

  // A busy seated architect is waited on (not duplicated): the reuse must not
  // mint a second planning id while the one architect is running elsewhere.
  const busyState = sprintEngineStateFixture({
    tasks: [readyArchitectTask],
    sprintEngineAgents: {
      architect: runtimeAgent('architect', { status: 'running', currentTaskId: 'T-other', lastOwnedTaskId: 'T-other' }),
    },
  })
  const busyCandidates = pickNextAutoRuns(
    workspaceFixture(),
    busyState,
    pickInput({ runningAgentIds: new Set(['architect']) }),
  )
  assert.equal(busyCandidates.length, 0, 'a busy architect is waited on; no architect-N is minted to cover the task')
}

function testPickNextAutoRunsDefersReworkToLiveBoundOwner(): void {
  // Review finding: when the previous owner is LIVE and idle, the wake paste
  // engages it in the same cycle — spawning a second agent for the same
  // rework double-dispatches the task.
  const state = sprintEngineStateFixture({
    tasks: [task({ id: 'T-rework', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-rework' }),
      'developer-2': runtimeAgent('developer'),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput({
    runningAgentIds: new Set(['developer-1']),
  }))
  assert.deepEqual(candidates, [], 'no spawn is planned while the live bound owner will be wake-pasted')
}

function testNeedsInputHoldRetainsResumeState(): void {
  // Review finding: needs_input keeps its owner server-side exactly like the
  // verdict-window statuses — the resolution respawn needs the conversation
  // that asked the question.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const state = sprintEngineStateFixture({
    tasks: [task({ id: 'T-held', role: 'developer', status: 'needs_input', boardColumn: 'needs_input', ownerAgentId: 'developer-1' })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-held' }),
    },
  })
  const parkedClock = new Map([[sprintEngineIdleClockKey(workspace, 'developer-1'), now - AUTO_RUN_IDLE_RETIREMENT_MS - 60_000]])
  const plan = taskScopedPlanInput({ workspace, state, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(plan.retirements.length, 1)
  assert.equal(plan.retirements[0].retainResumeState, true, 'a needs_input hold keeps the resume token for the resolution respawn')
}

function testReconcileLaunchFlagsPreservesRetainedResumeShape(): void {
  // Review finding: the mount-time launch-flag reconcile (app remount, second
  // sync window) must not wipe the deliberately-parked resume token.
  const retainedAgent = {
    ...sprintAgent('developer-1', 'Dev One', 'claude-code'),
    cliSessionId: 'retained-token',
    cliResumeAvailable: true,
    cliStartRequested: false,
    cliHasLaunched: false,
  }
  const staleAgent = {
    ...sprintAgent('developer-2', 'Dev Two', 'claude-code'),
    cliSessionId: 'dead-session',
    cliResumeAvailable: false,
    cliStartRequested: true,
    cliHasLaunched: true,
  }
  installWorkspaceStore(workspaceFixture({ agents: { 'developer-1': retainedAgent, 'developer-2': staleAgent } }))
  useWorkspaceStore.getState().reconcileWorkspaceAgentLaunchFlags([])
  const agents = useWorkspaceStore.getState().workspaces[0].agents
  assert.equal(agents['developer-1'].cliSessionId, 'retained-token', 'the retained resume token survives the reconcile')
  assert.equal(agents['developer-1'].cliResumeAvailable, true)
  // A genuinely stale launch state still has its GATE cleared — which is what
  // stops an auto-resume — but keeps its session identity. `cliSessionId` is the
  // key to the agent's painted screen on disk; wiping it here made the mounting
  // terminal mint a fresh uuid, miss the snapshot, and spawn a fresh CLI.
  assert.equal(agents['developer-2'].cliStartRequested, false)
  assert.equal(agents['developer-2'].cliHasLaunched, false)
  assert.equal(agents['developer-2'].cliResumeAvailable, false)
  assert.equal(agents['developer-2'].cliSessionId, 'dead-session', 'identity survives; the resume gate does not')
}

async function testSpawnResumeBlockedForCrashedLiveFlags(): Promise<void> {
  // Coverage gap from review: the crashed-live guard (!cliHasLaunched &&
  // !cliStartRequested) must suppress resume — a crashed session's stale
  // terminal key is not a retention-shaped token.
  const spawns: Array<{ resume?: boolean; metadata?: { cliSessionId?: string } }> = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (
      sessionId: string, _c: number, _r: number, _cwd?: string, resume?: boolean,
      _sp?: string, _cli?: AgentCli, _p?: string, _rt?: unknown, _so?: boolean,
      metadata?: { cliSessionId?: string },
    ) => {
      spawns.push({ resume, metadata })
      return { ok: true, sessionId }
    },
    logDiagnostic: async (input) => input,
  })
  const supervisor = await loadSupervisor()
  const crashedAgent = {
    ...sprintAgent('developer-1', 'Dev One', 'claude-code'),
    cliSessionId: 'stale-terminal-key',
    cliResumeAvailable: true,
    cliStartRequested: true,
    cliHasLaunched: true,
  }
  const workspace = workspaceFixture({
    agents: { 'developer-1': crashedAgent },
    sprintEngineAutoState: {
      desiredMode: 'run_agents', runtimeState: 'running', cliPermissionPreset: 'default',
      maxConcurrentAgents: 3, deliveredAgentNotificationEventKeys: [],
    },
  })
  const state = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }) },
  })
  installWorkspaceStore({ ...workspace, sprintEngineState: state })
  const result = await supervisor.spawnAutoRunCandidate(
    workspace, state,
    { agentId: 'developer-1', label: 'Dev One', role: 'developer', taskId: 'T-mine' },
    { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    emptyMcpSettings, mutableRef(new Set<string>()),
  )
  assert.equal(result, 'started')
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].resume, false, 'crashed-live flags suppress resume even for the own task')
  assert.equal(spawns[0].metadata?.cliSessionId, undefined)
}

async function testWindowDisposalWithoutTokenFullyClears(): Promise<void> {
  // Coverage gap from review: a codex window disposal with NO captured
  // harness id has no resume token — the executor must fully clear rather
  // than retain cliResumeAvailable with a garbage token.
  const kills: string[] = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-developer',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'developer-1',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
        startedAt: 1,
      },
    ],
    terminalStatus: async () => ({ processAlive: true }),
    terminalWrite: async () => ({ ok: true }),
    terminalKill: async (sessionId: string) => {
      kills.push(sessionId)
      return { ok: true }
    },
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    logDiagnostic: async (input) => input,
  })
  const supervisor = await loadSupervisor()
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'review', boardColumn: 'review', ownerAgentId: 'developer-1' })],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }) },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'developer-1': sprintAgent('developer-1', 'Dev One', 'codex') },
    sprintEngineAutoState: {
      desiredMode: 'run_agents', runtimeState: 'running', cliPermissionPreset: 'default',
      maxConcurrentAgents: 3, deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)
  const idleClockByAgent = mutableRef(new Map<string, number>([
    [sprintEngineIdleClockKey(workspace, 'developer-1'), Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
  ]))
  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)
  assert.deepEqual(kills, ['session-developer'])
  const cleared = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspace.id)?.agents['developer-1']
  assert.equal(cleared?.cliSessionId, undefined, 'no captured harness id for a non-stable-id CLI → full clear')
  assert.equal(cleared?.cliResumeAvailable, false, 'fresh-brief fallback: resume availability is not retained without a token')
}

async function testStaleRetainedResumeStateClearedOnceTaskDone(): Promise<void> {
  // Review finding: an approval landing AFTER window disposal leaves a
  // purposeless retained token that would leak into completed-run teardown
  // (board reopen would resume the finished conversation). The supervise
  // cycle clears it once the bound task is done and no session is live.
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    terminalWrite: async () => ({ ok: true }),
    terminalSpawn: async (sessionId: string) => ({ ok: true, sessionId }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    logDiagnostic: async (input) => input,
  })
  const supervisor = await loadSupervisor()
  const retainedAgent = {
    ...sprintAgent('developer-1', 'Dev One', 'claude-code'),
    cliSessionId: 'stale-retained-token',
    cliResumeAvailable: true,
    cliStartRequested: false,
    cliHasLaunched: false,
  }
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-mine', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null }),
      task({ id: 'T-open', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }) },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'developer-1': retainedAgent },
    sprintEngineAutoState: {
      desiredMode: 'run_agents', runtimeState: 'running', cliPermissionPreset: 'default',
      maxConcurrentAgents: 3, deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)
  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, mutableRef(new Map<string, number>()))
  const cleared = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspace.id)?.agents['developer-1']
  assert.equal(cleared?.cliSessionId, undefined, 'the stale token is cleared once the bound task is done')
  assert.equal(cleared?.cliResumeAvailable, false)
}

async function testWindowDisposalRetainsResumeStateInStore(): Promise<void> {
  // Executor side of MC-1444 Phase 2: a retainResumeState retirement keeps the
  // resume token (captured harness id) and cliResumeAvailable on the agent
  // record while still clearing the launch flags that would let a mounted
  // panel respawn the PTY.
  const kills: string[] = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-developer',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'developer-1',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'claude-code',
        cliSessionId: 'captured-harness-id',
        startedAt: 1,
      },
    ],
    terminalStatus: async () => ({ processAlive: true }),
    terminalWrite: async () => ({ ok: true }),
    terminalKill: async (sessionId: string) => {
      kills.push(sessionId)
      return { ok: true }
    },
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'review', boardColumn: 'review', ownerAgentId: 'developer-1' })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    // A launched claude-code agent carries the resume caps stamped at session
    // assign; retirement reads those stamped flags (not the catalog).
    agents: {
      'developer-1': {
        ...sprintAgent('developer-1', 'Dev One', 'claude-code'),
        cliResumeAvailable: true,
        cliUsesStableSessionId: true,
      },
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)
  const idleClockByAgent = mutableRef(new Map<string, number>([
    [sprintEngineIdleClockKey(workspace, 'developer-1'), Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
  ]))

  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)

  assert.deepEqual(kills, ['session-developer'], 'the parked publisher is disposed past the idle window')
  const retained = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspace.id)?.agents['developer-1']
  assert.equal(retained?.cliSessionId, 'captured-harness-id', 'window disposal keeps the resume token')
  assert.equal(retained?.cliResumeAvailable, true, 'window disposal keeps resume availability')
  assert.equal(retained?.cliStartRequested, false, 'launch flags still clear so the panel does not respawn')
  assert.equal(retained?.cliHasLaunched, false, 'launch flags still clear so the panel does not respawn')
}

function testActiveAssignmentRescueStopsAfterTwoPromptsWithDiagnostic(): void {
  const now = Date.parse('2026-06-17T12:00:00Z')
  const workspace = workspaceFixture()
  const startedAt = new Date(now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS * 3).toISOString()
  const claimedTask = task({
    id: 'T-active',
    title: 'Render haunted house shell',
    role: 'developer',
    status: 'in_progress',
    boardColumn: 'in_progress',
    ownerAgentId: 'developer-1',
    startedAt,
  })
  const state = sprintEngineStateFixture({
    tasks: [claimedTask],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'running', currentTaskId: 'T-active' }),
    },
  })
  const key = sprintEngineActiveAssignmentLedgerKey(workspace, { taskId: 'T-active' }, 'developer-1')
  const commonInput = {
    workspace,
    sprintEngineState: state,
    now,
    runningAgentIds: new Set(['developer-1']),
    idleAgentIds: new Set<string>(),
    dispatchLedger: new Map<string, SprintEngineDispatchAttempt>(),
    paths: new Set<SprintEngineDispatchPath>(['active_assignment']),
  }

  const secondPrompt = planSprintEngineDispatch({
    ...commonInput,
    continuationLedger: new Map<string, SprintEngineDispatchAttempt>([[key, { sentAt: now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS - 1_000, attempts: 1 }]]),
  })
  assert.equal(secondPrompt.pastes.length, 1, 'the second continuation prompt is allowed after another inactive hour')
  assert.equal(secondPrompt.pastes[0].prompt, 'Continue.')
  assert.equal(secondPrompt.diagnostics.length, 0)

  const exhausted = planSprintEngineDispatch({
    ...commonInput,
    continuationLedger: new Map<string, SprintEngineDispatchAttempt>([[key, { sentAt: now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS - 1_000, attempts: AUTO_RUN_ACTIVE_ASSIGNMENT_MAX_PROMPTS }]]),
  })
  assert.equal(exhausted.pastes.length, 0, 'the prompt cap suppresses further continuation pastes')
  assert.equal(exhausted.diagnostics.length, 1, 'exhausting rescue budget surfaces operator attention')
  assert.equal(exhausted.diagnostics[0].markExhausted, true)
  assert.equal(exhausted.diagnostics[0].diagnostic.level, 'warning')

  const alreadyReported = planSprintEngineDispatch({
    ...commonInput,
    continuationLedger: new Map<string, SprintEngineDispatchAttempt>([[key, {
      sentAt: now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS - 1_000,
      attempts: AUTO_RUN_ACTIVE_ASSIGNMENT_MAX_PROMPTS,
      exhaustedAt: now - 1_000,
    }]]),
  })
  assert.equal(alreadyReported.pastes.length, 0)
  assert.equal(alreadyReported.diagnostics.length, 0, 'the operator diagnostic is not emitted again every tick')
}

async function testActiveAssignmentExhaustionDiagnosticMarksLedger(): Promise<void> {
  const now = Date.parse('2026-06-17T12:00:00Z')
  const diagnostics: unknown[] = []
  installTestWindow({
    terminalList: async () => [],
    logDiagnostic: async (input) => {
      diagnostics.push(input)
      return input
    },
  })
  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture()
  const startedAt = new Date(now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS * 3).toISOString()
  const claimedTask = task({
    id: 'T-active',
    title: 'Render haunted house shell',
    role: 'developer',
    status: 'in_progress',
    boardColumn: 'in_progress',
    ownerAgentId: 'developer-1',
    startedAt,
  })
  const state = sprintEngineStateFixture({
    tasks: [claimedTask],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'running', currentTaskId: 'T-active' }),
    },
  })
  const key = sprintEngineActiveAssignmentLedgerKey(workspace, { taskId: 'T-active' }, 'developer-1')
  const ledger = new Map<string, SprintEngineDispatchAttempt>([[key, {
    sentAt: now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS - 1_000,
    attempts: AUTO_RUN_ACTIVE_ASSIGNMENT_MAX_PROMPTS,
  }]])
  const plan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: state,
    now,
    runningAgentIds: new Set(['developer-1']),
    idleAgentIds: new Set(),
    continuationLedger: ledger,
    dispatchLedger: new Map(),
    paths: new Set<SprintEngineDispatchPath>(['active_assignment']),
  })

  await supervisor.executeSprintEngineDispatchPlan(
    workspace,
    plan,
    { continuation: mutableRef(ledger), dispatch: mutableRef(new Map()) }
  )

  assert.equal(diagnostics.length, 1, 'exhausted active-assignment rescue publishes one operator diagnostic')
  assert.ok(ledger.get(key)?.exhaustedAt, 'diagnostic execution marks the rescue ledger exhausted')
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
      'security': sprintAgent('security', 'Code Reviewer'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  const state = sprintEngineStateFixture({
    goal: 'Ship registry-driven runtime renderer integration',
    sprintEngineAgents: {
      'security': runtimeAgent('security'),
    },
  })
  installWorkspaceStore({ ...workspace, sprintEngineState: state })

  const result = await supervisor.spawnAutoRunCandidate(
    workspace,
    state,
    {
      agentId: 'security',
      label: 'Code Reviewer',
      role: 'security',
      taskId: 'T4',
    },
    { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    emptyMcpSettings,
    mutableRef(new Set<string>()),
  )

  assert.equal(result, 'started')
  assert.equal(spawns.length, 1, 'missing terminal spawn path calls terminalSpawn once')
  assert.equal(spawns[0].cwd, '/tmp/workspace')
  assert.equal(spawns[0].statePath, '/tmp/workspace/.multi-code/sprintengine/team/run.yaml')
  assert.equal(spawns[0].cli, 'codex')
  assert.equal(spawns[0].metadata?.agentSession?.workId, 'T4')
  assert.equal(spawns[0].metadata?.agentSession?.role, 'security')
  assert.equal(spawns[0].metadata?.visible, false, 'normal auto-run spawns stay background')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.agent.join'), 'startup prompt names the MCP join tool')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.task.next'), 'startup prompt names the MCP task claim tool')
  assert.ok(!spawns[0].initialPrompt?.includes('sprintengine.agent.next_directive'), 'startup prompt does not route through the directive hop')
  assert.ok(spawns[0].initialPrompt?.includes('"role": "security"'), 'startup prompt embeds the role in the MCP payload')
  assert.ok(spawns[0].initialPrompt?.includes('"agentId": "security"'), 'startup prompt embeds the agentId in the MCP payload')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(spawns[0].initialPrompt ?? ''),
    'startup prompt does not contain any sprintengine CLI command instructions'
  )
}

async function testSuperviseRunnerCycleMintsWorkerForUncoveredReadyTask(): Promise<void> {
  // MC-1591 leases: with the roster ledger gone, an uncovered ready task is
  // covered by a worker id the supervisor MINTS locally (no roster-replenish
  // round-trip). A spent/retired id is never reused — developer-1 already
  // exists, so the mint allocates the next free id, developer-2, and spawns it.
  const spawns: Array<{ agentId?: string; cli?: AgentCli; initialPrompt?: string }> = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (
      sessionId: string,
      _cols: number,
      _rows: number,
      _cwd?: string,
      _resume?: boolean,
      _statePath?: string,
      cli?: AgentCli,
      initialPrompt?: string,
      _cliRuntimes?: unknown,
      _shellOnly?: boolean,
      metadata?: { agentId?: string; agentSession?: { role?: string } },
    ) => {
      spawns.push({ agentId: metadata?.agentId, cli, initialPrompt })
      return { ok: true, sessionId }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const initialState = sprintEngineStateFixture({
    runner: {
      cliWatchPolling: 'enabled',
      pollIntervalSeconds: 5,
      idleBackoffSeconds: 5,
      maxBackoffSeconds: 30,
      stopWhenComplete: true,
    },
    // roleRuntimes pins each role's cli/model (MC-1450); a minted worker that is
    // not yet in workspace.agents resolves its runtime from here at spawn.
    roleRuntimes: { developer: { cli: 'claude-code', model: null } },
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'retired' }),
    },
    tasks: [task({ id: 'T-ready', title: 'Ready developer task', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
  })
  const workspace = workspaceFixture({
    sprintEngineState: initialState,
    agents: {
      'developer-1': sprintAgent('developer-1', 'Perry'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState: initialState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent: mutableRef(new Map()),
  })

  const mintedSpawn = spawns.find((spawn) => spawn.agentId === 'developer-2')
  assert.ok(
    mintedSpawn,
    `a freshly minted worker is spawned for the uncovered ready task in the same supervise cycle; spawned ${JSON.stringify(spawns)}`
  )
  assert.ok(!spawns.some((spawn) => spawn.agentId === 'developer-1'), 'the spent/retired id is not reused')
  assert.equal(mintedSpawn.cli, 'claude-code')
  assert.ok(mintedSpawn.initialPrompt?.includes('sprintengine.agent.join'), 'minted spawn names the MCP join tool')
  assert.ok(
    mintedSpawn.initialPrompt?.includes('"role": "developer"') && mintedSpawn.initialPrompt?.includes('"agentId": "developer-2"'),
    'minted spawn embeds the MCP payload for the new agent'
  )
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(mintedSpawn.initialPrompt ?? ''),
    'minted spawn prompt does not embed any sprintengine CLI command'
  )
}

async function testSuperviseRunnerCycleRestartsExitedRoleForReadyTask(): Promise<void> {
  const spawns: Array<{ agentId?: string; cli?: AgentCli; initialPrompt?: string }> = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (
      sessionId: string,
      _cols: number,
      _rows: number,
      _cwd?: string,
      _resume?: boolean,
      _statePath?: string,
      cli?: AgentCli,
      initialPrompt?: string,
      _cliRuntimes?: unknown,
      _shellOnly?: boolean,
      metadata?: { agentId?: string },
    ) => {
      spawns.push({ agentId: metadata?.agentId, cli, initialPrompt })
      return { ok: true, sessionId }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const readyReviewTask = task({
    id: 'T6',
    title: 'Review phase-1 implementation quality',
    role: 'security',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
    dependsOn: ['T5'],
  })
  const sprintEngineState = sprintEngineStateFixture({
    runner: { cliWatchPolling: 'enabled', pollIntervalSeconds: 10, idleBackoffSeconds: 30, maxBackoffSeconds: 120, stopWhenComplete: true },
    sprintEngineAgents: {
      security: runtimeAgent('security', { status: 'idle', currentTaskId: null }),
    },
    tasks: [readyReviewTask],
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: {
      security: {
        ...sprintAgent('security', 'Shawn'),
        cliLastExitedAt: Date.now() - 60_000,
        cliStartRequested: false,
        cliHasLaunched: false,
      },
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(spawns.length, 1, `exited role agent should restart for ready work; spawns ${JSON.stringify(spawns)}`)
  assert.equal(spawns[0].agentId, 'security')
  assert.equal(spawns[0].cli, 'codex')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.agent.join'), 'restarted security prompt names the MCP join tool')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.task.next'), 'restarted security prompt names the MCP task claim tool')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(spawns[0].initialPrompt ?? ''),
    'restarted security prompt does not embed any sprintengine CLI command'
  )
}

type CapturedSpawn = { agentId?: string; cli?: AgentCli; initialPrompt?: string }

function installRespawnTestWindow(spawns: CapturedSpawn[]): void {
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (
      sessionId: string,
      _cols: number,
      _rows: number,
      _cwd?: string,
      _resume?: boolean,
      _statePath?: string,
      cli?: AgentCli,
      initialPrompt?: string,
      _cliRuntimes?: unknown,
      _shellOnly?: boolean,
      metadata?: { agentId?: string },
    ) => {
      spawns.push({ agentId: metadata?.agentId, cli, initialPrompt })
      return { ok: true, sessionId }
    },
    logDiagnostic: async (input) => input,
  })
}

const respawnTestCliRuntimes = {
  codex: { command: 'codex', useWsl: false },
  'claude-code': { command: 'claude', useWsl: false },
}

function testRevivesDepartedWorkerForOwnTask(): void {
  // Derived-liveness revival (T2): idle-retirement disposes a worker's terminal;
  // the agent reads as plain `idle` (no `left`/`dead`) with its durable
  // `lastOwnedTaskId` retained. Single-owner tasks (MC-1542) keep that owner
  // through `review`, so while no live agent of the role exists the respawn path
  // REVIVES the id bound to the task by ownership — no status read — and its
  // fresh session resumes the work.
  const now = Date.parse('2026-06-28T22:00:00Z')
  const reworkTask = task({
    id: 'T-rework',
    title: 'Developer task still owned through review',
    role: 'developer',
    status: 'review',
    boardColumn: 'review',
    ownerAgentId: 'developer-1',
  })
  const workspace = workspaceFixture({ agents: { 'developer-1': sprintAgent('developer-1', 'Perry') } })
  const departedOwner = { 'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-rework' }) }

  const plan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({ tasks: [reworkTask], sprintEngineAgents: departedOwner }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(plan.respawns.length, 1, `the departed owner is revived for its own task; respawns ${JSON.stringify(plan.respawns)}`)
  assert.equal(plan.respawns[0].agentId, 'developer-1', 'the id that last owned the task is revived, not a fresh replacement')
  assert.equal(plan.respawns[0].role, 'developer')
  assert.equal(plan.respawns[0].taskId, 'T-rework')

  // A fresh, never-owned ready task is NOT a revival: no departed id is bound to
  // it, so the candidate picker (not this path) mints a fresh worker for it.
  const freshTask = task({
    id: 'T-fresh',
    title: 'Fresh developer task',
    role: 'developer',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
  })
  const freshPlan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({
      tasks: [freshTask],
      // The idle developer never owned T-fresh, so owner affinity finds no match.
      sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-other' }) },
    }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(freshPlan.respawns.length, 0, 'a fresh unowned ready task is not a revival (fresh-task picker owns it)')

  // No revival when a live agent of the role already exists — it claims the work
  // through the normal idle picker, so we must not spawn a redundant one.
  const planWithLiveAgent = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({
      tasks: [reworkTask],
      sprintEngineAgents: {
        'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-rework' }),
        'developer-2': runtimeAgent('developer', { status: 'idle' }),
      },
    }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(['developer-2']),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(planWithLiveAgent.respawns.length, 0, 'no revival when a live agent of the role exists')

  // Storm guard: once the shared `respawn:` recovery ledger key has hit the retry
  // cap, revival stops (no endless respawn of a broken CLI). MC-1592 unified
  // claimed-work respawns and departed-owner revivals onto this one namespace;
  // while the revival is still an active recovery target its key must NOT be swept.
  const reviveKey = sprintEngineRespawnLedgerKey(workspace, { taskId: 'T-rework' }, 'developer-1')
  const cappedPlan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({ tasks: [reworkTask], sprintEngineAgents: departedOwner }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map([
      [reviveKey, { sentAt: now - 120_000, attempts: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES }],
    ]),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(cappedPlan.respawns.length, 0, 'revival stops once the retry cap is reached')
  assert.ok(
    cappedPlan.skips.some((skip) => skip.event === 'revive-retry-limit-reached'),
    'a capped revival emits the retry-limit skip event',
  )
  assert.ok(
    !cappedPlan.ledgerDeletes.some((del) => del.key === reviveKey),
    'an active revival target keeps its ledger key (not swept), so the retry cap holds across passes',
  )

  // An unmanaged claimant (no workspace.agents entry, e.g. a headless CLI) has no
  // renderer terminal to spawn, so it is never revived.
  const unmanagedPlan = planSprintEngineDispatch({
    workspace: workspaceFixture({ agents: {} }),
    sprintEngineState: sprintEngineStateFixture({ tasks: [reworkTask], sprintEngineAgents: departedOwner }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(unmanagedPlan.respawns.length, 0, 'an unmanaged departed owner is not revived (no terminal to spawn)')

  // Sweep: a `respawn:` recovery ledger entry for work that is NO LONGER an active
  // recovery target (here, a task that no longer exists) is deleted, so a
  // maxed-out retry budget resets and can't permanently block a future recovery.
  const staleReviveKey = sprintEngineRespawnLedgerKey(workspace, { taskId: 'T-gone' }, 'developer-1')
  const sweepPlan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({ tasks: [reworkTask], sprintEngineAgents: departedOwner }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map([
      [staleReviveKey, { sentAt: now - 120_000, attempts: 1 }],
    ]),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.ok(
    sweepPlan.ledgerDeletes.some((del) => del.key === staleReviveKey),
    'a stale respawn: ledger entry (no active target) is swept so its retry budget resets',
  )
}

function testRevivesDepartedPlanningAgentForNewReadyTask(): void {
  // Planning persistence (MC-1454): a departed architect is revived under its
  // SAME id for the NEXT ready task of its role — not only its own rework.
  // Its retained lastOwnedTaskId points at a PRIOR task that is not itself a
  // claimable wake target, so the owner-affinity pass alone would leave it
  // parked while a fresh architect task sits ready.
  const now = Date.parse('2026-06-28T22:00:00Z')
  const readyArchitectTask = task({
    id: 'T-plan-2',
    title: 'Next architect task',
    role: 'architect',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
  })
  const workspace = workspaceFixture({ agents: { architect: sprintAgent('architect', 'Ada') } })
  const departedArchitect = { architect: runtimeAgent('architect', { lastOwnedTaskId: 'T0' }) }

  const plan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({ tasks: [readyArchitectTask], sprintEngineAgents: departedArchitect }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(plan.respawns.length, 1, `a departed planner is revived for a new ready task; respawns ${JSON.stringify(plan.respawns)}`)
  assert.equal(plan.respawns[0].agentId, 'architect', 'revived under the SAME architect id, never architect-N')
  assert.equal(plan.respawns[0].role, 'architect')
  assert.equal(plan.respawns[0].taskId, 'T-plan-2')

  // No revival when a live architect exists — it claims the ready task via the
  // normal picker, so no redundant respawn.
  const liveArchitectPlan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({
      tasks: [readyArchitectTask],
      sprintEngineAgents: {
        architect: runtimeAgent('architect', { lastOwnedTaskId: 'T0' }),
        'architect-live': runtimeAgent('architect'),
      },
    }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(['architect-live']),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(liveArchitectPlan.respawns.length, 0, 'no planning revival when a live agent of the role exists')

  // Contrast: a departed NON-planning worker is NOT revived for a new unowned
  // task — worker revival stays owner-scoped (fresh-task minting owns new claims).
  const developerPlan = planSprintEngineDispatch({
    workspace: workspaceFixture({ agents: { 'developer-1': sprintAgent('developer-1', 'Dev') } }),
    sprintEngineState: sprintEngineStateFixture({
      tasks: [task({ id: 'T-new-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
      sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-old' }) },
    }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(developerPlan.respawns.length, 0, 'a departed worker is not revived for a new unowned task (owner affinity only)')
}

function testLegacyLeftDeadAgentStatusCoercesToIdle(): void {
  // Legacy tolerance (T2): a projection or persisted state written before
  // liveness was unified may carry a `left`/`dead` agent status. Both load
  // paths coerce any status outside the modelled set to `idle` so the payload
  // reads clean without a type violation.
  const projection = normalizeSprintEngineProjection({
    run: { name: 'Legacy run' },
    roster: {
      'developer-1': { role: 'developer', status: 'left', currentTaskId: null, lastOwnedTaskId: 'T1' },
      'security-1': { role: 'security', status: 'dead', currentTaskId: null },
    },
    tasks: [],
    artifacts: [],
  })
  assert.equal(projection?.sprintEngineAgents['developer-1'].status, 'idle', 'legacy left status loads as idle from a projection')
  assert.equal(projection?.sprintEngineAgents['developer-1'].lastOwnedTaskId, 'T1', 'the departed owner keeps its task binding')
  assert.equal(projection?.sprintEngineAgents['security-1'].status, 'idle', 'legacy dead status loads as idle from a projection')

  // Persisted renderer state (already SprintEngineState-shaped) is coerced too;
  // the legacy values are cast in because they are no longer in the union.
  const persisted = normalizeSprintEngineState(sprintEngineStateFixture({
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'left' as SprintEngineRuntimeAgent['status'], currentTaskId: null, lastOwnedTaskId: 'T1' },
    },
  }))
  assert.equal(persisted?.sprintEngineAgents['developer-1'].status, 'idle', 'legacy left status coerces to idle from persisted state')
  assert.equal(persisted?.sprintEngineAgents['developer-1'].lastOwnedTaskId, 'T1', 'coercion preserves the retained task binding')
}

async function testRespawnsDeadTaskClaimantAfterRestart(): Promise<void> {
  // Restart-recovery regression: a task claimed before an app restart whose
  // owner has no live terminal must get its claimant respawned (the claim
  // tools resume their own claims), instead of deadlocking forever because
  // prompts require a live terminal and spawns skip claimed work.
  const spawns: CapturedSpawn[] = []
  installRespawnTestWindow(spawns)

  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    agents: { 'developer-1': sprintAgent('developer-1', 'Devin') },
  })
  const state = sprintEngineStateFixture({
    tasks: [task({
      id: 'T1',
      title: 'Implement claimed work',
      role: 'developer',
      status: 'in_progress',
      boardColumn: 'in_progress',
      ownerAgentId: 'developer-1',
    })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'running', currentTaskId: 'T1' }),
    },
  })
  installWorkspaceStore(workspace)
  const sent = mutableRef(new Map<string, { sentAt: number; attempts?: number }>())

  await supervisor.respawnDeadSprintEngineClaimants(
    workspace,
    state,
    new Set(),
    new Set<string>(),
    sent,
    { cliRuntimes: respawnTestCliRuntimes, mcpSettings: emptyMcpSettings, inFlightSpawns: mutableRef(new Set<string>()) }
  )

  assert.equal(spawns.length, 1, `dead task claimant is respawned; spawns ${JSON.stringify(spawns)}`)
  assert.equal(spawns[0].agentId, 'developer-1')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.agent.join'), 'respawn prompt names the MCP join tool')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.task.next'), 'respawn prompt names the task claim tool')
  const key = sprintEngineRespawnLedgerKey(workspace, { taskId: 'T1' }, 'developer-1')
  assert.equal(sent.current.get(key)?.attempts, 1, 'respawn attempt is recorded in the unified attempt ledger')

  // Within the cooldown window the planner must not respawn again.
  await supervisor.respawnDeadSprintEngineClaimants(
    workspace,
    state,
    new Set(),
    new Set<string>(),
    sent,
    { cliRuntimes: respawnTestCliRuntimes, mcpSettings: emptyMcpSettings, inFlightSpawns: mutableRef(new Set<string>()) }
  )
  assert.equal(spawns.length, 1, 'no second respawn inside the cooldown window')
}

async function testRespawnSkipsLiveCappedNeedsInputAndCoolingClaimants(): Promise<void> {
  const spawns: CapturedSpawn[] = []
  installRespawnTestWindow(spawns)

  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    agents: {
      'developer-live': sprintAgent('developer-live', 'Liv'),
      'developer-blocked': sprintAgent('developer-blocked', 'Bea'),
      'developer-capped': sprintAgent('developer-capped', 'Cap'),
      'developer-cooling': sprintAgent('developer-cooling', 'Coda'),
    },
  })
  const claimedTask = (id: string, ownerAgentId: string) => task({
    id,
    role: 'developer',
    status: 'in_progress',
    boardColumn: 'in_progress',
    ownerAgentId,
  })
  const state = sprintEngineStateFixture({
    tasks: [
      claimedTask('T1', 'developer-live'),
      claimedTask('T2', 'developer-blocked'),
      claimedTask('T3', 'developer-capped'),
      claimedTask('T4', 'developer-cooling'),
    ],
    sprintEngineAgents: {
      'developer-live': runtimeAgent('developer', { status: 'running', currentTaskId: 'T1' }),
      'developer-blocked': runtimeAgent('developer', { status: 'needs_input', currentTaskId: 'T2' }),
      'developer-capped': runtimeAgent('developer', { status: 'running', currentTaskId: 'T3' }),
      'developer-cooling': runtimeAgent('developer', { status: 'running', currentTaskId: 'T4' }),
    },
  })
  installWorkspaceStore(workspace)
  const cappedKey = sprintEngineRespawnLedgerKey(workspace, { taskId: 'T3' }, 'developer-capped')
  const coolingKey = sprintEngineRespawnLedgerKey(workspace, { taskId: 'T4' }, 'developer-cooling')
  const sent = mutableRef(new Map<string, { sentAt: number; attempts?: number }>([
    [cappedKey, { sentAt: Date.now() - 120_000, attempts: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES }],
    [coolingKey, { sentAt: Date.now() - 5_000, attempts: 1 }],
  ]))

  await supervisor.respawnDeadSprintEngineClaimants(
    workspace,
    state,
    new Set(['developer-live']),
    new Set<string>(),
    sent,
    { cliRuntimes: respawnTestCliRuntimes, mcpSettings: emptyMcpSettings, inFlightSpawns: mutableRef(new Set<string>()) }
  )

  assert.equal(
    spawns.length,
    0,
    `live, needs_input, capped, and cooling-down claimants are never respawned; spawns ${JSON.stringify(spawns)}`
  )
  assert.equal(
    sent.current.get(cappedKey)?.attempts,
    supervisor.AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES,
    'capped respawn budget is not consumed further'
  )
  assert.equal(sent.current.get(coolingKey)?.attempts, 1, 'cooldown does not consume respawn budget')
}

async function testSuperviseRunnerCycleRespawnsDeadClaimantsAtFullOccupancy(): Promise<void> {
  // The live-reproduced restart deadlock: every concurrency slot is consumed
  // by an in-progress task whose owner terminal died with the app, so the
  // cycle used to return at `no-slots` every tick without ever spawning. The
  // respawn path must recover all claimants before slot accounting runs.
  const spawns: CapturedSpawn[] = []
  installRespawnTestWindow(spawns)

  const supervisor = await loadSupervisor()
  const claimedTask = (id: string, ownerAgentId: string) => task({
    id,
    role: 'developer',
    status: 'in_progress',
    boardColumn: 'in_progress',
    ownerAgentId,
  })
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [
      claimedTask('T1', 'developer-1'),
      claimedTask('T2', 'developer-2'),
      claimedTask('T3', 'developer-3'),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'running', currentTaskId: 'T1' }),
      'developer-2': runtimeAgent('developer', { status: 'running', currentTaskId: 'T2' }),
      'developer-3': runtimeAgent('developer', { status: 'running', currentTaskId: 'T3' }),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: {
      'developer-1': sprintAgent('developer-1', 'Devin'),
      'developer-2': sprintAgent('developer-2', 'Drew'),
      'developer-3': sprintAgent('developer-3', 'Dale'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: respawnTestCliRuntimes,
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(
    spawns.length,
    3,
    `all dead claimants are respawned despite zero free slots; spawned ${JSON.stringify(spawns.map((spawn) => spawn.agentId))}`
  )
  assert.deepEqual(
    spawns.map((spawn) => spawn.agentId).sort(),
    ['developer-1', 'developer-2', 'developer-3']
  )
  for (const spawn of spawns) {
    assert.ok(spawn.initialPrompt?.includes('sprintengine.agent.join'), 'respawn prompt names the MCP join tool')
    assert.ok(spawn.initialPrompt?.includes('sprintengine.task.next'), 'respawn prompt names the task claim tool')
  }
}

async function testAllPathsPlanNeverPastesAndKillsSameAgentInOnePass(): Promise<void> {
  // Cross-path per-agent dedup regression: a live-idle agent parked past the
  // idle-retirement window (kill-eligible) also has a claimable ready task of
  // its role (wake-paste-eligible). One supervise pass must engage the agent
  // exactly once — the wake paste — and never kill the terminal it just pasted
  // into.
  const writes: Array<{ sessionId: string; text: string }> = []
  const kills: string[] = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-reviewer',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'security-1',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
        startedAt: 1,
      },
    ],
    terminalStatus: async () => ({ processAlive: true }),
    terminalWrite: async (sessionId: string, text: string) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    terminalKill: async (sessionId: string) => {
      kills.push(sessionId)
      return { ok: true }
    },
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const readyReviewTask = task({
    id: 'T-ready',
    title: 'Ownerless ready review task',
    role: 'security',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
  })
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [readyReviewTask],
    sprintEngineAgents: {
      'security-1': runtimeAgent('security', { status: 'idle', currentTaskId: null }),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'security-1': sprintAgent('security-1', 'Shawn') },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)
  // Parked past the retirement window, so the idle_retire path would kill it if
  // the wake paste did not engage the agent first.
  const idleClockByAgent = mutableRef(new Map<string, number>([
    [sprintEngineIdleClockKey(workspace, 'security-1'), Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
  ]))

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: respawnTestCliRuntimes,
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent,
  })

  assert.equal(writes.length, 2, `exactly one engagement for the agent plus submit; writes ${JSON.stringify(writes.map((write) => write.sessionId))}`)
  assert.ok(writes[0].text.includes('sprintengine.task.next'), 'the single engagement is the ready-task wake paste')
  assert.deepEqual(kills, [], 'a terminal that received a paste this pass is never killed in the same pass')
}

async function testNotificationPasteSuppressesSamePassDispatchPaste(): Promise<void> {
  // Notification decisions are part of the one reconcile plan: a target that
  // receives a notification paste is engaged for the pass, so the durable
  // dispatch prompt for the same agent waits for the next tick instead of
  // landing as a second instruction in the same pass.
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend-2',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
        startedAt: 1,
      },
    ],
    terminalStatus: async () => ({ processAlive: true }),
    terminalWrite: async (sessionId: string, text: string) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const event = reworkNotificationEvent({ taskId: undefined })
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [task({ id: 'T4', role: 'frontend', status: 'in_progress', boardColumn: 'in_progress', ownerAgentId: 'frontend-2' })],
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', {
        status: 'running',
        currentTaskId: null,
        currentDispatch: {
          dispatchId: 'DISP-T4',
          targetKind: 'task',
          role: 'frontend',
          taskId: 'T4',
          reason: 'task_claimed',
        },
      }),
    },
    events: [event],
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'frontend-2': sprintAgent('frontend-2', 'Zion') },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: respawnTestCliRuntimes,
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(
    writes.length,
    2,
    `the engaged notification target gets exactly one instruction plus submit this pass; writes ${JSON.stringify(writes.map((write) => write.text.slice(0, 60)))}`
  )
  assert.ok(writes[0].text.includes('Sprint notification.'), 'the first write is the notification paste')
}

function idleReviewerCycleFixtures(input: { tasks: SprintEngineTask[]; reviewerOverrides?: Partial<SprintEngineRuntimeAgent> }): {
  workspace: Workspace
  sprintEngineState: SprintEngineState
} {
  const sprintEngineState = sprintEngineStateFixture({
    tasks: input.tasks,
    sprintEngineAgents: {
      'security-1': runtimeAgent('security', { status: 'idle', currentTaskId: null, ...input.reviewerOverrides }),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'security-1': sprintAgent('security-1', 'Shawn') },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  return { workspace, sprintEngineState }
}

function installIdleRetirementTestWindow(kills: string[], writes: Array<{ sessionId: string; text: string }>): void {
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-reviewer',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'security-1',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
        startedAt: 1,
      },
    ],
    terminalStatus: async () => ({ processAlive: true }),
    terminalWrite: async (sessionId: string, text: string) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    terminalKill: async (sessionId: string) => {
      kills.push(sessionId)
      return { ok: true }
    },
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    logDiagnostic: async (input) => input,
  })
}

async function runIdleRetirementCycle(
  supervisor: Awaited<ReturnType<typeof loadSupervisor>>,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  idleClockByAgent: { current: Map<string, number> },
  retirementCooldownByAgent?: { current: Map<string, number> }
): Promise<void> {
  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: respawnTestCliRuntimes,
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent,
    retirementCooldownByAgent,
  })
}

async function testIdleRetirementClosesParkedTerminalPastWindow(): Promise<void> {
  // Operator invariant: visible terminals = active work. A live-idle agent
  // holding no claim, with no claimable work for its role, parked past the
  // retirement window, gets its terminal closed; lazy spawn revives the role
  // when work appears.
  const kills: string[] = []
  const writes: Array<{ sessionId: string; text: string }> = []
  installIdleRetirementTestWindow(kills, writes)

  const supervisor = await loadSupervisor()
  const { workspace, sprintEngineState } = idleReviewerCycleFixtures({
    // Ready work exists for a different role only, so the run is mid-flight
    // but nothing can engage the idle reviewer.
    tasks: [task({ id: 'T-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
  })
  installWorkspaceStore(workspace)
  const idleClockByAgent = mutableRef(new Map<string, number>([
    [sprintEngineIdleClockKey(workspace, 'security-1'), Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
  ]))

  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)

  assert.deepEqual(kills, ['session-reviewer'], 'the parked reviewer terminal is retired past the idle window')
  assert.equal(writes.length, 0, 'retirement sends no prompt; the terminal is simply closed')
}

async function testIdleRetirementCooldownSuppressesRespawnStorm(): Promise<void> {
  // Storm guard: once an idle terminal is retired, a respawn that idles straight
  // back past the window must NOT be retired again until the cooldown elapses.
  // Without the cooldown the retire->respawn->idle->retire loop spawns a fresh
  // CLI process every few minutes.
  const kills: string[] = []
  const writes: Array<{ sessionId: string; text: string }> = []
  installIdleRetirementTestWindow(kills, writes)

  const supervisor = await loadSupervisor()
  const { workspace, sprintEngineState } = idleReviewerCycleFixtures({
    tasks: [task({ id: 'T-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
  })
  installWorkspaceStore(workspace)
  const clockKey = sprintEngineIdleClockKey(workspace, 'security-1')
  const idleClockByAgent = mutableRef(new Map<string, number>([
    [clockKey, Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
  ]))
  const retirementCooldownByAgent = mutableRef(new Map<string, number>())

  // First cycle: retire the parked reviewer and record the cooldown.
  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent, retirementCooldownByAgent)
  assert.deepEqual(kills, ['session-reviewer'], 'first cycle retires the parked reviewer')
  assert.equal(
    retirementCooldownByAgent.current.has(clockKey),
    true,
    'the retirement is recorded in the cooldown ledger keyed by the stable agent id'
  )

  // Simulate a respawn that idles straight back past the window: the idle clock
  // for the same agent matures again, but the cooldown is still active.
  idleClockByAgent.current.set(clockKey, Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000)
  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent, retirementCooldownByAgent)
  assert.deepEqual(kills, ['session-reviewer'], 'the respawned reviewer is NOT retired again inside the cooldown window')

  // Past the cooldown, retirement resumes (a genuinely parked role is still parked).
  retirementCooldownByAgent.current.set(clockKey, Date.now() - supervisor.AUTO_RUN_RETIREMENT_COOLDOWN_MS - 1_000)
  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent, retirementCooldownByAgent)
  assert.deepEqual(kills, ['session-reviewer', 'session-reviewer'], 'retirement resumes once the cooldown elapses')
}

async function testIdleRetirementSparesClaimHoldersFreshIdlersAndVisibleTabs(): Promise<void> {
  const supervisor = await loadSupervisor()

  // Case 1: a fresh idler (clock inside the window) is not retired.
  {
    const kills: string[] = []
    const writes: Array<{ sessionId: string; text: string }> = []
    installIdleRetirementTestWindow(kills, writes)
    const { workspace, sprintEngineState } = idleReviewerCycleFixtures({
      tasks: [task({ id: 'T-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
    })
    installWorkspaceStore(workspace)
    const idleClockByAgent = mutableRef(new Map<string, number>([
      [sprintEngineIdleClockKey(workspace, 'security-1'), Date.now() - 30_000],
    ]))
    await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)
    assert.deepEqual(kills, [], 'an idler inside the retirement window keeps its terminal')
  }

  // Case 2: a claim holder past the window is never retired, and its idle
  // clock entry is cleared rather than left to mature.
  {
    const kills: string[] = []
    const writes: Array<{ sessionId: string; text: string }> = []
    installIdleRetirementTestWindow(kills, writes)
    const { workspace, sprintEngineState } = idleReviewerCycleFixtures({
      tasks: [task({ id: 'T-own', role: 'security', status: 'in_progress', boardColumn: 'in_progress', ownerAgentId: 'security-1' })],
      reviewerOverrides: { status: 'running', currentTaskId: 'T-own' },
    })
    installWorkspaceStore(workspace)
    const clockKey = sprintEngineIdleClockKey(workspace, 'security-1')
    const idleClockByAgent = mutableRef(new Map<string, number>([
      [clockKey, Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
    ]))
    await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)
    assert.deepEqual(kills, [], 'a claim holder is never retired no matter how old its stale clock entry is')
    assert.equal(idleClockByAgent.current.has(clockKey), false, 'the stale idle clock entry is cleared for a claim holder')
  }

  // Case 3: the visible tab of the active workspace is never closed; the
  // retirement retries once the operator looks away.
  {
    const kills: string[] = []
    const writes: Array<{ sessionId: string; text: string }> = []
    installIdleRetirementTestWindow(kills, writes)
    const { workspace, sprintEngineState } = idleReviewerCycleFixtures({
      tasks: [task({ id: 'T-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
    })
    installWorkspaceStore(workspace)
    const layout: IJsonModel = {
      global: {},
      layout: {
        type: 'row',
        children: [{
          type: 'tabset',
          id: 'main',
          selected: 0,
          children: [{ type: 'tab', id: 'agent-tab', name: 'Shawn', component: 'agent', config: { agentId: 'security-1' } }],
        }],
      },
    }
    registerModel(workspace.id, Model.fromJson(layout))
    try {
      const idleClockByAgent = mutableRef(new Map<string, number>([
        [sprintEngineIdleClockKey(workspace, 'security-1'), Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
      ]))
      await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)
      assert.deepEqual(kills, [], 'the visible tab of the active workspace is never retired')
    } finally {
      unregisterModel(workspace.id)
    }
  }
}

async function testIdleRetirementSparesArchitectWithTriageWork(): Promise<void> {
  // Kill/respawn-storm regression: an idle architect past the window with
  // architect-actionable needs_input work must NOT be retired. Triage lives
  // outside the reconcile plan and respawns the architect whenever such work
  // exists, so retiring it here loops kill -> respawn -> retire every tick.
  const kills: string[] = []
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-architect',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'architect',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
        startedAt: 1,
      },
    ],
    terminalStatus: async () => ({ processAlive: true }),
    terminalWrite: async (sessionId: string, text: string) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    terminalKill: async (sessionId: string) => {
      kills.push(sessionId)
      return { ok: true }
    },
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [
      task({
        id: 'T-triage',
        role: 'architect',
        status: 'needs_input',
        boardColumn: 'in_progress',
        ownerAgentId: null,
        needsInput: { kind: 'architect', reason: 'Design decision required' } as SprintEngineTask['needsInput'],
      }),
    ],
    sprintEngineAgents: {
      architect: runtimeAgent('architect', { status: 'idle', currentTaskId: null }),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { architect: sprintAgent('architect', 'Aidan') },
  })
  installWorkspaceStore(workspace)
  const idleClockByAgent = mutableRef(new Map<string, number>([
    [sprintEngineIdleClockKey(workspace, 'architect'), Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
  ]))

  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)

  assert.ok(
    !kills.includes('session-architect'),
    'an architect with actionable needs_input triage work is never retired (triage owns that terminal)',
  )
}

async function testIdleRetirementResetsRetiredAgentLaunchState(): Promise<void> {
  // The kill alone does not stop a mounted-but-unfocused AgentPanel from
  // respawning the PTY (its `hasStarted` reads `cliStartRequested`). Retirement
  // must clear the agent's launch flags so the close sticks for one tick.
  const kills: string[] = []
  const writes: Array<{ sessionId: string; text: string }> = []
  installIdleRetirementTestWindow(kills, writes)

  const supervisor = await loadSupervisor()
  const { workspace, sprintEngineState } = idleReviewerCycleFixtures({
    tasks: [task({ id: 'T-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
  })
  installWorkspaceStore(workspace)
  const idleClockByAgent = mutableRef(new Map<string, number>([
    [sprintEngineIdleClockKey(workspace, 'security-1'), Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
  ]))

  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)

  assert.deepEqual(kills, ['session-reviewer'], 'the parked reviewer terminal is retired past the idle window')
  const retiredAgent = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspace.id)?.agents['security-1']
  assert.equal(retiredAgent?.cliStartRequested, false, 'retirement clears cliStartRequested so the renderer does not respawn the PTY')
  assert.equal(retiredAgent?.cliSessionId, undefined, 'retirement clears the dead session id')
}

async function testNotificationSpawnFailureAbortsRemainingPlanActions(): Promise<void> {
  // Failure boundary regression: a failed notification spawn stops the
  // automation (recordSpawnFailure), so the same reconcile pass must not go
  // on to paste prompts, kill terminals, or spawn respawns past that
  // boundary — the pre-fold cycle returned before any dispatch path ran.
  const writes: Array<{ sessionId: string; text: string }> = []
  const kills: string[] = []
  let spawnAttempts = 0
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend-2',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
        startedAt: 1,
      },
    ],
    terminalStatus: async () => ({ processAlive: false }),
    terminalWrite: async (sessionId: string, text: string) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    terminalKill: async (sessionId: string) => {
      kills.push(sessionId)
      return { ok: true }
    },
    terminalSpawn: async () => {
      spawnAttempts += 1
      return { ok: false, message: 'spawn backend unavailable' }
    },
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const notificationEvent = reworkNotificationEvent({ targetAgentId: 'developer-1', taskId: 'T-rework' })
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-rework', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null })],
    sprintEngineAgents: {
      // Dead notification target whose spawn will fail.
      'developer-1': runtimeAgent('developer', { status: 'idle', currentTaskId: null }),
      // Live agent with a durable dispatch due — its paste must NOT happen
      // once the notification spawn has failed.
      'frontend-2': runtimeAgent('frontend', {
        status: 'running',
        currentTaskId: null,
        currentDispatch: { dispatchId: 'DISP-1', targetKind: 'task', role: 'frontend', taskId: 'T-f', reason: 'task_claimed' },
      }),
    },
    events: [notificationEvent],
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: {
      'developer-1': sprintAgent('developer-1', 'Devin'),
      'frontend-2': sprintAgent('frontend-2', 'Zion'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: respawnTestCliRuntimes,
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(spawnAttempts, 1, 'exactly one spawn attempt (the failing notification spawn)')
  assert.equal(writes.length, 0, `no paste executes past the spawn-failure boundary; writes ${JSON.stringify(writes.map((write) => write.text.slice(0, 50)))}`)
  assert.deepEqual(kills, [], 'no terminal is killed past the spawn-failure boundary')
}

async function testSecondNotificationForSameAgentDefersToNextPass(): Promise<void> {
  // Per-agent dedup applies inside the notification path: two pending event
  // ids for one live target produce one paste this pass; the second event
  // stays undelivered and lands on the next pass.
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend-2',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
        startedAt: 1,
      },
    ],
    terminalWrite: async (sessionId: string, text: string) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const workspace = reworkNotificationWorkspaceFixture()
  const firstEvent = reworkNotificationEvent({ id: 'EV-rework-1' })
  const secondEvent = reworkNotificationEvent({ id: 'EV-rework-2', message: 'Second round of changes requested.' })
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', { status: 'running', currentTaskId: 'T-rework' }),
    },
    events: [firstEvent, secondEvent],
  })
  installWorkspaceStore(workspace)
  const sent = mutableRef(new Set<string>())

  await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set(['frontend-2']),
    respawnTestCliRuntimes,
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    sent
  )

  assert.equal(writes.length, 2, `one engagement per agent per pass plus submit; writes ${JSON.stringify(writes.map((write) => write.text.slice(0, 50)))}`)
  const firstKey = agentNotificationDeliveryKey(workspace, firstEvent)
  const secondKey = agentNotificationDeliveryKey(workspace, secondEvent)
  assert.equal(sent.current.has(firstKey), true, 'first event is delivered this pass')
  assert.equal(sent.current.has(secondKey), false, 'second event stays pending for the next pass')

  await supervisor.deliverAgentNotificationEvents(
    workspace,
    state,
    new Set(['frontend-2']),
    respawnTestCliRuntimes,
    emptyMcpSettings,
    mutableRef(new Set<string>()),
    sent
  )
  assert.equal(writes.length, 4, 'the deferred event is delivered and submitted on the next pass')
  assert.equal(sent.current.has(secondKey), true, 'second event is delivered on the next pass')
}

async function testTriageDefersWhenPlanEngagedArchitectThisPass(): Promise<void> {
  // Triage lives outside the reconcile plan; when the plan engaged the
  // architect this pass (e.g. a ready-task wake paste), triage must defer to
  // the next tick instead of stacking a second, contradictory instruction
  // into the same terminal.
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-architect',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'architect',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'codex',
        startedAt: 1,
      },
    ],
    terminalStatus: async () => ({ processAlive: true }),
    terminalWrite: async (sessionId: string, text: string) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [
      // Ready architect-role wake candidate for the live-idle architect.
      task({ id: 'T-arch', role: 'architect', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
      // Architect-actionable needs_input task owned by another agent.
      task({
        id: 'T-blocked',
        role: 'developer',
        status: 'needs_input',
        boardColumn: 'in_progress',
        ownerAgentId: 'developer-9',
        needsInput: { kind: 'architect', reason: 'Design decision required', question: 'Which schema?' },
      }),
    ],
    sprintEngineAgents: {
      architect: runtimeAgent('architect', { status: 'idle', currentTaskId: null }),
      'developer-9': runtimeAgent('developer', { status: 'needs_input', currentTaskId: 'T-blocked' }),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { architect: sprintAgent('architect', 'Ari') },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: respawnTestCliRuntimes,
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(
    writes.length,
    2,
    `the engaged architect receives exactly one instruction plus submit this pass; writes ${JSON.stringify(writes.map((write) => write.text.slice(0, 60)))}`
  )
  assert.ok(writes[0].text.includes('sprintengine.task.next'), 'the first write is the wake paste')
  assert.ok(
    !writes.some((write) => write.text.includes('sprintengine.triage.needs_input')),
    'no triage prompt is pasted in the same pass that engaged the architect'
  )
}

async function testSuperviseRunnerCycleBootstrapsOnlyArchitectForFreshRun(): Promise<void> {
  // The lazy-spawn headline: a fresh automation run with a full roster and no
  // tasks must spawn exactly one terminal — the architect carrying its stored
  // handoff prompt — never a roster-wide spawn burst.
  const spawns: Array<{ agentId?: string; cli?: AgentCli; initialPrompt?: string }> = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (
      sessionId: string,
      _cols: number,
      _rows: number,
      _cwd?: string,
      _resume?: boolean,
      _statePath?: string,
      cli?: AgentCli,
      initialPrompt?: string,
      _cliRuntimes?: unknown,
      _shellOnly?: boolean,
      metadata?: { agentId?: string },
    ) => {
      spawns.push({ agentId: metadata?.agentId, cli, initialPrompt })
      return { ok: true, sessionId }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const sprintEngineState = sprintEngineStateFixture({
    runner: { cliWatchPolling: 'enabled', pollIntervalSeconds: 10, idleBackoffSeconds: 30, maxBackoffSeconds: 120, stopWhenComplete: true },
    sprintEngineAgents: {
      architect: runtimeAgent('architect'),
      product: runtimeAgent('product'),
      developer: runtimeAgent('developer'),
      frontend: runtimeAgent('frontend'),
      security: runtimeAgent('security'),
      tester: runtimeAgent('tester'),
    },
    tasks: [],
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: {
      architect: { ...sprintAgent('architect', 'Ari'), cliStartupPrompt: 'Plan handoff for the team', cliOnboardingPromptSent: false },
      product: sprintAgent('product', 'Pia'),
      developer: sprintAgent('developer', 'Devin'),
      frontend: sprintAgent('frontend', 'Rio'),
      security: sprintAgent('security', 'Shawn'),
      tester: sprintAgent('tester', 'Tess'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 6,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(
    spawns.length,
    1,
    `fresh run spawns exactly one terminal (the architect), not the roster; spawned ${JSON.stringify(spawns.map((spawn) => spawn.agentId))}`
  )
  assert.equal(spawns[0].agentId, 'architect')
  assert.ok(
    spawns[0].initialPrompt?.includes('Plan handoff for the team'),
    'bootstrap delivers the stored architect handoff prompt'
  )
}

async function testSuperviseRunnerCycleReengagesStalledLiveIdleAgentForReadyTask(): Promise<void> {
  // Repro for the renderer-cli-plugin-catalog stall (T4 stuck unclaimed).
  // The frontend implementer's CLI is still ALIVE but idle — it finished its turn
  // and stopped — so getRunningAutoRunAgentIds reports it in runningAgentIds.
  // Meanwhile T4 sits ownerless and ready. Because the agent counts as "running":
  //   - pickNextAutoRuns excludes it from reusable role agents,
  // leaving capped wake-candidate prompts as the only re-engagement path. Once that
  // cap is reached the run is permanently stranded with a green "running" light.
  //
  // Desired behaviour: a stalled live-idle agent with claimable role work must be
  // re-engaged (spawn a replacement runner and/or keep nudging). This asserts that
  // re-engagement happens; it FAILS against current code, pinning the defect.
  const spawns: Array<{ agentId?: string; cli?: AgentCli }> = []
  const writes: Array<{ sessionId: string; text: string }> = []
  const kills: string[] = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-frontend-live',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'frontend',
        sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
        executionMode: 'current_workspace',
        cli: 'claude-code',
      },
    ],
    terminalStatus: async () => ({ processAlive: true }),
    terminalWrite: async (sessionId: string, text: string) => {
      writes.push({ sessionId, text })
      return { ok: true }
    },
    terminalKill: async (sessionId: string) => {
      kills.push(sessionId)
      return { ok: true }
    },
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (
      sessionId: string,
      _cols: number,
      _rows: number,
      _cwd?: string,
      _resume?: boolean,
      _statePath?: string,
      cli?: AgentCli,
      _initialPrompt?: string,
      _cliRuntimes?: unknown,
      _shellOnly?: boolean,
      metadata?: { agentId?: string },
    ) => {
      spawns.push({ agentId: metadata?.agentId, cli })
      return { ok: true, sessionId }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const readyTask = task({
    id: 'T4',
    title: 'Render installed plugins in Agents settings',
    role: 'frontend',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
    dependsOn: [],
  })
  const sprintEngineState = sprintEngineStateFixture({
    runner: { cliWatchPolling: 'enabled', pollIntervalSeconds: 10, idleBackoffSeconds: 30, maxBackoffSeconds: 120, stopWhenComplete: true },
    sprintEngineAgents: {
      frontend: runtimeAgent('frontend', { status: 'idle', currentTaskId: null }),
    },
    tasks: [readyTask],
  })

  // Sanity: the engine itself considers this claimable role work, so the stall is a
  // re-engagement gap, not a readiness problem.
  assert.ok(
    getSprintEngineWakeCandidateTasks(sprintEngineState).some((candidate) => candidate.id === 'T4'),
    'ownerless ready T4 is claimable frontend work',
  )

  const workspace = workspaceFixture({
    sprintEngineState,
    agents: {
      frontend: sprintAgent('frontend', 'Rio', 'claude-code'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  // The live-idle agent has already exhausted the wake-candidate prompt budget,
  // matching the stranded run after the supervisor gave up.
  const continuationKey = continuationMessageKey(workspace, 'T4', 'frontend')
  const sentContinuationMessages = mutableRef(new Map<string, { sentAt: number; attempts?: number }>([
    [continuationKey, { sentAt: Date.now() - 120_000, attempts: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES }],
  ]))

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages,
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent: mutableRef(new Map()),
  })

  // Before the fix: frontend is treated as "running", so no replacement is
  // spawned and the capped continuation path writes nothing — the task is
  // stranded. The fix re-engages by restarting (killing) the stalled terminal so
  // the exit→respawn path claims it next tick.
  assert.ok(
    kills.length + spawns.length + writes.length >= 1,
    `stalled live-idle frontend agent must be re-engaged for ownerless ready work; got kills=${JSON.stringify(kills)} spawns=${JSON.stringify(spawns)} writes=${writes.length}`,
  )
  assert.deepEqual(
    kills,
    ['session-frontend-live'],
    'the stalled frontend terminal is restarted so a fresh agent can claim the ready task',
  )
}

async function testSuperviseRunnerCycleDoesNotRestartUnresolvedNeedsInputOwner(): Promise<void> {
  const spawns: Array<{ agentId?: string; cli?: AgentCli; initialPrompt?: string }> = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (
      sessionId: string,
      _cols: number,
      _rows: number,
      _cwd?: string,
      _resume?: boolean,
      _statePath?: string,
      cli?: AgentCli,
      initialPrompt?: string,
      _cliRuntimes?: unknown,
      _shellOnly?: boolean,
      metadata?: { agentId?: string },
    ) => {
      spawns.push({ agentId: metadata?.agentId, cli, initialPrompt })
      return { ok: true, sessionId }
    },
    logDiagnostic: async (input) => input,
  })

  const supervisor = await loadSupervisor()
  const blockedTask = task({
    id: 'T-needs-input',
    title: 'Continue after resolved input',
    status: 'needs_input',
    boardColumn: 'needs_input',
    role: 'developer',
    ownerAgentId: 'developer-1',
    dependsOn: [],
  })
  const sprintEngineState = sprintEngineStateFixture({
    runner: { cliWatchPolling: 'enabled', pollIntervalSeconds: 10, idleBackoffSeconds: 30, maxBackoffSeconds: 120, stopWhenComplete: true },
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'needs_input', currentTaskId: 'T-needs-input' }),
    },
    tasks: [blockedTask],
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: {
      'developer-1': {
        ...sprintAgent('developer-1', 'Dana'),
        cliLastExitedAt: Date.now() - 60_000,
        cliStartRequested: false,
        cliHasLaunched: false,
      },
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 1,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(spawns.length, 0, `unresolved needs_input owner should not be restarted; spawns ${JSON.stringify(spawns)}`)
}

async function testSuperviseRunnerCycleDoesNotMutateTaskState(): Promise<void> {
  const mutations: string[] = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    terminalSpawn: async (sessionId: string) => ({ ok: true, sessionId }),
    logDiagnostic: async (input) => input,
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
  })
  const state = sprintEngineStateFixture({
    roleCounts: { security: 1 } as SprintEngineState['roleCounts'],
    sprintEngineAgents: {
      'security': runtimeAgent('security'),
    },
    tasks: [reviewTask],
  })
  const workspace = workspaceFixture({
    sprintEngineState: state,
    agents: {
      'security': sprintAgent('security', 'Code Reviewer'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState: state,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.deepEqual(mutations, [], 'auto-run dispatch paths must not call renderer task/artifact mutation APIs')
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
      targetKind: 'task',
      taskId: 'T3',
      reason: 'task_claimed',
    }),
    '/tmp/workspace/.multi-code/sprintengine/team/run.yaml:developer-1:task:T3::task_claimed',
    'dispatch delivery has a stable target fallback when dispatch id is unavailable'
  )
}

function testStartupPromptIsMcpNative(): void {
  const prompt = buildSprintEngineStartupPrompt('frontend', 'frontend-2', 'Ship MCP runtime', {
    executionCwd: '/tmp/workspace',
    workspaceRoot: '/tmp/workspace',
    sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    commandMode: 'join',
  })

  assert.ok(prompt.startsWith('Your first action is to run the MCP calls listed in the "First MCP Calls" section below'))
  assert.ok(prompt.includes('Worker cwd: /tmp/workspace'))
  assert.ok(!prompt.includes('/tmp/workspace/.multi-code/sprintengine/team/run.yaml'), 'startup prompt does not expose the run state path')
  assert.ok(prompt.includes('sprintengine.agent.join'), 'startup prompt names the MCP join tool')
  assert.ok(prompt.includes('sprintengine.task.next'), 'startup prompt names the MCP claim tool')
  assert.ok(!prompt.includes('sprintengine.agent.next_directive'), 'startup prompt does not route through the directive hop')
  assert.ok(!prompt.includes('"statePath"'), 'startup prompt must not embed statePath in the MCP payload; the managed MCP server resolves it from run context')
  assert.ok(prompt.includes('"role": "frontend"'), 'startup prompt embeds the role in the MCP payload')
  assert.ok(prompt.includes('"agentId": "frontend-2"'), 'startup prompt embeds the agentId in the join payload')
  assert.ok(prompt.includes('"id": "frontend-2"'), 'startup prompt embeds the agent id in the claim payload')
  assert.ok(!prompt.includes('"workspaceRoot"'), 'startup prompt must not embed workspaceRoot in the MCP payload; the managed MCP server resolves it from run context')
  assert.ok(!prompt.includes('SPRINTENGINE_STATE_PATH'), 'startup prompt must not reference env-based managed routing')
  assert.ok(!prompt.includes('SPRINTENGINE_WORKSPACE_ROOT'), 'startup prompt must not reference env-based managed routing')
  assert.ok(!prompt.includes('launch env'), 'startup prompt must describe run-context routing, not launch-env routing')
  assert.ok(prompt.includes('sprintengine.help'), 'startup prompt directs agents to read MCP-owned workflow help first')
  assert.ok(!prompt.includes('nextMcpToolName') && !prompt.includes('nextMcpArguments'), 'startup prompt does not teach the directive routing fields')
  assert.ok(!prompt.includes('retryAfterMs'), 'startup prompt does not instruct Multicode agents to use retryAfterMs')
  assert.doesNotMatch(prompt, /poll|backoff|sleep/iu, 'startup prompt does not define idle polling behavior')
  assert.ok(prompt.includes('stop — Multicode re-engages this terminal'), 'startup prompt carries the no-work stop contract')
  assert.ok(!prompt.includes('sprintengine.triage.needs_input'), 'startup prompt does not inline MCP triage workflow details')
  assert.ok(!prompt.includes('sprintengine.task.publish'), 'startup prompt does not inline MCP publish workflow details')
  assert.ok(!prompt.includes('sprintengine.gate.verdict'), 'startup prompt does not inline MCP gate verdict workflow details')
  assert.ok(!prompt.includes('sprintengine.artifact.add'), 'startup prompt does not inline MCP artifact workflow details')
  assert.ok(!prompt.includes('needsInputKind') && !prompt.includes('needsInputReason'), 'startup prompt does not inline needs_input payload details')
  assert.ok(prompt.includes('sprintengine-studio'), 'startup prompt names the managed MCP server entry')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(prompt),
    'startup prompt does not instruct the agent to run any sprintengine CLI command'
  )
}

function testArchitectInitStartupPromptIsMcpNative(): void {
  const prompt = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship MCP runtime', {
    executionCwd: '/tmp/workspace',
    workspaceRoot: '/tmp/workspace',
    sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    rosterArgs: ['developer:developer-1', 'frontend:frontend'],
    commandMode: 'init',
  })

  assert.ok(prompt.includes('sprintengine.init'), 'architect init prompt names the MCP init tool instead of the init CLI')
  assert.ok(prompt.includes('"goal": "Ship MCP runtime"'), 'init payload carries the goal')
  assert.ok(prompt.includes('"agent"'), 'init payload carries the roster')
  assert.ok(prompt.includes('"developer:developer-1"'), 'init payload preserves roster agent specs verbatim')
  assert.ok(prompt.includes('sprintengine.agent.join'), 'architect init flow then joins via MCP')
  assert.ok(prompt.includes('sprintengine.task.next'), 'architect init flow then claims its first task directly')
  assert.ok(!prompt.includes('sprintengine.agent.next_directive'), 'architect init flow does not route through the directive hop')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(prompt),
    'architect init prompt does not instruct the agent to run any sprintengine CLI command'
  )
}

function testGeneralStartupPromptIsMcpNative(): void {
  const prompt = buildSprintEngineStartupPrompt('general', 'general', 'Ship the sprint', {
    executionCwd: '/tmp/workspace',
    workspaceRoot: '/tmp/workspace',
    sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    commandMode: 'join',
  })

  // Joins as general, claims directly, and never initializes the run (init stays app-owned).
  assert.ok(prompt.includes('sprintengine.agent.join'), 'general startup prompt joins via MCP')
  assert.ok(prompt.includes('"role": "general"'), 'general join payload carries role general')
  assert.ok(prompt.includes('"agentId": "general"'), 'general join payload carries the agent id')
  assert.ok(prompt.includes('"id": "general"'), 'general claim payload carries the agent id')
  assert.ok(prompt.includes('sprintengine.task.next'), 'general startup prompt claims work directly')
  assert.ok(!prompt.includes('sprintengine.init'), 'a General does not call sprintengine.init')
  // Drives the full single-agent loop and assigns planning to the General when no plan exists.
  assert.ok(/plan/iu.test(prompt), 'general startup prompt drives planning')
  assert.ok(/build/iu.test(prompt), 'general startup prompt drives the build step')
  assert.ok(/review/iu.test(prompt), 'general startup prompt drives self-review')
  assert.ok(/test/iu.test(prompt), 'general startup prompt drives testing')
  assert.ok(/publish/iu.test(prompt), 'general startup prompt drives publishing')
  assert.ok(prompt.includes('you are the planner'), 'general becomes the planner when the run has no task graph')
  assert.ok(/roles are user config/iu.test(prompt), 'general startup prompt routes role wishes to needs_input, never self-service growth')
  assert.ok(/needs_input/u.test(prompt), 'general startup prompt names the needs_input escalation path')
  // Same no-statePath/workspaceRoot routing invariant as every other startup prompt.
  assert.ok(!prompt.includes('"statePath"'), 'general startup prompt must not embed statePath in the MCP payload')
  assert.ok(!prompt.includes('"workspaceRoot"'), 'general startup prompt must not embed workspaceRoot in the MCP payload')
  assert.ok(!prompt.includes('/tmp/workspace/.multi-code/sprintengine/team/run.yaml'), 'general startup prompt does not expose the run state path')
  assert.ok(prompt.includes('sprintengine-studio'), 'general startup prompt names the managed MCP server entry')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(prompt),
    'general startup prompt does not instruct the agent to run any sprintengine CLI command'
  )
}

function testArchitectWakeStartupPromptCarriesConfiguredRoles(): void {
  // The configured-roster boundary must ride the architect's WAKE (join)
  // dispatch, not only its init bootstrap — the roster is an enforced invariant
  // for every replan, so a woken architect keeps scheduling only for the run's
  // roles and escalates to the user rather than inventing an off-roster role.
  const wake = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship it', {
    executionCwd: '/tmp/workspace',
    sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    configuredRoles: ['architect', 'developer', 'tester'],
    commandMode: 'join',
  })
  assert.ok(
    wake.includes("Your run's roles are: architect, developer, tester"),
    'the architect wake (join) prompt carries the configured-roster boundary, not only init',
  )
  assert.ok(
    /raise needs_input to the user rather than adding the role/.test(wake),
    'the boundary tells the architect to escalate off-roster needs instead of adding a role',
  )

  // Init dispatch carries the same invariant on bootstrap.
  const init = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship it', {
    configuredRoles: ['architect', 'developer'],
    commandMode: 'init',
  })
  assert.ok(
    init.includes("Your run's roles are: architect, developer"),
    'the architect init prompt also carries the configured-roster boundary',
  )

  // A non-architect worker never receives the architect roster boundary.
  const worker = buildSprintEngineStartupPrompt('developer', 'developer-1', 'Ship it', {
    configuredRoles: ['architect', 'developer', 'tester'],
    commandMode: 'join',
  })
  assert.ok(
    !worker.includes("Your run's roles are:"),
    'a non-architect prompt does not carry the architect roster boundary',
  )
}

function testPromptBuildersIncludeAgentIdAndCommand(): void {
  const teamStatePath = '/tmp/workspace/.multi-code/sprintengine/team/run.yaml'
  const readyTask = task({ id: 'T3', title: 'Build feature', role: 'developer' })
  const continuation = buildSprintEngineContinuationPrompt(readyTask, 'developer-1')
  assert.ok(!continuation.includes('sprintengine.agent.next_directive'), 'continuation prompt does not route through the directive hop')
  assert.ok(!continuation.includes('"statePath"'), 'continuation prompt must not embed statePath; the managed MCP server resolves it from run context')
  assert.ok(!continuation.includes('SPRINTENGINE_STATE_PATH'), 'continuation prompt must not reference env-based managed routing')
  assert.ok(continuation.includes('"role": "developer"'), 'continuation prompt embeds the role in the claim payload')
  assert.ok(continuation.includes('"id": "developer-1"'), 'continuation prompt embeds the agent id in the claim payload')
  assert.ok(continuation.includes('sprintengine.task.next'), 'continuation prompt names the MCP task-next tool to invoke')
  assert.ok(continuation.includes('T3 - Build feature'))
  assert.ok(continuation.includes('wake candidate'))
  assert.ok(continuation.includes('stop — Multicode re-engages this terminal'), 'continuation prompt carries the no-work stop contract')
  assert.ok(!continuation.includes('retryAfterMs'), 'continuation prompt does not reference retryAfterMs')
  assert.doesNotMatch(continuation, /poll|backoff|sleep/iu, 'continuation prompt does not define idle polling behavior')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(continuation),
    'continuation prompt does not instruct the agent to run a sprintengine CLI command'
  )

  const continuationNoState = buildSprintEngineContinuationPrompt(readyTask, 'developer-1')
  assert.ok(
    !continuationNoState.includes('"statePath"'),
    'continuation prompt must not embed statePath even when called without one; the managed MCP server resolves it from run context'
  )

  const notif = buildAgentNotificationPrompt({
    id: 'EV-001',
    timestamp: '2026-05-18T00:00:00Z',
    type: 'agent_notification_requested',
    actor: 'system',
    message: 'Your task was resolved.',
    targetAgentId: 'developer-1',
    taskId: 'T3',
    notificationKind: 'task_completed_after_artifact_approval',
  }, { agentId: 'developer-1', role: 'developer' })
  assert.ok(notif.includes('Your sprint task is complete.'))
  assert.ok(notif.includes('Task: T3'))
  assert.ok(
    !notif.includes('sprintengine.agent.next_directive'),
    'completion notifications do not include a reconcile directive call'
  )
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(notif),
    'completion notifications do not include any sprintengine CLI command'
  )

  const reworkNotif = buildAgentNotificationPrompt({
    id: 'EV-002',
    timestamp: '2026-05-18T00:00:00Z',
    type: 'agent_notification_requested',
    actor: 'system',
    message: 'Changes were requested for artifact AR-9.',
    targetAgentId: 'frontend-2',
    taskId: 'T4',
    artifactId: 'AR-9',
    notificationKind: 'task_changes_requested_after_artifact_review',
  }, { agentId: 'frontend-2', role: 'frontend' })
  assert.ok(reworkNotif.includes('Re-read the current task card'))
  assert.ok(reworkNotif.includes('sprintengine.task.get'), 'rework notifications name the MCP task read tool')
  assert.ok(reworkNotif.includes('taskId: "T4"'), 'rework notifications embed the taskId in the task.get payload')
  assert.ok(
    !reworkNotif.includes(`statePath: "${teamStatePath}"`),
    'rework notifications embed statePath in the task.get payload'
  )
  assert.ok(reworkNotif.includes('sprintengine.task.next'), 'rework notifications name the MCP claim tool to resume the active task')
  assert.ok(!reworkNotif.includes('sprintengine.agent.next_directive'), 'rework notifications do not route through the directive hop')
  assert.ok(!reworkNotif.includes('"statePath"'), 'rework notifications must not embed statePath; the managed MCP server resolves it from run context')
  assert.ok(reworkNotif.includes('"role": "frontend"'))
  assert.ok(reworkNotif.includes('"id": "frontend-2"'))
  assert.ok(reworkNotif.includes('Artifact: AR-9'))
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(reworkNotif),
    'rework notifications do not embed any sprintengine CLI command'
  )

  const triage = buildArchitectNeedsInputTriagePrompt({
    workspaceFolderPath: '/tmp/workspace',
    sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    taskIds: ['T5', 'T6'],
  })
  assert.ok(triage.includes('sprintengine.triage.needs_input'), 'architect triage prompt names the MCP triage tool')
  assert.ok(
    !triage.includes('"statePath"'),
    'architect triage payload must not embed statePath; the managed MCP server resolves it from run context'
  )
  assert.ok(!triage.includes('/tmp/workspace/.multi-code/sprintengine/team/run.yaml'), 'architect triage prompt does not expose the run state path')
  assert.ok(triage.includes('"id": "architect"'), 'architect triage payload embeds the architect actor id')
  assert.ok(triage.includes('sprintengine.task.note'), 'architect triage prompt names the MCP task-note tool for handoff')
  assert.ok(triage.includes('T5, T6'))
  assert.ok(
    !/sprintengine (join|task |gate |triage |init |handover)/.test(triage),
    'architect triage prompt does not embed a sprintengine CLI command'
  )
}

function testAgentNotificationPromptCompactsLongResolutionText(): void {
  const longResolution = [
    'INPUT RESOLVED by architect: Resolved (verification).',
    'VISUAL-EVIDENCE BAR FOR T7: component-render tests are sufficient evidence for this sprint.',
    'Rationale: web smoke is waived due to documented infra constraints.',
    'Action for you: no source change and no scope expansion. Re-publish to review.',
  ].join('\n\n\n')
  const prompt = buildAgentNotificationPrompt({
    id: 'EV-long',
    timestamp: '2026-06-13T00:00:00Z',
    type: 'agent_notification_requested',
    actor: 'architect',
    message: longResolution,
    targetAgentId: 'frontend-1',
    taskId: 'T7',
    notificationKind: 'task_resume_requested',
  }, { agentId: 'frontend-1', role: 'frontend' })

  assert.ok(prompt.includes('Input was resolved for this task.'), 'resume notifications use a compact renderer-owned summary')
  assert.ok(prompt.includes('sprintengine.task.get'), 'compact notification still tells the agent to re-read the task card')
  assert.ok(prompt.includes('sprintengine.task.next'), 'compact notification still tells the agent to reconcile through the claim tool')
  assert.ok(!prompt.includes('VISUAL-EVIDENCE BAR'), 'long architect resolution text is not pasted into the terminal notification')
  assert.ok(!prompt.includes('web smoke is waived'), 'notification prompt avoids inlining detailed rationale prose')
}

function testSprintEngineAutomationNotificationCountIsWorkspaceScoped(): void {
  const notifications: AppNotification[] = [
    automationNotification({ workspaceId: 'workspace-1', read: false }),
    automationNotification({ workspaceId: 'workspace-1', read: false }),
    automationNotification({ workspaceId: 'workspace-1', read: true }),
    automationNotification({ workspaceId: 'workspace-2', read: false }),
    {
      ...automationNotification({ workspaceId: 'workspace-1', read: false }),
      title: 'Other Sprint Engine notification',
    },
  ]

  assert.equal(
    countUnreadSprintEngineAutomationNotifications(notifications, 'workspace-1'),
    2,
    'Sprint Engine automation badge counts unread matching notifications for the current workspace only',
  )
}

function automationNotification(input: { workspaceId: string; read: boolean }): AppNotification {
  return {
    id: `notification-${input.workspaceId}-${input.read ? 'read' : 'unread'}`,
    timestamp: '2026-05-28T08:00:00.000Z',
    level: 'info',
    source: 'sprintengine',
    title: SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE,
    message: 'Sprint automation is now Run agents.',
    workspaceId: input.workspaceId,
    read: input.read,
  }
}

function testDispatchPromptUsesDirectClaim(): void {
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
  assert.ok(prompt.includes('sprintengine.task.next'), 'task dispatch prompt names the MCP claim tool directly')
  assert.ok(!prompt.includes('sprintengine.agent.next_directive'), 'dispatch prompt does not route through the directive hop')
  assert.ok(!prompt.includes('"statePath"'), 'dispatch prompt must not embed statePath; the managed MCP server resolves it from run context')
  assert.ok(prompt.includes('"role": "frontend"'), 'dispatch prompt embeds the dispatch role in the MCP payload')
  assert.ok(prompt.includes('"id": "frontend-3"'), 'dispatch prompt embeds the agent id in the MCP payload')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(prompt),
    'dispatch prompt does not embed any sprintengine CLI command'
  )
  assert.ok(!prompt.includes('wake candidate'))

  const promptWithoutState = buildSprintEngineDispatchPrompt({
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
  assert.ok(
    !promptWithoutState.includes('"statePath"'),
    'dispatch prompt must not embed statePath even when called without one; the managed MCP server resolves it from run context'
  )
}

function testDispatchAndContinuationPromptsWorkForRegistryKeyedRoles(): void {
  // Registry-keyed custom role (workspace-defined marketer). The wake-up
  // path must reproduce the role id verbatim in the MCP directive payload
  // so the managed server binds the running terminal to its
  // registry-discovered Soul. No bundled-role label lookup or hardcoded
  // role list should intercept the value.
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
  assert.ok(dispatchPrompt.includes('sprintengine.task.next'))
  assert.ok(!dispatchPrompt.includes('sprintengine.agent.next_directive'))
  assert.ok(!dispatchPrompt.includes('"statePath"'), 'dispatch prompt must not embed statePath')
  assert.ok(dispatchPrompt.includes('"role": "marketer"'))
  assert.ok(dispatchPrompt.includes('"id": "marketer-1"'))

  const continuationPrompt = buildSprintEngineContinuationPrompt(
    task({ id: 'M3', title: 'Campaign brief', role: 'marketer' }),
    'marketer-1',
  )
  assert.ok(continuationPrompt.includes('wake candidate for a ready marketer task'))
  assert.ok(continuationPrompt.includes('sprintengine.task.next'))
  assert.ok(!continuationPrompt.includes('sprintengine.agent.next_directive'))
  assert.ok(!continuationPrompt.includes('"statePath"'), 'continuation prompt must not embed statePath')
  assert.ok(continuationPrompt.includes('"role": "marketer"'))
  assert.ok(continuationPrompt.includes('"id": "marketer-1"'))

}

function testGetArchitectActionableNeedsInputTasksFiltersByKind(): void {
  const tasks: SprintEngineTask[] = [
    task({ id: 'T1', status: 'needs_input', needsInput: { kind: 'architect', reason: 'task_scope' } as SprintEngineTask['needsInput'] }),
    task({ id: 'T2', status: 'needs_input', needsInput: { kind: 'user', reason: 'verification' } as SprintEngineTask['needsInput'] }),
    task({ id: 'T3', status: 'needs_input', needsInput: { kind: 'architect', reason: 'verification' } as SprintEngineTask['needsInput'] }),
    task({ id: 'T4', status: 'in_progress' }),
  ]
  const state = sprintEngineStateFixture({ tasks })
  const filtered = getArchitectActionableNeedsInputTasks(state).map((task) => task.id)
  // Architect-routed (kind === 'architect') tasks are actionable regardless of
  // reason; user-routed (T2) and non-needs_input (T4) are not.
  assert.deepEqual(filtered.sort(), ['T1', 'T3'], 'architect-routed tasks are actionable regardless of reason')
}

function testRunBlockedOnExternalInputDetectsBlockedDependencyTail(): void {
  const blockedSmoke = task({
    id: 'T23',
    status: 'needs_input',
    boardColumn: 'needs_input',
    role: 'tester',
    ownerAgentId: 'tester',
    dependsOn: ['T22'],
    needsInput: {
      kind: 'user',
      reason: 'verification',
      question: 'Needs a physical mobile pairing session.',
    },
  })
  const finalSignoff = task({
    id: 'T24',
    title: 'Final architect signoff',
    status: 'todo',
    boardColumn: 'todo',
    role: 'architect',
    ownerAgentId: null,
    dependsOn: ['T23'],
  })
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T22', status: 'done', boardColumn: 'done', ownerAgentId: null }),
      blockedSmoke,
      finalSignoff,
    ],
    sprintEngineAgents: {
      tester: runtimeAgent('tester', { status: 'needs_input', currentTaskId: 'T23' }),
      architect: runtimeAgent('architect', { status: 'idle' }),
    },
  })

  assert.equal(
    isSprintEngineRunBlockedOnExternalInput(state),
    true,
    'a final todo task dependency-blocked by external_validation should quiesce auto-run'
  )
}

function testDescribeExternalInputBlockNamesBlockingTask(): void {
  const blockedSmoke = task({
    id: 'T23',
    title: 'Validate pairing on a real device',
    status: 'needs_input',
    boardColumn: 'needs_input',
    role: 'tester',
    ownerAgentId: 'tester',
    needsInput: {
      kind: 'user',
      reason: 'verification',
      question: 'Needs a physical mobile pairing session.',
    },
  })
  const finalSignoff = task({
    id: 'T24',
    title: 'Final architect signoff',
    status: 'todo',
    boardColumn: 'todo',
    role: 'architect',
    ownerAgentId: null,
    dependsOn: ['T23'],
  })
  const state = sprintEngineStateFixture({ tasks: [blockedSmoke, finalSignoff] })

  const description = describeSprintEngineExternalInputAutoRunBlock(state)

  assert.equal(description.taskId, 'T23')
  assert.equal(description.agentId, 'tester')
  assert.match(description.message, /Waiting on T23/)
  assert.match(description.message, /physical mobile pairing/)
  assert.match(description.details, /Blocking task: T23 - Validate pairing on a real device/)
  assert.match(description.details, /Blocked dependents: T24/)
}

function testRunBlockedOnExternalInputKeepsAutoRunWhenWorkExists(): void {
  const blockedTask = task({
    id: 'T1',
    status: 'needs_input',
    boardColumn: 'needs_input',
    role: 'tester',
    ownerAgentId: 'tester',
    needsInput: {
      kind: 'user',
      reason: 'verification',
      question: 'Needs device validation.',
    },
  })
  const readyTask = task({
    id: 'T2',
    status: 'todo',
    boardColumn: 'ready',
    role: 'developer',
    ownerAgentId: null,
    dependsOn: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [blockedTask, readyTask],
    sprintEngineAgents: {
      tester: runtimeAgent('tester', { status: 'needs_input', currentTaskId: 'T1' }),
      'developer-1': runtimeAgent('developer'),
    },
  })

  assert.equal(
    isSprintEngineRunBlockedOnExternalInput(state),
    false,
    'external validation blockers must not stop auto-run while unrelated ready work exists'
  )
}

function testRunBlockedOnExternalInputKeepsAutoRunWithActiveDispatch(): void {
  const blockedTask = task({
    id: 'T1',
    status: 'needs_input',
    boardColumn: 'needs_input',
    role: 'tester',
    ownerAgentId: 'tester',
    needsInput: {
      kind: 'user',
      reason: 'verification',
      question: 'Needs device validation.',
    },
  })
  const dependentTask = task({
    id: 'T2',
    status: 'todo',
    boardColumn: 'todo',
    role: 'architect',
    ownerAgentId: null,
    dependsOn: ['T1'],
  })
  const state = sprintEngineStateFixture({
    tasks: [blockedTask, dependentTask],
    sprintEngineAgents: {
      tester: runtimeAgent('tester', { status: 'needs_input', currentTaskId: 'T1' }),
      architect: runtimeAgent('architect', {
        status: 'idle',
        currentDispatch: {
          dispatchId: 'D-1',
          targetKind: 'task',
          taskId: 'T2',
          reason: 'resume',
        },
      }),
    },
  })

  assert.equal(
    isSprintEngineRunBlockedOnExternalInput(state),
    false,
    'auto-run must not quiesce while a durable dispatch still needs delivery'
  )
}

function testRunBlockedOnExternalInputKeepsAutoRunWithReadyApproval(): void {
  const blockedTask = task({
    id: 'T1',
    status: 'needs_input',
    boardColumn: 'needs_input',
    role: 'tester',
    ownerAgentId: 'tester',
    needsInput: {
      kind: 'user',
      reason: 'verification',
      question: 'Needs device validation.',
    },
  })
  const state = sprintEngineStateFixture({
    tasks: [blockedTask],
    artifacts: [
      {
        id: 'A-1',
        taskId: 'T1',
        kind: 'validation_report',
        title: 'Validation report',
        status: 'ready_for_review',
        path: 'artifacts/validation.md',
        createdBy: 'tester',
        fingerprint: null,
        reviewHistory: [],
        recommendedTasks: [],
        createdAt: '2026-05-27T12:00:00Z',
        updatedAt: '2026-05-27T12:00:00Z',
      },
    ],
    sprintEngineAgents: {
      tester: runtimeAgent('tester', { status: 'needs_input', currentTaskId: 'T1' }),
    },
  })

  assert.equal(
    isSprintEngineRunBlockedOnExternalInput(state),
    false,
    'auto-run must keep running when a ready artifact can still be auto-approved'
  )
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
  // Regression: an agent-invented kind survives normalization for manual
  // review, but must never become an approval intent — the main-process gate
  // rejects unknown kinds, so proposing one loops warning/cooldown forever.
  const unknownKindArtifact: SprintEngineArtifact = {
    id: 'AR-004',
    taskId: 'T4',
    kind: 'frontend_design',
    title: 'Unknown kind',
    status: 'ready_for_review',
    path: 'docs/unknown.md',
    createdBy: 'developer-1',
    createdAt: '2026-05-18T00:00:03Z',
  } as SprintEngineArtifact

  const state = sprintEngineStateFixture({
    tasks,
    artifacts: [reviewArtifact, draftArtifact, orphanArtifact, unknownKindArtifact],
  })
  const eligibleIds = getAutoApprovalIntentArtifacts(state).map((artifact) => artifact.id)
  // The review artifact is eligible because the artifact passes the eligibility predicate
  // or because its task has a sibling in needs_input that allows approvable review statuses.
  assert.ok(eligibleIds.includes('AR-001'), 'ready_for_review artifact on review task is eligible')
  assert.ok(!eligibleIds.includes('AR-002'), 'draft artifact is not proposed because Sprint Engine rejects draft approval')
  assert.ok(!eligibleIds.includes('AR-003'), 'orphan artifact without a matching task is not eligible')
  assert.ok(!eligibleIds.includes('AR-004'), 'unknown-kind artifact is never proposed for auto-approval')
}

function testGetAutoApprovalIntentArtifactsExcludesSameFileDuplicateVeto(): void {
  // Agreement with the main-process gate (getArtifactAutoApprovalBlocker,
  // verified in src/main/sprintengine-artifacts.test.ts over the same matrix):
  // a stale same-file duplicate must NOT veto an intent, while a distinct
  // pending sibling must. Without agreement the supervisor proposes an artifact
  // the gate rejects and loops warning -> cooldown forever.
  const planTask = task({ id: 'T0', ownerAgentId: 'architect', status: 'needs_input', role: 'architect' })

  const readyPlan = {
    id: 'A2',
    taskId: 'T0',
    kind: 'architect_plan',
    title: 'Plan',
    status: 'ready_for_review',
    path: 'plan.md',
    createdBy: 'architect',
    createdAt: '2026-06-19T00:00:00Z',
  } as SprintEngineArtifact
  // Stale placeholder for the SAME file, stored full-prefix instead of bare.
  const staleSameFileDuplicate = {
    id: 'A1',
    taskId: 'T0',
    kind: 'architect_plan',
    title: 'Plan',
    status: 'draft',
    path: '.multi-code/sprintengine/team/plan.md',
    createdBy: 'sprintengine',
    createdAt: '2026-06-19T00:00:00Z',
  } as SprintEngineArtifact

  const sameFileState = sprintEngineStateFixture({
    tasks: [planTask],
    artifacts: [staleSameFileDuplicate, readyPlan],
  })
  assert.deepEqual(
    getAutoApprovalIntentArtifacts(sameFileState).map((artifact) => artifact.id),
    ['A2'],
    'a stale same-file duplicate must not veto the real plan auto-approval intent'
  )

  // A distinct pending sibling (different file, draft) is an independent review
  // gate and must suppress the intent so the gate does not later reject it.
  const distinctPending = {
    id: 'A3',
    taskId: 'T0',
    kind: 'design_notes',
    title: 'Notes',
    status: 'draft',
    path: 'design-notes.md',
    createdBy: 'architect',
    createdAt: '2026-06-19T00:00:00Z',
  } as SprintEngineArtifact
  const distinctState = sprintEngineStateFixture({
    tasks: [planTask],
    artifacts: [readyPlan, distinctPending],
  })
  assert.deepEqual(
    getAutoApprovalIntentArtifacts(distinctState).map((artifact) => artifact.id),
    [],
    'a distinct pending sibling must suppress the intent to match the gate veto'
  )
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

function runtimeAgent(role: SprintEngineRoleId, overrides: Partial<SprintEngineRuntimeAgent> = {}): SprintEngineRuntimeAgent {
  return { role, status: 'idle', currentTaskId: null, ...overrides }
}

function pickInput(
  overrides: Partial<Parameters<typeof pickNextAutoRuns>[2]> = {}
): Parameters<typeof pickNextAutoRuns>[2] {
  return {
    limit: 3,
    runningAgentIds: new Set<string>(),
    inFlightSpawns: new Set<string>(),
    ...overrides,
  }
}

function bootstrapWorkspace(agents: Workspace['agents'] = {}): Workspace {
  return workspaceFixture({ agents })
}

function bootstrapState(overrides: Partial<SprintEngineState> = {}): SprintEngineState {
  return sprintEngineStateFixture({
    sprintEngineAgents: {
      architect: runtimeAgent('architect'),
      developer: runtimeAgent('developer'),
      security: runtimeAgent('security'),
    },
    ...overrides,
  })
}

function bootstrapOptions(overrides: Partial<{
  runningAgentIds: Set<string>
  inFlightSpawnKeys: Set<string>
}> = {}): Parameters<typeof pickSprintEngineBootstrapCandidate>[2] {
  return {
    runningAgentIds: new Set<string>(),
    inFlightSpawnKeys: new Set<string>(),
    ...overrides,
  }
}

function testBootstrapSpawnsArchitectForFreshRunWithoutTasks(): void {
  const decision = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace({ architect: { ...sprintAgent('architect', 'Ari'), cliStartupPrompt: 'handoff', cliOnboardingPromptSent: false } }),
    bootstrapState(),
    bootstrapOptions()
  )

  assert.equal(decision.kind, 'spawn', 'fresh run with no tasks bootstraps the architect')
  if (decision.kind === 'spawn') {
    assert.equal(decision.candidate.agentId, 'architect', 'only the architect is bootstrap-spawned')
    assert.equal(decision.candidate.role, 'architect')
    assert.equal(decision.candidate.taskId, 'bootstrap-architect')
    assert.equal(decision.candidate.label, 'Ari', 'bootstrap reuses the named workspace agent label')
  }

  // New-team wizard runs have no stored handoff prompt and no workspace agent
  // entry yet; the architect still bootstraps (with the generated init prompt
  // downstream) under the roster label.
  const freshTeam = pickSprintEngineBootstrapCandidate(bootstrapWorkspace(), bootstrapState(), bootstrapOptions())
  assert.equal(freshTeam.kind, 'spawn', 'a new team with no stored prompt still bootstraps the architect')
  if (freshTeam.kind === 'spawn') {
    assert.equal(freshTeam.candidate.agentId, 'architect')
    assert.ok(freshTeam.candidate.label, 'bootstrap falls back to the roster label when no agent entry exists')
  }
}

function testBootstrapDeliversUndeliveredArchitectStartupPromptEvenWithTasks(): void {
  const tasks = [task({ id: 'T1', status: 'todo', boardColumn: 'ready', role: 'developer', ownerAgentId: null })]
  const undelivered = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace({ architect: { ...sprintAgent('architect', 'Ari'), cliStartupPrompt: 'handoff', cliOnboardingPromptSent: false } }),
    bootstrapState({ tasks }),
    bootstrapOptions()
  )
  assert.equal(undelivered.kind, 'spawn', 'an undelivered stored handoff prompt still bootstraps after tasks exist')

  const delivered = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace({ architect: { ...sprintAgent('architect', 'Ari'), cliStartupPrompt: 'handoff', cliOnboardingPromptSent: true } }),
    bootstrapState({ tasks }),
    bootstrapOptions()
  )
  assert.equal(delivered.kind, 'none', 'a delivered handoff prompt does not re-bootstrap')
}

function testBootstrapDoesNothingOncePlanTasksExist(): void {
  const decision = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace(),
    bootstrapState({
      tasks: [
        task({ id: 'T1', status: 'todo', boardColumn: 'ready', role: 'developer', ownerAgentId: null }),
        task({ id: 'T2', status: 'review', role: 'developer' }),
      ],
    }),
    bootstrapOptions()
  )

  assert.equal(
    decision.kind,
    'none',
    'once the plan exists, all spawning is work-driven through pickNextAutoRuns — never a roster sweep'
  )
}

function testBootstrapSkipsRunningInFlightAndRetiredArchitect(): void {
  assert.equal(
    pickSprintEngineBootstrapCandidate(
      bootstrapWorkspace(),
      bootstrapState(),
      bootstrapOptions({ runningAgentIds: new Set(['architect']) })
    ).kind,
    'none',
    'a running architect terminal is never duplicated'
  )
  assert.equal(
    pickSprintEngineBootstrapCandidate(
      bootstrapWorkspace(),
      bootstrapState(),
      bootstrapOptions({ inFlightSpawnKeys: new Set(['workspace-1:architect']) })
    ).kind,
    'none',
    'an in-flight architect spawn is never duplicated'
  )
  assert.equal(
    pickSprintEngineBootstrapCandidate(
      bootstrapWorkspace(),
      bootstrapState({
        sprintEngineAgents: {
          architect: runtimeAgent('architect', { status: 'retired' }),
          developer: runtimeAgent('developer'),
        },
      }),
      bootstrapOptions()
    ).kind,
    'none',
    'a retired architect already exists, so it is re-engaged through the picker/revival path, not duplicated by bootstrap'
  )
}

function testBootstrapStallsInsteadOfSpawningWithoutArchitectOrAfterPrePlanExit(): void {
  const noArchitect = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace(),
    bootstrapState({ sprintEngineAgents: { developer: runtimeAgent('developer') } }),
    bootstrapOptions()
  )
  assert.deepEqual(
    noArchitect,
    { kind: 'stall', reason: 'no_planner' },
    'no tasks and no planner (architect or general) is a visible stall, not a silent no-op'
  )

  const noArchitectWithTasks = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace(),
    bootstrapState({
      sprintEngineAgents: { developer: runtimeAgent('developer') },
      tasks: [task({ id: 'T1', status: 'todo', boardColumn: 'ready', role: 'developer', ownerAgentId: null })],
    }),
    bootstrapOptions()
  )
  assert.equal(noArchitectWithTasks.kind, 'none', 'architect-less runs with tasks proceed work-driven')

  const exitedBeforePlan = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace({
      architect: { ...sprintAgent('architect', 'Ari'), cliLastExitedAt: Date.now(), cliOnboardingPromptSent: true },
    }),
    bootstrapState(),
    bootstrapOptions()
  )
  assert.deepEqual(
    exitedBeforePlan,
    { kind: 'stall', reason: 'architect_exited_before_plan' },
    'an architect that exited pre-plan after its prompt was delivered stalls visibly instead of spawn-looping'
  )

  const exitedWithUndeliveredPrompt = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace({
      architect: { ...sprintAgent('architect', 'Ari'), cliLastExitedAt: Date.now(), cliStartupPrompt: 'handoff', cliOnboardingPromptSent: false },
    }),
    bootstrapState(),
    bootstrapOptions()
  )
  assert.equal(
    exitedWithUndeliveredPrompt.kind,
    'spawn',
    'an exited architect whose stored handoff was never delivered is respawned to deliver it'
  )
}

function testGetSprintEngineAutoRunOccupiedAgentIdsDoesNotCountDeadNeedsInputOwner(): void {
  const occupiedAgentIds = getSprintEngineAutoRunOccupiedAgentIds({
    tasks: [
      task({ id: 'T1', status: 'needs_input', ownerAgentId: 'developer-1', role: 'developer' }),
      task({ id: 'T2', status: 'needs_input', ownerAgentId: 'frontend', role: 'frontend' }),
    ],
    inFlightSpawnKeys: new Set<string>(),
    workspaceId: 'workspace-1',
    runningAgentIds: new Set(['frontend']),
  })

  assert.deepEqual(
    [...occupiedAgentIds].sort(),
    ['frontend'],
    'dead needs_input owners do not consume an auto-run slot that unrelated work can use'
  )
}

function testPickNextAutoRunsSelectsReadyTaskForIdleRoleAgent(): void {
  // A never-owned idle worker of the role is reusable capacity (restart-in-place,
  // no id churn) — the picker hands the ready task to it rather than minting.
  const readyTask = task({
    id: 'T-ready',
    status: 'todo',
    boardColumn: 'ready',
    role: 'developer',
    ownerAgentId: undefined as unknown as string,
    dependsOn: [],
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
}

function testPickNextAutoRunsSkipsUnresolvedNeedsInputOwner(): void {
  const needsInputTask = task({
    id: 'T-needs-input',
    status: 'needs_input',
    boardColumn: 'needs_input',
    role: 'developer',
    ownerAgentId: 'developer-1',
    dependsOn: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [needsInputTask],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer') },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 0, 'unresolved needs_input work waits for explicit input instead of redispatching the owner')
}

function testPickNextAutoRunsSkipsRetiredRoleAgent(): void {
  // MC-1591 leases: a retired/spent id is never reused for a new claim — the
  // picker skips it and mints a fresh worker (developer-2) for the ready task.
  const readyTask = task({
    id: 'T-ready',
    status: 'todo',
    boardColumn: 'ready',
    role: 'developer',
    ownerAgentId: undefined as unknown as string,
    dependsOn: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [readyTask],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { status: 'retired' }) },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 1, 'the retired id is skipped; a fresh worker is minted')
  assert.equal(candidates[0].agentId, 'developer-2', 'the minted id skips the retired developer-1')
}

function testPickNextAutoRunsSpawnsReadyWorkImmediatelyWithoutReservation(): void {
  // MC-1592: the time-based continuation-grace reservation is gone. Ready
  // unowned work is spawnable the moment it is uncovered — an unbound ready
  // task is never held back on the theory that an idle terminal might take it.
  // Only a bound owner (retained lastOwnedTaskId) defers a task, and a booting
  // unbound session covers its key's demand.
  const readyTask = task({
    id: 'T-ready',
    status: 'todo',
    boardColumn: 'ready',
    role: 'developer',
    ownerAgentId: undefined as unknown as string,
    dependsOn: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [readyTask],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer') },
  })

  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 1, 'ready unowned work is spawnable immediately — no grace reservation')
  assert.equal(candidates[0].taskId, 'T-ready')

  // A booting unbound session for the same key covers the demand instead.
  const covered = pickNextAutoRuns(
    workspaceFixture(),
    state,
    pickInput({
      runningAgentIds: new Set(['developer-2']),
      unboundLiveWorkers: [{ agentId: 'developer-2', role: 'developer', taskId: 'T-ready' }],
    })
  )
  assert.equal(covered.length, 0, 'a booting unbound worker covers its demand key — no double spawn')
}

function testDeriveAutomationModeTrustsLocalAutoStateOverRunnerPolicy(): void {
  // Regression: the user clicks Manual in the Sprint Engine board panel. The
  // local autoState becomes manual immediately, but the persisted run.yaml
  // runner.cliWatchPolling is still 'enabled' until the IPC round-trip and projection
  // refresh complete. deriveSprintEngineAutomationMode must NOT use the
  // persisted runner.cliWatchPolling as a "yes auto" signal — doing that lets stale
  // persisted state override the user's live choice and the UI flicks back to
  // the previous automation mode. See sprintengineAutomation.ts for the full
  // rationale.

  const manualAutoState = { desiredMode: 'manual' as const, runtimeState: 'idle' as const }
  const runnerAuto = { cliWatchPolling: 'enabled' as const, pollIntervalSeconds: 10, idleBackoffSeconds: 30, maxBackoffSeconds: 120, stopWhenComplete: true }
  const runnerOff = { cliWatchPolling: 'disabled' as const, pollIntervalSeconds: 10, idleBackoffSeconds: 30, maxBackoffSeconds: 120, stopWhenComplete: true }

  const fromDeriveModule = (): typeof deriveSprintEngineAutomationMode => deriveSprintEngineAutomationMode
  const derive = fromDeriveModule()

  assert.equal(
    derive(manualAutoState, runnerAuto),
    'manual',
    'local manual autoState must win when run.yaml runner.cliWatchPolling is still enabled (stale projection)'
  )
  assert.equal(
    derive(manualAutoState, runnerOff),
    'manual',
    'local manual autoState yields manual when runner.cliWatchPolling is also disabled'
  )
  assert.equal(
    derive({ desiredMode: 'run_agents', runtimeState: 'running' }, runnerOff),
    'run_agents',
    'local auto autoState yields run_agents even when run.yaml runner.cliWatchPolling is still disabled'
  )
  assert.equal(
    derive({ desiredMode: 'run_agents_and_approve_artifacts', runtimeState: 'running' }, runnerOff),
    'run_agents_and_approve_artifacts',
    'explicit approval mode wins regardless of runner.cliWatchPolling'
  )
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

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// T3: the supervisor's hard-completion gate must route through the shared
// dormancy helper — fire runner_complete once AND tear the run's agents down
// once — so a run first detected complete by this 4s poll (before the reactive
// projection reconcile) tears down exactly once and does not re-fire on repeat.
async function testHardCompletionGateEntersDormancyExactlyOnceViaHelper(): Promise<void> {
  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
  const autoState = workspace.sprintEngineAutoState!

  let applierCount = 0
  let teardownCount = 0
  const ports = {
    applySprintEngineAutomationEvent: (_workspaceId: string, event: { type: string }) => {
      applierCount += 1
      if (event.type === 'runner_complete') autoState.runtimeState = 'complete'
    },
    tearDownCompletedRunAgents: async () => { teardownCount += 1 },
    setCompletionTeardownAt: (_workspaceId: string, at: number | undefined) => {
      autoState.completionTeardownAt = at
    },
    now: () => 4321,
  }

  const state = sprintEngineStateFixture({
    tasks: [task({ id: 'T1', status: 'done' }), task({ id: 'T2', status: 'done' })],
  })

  const first = supervisor.enterDormancyIfRunComplete(workspace, state, ports)
  await flushMicrotasks()
  assert.equal(first, true, 'completed run enters dormancy')
  assert.equal(applierCount, 1, 'runner_complete fired exactly once')
  assert.equal(teardownCount, 1, 'teardown ran exactly once')
  assert.equal(autoState.completionTeardownAt, 4321, 'teardown marker set after teardown resolved')

  // Repeat entry now that the run is complete + marked: no re-fire, no re-teardown.
  const second = supervisor.enterDormancyIfRunComplete(workspace, state, ports)
  await flushMicrotasks()
  assert.equal(second, true, 'still reports the run complete')
  assert.equal(applierCount, 1, 'runner_complete not re-fired once complete')
  assert.equal(teardownCount, 1, 'teardown not re-run once the marker is set')
}

async function testHardCompletionGateIgnoresIncompleteRun(): Promise<void> {
  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture()
  let touched = 0
  const ports = {
    applySprintEngineAutomationEvent: () => { touched += 1 },
    tearDownCompletedRunAgents: async () => { touched += 1 },
    setCompletionTeardownAt: () => { touched += 1 },
    now: () => 1,
  }
  const state = sprintEngineStateFixture({ tasks: [task({ status: 'in_progress' })] })
  const result = supervisor.enterDormancyIfRunComplete(workspace, state, ports)
  await flushMicrotasks()
  assert.equal(result, false, 'an incomplete run does not enter dormancy')
  assert.equal(touched, 0, 'no dormancy port is invoked for an incomplete run')
}

// T3: the auto-run poll interval and its registered timer exist ONLY while at
// least one workspace needs the poller; when none do, no live interval and no
// 'SprintEngine auto-run poll' timer remain, and returning demand re-arms.
async function testAutoRunPollerControllerArmsOnlyWhenNeededAndReArms(): Promise<void> {
  const supervisor = await loadSupervisor()
  const LABEL = 'SprintEngine auto-run poll'
  const registeredCount = (): number =>
    getTimerRegistrations().filter((entry) => entry.label === LABEL).length

  let needed = false
  let tickCount = 0
  let intervalId = 0
  const cleared: number[] = []
  const controller = supervisor.createAutoRunPollerController({
    isPollerNeeded: () => needed,
    tick: () => { tickCount += 1 },
    setInterval: () => { intervalId += 1; return intervalId },
    clearInterval: (id: number) => { cleared.push(id) },
  })

  // No demand: nothing armed, nothing registered, no tick.
  controller.sync()
  assert.equal(intervalId, 0, 'no interval armed while no workspace needs the poller')
  assert.equal(tickCount, 0, 'no tick ran while unarmed')
  assert.equal(registeredCount(), 0, 'no auto-run poll timer registered while unarmed')

  // Demand appears: arm once, register the timer, run an immediate tick.
  needed = true
  controller.sync()
  assert.equal(intervalId, 1, 'interval armed once demand appears')
  assert.equal(tickCount, 1, 'immediate tick on arm')
  assert.equal(registeredCount(), 1, 'auto-run poll timer registered while armed')

  // Idempotent while still needed.
  controller.sync()
  assert.equal(intervalId, 1, 'sync does not re-arm an already-live interval')
  assert.equal(registeredCount(), 1, 'no duplicate timer registration')

  // Demand disappears: clear the interval and unregister the timer.
  needed = false
  controller.sync()
  assert.deepEqual(cleared, [1], 'interval cleared when demand disappears')
  assert.equal(registeredCount(), 0, 'timer unregistered once idle')

  // Returning demand (mirrors user_set_mode back to a running mode) re-arms.
  needed = true
  controller.sync()
  assert.equal(intervalId, 2, 're-arms a fresh interval on returning demand')
  assert.equal(registeredCount(), 1, 'timer re-registered on re-arm')

  controller.dispose()
  assert.deepEqual(cleared, [1, 2], 'dispose clears the live interval')
  assert.equal(registeredCount(), 0, 'dispose unregisters the timer')
}
