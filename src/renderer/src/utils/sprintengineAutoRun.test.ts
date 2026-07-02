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
  AUTO_RUN_ROLE_CONTINUATION_GRACE_MS,
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
  buildSprintEngineGateContinuationPrompt,
  continuationMessageKey,
  describeSprintEngineExternalInputAutoRunBlock,
  getActiveSprintEngineAutoRunGateClaims,
  getArchitectActionableNeedsInputTasks,
  getAutoApprovalIntentArtifacts,
  getClaimableSprintEngineAutoRunGates,
  getPendingAgentNotificationEvents,
  getSprintEngineAutoRunOccupiedAgentIds,
  getSprintEngineQueueDepthReplenishRoles,
  getSprintEngineWakeCandidateTasks,
  isSprintEngineAutoPendingSpawnStillRelevant,
  isSprintEngineRunBlockedOnExternalInput,
  pickNextAutoRuns,
  pickSprintEngineBootstrapCandidate,
  planSprintEngineDispatch,
  sprintEngineDispatchDeliveryKey,
  sprintEngineActiveAssignmentLedgerKey,
  sprintEngineAutoRunWorkKey,
  sprintEngineIdleClockKey,
  sprintEngineRespawnLedgerKey,
  sprintEngineReviveLedgerKey,
  AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES,
  type AutoRunCandidate,
  type RoleContinuationGrace,
  type SprintEngineDispatchAttempt,
  type SprintEngineDispatchPath,
} from './sprintengineAutoRun'
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
  SprintEngineQualityGate,
  SprintEngineRole,
  SprintEngineRoleId,
  SprintEngineRuntimeAgent,
  SprintEngineState,
  SprintEngineTask,
  Workspace,
  McpSettings,
} from '../types/workspace'
import { defaultAgent } from '../store/slices/agentsSlice'

const emptyMcpSettings: McpSettings = { syncEnabled: false, servers: {} }

void main()

async function main(): Promise<void> {
  testWorkKeysSeparateTaskAndGateSpawns()
  testReviewPhaseOnlyExposesReviewGates()
  testPendingGateRelevanceIsGateSpecific()
  testActiveGateClaimCanBeResumed()
  testTestingPhaseExposesTesterAfterReviewApproval()
  testKeyHelpersAreStableAndScoped()
  testStartupPromptIsMcpNative()
  testArchitectInitStartupPromptIsMcpNative()
  testGeneralStartupPromptIsMcpNative()
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
  testGetSprintEngineAutoRunOccupiedAgentIdsIgnoresChangesRequestedOwners()
  testGetSprintEngineAutoRunOccupiedAgentIdsDoesNotCountDeadNeedsInputOwner()
  testPickNextAutoRunsSelectsReadyTaskForIdleRoleAgent()
  testPickNextAutoRunsSelectsOwnerlessChangesRequestedWork()
  testPickNextAutoRunsSelectsStaleOwnedChangesRequestedWork()
  testPickNextAutoRunsSkipsUnresolvedNeedsInputOwner()
  testPickNextAutoRunsSelectsReviewTestingAndProductGates()
  testPickNextAutoRunsSkipsRetiredRoleAgent()
  testPickNextAutoRunsIgnoresRetiredPreviousOwnerForOwnerlessRework()
  testPickNextAutoRunsHonoursContinuationGraceWindow()
  testPickNextAutoRunsResumesActiveGateClaim()
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
  await testWakeCandidateCleanupPreservesGateRetryKeys()
  await testClaimedGateContinuationSkipsMatchingCurrentDispatch()
  await testClaimedGateContinuationSkipsMatchingCurrentGateWhenDispatchMissing()
  await testDispatchPromptSkipsBusyDifferentTaskTerminal()
  await testDispatchPromptSkipsAgentAlreadyWorkingDispatchTask()
  await testDispatchPromptSkipsAgentAlreadyReviewingDispatchGate()
  await testDispatchPromptSkipsNeedsInputAgent()
  testActiveAssignmentRescueSendsMinimalPromptAfterSprintEngineInactivity()
  testActiveAssignmentRescueUsesSprintEngineActivityAndResetsBudget()
  testTaskScopedRetirementFiresOnTerminalStateDespiteReadyQueue()
  testTaskScopedRetirementNeverFiresMidReworkLoop()
  testTaskScopedWakeRestrictionBlocksCrossTaskReuse()
  testTaskScopedLifecycleExemptsPlanningRoles()
  testTaskScopedRetirementHonorsShortCooldown()
  testTaskScopedRestrictionDoesNotBlockGateClaims()
  testTaskScopedParkingStaysConsistentWithGateAvailability()
  testWindowDisposalMarksRetainResumeStateAndTerminalStateDoesNot()
  testPickNextAutoRunsPrefersPreviousOwnerForRework()
  await testSpawnAutoRunCandidateResumesPreviousOwnerConversation()
  await testWindowDisposalRetainsResumeStateInStore()
  testQueueDepthReplenishRolesComputeDeficits()
  testTaskScopedRetirementStormBoundFallsBackToSlowCadence()
  testSelfReviewBarredOwnGateDoesNotParkCompletedWorker()
  testGenericPickAvoidsReworkReservedOwners()
  testPickNextAutoRunsDefersReworkToLiveBoundOwner()
  testNeedsInputHoldRetainsResumeState()
  testReconcileLaunchFlagsPreservesRetainedResumeShape()
  await testSpawnResumeBlockedForCrashedLiveFlags()
  await testWindowDisposalWithoutTokenFullyClears()
  await testQueueDepthTriggerPayloadAndNoopFingerprint()
  await testStaleRetainedResumeStateClearedOnceTaskDone()
  testActiveAssignmentRescueStopsAfterTwoPromptsWithDiagnostic()
  await testActiveAssignmentExhaustionDiagnosticMarksLedger()
  testActiveGateAssignmentRescueSendsMinimalPrompt()
  await testSpawnAutoRunCandidateStartsMissingTerminalWithJoinPrompt()
  await testSuperviseRunnerCycleSpawnsReplenishedRetiredCapacity()
  await testSuperviseRunnerCycleRestartsExitedRoleForReadyTask()
  await testSuperviseRunnerCycleBootstrapsOnlyArchitectForFreshRun()
  await testSuperviseRunnerCycleDoesNotRestartUnresolvedNeedsInputOwner()
  await testSuperviseRunnerCycleStartsReviewGateWhenUnrelatedAgentNeedsInput()
  await testSuperviseRunnerCycleDoesNotMutateTaskOrGateState()
  await testSuperviseRunnerCycleReengagesStalledLiveIdleAgentForChangesRequested()
  await testRespawnsDeadTaskClaimantAfterRestart()
  await testRespawnsDeadGateClaimantWithGateClaimTool()
  await testRespawnSkipsLiveCappedNeedsInputAndCoolingClaimants()
  testRevivesLeftAgentForClaimableWork()
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
  // The queue-depth replenish trigger (MC-1444 Phase 3) may fire during any
  // supervise cycle whose fixture has ready tasks beyond spawnable capacity;
  // default it to a no-op "nothing created" result so fixtures that don't
  // exercise replenishment keep working. Tests that assert on replenish
  // behavior pass their own stub.
  const apiWithDefaults = {
    replenishSprintEngineRoster: async () => ({ ok: true, data: {} }),
    ...api,
  }
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage, api: apiWithDefaults, crypto: cryptoShim },
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
      desiredMode: 'run_agents_and_approve_artifacts',
      runtimeState: 'running',
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
    qualityGates: [],
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
      pendingSpawns: [],
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
        qualityGates: [],
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
      pendingSpawns: [],
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
      pendingSpawns: [],
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
    qualityGates: [],
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
    {
      capacityByRole: new Map([['frontend', 1]]),
      agentIds: new Set(['frontend-2']),
    },
    sent
  )
  assert.equal(writes.length, 2, 'wake-candidate prompt is still pasted and submitted for the final allowed retry')
  assert.equal(sent.current.get(key)?.attempts, supervisor.AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES)

  sent.current.set(key, { sentAt: Date.now() - 120_000, attempts: supervisor.AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES })
  await supervisor.sendContinuationPromptsToIdleAgents(
    workspace,
    state,
    {
      capacityByRole: new Map([['frontend', 1]]),
      agentIds: new Set(['frontend-2']),
    },
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
    qualityGates: [],
  })
  const readyTask = task({
    id: 'T7',
    title: 'Convert bottom sheets to PIN minimal',
    status: 'todo',
    boardColumn: 'ready',
    role: 'frontend',
    ownerAgentId: null,
    qualityGates: [],
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

async function testWakeCandidateCleanupPreservesGateRetryKeys(): Promise<void> {
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
    qualityGates: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [readyTask],
    sprintEngineAgents: {
      'frontend-2': runtimeAgent('frontend', { status: 'idle' }),
    },
  })
  const staleTaskKey = continuationMessageKey(workspace, 'T-old', 'frontend-2')
  const gateKey = continuationMessageKey(workspace, 'T6:tester', 'tester-1')
  const sent = mutableRef(new Map<string, { sentAt: number; attempts?: number }>([
    [staleTaskKey, { sentAt: Date.now() - 120_000, attempts: 1 }],
    [gateKey, { sentAt: Date.now() - 120_000, attempts: 1 }],
  ]))

  await supervisor.sendContinuationPromptsToIdleAgents(
    workspace,
    state,
    {
      capacityByRole: new Map([['frontend', 1]]),
      agentIds: new Set(['frontend-2']),
    },
    sent
  )

  assert.equal(writes.length, 2, 'ready task wake candidate is still sent and submitted')
  assert.equal(sent.current.has(staleTaskKey), false, 'stale task wake-candidate retry state is pruned')
  assert.equal(sent.current.has(gateKey), true, 'claimed-gate retry state is not pruned by task wake cleanup')
}

