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
} from '../../../shared/sprintengine/auto-run'
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
} from '../types/workspace'
import { defaultAgent } from '../store/slices/agentsSlice'


void main()

async function main(): Promise<void> {
  testKeyHelpersAreStableAndScoped()
  testStartupPromptIsMcpNative()
  testArchitectInitStartupPromptIsMcpNative()
  testRolelessStartupPromptIsMcpNative()
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
  testBootstrapPlansGoalOnlyRunsAndNeverPrePlannedOnes()
  testBootstrapDoesNotPlanARolelessEpicSourcedRun()
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
  testTaskScopedRetirementStormBoundFallsBackToSlowCadence()
  testGenericPickAvoidsReworkReservedOwners()
  testPickNextAutoRunsNeverReusesSpentIdForNewClaim()
  testPickNextAutoRunsReusesPlanningIdAcrossSequentialTasks()
  testPickNextAutoRunsDefersReworkToLiveBoundOwner()
  testNeedsInputHoldRetainsResumeState()
  testReconcileLaunchFlagsPreservesRetainedResumeShape()
  testActiveAssignmentRescueStopsAfterTwoPromptsWithDiagnostic()
  testRevivesDepartedWorkerForOwnTask()
  testRevivesDepartedPlanningAgentForNewReadyTask()
  testLegacyLeftDeadAgentStatusCoercesToIdle()
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
      cliPermissionPreset: 'manual',
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

/**
 * The run context `findSprintEngineWakeCandidateTaskForAgent` bounds its answer
 * by (MC-2050): a role-based run, where no id below holds the coordinator seat
 * and no task is the coordination job, so every case there is decided by the
 * role comparison exactly as it was before the routing rule reached wake.
 */
const roleBasedWakeState: Pick<SprintEngineState, 'artifacts' | 'configuredRoles'> = {
  artifacts: [],
  configuredRoles: ['architect', 'developer'],
}


function installWorkspaceStore(workspace: Workspace): void {
  useWorkspaceStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  })
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
  // The architect orchestrates a whole sprint, so it keeps the reuse-preferring
  // lifecycle. A MINTED ROLELESS worker does NOT: it is an ordinary task-scoped
  // worker that happens to carry no role, so it is never handed a second task
  // (MC-2057 — `general` used to be exempt here purely because the predicate
  // read it as a planning role).
  const now = Date.parse('2026-07-02T12:00:00Z')
  const workspace = workspaceFixture()
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T-finished', role: undefined, status: 'done', boardColumn: 'done', ownerAgentId: null }),
      task({ id: 'T-next', role: undefined, status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      'agent-1': runtimeAgent(undefined, { lastOwnedTaskId: 'T-finished' }),
    },
  })
  const wakePlan = taskScopedPlanInput({ workspace, state, now, idleAgentIds: ['agent-1'], paths: ['task_wake'] })
  assert.equal(wakePlan.pastes.length, 0, 'a used roleless worker is never woken for another task')
  assert.equal(
    sprintEngineWakeRestrictionTaskId('agent-1', runtimeAgent(undefined, { lastOwnedTaskId: 'T-finished' }), { configuredRoles: [] }),
    'T-finished',
    'a used roleless worker is restricted to its own task, exactly like a named worker'
  )
  assert.equal(
    sprintEngineWakeRestrictionTaskId('coordinator', runtimeAgent(undefined, { lastOwnedTaskId: 'T-finished' }), { configuredRoles: [] }),
    null,
    'the roleless coordinator seat carries no wake restriction — same seat, and the only thing that separates it from the worker above is its id'
  )

  assert.equal(
    sprintEngineWakeRestrictionTaskId('architect', runtimeAgent('architect', { lastOwnedTaskId: 'T-x' }), {}),
    null,
    'architect carries no wake restriction'
  )
  assert.equal(
    sprintEngineWakeRestrictionTaskId('developer-1', runtimeAgent('developer'), {}),
    null,
    'an implementation agent that never owned a task carries no restriction'
  )
  assert.equal(
    sprintEngineWakeRestrictionTaskId('developer-1', runtimeAgent('developer', { lastOwnedTaskId: 'T-x' }), {}),
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
      'primary',
      roleBasedWakeState
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
    findSprintEngineWakeCandidateTaskForAgent(wakeTasks, 'developer', 'developer-1', new Set(), null, 'mobile', roleBasedWakeState)?.id,
    'T-mobile',
  )
  assert.equal(
    findSprintEngineWakeCandidateTaskForAgent(wakeTasks, 'developer', 'developer-1', new Set(), null, 'primary', roleBasedWakeState)?.id,
    'T-desktop',
  )
  // A tree with no work for the role offers nothing, rather than another tree's task.
  assert.equal(
    findSprintEngineWakeCandidateTaskForAgent([wakeTasks[0]], 'developer', 'developer-1', new Set(), null, 'primary', roleBasedWakeState),
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
  const revivalWorkspace = workspaceFixture({ agents: { 'developer-1': sprintAgent('developer-1', 'Dana') } })
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
  const workspace = workspaceFixture({ agents: { 'developer-1': sprintAgent('developer-1', 'Dana') } })
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

function testRolelessStartupPromptIsMcpNative(): void {
  const prompt = buildSprintEngineStartupPrompt(undefined, 'coordinator', 'Ship the sprint', {
    executionCwd: '/tmp/workspace',
    workspaceRoot: '/tmp/workspace',
    sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    commandMode: 'join',
  })

  // Joins with NO role, claims directly, and never initializes the run (init stays app-owned).
  assert.ok(prompt.includes('sprintengine.agent.join'), 'roleless startup prompt joins via MCP')
  assert.ok(!prompt.includes('"role"'), 'a roleless join/claim payload omits `role` rather than sending a stand-in')
  assert.ok(!/general/iu.test(prompt), '"General" is not a thing the app says any more')
  assert.ok(prompt.includes('"agentId": "coordinator"'), 'roleless join payload carries the agent id')
  assert.ok(prompt.includes('"id": "coordinator"'), 'roleless claim payload carries the agent id')
  assert.ok(prompt.includes('sprintengine.task.next'), 'roleless startup prompt claims work directly')
  assert.ok(!prompt.includes('sprintengine.init'), 'a roleless agent does not call sprintengine.init')
  // Drives the full loop and assigns planning to it when no plan exists.
  assert.ok(/plan/iu.test(prompt), 'roleless startup prompt drives planning')
  assert.ok(/build/iu.test(prompt), 'roleless startup prompt drives the build step')
  assert.ok(/review/iu.test(prompt), 'roleless startup prompt drives self-review')
  assert.ok(/test/iu.test(prompt), 'roleless startup prompt drives testing')
  assert.ok(/publish/iu.test(prompt), 'roleless startup prompt drives publishing')
  assert.ok(prompt.includes('you are the planner'), 'a roleless agent becomes the planner when the run has no task graph')
  assert.ok(/roles are user config/iu.test(prompt), 'roleless startup prompt routes role wishes to needs_input, never self-service growth')
  assert.ok(/needs_input/u.test(prompt), 'roleless startup prompt names the needs_input escalation path')
  // The boundary is stated as absence, not as a role named `undefined`.
  assert.ok(prompt.includes('You have no role.'), 'the work boundary says the agent has no role')
  assert.ok(!/undefined/u.test(prompt), 'no stringified undefined reaches the prompt')
  // Same no-statePath/workspaceRoot routing invariant as every other startup prompt.
  assert.ok(!prompt.includes('"statePath"'), 'roleless startup prompt must not embed statePath in the MCP payload')
  assert.ok(!prompt.includes('"workspaceRoot"'), 'roleless startup prompt must not embed workspaceRoot in the MCP payload')
  assert.ok(!prompt.includes('/tmp/workspace/.multi-code/sprintengine/team/run.yaml'), 'roleless startup prompt does not expose the run state path')
  assert.ok(prompt.includes('sprintengine-studio'), 'roleless startup prompt names the managed MCP server entry')
  assert.ok(
    !/sprintengine (join|task|gate|triage|init|handover)/.test(prompt),
    'roleless startup prompt does not instruct the agent to run any sprintengine CLI command'
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

  // A roleless task's wake prompt must never render `String(undefined)` — not in
  // the prose, and not as a `role` in the claim payload (MC-2057). The engine's
  // `optional_configured_role` reads an omitted role as "no role"; a stand-in
  // string would be rejected as an unconfigured role.
  const rolelessWake = buildSprintEngineContinuationPrompt(
    task({ id: 'T9', title: 'Roleless work', role: undefined }),
    'agent-1',
  )
  assert.ok(!/undefined/u.test(rolelessWake), 'a roleless wake prompt never stringifies undefined')
  assert.ok(!rolelessWake.includes('"role"'), 'a roleless claim payload omits role rather than sending a stand-in')
  assert.ok(rolelessWake.includes('"id": "agent-1"'), 'a roleless claim payload still carries the agent id')
  assert.ok(rolelessWake.includes('T9 - Roleless work'), 'and still names the task')

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
    agentId: 'architect',
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

  // MC-2057: the payload id is the SEAT's agent id, not the literal. A roleless
  // run has no `architect` id, so the hardcoded one named nobody and the triage
  // tool could not resolve an actor from it.
  const rolelessTriage = buildArchitectNeedsInputTriagePrompt({
    workspaceFolderPath: '/tmp/workspace',
    sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    agentId: 'coordinator',
    taskIds: ['T5'],
  })
  assert.ok(rolelessTriage.includes('"id": "coordinator"'), 'a roleless run triages as its coordinator seat')
  assert.ok(!rolelessTriage.includes('"id": "architect"'), 'no architect id survives on a roleless run')
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

function runtimeAgent(role: SprintEngineRoleId | undefined, overrides: Partial<SprintEngineRuntimeAgent> = {}): SprintEngineRuntimeAgent {
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

/**
 * MC-2179, both directions of the same guard. Creation composes a handoff prompt
 * onto the coordinator seat whether or not the run needs planning, so the prompt
 * alone cannot decide: an epic- or selection-sourced run opens with its graph
 * already minted and must spawn NO planning agent, while a goal-only run opens
 * with nothing to execute and must spawn exactly one.
 */
function testBootstrapPlansGoalOnlyRunsAndNeverPrePlannedOnes(): void {
  const undeliveredArchitect = {
    architect: { ...sprintAgent('architect', 'Ari'), cliStartupPrompt: 'handoff', cliOnboardingPromptSent: false },
  }
  const tasks = [task({ id: 'T1', status: 'todo', boardColumn: 'ready', role: 'developer', ownerAgentId: null })]

  const goalOnly = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace(undeliveredArchitect),
    bootstrapState(),
    bootstrapOptions()
  )
  assert.equal(goalOnly.kind, 'spawn', 'a goal-only run has nothing to execute until someone plans, so it still bootstraps')

  const prePlanned = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace(undeliveredArchitect),
    bootstrapState({ tasks }),
    bootstrapOptions()
  )
  assert.equal(
    prePlanned.kind,
    'none',
    'a run whose graph arrived with it spawns no planner — an undelivered handoff prompt no longer overrides run state'
  )

  const delivered = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace({ architect: { ...sprintAgent('architect', 'Ari'), cliStartupPrompt: 'handoff', cliOnboardingPromptSent: true } }),
    bootstrapState({ tasks }),
    bootstrapOptions()
  )
  assert.equal(delivered.kind, 'none', 'a delivered handoff prompt does not re-bootstrap')
}

/**
 * The shape actually observed (MC-2179): a ROLELESS epic-sourced run, whose
 * coordinator seat carries the undelivered handoff prompt and whose tasks were
 * imported from the epic's children before any agent existed.
 */
function testBootstrapDoesNotPlanARolelessEpicSourcedRun(): void {
  const decision = pickSprintEngineBootstrapCandidate(
    bootstrapWorkspace({
      coordinator: { ...sprintAgent('coordinator', 'Coordinator'), cliStartupPrompt: 'handoff', cliOnboardingPromptSent: false },
    }),
    sprintEngineStateFixture({
      configuredRoles: [],
      sprintEngineAgents: { coordinator: runtimeAgent(undefined) },
      tasks: [
        task({ id: 'T1', role: undefined, status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
        task({ id: 'T2', role: undefined, status: 'todo', boardColumn: 'ready', ownerAgentId: null, dependsOn: ['T1'] }),
      ],
    }),
    bootstrapOptions()
  )
  assert.equal(decision.kind, 'none', 'the imported epic IS the plan, so the coordinator seat is not spawned to re-plan it')
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
    'no tasks and no architect seat on the roster is a visible stall, not a silent no-op'
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