async function testClaimedGateContinuationSkipsMatchingCurrentDispatch(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-tester',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'tester-1',
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
      'tester-1': sprintAgent('tester-1', 'Tess'),
    },
  })
  const testingTask = task({
    id: 'T6',
    title: 'Normalize Sprint Engine MCP tool contracts',
    status: 'testing',
    boardColumn: 'testing',
    role: 'developer',
    ownerAgentId: null,
    qualityGates: [
      { id: 'code_reviewer', phase: 'review', role: 'code_reviewer', status: 'approved', required: true, allowSelfReview: true, focus: '', attempts: [] },
      { id: 'spec_reviewer', phase: 'review', role: 'spec_reviewer', status: 'approved', required: true, allowSelfReview: true, focus: '', attempts: [] },
      {
        id: 'tester',
        phase: 'testing',
        role: 'tester',
        status: 'in_progress',
        required: true,
        allowSelfReview: true,
        focus: '',
        attempts: [{ id: 'GA-001', status: 'in_progress', role: 'tester', claimedBy: 'tester-1', startedAt: '2026-05-27T19:57:15Z' }],
      },
    ],
  })
  const state = sprintEngineStateFixture({
    tasks: [testingTask],
    sprintEngineAgents: {
      'tester-1': runtimeAgent('tester', {
        status: 'running',
        currentTaskId: 'T6',
        currentDispatch: {
          dispatchId: 'DISP-dd5c336fd44f0fb7',
          targetKind: 'gate',
          role: 'tester',
          reason: 'gate_claimed',
          taskId: 'T6',
          gateId: 'tester',
          attemptId: 'GA-001',
        },
      }),
    },
  })
  const key = continuationMessageKey(workspace, 'T6:tester', 'tester-1')
  const sent = mutableRef(new Map<string, { sentAt: number; attempts?: number }>([
    [key, { sentAt: Date.now() - 120_000, attempts: 4 }],
  ]))

  await supervisor.sendGateContinuationPromptsToAgents(
    workspace,
    state,
    new Set(['tester-1']),
    { capacityByRole: new Map(), agentIds: new Set() },
    sent
  )

  assert.equal(writes.length, 0, 'claimed gate prompt is not pasted once the matching durable dispatch is current')
  assert.equal(sent.current.has(key), false, 'stale claimed-gate continuation retry state is cleared')
}

async function testClaimedGateContinuationSkipsMatchingCurrentGateWhenDispatchMissing(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-tester',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'tester-1',
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
      'tester-1': sprintAgent('tester-1', 'Tess'),
    },
  })
  const testingTask = task({
    id: 'T16',
    title: 'Implement gig edit and cancellation flows',
    status: 'testing',
    boardColumn: 'testing',
    role: 'developer',
    ownerAgentId: null,
    qualityGates: [
      { id: 'code_reviewer', phase: 'review', role: 'code_reviewer', status: 'approved', required: true, allowSelfReview: true, focus: '', attempts: [] },
      {
        id: 'tester',
        phase: 'testing',
        role: 'tester',
        status: 'in_progress',
        required: true,
        allowSelfReview: true,
        focus: '',
        attempts: [{ id: 'GA-T16-001', status: 'in_progress', role: 'tester', claimedBy: 'tester-1', startedAt: '2026-05-30T10:15:00Z' }],
      },
    ],
  })
  const state = sprintEngineStateFixture({
    tasks: [testingTask],
    sprintEngineAgents: {
      'tester-1': runtimeAgent('tester', {
        status: 'running',
        currentTaskId: 'T16',
        currentGateId: 'tester',
        currentGate: {
          taskId: 'T16',
          gateId: 'tester',
          attemptId: 'GA-T16-001',
        },
        currentDispatch: null,
      }),
    },
  })
  const key = continuationMessageKey(workspace, 'T16:tester', 'tester-1')
  const sent = mutableRef(new Map<string, { sentAt: number; attempts?: number }>([
    [key, { sentAt: Date.now() - 120_000, attempts: 4 }],
  ]))

  await supervisor.sendGateContinuationPromptsToAgents(
    workspace,
    state,
    new Set(['tester-1']),
    { capacityByRole: new Map(), agentIds: new Set() },
    sent
  )

  assert.equal(writes.length, 0, 'claimed gate prompt is not pasted when the runtime agent already owns the gate')
  assert.equal(sent.current.has(key), false, 'stale claimed-gate retry state is cleared even without currentDispatch')
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

async function testDispatchPromptSkipsAgentAlreadyReviewingDispatchGate(): Promise<void> {
  const writes: Array<{ sessionId: string; text: string }> = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-reviewer',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'code-reviewer',
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
      'code-reviewer': sprintAgent('code-reviewer', 'Casey'),
    },
  })
  const state = sprintEngineStateFixture({
    sprintEngineAgents: {
      'code-reviewer': runtimeAgent('code_reviewer', {
        status: 'running',
        currentTaskId: 'T12',
        currentGateId: 'code_reviewer',
        currentGate: {
          taskId: 'T12',
          gateId: 'code_reviewer',
          attemptId: 'GATE-code_reviewer-1',
        },
        currentDispatch: {
          dispatchId: 'DISP-active-gate',
          targetKind: 'gate',
          role: 'code_reviewer',
          taskId: 'T12',
          gateId: 'code_reviewer',
          attemptId: 'GATE-code_reviewer-1',
          reason: 'gate_claimed',
        },
      }),
    },
  })

  await supervisor.sendDispatchPromptsToRunningAgents(
    workspace,
    state,
    new Set(['code-reviewer']),
    sent
  )

  assert.equal(writes.length, 0, 'dispatch prompts do not interrupt an agent already reviewing the same gate')
  assert.equal(sent.current.size, 0, 'skipped active gate dispatch prompts are not marked delivered')
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
    qualityGates: [],
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
    qualityGates: [],
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
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T-next', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
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

function testTaskScopedRetirementNeverFiresMidReworkLoop(): void {
  // Publish→verdict is NOT terminal: a task in review keeps the worker on the
  // ordinary idle-window path (fast rework lands in the warm terminal), and a
  // changes_requested verdict wakes the same agent instead of retiring it.
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
  assert.equal(freshPlan.retirements.length, 0, 'a worker awaiting its verdict is not retired inside the idle window')

  const parkedClock = new Map([[sprintEngineIdleClockKey(workspace, 'developer-1'), now - AUTO_RUN_IDLE_RETIREMENT_MS - 60_000]])
  const parkedPlan = taskScopedPlanInput({ workspace, state: inReviewState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(parkedPlan.retirements.length, 1, 'past the idle window the parked publisher is still reclaimed (production behavior)')
  assert.equal(parkedPlan.retirements[0].data.reason, 'idle_window')

  const reworkState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'changes_requested', boardColumn: 'changes_requested', ownerAgentId: 'developer-1', qualityGates: [] })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  const reworkWake = taskScopedPlanInput({ workspace, state: reworkState, now, idleAgentIds: ['developer-1'], paths: ['task_wake'] })
  assert.equal(reworkWake.pastes.length, 1, 'rework on the worker\'s own task still wakes the live terminal')
  assert.equal(reworkWake.pastes[0].agentId, 'developer-1')
  const reworkRetire = taskScopedPlanInput({ workspace, state: reworkState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(reworkRetire.retirements.length, 0, 'own-task rework blocks retirement even past the idle window')
}

function testTaskScopedWakeRestrictionBlocksCrossTaskReuse(): void {
  // A used live terminal never receives a different task; a fresh agent of the
  // same role does.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T-next', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
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
      task({ id: 'T-finished', role: 'general', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T-next', role: 'general', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
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
      [task({ id: 'T-other', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] })],
      'developer',
      'developer-1',
      new Set(),
      'T-x'
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
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
      // The run must still be mid-flight: an all-tasks-done run skips the
      // idle_retire path entirely (completion teardown owns those terminals).
      task({ id: 'T-elsewhere', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
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

function testTaskScopedRestrictionDoesNotBlockGateClaims(): void {
  // Reviewers keep the reuse-preferring lifecycle BY DECISION (MC-1444), and
  // that includes roles that also own tasks: the product agent owns the intake
  // task yet must review every task's product gate. Gate claiming is therefore
  // never restricted by lastOwnedTaskId — only handing out TASKS is.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const gatedTask = task({
    id: 'T-other',
    role: 'developer',
    status: 'review',
    boardColumn: 'review',
    ownerAgentId: 'developer-2',
    qualityGates: [
      { id: 'product', phase: 'review', role: 'product', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
  })
  const state = sprintEngineStateFixture({
    tasks: [
      // The product agent's own intake task, parked in review awaiting the user.
      task({ id: 'T-intake', role: 'product', status: 'review', boardColumn: 'review', ownerAgentId: 'product-1', qualityGates: [] }),
      gatedTask,
    ],
    sprintEngineAgents: {
      'product-1': runtimeAgent('product', { lastOwnedTaskId: 'T-intake' }),
    },
  })
  const plan = taskScopedPlanInput({ workspace, state, now, idleAgentIds: ['product-1'], paths: ['gate'] })
  assert.equal(plan.pastes.length, 1, 'the used product terminal still claims another task\'s product gate')
  assert.equal(plan.pastes[0].agentId, 'product-1')
}

function testTaskScopedParkingStaysConsistentWithGateAvailability(): void {
  // Regression (found in review): a completed task-scoped worker whose role
  // has a claimable gate elsewhere must not become a zombie — parked by the
  // claimable-gate retirement skip yet refused the gate. With gate claiming
  // unrestricted, the gate path engages it; retirement then waits (engaged
  // agents are never killed in the same pass), and fires once no gate work
  // remains.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const gatedTask = task({
    id: 'T-other',
    role: 'tester',
    status: 'review',
    boardColumn: 'review',
    ownerAgentId: 'tester-9',
    qualityGates: [
      { id: 'developer', phase: 'review', role: 'developer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
  })
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
      gatedTask,
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-finished' }),
    },
  })
  const idleClock = new Map([[sprintEngineIdleClockKey(workspace, 'developer-1'), now - 1_000]])
  // Gate + retire in one pass: the gate engagement wins (one action per agent
  // per pass), so the worker does the gate instead of rotting.
  const plan = taskScopedPlanInput({ workspace, state, now, idleAgentIds: ['developer-1'], paths: ['gate', 'idle_retire'], idleClock })
  assert.equal(plan.pastes.length, 1, 'the completed worker is engaged on the claimable same-role gate')
  assert.equal(plan.pastes[0].agentId, 'developer-1')
  assert.equal(plan.retirements.length, 0, 'no kill is planned in the same pass as an engagement')

  // Once the gate is gone, the completed worker retires without the idle window.
  const stateNoGate = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T-elsewhere', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-finished' }),
    },
  })
  const retirePlan = taskScopedPlanInput({ workspace, state: stateNoGate, now, idleAgentIds: ['developer-1'], paths: ['gate', 'idle_retire'], idleClock })
  assert.equal(retirePlan.retirements.length, 1, 'with no claimable gate the completed worker retires promptly')
  assert.equal(retirePlan.retirements[0].data.reason, 'task_scoped_terminal_state')
}

function testWindowDisposalMarksRetainResumeStateAndTerminalStateDoesNot(): void {
  // MC-1444 Phase 2: an idle-window disposal of a worker whose own task is
  // still in publish→verdict carries retainResumeState (the executor keeps the
  // resume token); a terminal-state retirement never does (the next task must
  // get a fresh session).
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const parkedClock = new Map([[sprintEngineIdleClockKey(workspace, 'developer-1'), now - AUTO_RUN_IDLE_RETIREMENT_MS - 60_000]])

  const inReviewState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'review', boardColumn: 'review', ownerAgentId: 'developer-1', qualityGates: [] })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  const windowPlan = taskScopedPlanInput({ workspace, state: inReviewState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(windowPlan.retirements.length, 1)
  assert.equal(windowPlan.retirements[0].retainResumeState, true, 'window disposal keeps the resume token for late rework')

  const doneState = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-mine', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T-open', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  const terminalPlan = taskScopedPlanInput({ workspace, state: doneState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(terminalPlan.retirements.length, 1)
  assert.equal(terminalPlan.retirements[0].retainResumeState, undefined, 'terminal-state retirement clears resume state — fresh session per task')

  // A parked agent with NO owned task (fresh/reviewer) also gets a plain
  // disposal: nothing to resume toward.
  const neverOwnedState = sprintEngineStateFixture({
    tasks: [task({ id: 'T-open', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer'),
    },
  })
  const plainPlan = taskScopedPlanInput({ workspace, state: neverOwnedState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock: parkedClock })
  assert.equal(plainPlan.retirements.length, 1)
  assert.equal(plainPlan.retirements[0].retainResumeState, undefined)
}

function testPickNextAutoRunsPrefersPreviousOwnerForRework(): void {
  // Owner affinity (MC-1444 Phase 2): a changes_requested task goes back to
  // the roster agent that owned it — its respawn resumes the original
  // conversation — even when another idle agent of the role sorts first.
  const reworkTask = task({
    id: 'T-mine',
    role: 'developer',
    status: 'changes_requested',
    boardColumn: 'changes_requested',
    ownerAgentId: null,
    qualityGates: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [reworkTask],
    sprintEngineAgents: {
      'developer-0': runtimeAgent('developer'),
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].taskId, 'T-mine')
  assert.equal(candidates[0].agentId, 'developer-1', 'the previous owner is preferred over the first eligible role agent')

  // Without a previous owner among the eligible agents, selection falls back
  // to the generic first-eligible pick.
  const noOwnerState = sprintEngineStateFixture({
    tasks: [reworkTask],
    sprintEngineAgents: {
      'developer-0': runtimeAgent('developer'),
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-other' }),
    },
  })
  const fallback = pickNextAutoRuns(workspaceFixture(), noOwnerState, pickInput())
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].agentId, 'developer-0')
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
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
  })
  const state = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'changes_requested', boardColumn: 'changes_requested', ownerAgentId: null, qualityGates: [] })],
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
    tasks: [task({ id: 'T-new', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] })],
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
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T-open', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
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

function testSelfReviewBarredOwnGateDoesNotParkCompletedWorker(): void {
  // Review finding: a claimable same-role gate the agent can never claim
  // (its own task, allowSelfReview false) must not park it as a zombie.
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const state = sprintEngineStateFixture({
    tasks: [
      task({
        id: 'T-mine',
        role: 'developer',
        status: 'review',
        boardColumn: 'review',
        ownerAgentId: 'developer-1',
        qualityGates: [
          { id: 'developer', phase: 'review', role: 'developer', status: 'pending', required: true, allowSelfReview: false, focus: '', attempts: [] },
        ],
      }),
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
    ],
    sprintEngineAgents: {
      // lastOwned points at the done task; the pending gate is on T-mine
      // which this agent owns — self-review barred, so the gate cannot park it.
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-finished' }),
    },
  })
  const idleClock = new Map([[sprintEngineIdleClockKey(workspace, 'developer-1'), now - 1_000]])
  const plan = taskScopedPlanInput({ workspace, state, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock })
  assert.equal(plan.retirements.length, 1, 'a gate the agent can never claim does not defer its retirement')

  // Wait — the gate is on developer-1's OWN task, but its ownership matters,
  // not lastOwned: a different agent (fresh) CAN claim it, so a fresh idle
  // developer IS parked by it (claimable work for the role).
  const parkedState = sprintEngineStateFixture({
    tasks: [
      task({
        id: 'T-other',
        role: 'developer',
        status: 'review',
        boardColumn: 'review',
        ownerAgentId: 'developer-9',
        qualityGates: [
          { id: 'developer', phase: 'review', role: 'developer', status: 'pending', required: true, allowSelfReview: false, focus: '', attempts: [] },
        ],
      }),
      task({ id: 'T-finished', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-finished' }),
    },
  })
  const parkedPlan = taskScopedPlanInput({ workspace, state: parkedState, now, idleAgentIds: ['developer-1'], paths: ['idle_retire'], idleClock })
  assert.equal(parkedPlan.retirements.length, 0, 'a gate the agent CAN claim (someone else\'s task) still parks it for that work')
}

function testGenericPickAvoidsReworkReservedOwners(): void {
  // Review finding: iteration order must not burn a rework owner (and its
  // retained conversation) on an unrelated earlier task.
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-new', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T-rework', role: 'developer', status: 'changes_requested', boardColumn: 'changes_requested', ownerAgentId: null, qualityGates: [] }),
    ],
    sprintEngineAgents: {
      // Previous owner of the rework sorts FIRST — the generic pick must skip it.
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-rework' }),
      'developer-2': runtimeAgent('developer'),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  const byTask = new Map(candidates.map((candidate) => [candidate.taskId, candidate.agentId]))
  assert.equal(byTask.get('T-new'), 'developer-2', 'the unreserved agent takes the new task')
  assert.equal(byTask.get('T-rework'), 'developer-1', 'the rework owner is preserved for its own task')
}

function testPickNextAutoRunsDefersReworkToLiveBoundOwner(): void {
  // Review finding: when the previous owner is LIVE and idle, the wake paste
  // engages it in the same cycle — spawning a second agent for the same
  // rework double-dispatches the task.
  const state = sprintEngineStateFixture({
    tasks: [task({ id: 'T-rework', role: 'developer', status: 'changes_requested', boardColumn: 'changes_requested', ownerAgentId: null, qualityGates: [] })],
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
    tasks: [task({ id: 'T-held', role: 'developer', status: 'needs_input', boardColumn: 'needs_input', ownerAgentId: 'developer-1', qualityGates: [] })],
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
  assert.equal(agents['developer-2'].cliSessionId, undefined, 'a genuinely stale launch state is still cleared')
  assert.equal(agents['developer-2'].cliStartRequested, false)
}

function testQueueDepthReplenishRolesComputeDeficits(): void {
  // MC-1444 Phase 3 trigger: a role is flagged when its ready-queue depth
  // exceeds spawnable capacity. Bound-in-window ids are not capacity; a
  // covered changes_requested task adds no depth; planning roles never flag.
  const deficitState = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T0', role: 'developer', status: 'review', boardColumn: 'review', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T1', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T2', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'G1', role: 'general', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T0' }),
      'developer-2': runtimeAgent('developer'),
    },
  })
  assert.deepEqual(
    getSprintEngineQueueDepthReplenishRoles(deficitState),
    ['developer'],
    'two ready tasks vs one spawnable id flags the role; the window-bound id is not capacity; the planning role never flags'
  )

  const coveredState = sprintEngineStateFixture({
    tasks: [task({ id: 'T1', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] })],
    sprintEngineAgents: {
      'developer-2': runtimeAgent('developer'),
    },
  })
  assert.deepEqual(getSprintEngineQueueDepthReplenishRoles(coveredState), [], 'capacity covering depth flags nothing')

  const reworkState = sprintEngineStateFixture({
    tasks: [task({ id: 'T1', role: 'developer', status: 'changes_requested', boardColumn: 'changes_requested', ownerAgentId: null, qualityGates: [] })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T1' }),
    },
  })
  assert.deepEqual(
    getSprintEngineQueueDepthReplenishRoles(reworkState),
    [],
    'rework covered by its bound previous owner adds no depth'
  )

  // Review findings: a LIVE done-lastOwned terminal (retirement deferred,
  // e.g. visible tab) is not capacity — without the liveness exclusion the
  // whole role queue stalls behind the watched terminal; and triage-pending
  // tasks add no depth (Python's task_is_ready refuses them).
  const watchedState = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-done', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T-next', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-done' }),
    },
  })
  assert.deepEqual(
    getSprintEngineQueueDepthReplenishRoles(watchedState, new Set(['developer-1'])),
    ['developer'],
    'a live done-lastOwned terminal is not capacity — the role needs a mint'
  )
  assert.deepEqual(
    getSprintEngineQueueDepthReplenishRoles(watchedState, new Set()),
    [],
    'the same id counts once disposed (it respawns fresh)'
  )

  const triageState = sprintEngineStateFixture({
    tasks: [
      { ...task({ id: 'T-triage', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }), needsTriage: true } as SprintEngineTask,
    ],
    sprintEngineAgents: {},
  })
  assert.deepEqual(
    getSprintEngineQueueDepthReplenishRoles(triageState),
    [],
    'triage-pending tasks add no depth (Python would refuse to fill them)'
  )
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
      maxConcurrentAgents: 3, pendingSpawns: [], deliveredAgentNotificationEventKeys: [],
    },
  })
  const state = sprintEngineStateFixture({
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'changes_requested', boardColumn: 'changes_requested', ownerAgentId: null, qualityGates: [] })],
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
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'review', boardColumn: 'review', ownerAgentId: 'developer-1', qualityGates: [] })],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }) },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'developer-1': sprintAgent('developer-1', 'Dev One', 'codex') },
    sprintEngineAutoState: {
      desiredMode: 'run_agents', runtimeState: 'running', cliPermissionPreset: 'default',
      maxConcurrentAgents: 3, pendingSpawns: [], deliveredAgentNotificationEventKeys: [],
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

async function testQueueDepthTriggerPayloadAndNoopFingerprint(): Promise<void> {
  // Coverage gap from review: the Phase 3 trigger payload was unasserted (a
  // regression could silently disable queue-depth minting), and a no-mint
  // outcome must park the trigger until the projection changes instead of
  // spawning a no-op CLI subprocess every supervise tick.
  const replenishCalls: Array<Record<string, unknown>> = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    terminalWrite: async () => ({ ok: true }),
    terminalSpawn: async (sessionId: string) => ({ ok: true, sessionId }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    replenishSprintEngineRoster: async (input: Record<string, unknown>) => {
      replenishCalls.push(input)
      return { ok: true, data: {} }
    },
    logDiagnostic: async (input) => input,
  })
  const supervisor = await loadSupervisor()
  const sprintEngineState = sprintEngineStateFixture({
    updatedAt: '2026-07-02T12:00:00Z',
    tasks: [
      task({ id: 'T1', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T2', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
    ],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer'),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'developer-1': sprintAgent('developer-1', 'Dev One') },
    sprintEngineAutoState: {
      desiredMode: 'run_agents', runtimeState: 'running', cliPermissionPreset: 'default',
      maxConcurrentAgents: 4, pendingSpawns: [], deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)
  const idleClockByAgent = mutableRef(new Map<string, number>())
  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)
  assert.equal(replenishCalls.length, 1, 'a role deficit triggers exactly one replenish call')
  assert.equal(replenishCalls[0].queueDepth, true, 'the payload requests queue-depth mode')
  assert.equal(replenishCalls[0].maxNew, 4, 'maxNew carries the local concurrency ceiling')

  // Same projection, no mint: the trigger is parked — no per-tick churn.
  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)
  assert.equal(replenishCalls.length, 1, 'a no-mint outcome parks the trigger until the projection changes')
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
      task({ id: 'T-mine', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
      task({ id: 'T-open', role: 'tester', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
    ],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }) },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'developer-1': retainedAgent },
    sprintEngineAutoState: {
      desiredMode: 'run_agents', runtimeState: 'running', cliPermissionPreset: 'default',
      maxConcurrentAgents: 3, pendingSpawns: [], deliveredAgentNotificationEventKeys: [],
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
    tasks: [task({ id: 'T-mine', role: 'developer', status: 'review', boardColumn: 'review', ownerAgentId: 'developer-1', qualityGates: [] })],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { lastOwnedTaskId: 'T-mine' }),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'developer-1': sprintAgent('developer-1', 'Dev One', 'claude-code') },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
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
    qualityGates: [],
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
    qualityGates: [],
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

function testActiveGateAssignmentRescueSendsMinimalPrompt(): void {
  const now = Date.parse('2026-06-17T12:00:00Z')
  const startedAt = new Date(now - AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS - 1_000).toISOString()
  const workspace = workspaceFixture()
  const reviewTask = task({
    id: 'T-review',
    title: 'Review haunted house shell',
    status: 'review',
    boardColumn: 'review',
    ownerAgentId: 'developer-1',
    qualityGates: [{
      id: 'code_reviewer',
      phase: 'review',
      role: 'code_reviewer',
      status: 'in_progress',
      required: true,
      allowSelfReview: true,
      focus: '',
      attempts: [{
        id: 'GATE-code_reviewer-1',
        status: 'in_progress',
        role: 'code_reviewer',
        claimedBy: 'code-reviewer-1',
        startedAt,
      }],
    }],
  })
  const state = sprintEngineStateFixture({
    tasks: [reviewTask],
    sprintEngineAgents: {
      'code-reviewer-1': runtimeAgent('code_reviewer', {
        status: 'running',
        currentTaskId: 'T-review',
        currentGateId: 'code_reviewer',
      }),
    },
  })

  const plan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: state,
    now,
    runningAgentIds: new Set(['code-reviewer-1']),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['active_assignment']),
  })

  assert.equal(plan.pastes.length, 1, 'stale claimed gate work gets one continuation paste')
  assert.equal(plan.pastes[0].prompt, 'Continue.')
  assert.equal(
    plan.pastes[0].key,
    sprintEngineActiveAssignmentLedgerKey(workspace, { taskId: 'T-review', gateId: 'code_reviewer' }, 'code-reviewer-1')
  )
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
      'code_reviewer': sprintAgent('code_reviewer', 'Code Reviewer'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
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
  assert.equal(spawns[0].metadata?.agentSession?.role, 'code_reviewer')
  assert.equal(spawns[0].metadata?.visible, false, 'normal auto-run spawns stay background')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.agent.join'), 'startup prompt names the MCP join tool')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.gate.next'), 'startup prompt names the MCP gate claim tool')
  assert.ok(!spawns[0].initialPrompt?.includes('sprintengine.agent.next_directive'), 'startup prompt does not route through the directive hop')
  assert.ok(spawns[0].initialPrompt?.includes('"role": "code_reviewer"'), 'startup prompt embeds the role in the MCP payload')
  assert.ok(spawns[0].initialPrompt?.includes('"agentId": "code_reviewer"'), 'startup prompt embeds the agentId in the MCP payload')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(spawns[0].initialPrompt ?? ''),
    'startup prompt does not contain any sprintengine CLI command instructions'
  )
}

async function testSuperviseRunnerCycleSpawnsReplenishedRetiredCapacity(): Promise<void> {
  const spawns: Array<{ agentId?: string; cli?: AgentCli; initialPrompt?: string }> = []
  const replenishedProjection = {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: '2026-05-21T12:00:00Z',
    updatedAt: '2026-05-21T12:00:00Z',
    run: {
      id: 'run-id',
      name: 'Auto-run workspace',
      goal: '',
      status: 'executing',
      rosterConfigured: true,
      runner: { cliWatchPolling: 'enabled' },
    },
    roleCounts: { developer: 2 },
    roster: {
      'developer-1': { role: 'developer', status: 'retired', currentTaskId: null },
      'developer-2': { role: 'developer', status: 'idle', currentTaskId: null },
    },
    // Replenished capacity only spawns for claimable work: the lazy-spawn
    // contract routes the replacement through pickNextAutoRuns, so the run
    // must have a ready developer task for the same-cycle spawn to happen.
    tasks: [{
      id: 'T-ready',
      title: 'Ready developer task',
      role: 'developer',
      status: 'ready',
      folderStatus: 'ready',
      dependsOn: [],
      qualityGates: [],
      activity: [],
    }],
    artifacts: [],
    activity: [],
  }
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    replenishSprintEngineRoster: async () => ({
      ok: true,
      data: {
        projectionContent: JSON.stringify(replenishedProjection),
        tool: { created: [{ id: 'developer-2', role: 'developer' }] },
      },
    }),
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
      pendingSpawns: [],
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
    continuationGraceByTask: mutableRef(new Map()),
    idleClockByAgent: mutableRef(new Map()),
  })

  const replacementSpawn = spawns.find((spawn) => spawn.agentId === 'developer-2')
  assert.ok(
    replacementSpawn,
    `newly replenished roster member is spawned in the same supervise cycle; spawned ${JSON.stringify(spawns)}`
  )
  assert.ok(!spawns.some((spawn) => spawn.agentId === 'developer-1'), 'retired roster member is not respawned')
  assert.equal(replacementSpawn.cli, 'claude-code')
  assert.ok(replacementSpawn.initialPrompt?.includes('sprintengine.agent.join'), 'replacement spawn names the MCP join tool')
  assert.ok(
    replacementSpawn.initialPrompt?.includes('"role": "developer"') && replacementSpawn.initialPrompt?.includes('"agentId": "developer-2"'),
    'replacement spawn embeds the MCP payload for the new agent'
  )
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(replacementSpawn.initialPrompt ?? ''),
    'replacement spawn prompt does not embed any sprintengine CLI command'
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
    role: 'code_reviewer',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
    dependsOn: ['T5'],
    qualityGates: [],
  })
  const sprintEngineState = sprintEngineStateFixture({
    runner: { cliWatchPolling: 'enabled', pollIntervalSeconds: 10, idleBackoffSeconds: 30, maxBackoffSeconds: 120, stopWhenComplete: true },
    sprintEngineAgents: {
      code_reviewer: runtimeAgent('code_reviewer', { status: 'idle', currentTaskId: null }),
    },
    tasks: [readyReviewTask],
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: {
      code_reviewer: {
        ...sprintAgent('code_reviewer', 'Shawn'),
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
      pendingSpawns: [],
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
    continuationGraceByTask: mutableRef(new Map()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(spawns.length, 1, `exited role agent should restart for ready work; spawns ${JSON.stringify(spawns)}`)
  assert.equal(spawns[0].agentId, 'code_reviewer')
  assert.equal(spawns[0].cli, 'codex')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.agent.join'), 'restarted code_reviewer prompt names the MCP join tool')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.gate.next'), 'restarted code_reviewer prompt names the MCP gate claim tool')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(spawns[0].initialPrompt ?? ''),
    'restarted code_reviewer prompt does not embed any sprintengine CLI command'
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

function testRevivesLeftAgentForClaimableWork(): void {
  // Regression: idle-retirement disposes a role's terminal (agent -> 'left').
  // When claimable work later appears for that role and no live agent of the
  // role exists, the respawn path must REVIVE the left agent — otherwise the
  // gate/ready-task pickers (which only match `idle` agents) strand the run.
  const now = Date.parse('2026-06-28T22:00:00Z')
  const readyTask = task({
    id: 'T-ready',
    title: 'Ready developer task',
    role: 'developer',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
    qualityGates: [],
  })
  const workspace = workspaceFixture({ agents: { 'developer-1': sprintAgent('developer-1', 'Perry') } })

  const plan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({
      tasks: [readyTask],
      sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { status: 'left' }) },
    }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(plan.respawns.length, 1, `a left agent is revived for claimable ready work; respawns ${JSON.stringify(plan.respawns)}`)
  assert.equal(plan.respawns[0].agentId, 'developer-1', 'the left agent itself is revived, not a fresh replacement')
  assert.equal(plan.respawns[0].role, 'developer')

  // No revival when a live agent of the role already exists — it will claim the
  // work through the normal idle picker, so we must not spawn a redundant one.
  const planWithLiveAgent = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({
      tasks: [readyTask],
      sprintEngineAgents: {
        'developer-1': runtimeAgent('developer', { status: 'left' }),
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

  // Storm guard: once the `revive:` ledger key has hit the retry cap, revival
  // stops (no endless respawn of a broken CLI). The key uses its own `revive:`
  // namespace so the `respawn:` sweep can't wipe it and reset the counter; and
  // while the revival is still an active target its key must NOT be swept.
  const reviveKey = sprintEngineReviveLedgerKey(workspace, { taskId: 'T-ready' }, 'developer-1')
  const cappedPlan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({
      tasks: [readyTask],
      sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { status: 'left' }) },
    }),
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

  // The production stuck case: a task in REVIEW with a pending review gate whose
  // role has only left agents. Revival must respawn the reviewer for the GATE
  // (distinct code path from ready-task revival), carrying the gateId.
  const reviewTask = task({
    id: 'T-review',
    title: 'Developer task awaiting review',
    role: 'developer',
    status: 'review',
    boardColumn: 'review',
    ownerAgentId: null,
    qualityGates: [
      { id: 'code_reviewer', phase: 'review', role: 'code_reviewer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
  })
  const gateWorkspace = workspaceFixture({ agents: { 'code-reviewer-1': sprintAgent('code-reviewer-1', 'Remy') } })
  const gatePlan = planSprintEngineDispatch({
    workspace: gateWorkspace,
    sprintEngineState: sprintEngineStateFixture({
      tasks: [reviewTask],
      sprintEngineAgents: { 'code-reviewer-1': runtimeAgent('code_reviewer', { status: 'left' }) },
    }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(gatePlan.respawns.length, 1, `a left reviewer is revived for a pending gate; respawns ${JSON.stringify(gatePlan.respawns)}`)
  assert.equal(gatePlan.respawns[0].agentId, 'code-reviewer-1')
  assert.equal(gatePlan.respawns[0].role, 'code_reviewer')
  assert.equal(gatePlan.respawns[0].gateId, 'code_reviewer', 'the revival carries the gate id so the reviewer claims the gate')

  // A `dead` agent (process died, vs cleanly left) is equally revivable.
  const deadPlan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({
      tasks: [readyTask],
      sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { status: 'dead' }) },
    }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(deadPlan.respawns.length, 1, 'a dead agent is revived for claimable work')
  assert.equal(deadPlan.respawns[0].agentId, 'developer-1')

  // An unmanaged claimant (no workspace.agents entry, e.g. a headless CLI) has no
  // renderer terminal to spawn, so it is never revived.
  const unmanagedPlan = planSprintEngineDispatch({
    workspace: workspaceFixture({ agents: {} }),
    sprintEngineState: sprintEngineStateFixture({
      tasks: [readyTask],
      sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { status: 'left' }) },
    }),
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn']),
  })
  assert.equal(unmanagedPlan.respawns.length, 0, 'an unmanaged left agent is not revived (no terminal to spawn)')

  // Sweep: a `revive:` ledger entry for work that is NO LONGER an active revival
  // target (here, a task that no longer exists) is deleted, so a maxed-out retry
  // budget resets and can't permanently block a future legitimate revival.
  const staleReviveKey = sprintEngineReviveLedgerKey(workspace, { taskId: 'T-gone' }, 'developer-1')
  const sweepPlan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: sprintEngineStateFixture({
      tasks: [readyTask],
      sprintEngineAgents: { 'developer-1': runtimeAgent('developer', { status: 'left' }) },
    }),
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
    'a stale revive: ledger entry (no active target) is swept so its retry budget resets',
  )
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
      qualityGates: [],
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
    { capacityByRole: new Map(), agentIds: new Set() },
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
    { capacityByRole: new Map(), agentIds: new Set() },
    sent,
    { cliRuntimes: respawnTestCliRuntimes, mcpSettings: emptyMcpSettings, inFlightSpawns: mutableRef(new Set<string>()) }
  )
  assert.equal(spawns.length, 1, 'no second respawn inside the cooldown window')
}

async function testRespawnsDeadGateClaimantWithGateClaimTool(): Promise<void> {
  const spawns: CapturedSpawn[] = []
  installRespawnTestWindow(spawns)

  const supervisor = await loadSupervisor()
  const workspace = workspaceFixture({
    agents: { 'code_reviewer-1': sprintAgent('code_reviewer-1', 'Shawn') },
  })
  const reviewTask = task({
    id: 'T3',
    status: 'review',
    boardColumn: 'review',
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
        attempts: [{ id: 'GA-001', status: 'in_progress', role: 'code_reviewer', claimedBy: 'code_reviewer-1', startedAt: '2026-06-12T08:00:00Z' }],
      },
    ],
  })
  const state = sprintEngineStateFixture({
    tasks: [reviewTask],
    sprintEngineAgents: {
      'code_reviewer-1': runtimeAgent('code_reviewer', { status: 'running', currentTaskId: 'T3' }),
    },
  })
  installWorkspaceStore(workspace)
  const sent = mutableRef(new Map<string, { sentAt: number; attempts?: number }>())

  await supervisor.respawnDeadSprintEngineClaimants(
    workspace,
    state,
    new Set(),
    { capacityByRole: new Map(), agentIds: new Set() },
    sent,
    { cliRuntimes: respawnTestCliRuntimes, mcpSettings: emptyMcpSettings, inFlightSpawns: mutableRef(new Set<string>()) }
  )

  assert.equal(spawns.length, 1, `dead gate claimant is respawned; spawns ${JSON.stringify(spawns)}`)
  assert.equal(spawns[0].agentId, 'code_reviewer-1')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.gate.next'), 'gate-claim respawn prompt names the gate claim tool')
  const key = sprintEngineRespawnLedgerKey(workspace, { taskId: 'T3', gateId: 'code_reviewer' }, 'code_reviewer-1')
  assert.equal(sent.current.get(key)?.attempts, 1, 'gate respawn attempt is recorded under the gate work key')
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
    qualityGates: [],
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
    { capacityByRole: new Map(), agentIds: new Set() },
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
    qualityGates: [],
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
      pendingSpawns: [],
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
    continuationGraceByTask: mutableRef(new Map()),
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
  // Cross-path per-agent dedup regression: a live-idle reviewer has exhausted
  // its wake budget on a ready task (restart-eligible) while a claimable gate
  // of its role is due (gate-paste-eligible). One supervise pass must engage
  // the agent exactly once — the gate paste — and never kill the terminal it
  // just pasted into.
  const writes: Array<{ sessionId: string; text: string }> = []
  const kills: string[] = []
  installTestWindow({
    terminalList: async () => [
      {
        sessionId: 'session-reviewer',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'workspace-1',
        agentId: 'code_reviewer-1',
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
    role: 'code_reviewer',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
    qualityGates: [],
  })
  const gatedTask = task({
    id: 'T3',
    status: 'review',
    boardColumn: 'review',
    ownerAgentId: 'developer-1',
    qualityGates: [
      { id: 'code_reviewer', phase: 'review', role: 'code_reviewer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
  })
  const sprintEngineState = sprintEngineStateFixture({
    tasks: [readyReviewTask, gatedTask],
    sprintEngineAgents: {
      'code_reviewer-1': runtimeAgent('code_reviewer', { status: 'idle', currentTaskId: null }),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'code_reviewer-1': sprintAgent('code_reviewer-1', 'Shawn') },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
  })
  installWorkspaceStore(workspace)
  const wakeKey = continuationMessageKey(workspace, 'T-ready', 'code_reviewer-1')
  const sentContinuationMessages = mutableRef(new Map<string, { sentAt: number; attempts?: number }>([
    [wakeKey, { sentAt: Date.now() - 120_000, attempts: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES }],
  ]))

  await supervisor.superviseRunnerActiveCycle({
    workspace,
    sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
    superviseStartedAt: 0,
    cliRuntimes: respawnTestCliRuntimes,
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages,
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    continuationGraceByTask: mutableRef(new Map()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(writes.length, 2, `exactly one engagement for the agent plus submit; writes ${JSON.stringify(writes.map((write) => write.sessionId))}`)
  assert.ok(writes[0].text.includes('sprintengine.gate.next'), 'the single engagement is the gate continuation paste')
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
    tasks: [task({ id: 'T4', role: 'frontend', status: 'in_progress', boardColumn: 'in_progress', ownerAgentId: 'frontend-2', qualityGates: [] })],
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
      pendingSpawns: [],
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
    continuationGraceByTask: mutableRef(new Map()),
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
      'code_reviewer-1': runtimeAgent('code_reviewer', { status: 'idle', currentTaskId: null, ...input.reviewerOverrides }),
    },
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: { 'code_reviewer-1': sprintAgent('code_reviewer-1', 'Shawn') },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
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
        agentId: 'code_reviewer-1',
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
    continuationGraceByTask: mutableRef(new Map()),
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
    tasks: [task({ id: 'T-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] })],
  })
  installWorkspaceStore(workspace)
  const idleClockByAgent = mutableRef(new Map<string, number>([
    [sprintEngineIdleClockKey(workspace, 'code_reviewer-1'), Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
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
    tasks: [task({ id: 'T-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] })],
  })
  installWorkspaceStore(workspace)
  const clockKey = sprintEngineIdleClockKey(workspace, 'code_reviewer-1')
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
      tasks: [task({ id: 'T-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] })],
    })
    installWorkspaceStore(workspace)
    const idleClockByAgent = mutableRef(new Map<string, number>([
      [sprintEngineIdleClockKey(workspace, 'code_reviewer-1'), Date.now() - 30_000],
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
      tasks: [task({ id: 'T-own', role: 'code_reviewer', status: 'in_progress', boardColumn: 'in_progress', ownerAgentId: 'code_reviewer-1', qualityGates: [] })],
      reviewerOverrides: { status: 'running', currentTaskId: 'T-own' },
    })
    installWorkspaceStore(workspace)
    const clockKey = sprintEngineIdleClockKey(workspace, 'code_reviewer-1')
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
      tasks: [task({ id: 'T-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] })],
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
          children: [{ type: 'tab', id: 'agent-tab', name: 'Shawn', component: 'agent', config: { agentId: 'code_reviewer-1' } }],
        }],
      },
    }
    registerModel(workspace.id, Model.fromJson(layout))
    try {
      const idleClockByAgent = mutableRef(new Map<string, number>([
        [sprintEngineIdleClockKey(workspace, 'code_reviewer-1'), Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
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
        qualityGates: [],
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
    tasks: [task({ id: 'T-dev', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] })],
  })
  installWorkspaceStore(workspace)
  const idleClockByAgent = mutableRef(new Map<string, number>([
    [sprintEngineIdleClockKey(workspace, 'code_reviewer-1'), Date.now() - supervisor.AUTO_RUN_IDLE_RETIREMENT_MS - 60_000],
  ]))

  await runIdleRetirementCycle(supervisor, workspace, sprintEngineState, idleClockByAgent)

  assert.deepEqual(kills, ['session-reviewer'], 'the parked reviewer terminal is retired past the idle window')
  const retiredAgent = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspace.id)?.agents['code_reviewer-1']
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
    tasks: [task({ id: 'T-rework', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] })],
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
      pendingSpawns: [],
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
    continuationGraceByTask: mutableRef(new Map()),
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
      task({ id: 'T-arch', role: 'architect', status: 'todo', boardColumn: 'ready', ownerAgentId: null, qualityGates: [] }),
      // Architect-actionable needs_input task owned by another agent.
      task({
        id: 'T-blocked',
        role: 'developer',
        status: 'needs_input',
        boardColumn: 'in_progress',
        ownerAgentId: 'developer-9',
        qualityGates: [],
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
      pendingSpawns: [],
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
    continuationGraceByTask: mutableRef(new Map()),
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
      code_reviewer: runtimeAgent('code_reviewer'),
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
      code_reviewer: sprintAgent('code_reviewer', 'Shawn'),
      tester: sprintAgent('tester', 'Tess'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 6,
      pendingSpawns: [],
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
    continuationGraceByTask: mutableRef(new Map()),
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

async function testSuperviseRunnerCycleReengagesStalledLiveIdleAgentForChangesRequested(): Promise<void> {
  // Repro for the renderer-cli-plugin-catalog stall (T4 stuck in changes_requested).
  // The frontend implementer's CLI is still ALIVE but idle — it finished its turn
  // after submitting its review gate verdict — so getRunningAutoRunAgentIds reports
  // it in runningAgentIds. Meanwhile reviewers moved the task back to an ownerless
  // `changes_requested`. Because the agent counts as "running":
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
  const reworkTask = task({
    id: 'T4',
    title: 'Render installed plugins in Agents settings',
    role: 'frontend',
    status: 'changes_requested',
    boardColumn: 'changes_requested',
    ownerAgentId: null,
    dependsOn: [],
    qualityGates: [],
  })
  const sprintEngineState = sprintEngineStateFixture({
    runner: { cliWatchPolling: 'enabled', pollIntervalSeconds: 10, idleBackoffSeconds: 30, maxBackoffSeconds: 120, stopWhenComplete: true },
    sprintEngineAgents: {
      frontend: runtimeAgent('frontend', { status: 'idle', currentTaskId: null }),
    },
    tasks: [reworkTask],
  })

  // Sanity: the engine itself considers this claimable role work, so the stall is a
  // re-engagement gap, not a readiness problem.
  assert.ok(
    getSprintEngineWakeCandidateTasks(sprintEngineState).some((candidate) => candidate.id === 'T4'),
    'ownerless changes_requested T4 is claimable frontend work',
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
      pendingSpawns: [],
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
    continuationGraceByTask: mutableRef(new Map()),
    idleClockByAgent: mutableRef(new Map()),
  })

  // Before the fix: frontend is treated as "running", so no replacement is
  // spawned and the capped continuation path writes nothing — the task is
  // stranded. The fix re-engages by restarting (killing) the stalled terminal so
  // the exit→respawn path claims it next tick.
  assert.ok(
    kills.length + spawns.length + writes.length >= 1,
    `stalled live-idle frontend agent must be re-engaged for ownerless changes_requested work; got kills=${JSON.stringify(kills)} spawns=${JSON.stringify(spawns)} writes=${writes.length}`,
  )
  assert.deepEqual(
    kills,
    ['session-frontend-live'],
    'the stalled frontend terminal is restarted so a fresh agent can claim the changes_requested task',
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
    qualityGates: [],
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
      pendingSpawns: [],
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
    continuationGraceByTask: mutableRef(new Map()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(spawns.length, 0, `unresolved needs_input owner should not be restarted; spawns ${JSON.stringify(spawns)}`)
}

async function testSuperviseRunnerCycleStartsReviewGateWhenUnrelatedAgentNeedsInput(): Promise<void> {
  const spawns: Array<{ agentId?: string; cli?: AgentCli; initialPrompt?: string }> = []
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
  const externalValidationTask = task({
    id: 'T-needs-input',
    title: 'Validate device calendar externally',
    status: 'needs_input',
    boardColumn: 'needs_input',
    role: 'developer',
    ownerAgentId: 'developer-1',
    dependsOn: [],
    qualityGates: [],
  })
  const reviewTask = task({
    id: 'T-review',
    title: 'Review Google Calendar sync',
    status: 'review',
    boardColumn: 'review',
    role: 'developer',
    ownerAgentId: null,
    dependsOn: ['T-needs-input'],
    qualityGates: [
      { id: 'code_reviewer', phase: 'review', role: 'code_reviewer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
  })
  const sprintEngineState = sprintEngineStateFixture({
    runner: { cliWatchPolling: 'enabled', pollIntervalSeconds: 10, idleBackoffSeconds: 30, maxBackoffSeconds: 120, stopWhenComplete: true },
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'needs_input', currentTaskId: 'T-needs-input' }),
      'code_reviewer': runtimeAgent('code_reviewer', { status: 'idle', currentTaskId: null }),
    },
    tasks: [externalValidationTask, reviewTask],
  })
  const workspace = workspaceFixture({
    sprintEngineState,
    agents: {
      'developer-1': sprintAgent('developer-1', 'Dana'),
      'code_reviewer': sprintAgent('code_reviewer', 'Code Reviewer'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
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
    continuationGraceByTask: mutableRef(new Map()),
    idleClockByAgent: mutableRef(new Map()),
  })

  assert.equal(spawns.length, 1, `unrelated needs_input work must not block review gate spawn; spawns ${JSON.stringify(spawns)}`)
  assert.equal(spawns[0].agentId, 'code_reviewer')
  assert.ok(spawns[0].initialPrompt?.includes('sprintengine.gate.next'), 'reviewer prompt names the MCP gate claim tool')
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
      'code_reviewer': sprintAgent('code_reviewer', 'Code Reviewer'),
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
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
    cliRuntimes: { codex: { command: 'codex', useWsl: false }, 'claude-code': { command: 'claude', useWsl: false } },
    mcpSettings: emptyMcpSettings,
    inFlightSpawns: mutableRef(new Set<string>()),
    sentContinuationMessages: mutableRef(new Map()),
    sentDispatchMessages: mutableRef(new Map()),
    sentArchitectTriageMessages: mutableRef(new Map()),
    sentAgentNotificationEvents: mutableRef(new Set()),
    continuationGraceByTask: mutableRef(new Map()),
    idleClockByAgent: mutableRef(new Map()),
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
  assert.ok(prompt.includes('multicode-sprintengine'), 'startup prompt names the managed MCP server entry')
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
  assert.ok(/never add roster members/iu.test(prompt), 'general startup prompt forbids growing the roster')
  // Same no-statePath/workspaceRoot routing invariant as every other startup prompt.
  assert.ok(!prompt.includes('"statePath"'), 'general startup prompt must not embed statePath in the MCP payload')
  assert.ok(!prompt.includes('"workspaceRoot"'), 'general startup prompt must not embed workspaceRoot in the MCP payload')
  assert.ok(!prompt.includes('/tmp/workspace/.multi-code/sprintengine/team/run.yaml'), 'general startup prompt does not expose the run state path')
  assert.ok(prompt.includes('multicode-sprintengine'), 'general startup prompt names the managed MCP server entry')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(prompt),
    'general startup prompt does not instruct the agent to run any sprintengine CLI command'
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

  const gateTask = task({ id: 'T3', title: 'Build feature' })
  const gate = gateTask.qualityGates![0]
  const claimed = buildSprintEngineGateContinuationPrompt(gateTask, gate, 'code_reviewer', true)
  assert.ok(claimed.includes('already claimed by this terminal'))
  assert.ok(claimed.includes('sprintengine.gate.next'), 'claimed gate prompt names the MCP gate-next tool to resume the claim')
  assert.ok(!claimed.includes('sprintengine.agent.next_directive'), 'claimed gate prompt does not route through the directive hop')
  assert.ok(!claimed.includes('"statePath"'), 'claimed gate prompt must not embed statePath; the managed MCP server resolves it from run context')
  assert.ok(claimed.includes('sprintengine.gate.verdict'), 'claimed gate prompt names the MCP verdict tool')
  const broadCommandBan = ['do not run', 'shell', 'commands'].join(' ')
  const commandCategory = ['shell', 'commands'].join(' ')
  assert.ok(
    !claimed.includes(broadCommandBan),
    'claimed gate prompt does not block local verification commands'
  )
  assert.ok(
    !claimed.includes(commandCategory),
    'claimed gate prompt avoids shell-command wording entirely'
  )
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(claimed),
    'claimed gate prompt does not embed a sprintengine CLI command'
  )

  const ready = buildSprintEngineGateContinuationPrompt(gateTask, gate, 'code_reviewer', false)
  assert.ok(ready.includes('wake candidate'))
  assert.ok(!ready.includes('sprintengine.agent.next_directive'), 'unclaimed gate prompt does not route through the directive hop')
  assert.ok(!ready.includes('"statePath"'), 'unclaimed gate prompt must not embed statePath; the managed MCP server resolves it from run context')
  assert.ok(ready.includes('"role": "code_reviewer"'))
  assert.ok(ready.includes('"id": "code_reviewer"'))
  assert.ok(ready.includes('sprintengine.gate.next'), 'unclaimed gate prompt names the MCP gate-next tool to invoke')
  assert.ok(
    !ready.includes(broadCommandBan),
    'unclaimed gate prompt does not block local verification commands'
  )
  assert.ok(
    !ready.includes(commandCategory),
    'unclaimed gate prompt avoids shell-command wording entirely'
  )
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(ready),
    'unclaimed gate prompt does not embed a sprintengine CLI command'
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
  assert.ok(gatePrompt.includes('wake candidate'))
  assert.ok(gatePrompt.includes('Gate: marketer_review (review / marketer)'))
  assert.ok(gatePrompt.includes('sprintengine.gate.next'))
  assert.ok(!gatePrompt.includes('sprintengine.agent.next_directive'))
  assert.ok(!gatePrompt.includes('"statePath"'), 'gate prompt must not embed statePath')
  assert.ok(gatePrompt.includes('"role": "marketer"'))
  assert.ok(gatePrompt.includes('"id": "marketer-2"'))
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
    qualityGates: [],
  })
  const finalSignoff = task({
    id: 'T24',
    title: 'Final architect signoff',
    status: 'todo',
    boardColumn: 'todo',
    role: 'architect',
    ownerAgentId: null,
    dependsOn: ['T23'],
    qualityGates: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T22', status: 'done', boardColumn: 'done', ownerAgentId: null, qualityGates: [] }),
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
    qualityGates: [],
  })
  const finalSignoff = task({
    id: 'T24',
    title: 'Final architect signoff',
    status: 'todo',
    boardColumn: 'todo',
    role: 'architect',
    ownerAgentId: null,
    dependsOn: ['T23'],
    qualityGates: [],
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
    qualityGates: [],
  })
  const readyTask = task({
    id: 'T2',
    status: 'todo',
    boardColumn: 'ready',
    role: 'developer',
    ownerAgentId: null,
    dependsOn: [],
    qualityGates: [],
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
    qualityGates: [],
  })
  const dependentTask = task({
    id: 'T2',
    status: 'todo',
    boardColumn: 'todo',
    role: 'architect',
    ownerAgentId: null,
    dependsOn: ['T1'],
    qualityGates: [],
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
    qualityGates: [],
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

function bootstrapWorkspace(agents: Workspace['agents'] = {}): Workspace {
  return workspaceFixture({ agents })
}

function bootstrapState(overrides: Partial<SprintEngineState> = {}): SprintEngineState {
  return sprintEngineStateFixture({
    sprintEngineAgents: {
      architect: runtimeAgent('architect'),
      developer: runtimeAgent('developer'),
      code_reviewer: runtimeAgent('code_reviewer'),
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
    'a retired architect waits for roster replenishment instead of bootstrap'
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

function testGetSprintEngineAutoRunOccupiedAgentIdsIgnoresChangesRequestedOwners(): void {
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
    ['developer-1', 'spec-reviewer', 'tester'],
    'changes_requested owners are stale attribution and do not occupy global auto-run slots'
  )
}

function testGetSprintEngineAutoRunOccupiedAgentIdsDoesNotCountDeadNeedsInputOwner(): void {
  const occupiedAgentIds = getSprintEngineAutoRunOccupiedAgentIds({
    tasks: [
      task({ id: 'T1', status: 'needs_input', ownerAgentId: 'developer-1', role: 'developer' }),
      task({ id: 'T2', status: 'needs_input', ownerAgentId: 'frontend', role: 'frontend' }),
    ],
    pendingSpawns: [],
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

function testPickNextAutoRunsSelectsOwnerlessChangesRequestedWork(): void {
  const reworkTask = task({
    id: 'T-rework',
    status: 'changes_requested',
    boardColumn: 'changes_requested',
    role: 'developer',
    ownerAgentId: null,
    dependsOn: [],
    qualityGates: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [reworkTask],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer') },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 1, 'ownerless changes_requested work is a normal role candidate')
  assert.equal(candidates[0].agentId, 'developer-1')
  assert.equal(candidates[0].taskId, 'T-rework')
  assert.equal(candidates[0].gateId, undefined)
}

function testPickNextAutoRunsSelectsStaleOwnedChangesRequestedWork(): void {
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
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'retired' }),
      'developer-2': runtimeAgent('developer'),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 1, 'stale owned changes_requested work still starts same-role capacity for cleanup and claim')
  assert.equal(candidates[0].agentId, 'developer-2')
  assert.equal(candidates[0].taskId, 'T-rework')
}

function testPickNextAutoRunsSkipsUnresolvedNeedsInputOwner(): void {
  const needsInputTask = task({
    id: 'T-needs-input',
    status: 'needs_input',
    boardColumn: 'needs_input',
    role: 'developer',
    ownerAgentId: 'developer-1',
    dependsOn: [],
    qualityGates: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [needsInputTask],
    sprintEngineAgents: { 'developer-1': runtimeAgent('developer') },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 0, 'unresolved needs_input work waits for explicit input instead of redispatching the owner')
}

function testPickNextAutoRunsSelectsReviewTestingAndProductGates(): void {
  const gateScenarios: Array<{
    phase: 'review' | 'testing' | 'product'
    role: SprintEngineRole
    gateId: string
  }> = [
    { phase: 'review', role: 'code_reviewer', gateId: 'code_reviewer' },
    { phase: 'testing', role: 'tester', gateId: 'tester' },
    { phase: 'product', role: 'product', gateId: 'product_acceptance' },
  ]

  for (const scenario of gateScenarios) {
    const gatedTask = task({
      id: `T-${scenario.phase}`,
      status: scenario.phase,
      boardColumn: scenario.phase,
      role: 'developer',
      ownerAgentId: 'developer-1',
      qualityGates: [
        {
          id: scenario.gateId,
          phase: scenario.phase,
          role: scenario.role,
          status: 'pending',
          required: true,
          allowSelfReview: true,
          focus: '',
          attempts: [],
        },
      ],
    })
    const state = sprintEngineStateFixture({
      tasks: [gatedTask],
      sprintEngineAgents: {
        [scenario.role]: runtimeAgent(scenario.role),
      },
    })
    const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
    assert.equal(candidates.length, 1, `${scenario.phase} gate is a spawn candidate`)
    assert.equal(candidates[0].agentId, scenario.role)
    assert.equal(candidates[0].role, scenario.role)
    assert.equal(candidates[0].taskId, `T-${scenario.phase}`)
    assert.equal(candidates[0].gateId, scenario.gateId)
  }
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

function testPickNextAutoRunsIgnoresRetiredPreviousOwnerForOwnerlessRework(): void {
  const reworkTask = task({
    id: 'T-rework',
    status: 'changes_requested',
    boardColumn: 'changes_requested',
    role: 'developer',
    ownerAgentId: null,
    dependsOn: [],
    qualityGates: [],
  })
  const state = sprintEngineStateFixture({
    tasks: [reworkTask],
    sprintEngineAgents: {
      'developer-1': runtimeAgent('developer', { status: 'retired' }),
      'developer-2': runtimeAgent('developer'),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  assert.equal(candidates.length, 1, 'retired previous owners do not block ownerless rework')
  assert.equal(candidates[0].agentId, 'developer-2')
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
      'developer-1': runtimeAgent('developer', { status: 'running', currentTaskId: 'T-review' }),
      'code_reviewer': runtimeAgent('code_reviewer'),
    },
  })
  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickInput())
  const gateCandidate = candidates.find((candidate) => candidate.gateId === 'code_reviewer')
  assert.ok(gateCandidate, 'active gate claim is surfaced for the reviewer')
  assert.equal(gateCandidate?.agentId, 'code_reviewer')
  assert.equal(gateCandidate?.role, 'code_reviewer')
}
