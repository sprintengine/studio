import assert from 'node:assert/strict'
import { getSprintEngineStartupCommandMode } from './agentPrompt'
import {
  applyUserDisabledSprintEngineRoleCounts,
  bracketedTerminalPaste,
  buildSprintEngineAgentRoster,
  buildSprintEngineAgentRosterFromRuntimeAgents,
  buildSprintEngineRoleRegistry,
  getNextSprintEngineAgentId,
  sprintEngineEnabledRoles,
  formatSprintEngineLockAge,
  getLatestSprintEngineTaskComment,
  getOpenSprintEngineFeedbackComments,
  getOpenSprintEngineFeedbackFindings,
  getOpenSprintEngineFeedbackIssues,
  isCanceledSprintEngineRun,
  getSprintEngineBoardRunPhase,
  getSprintEngineKanbanEmptyMessage,
  getSprintEngineRoleAccent,
  getSprintEngineRoleGlyphKind,
  getSprintEngineRoleLabel,
  getSprintEngineAgentActivityDescending,
  getSprintEngineTaskActivityDescending,
  getSprintEngineTaskBoardColumn,
  getSprintEngineTaskImplementerTimeline,
  getSprintEngineTaskOwnerLabel,
  getReviewableSprintEngineArtifacts,
  getSprintEngineArtifactAutoApprovalEligibility,
  getSprintEngineTasksWorkedOnByAgent,
  getUserDisabledSprintEngineRoleIds,
  humanizeSprintEngineRoleId,
  isBundledSprintEngineRole,
  isNewSprintEngineRoleForRun,
  isPathInsideOrEqual,
  isSprintEngineRoleId,
  isSprintEngineTaskLaunchable,
  normalizeSprintEngineProjection,
  normalizeSprintEngineRoleCounts,
  normalizeSprintEngineState,
  sprintEnginePlannerRole,
  orderSprintEngineBoardColumnTasks,
  orderSprintEngineRosterRoles,
  resolveSprintEngineArtifactEditorPath,
  sprintEngineArtifactKindLabel,
  sprintEngineNeutralRoleAccent,
  deriveSprintEngineRepoMergeRollup,
  deriveSprintEngineRunGlyph,
  sprintEngineRoleOrder,
  sprintEngineRunAwaitsHumanInput,
  sprintEngineTaskBoardColumns,
  shouldResumeRecordedRosterSession,
  willResumeRecordedRosterSession,
} from './sprintengine'
import { taskGraphEdgeStyle, taskGraphEndEdgeStyle } from '../components/panels/sprintEngineTaskGraph'
import {
  BUNDLED_SPRINT_ENGINE_ADDABLE_ROLES,
  BUNDLED_SPRINT_ENGINE_BOARD_ROLE_SUMMARIES,
  BUNDLED_SPRINT_ENGINE_SWEEP_ROLE_IDS,
  BUNDLED_SPRINT_ENGINE_WIZARD_ROLE_SUMMARIES,
  buildSprintEngineAddMemberOptions,
  buildSprintEngineRosterCountByRole,
  findFirstUncoveredSprintEngineRole,
  getSprintEngineWizardRoleSummary,
  listSprintEngineAddableRoles,
  listSprintEngineWizardRoles,
  sprintEngineRosterHasPlanningRole,
  sprintEngineRosterRoleFloor,
} from './sprintengineRoleOptions'
import {
  buildSprintEngineAddressPlanReviewsPrompt,
  buildSprintEnginePlanReviewStartupPrompt,
  buildSprintEnginePlanRevisionForNewMemberPrompt,
  buildSprintEngineRecoveryAuditPrompt,
} from './sprintenginePlanReviewPrompts'
import type { AgentCli, SprintEngineRoleId, SprintEngineRoleRegistry, SprintEngineRosterSession, SprintEngineState, SprintEngineTask } from '../types/workspace'

function fakeProjection(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: '2026-05-16T20:00:00Z',
    updatedAt: '2026-05-16T20:00:00Z',
    run: {
      id: 'run-id',
      name: 'Sample Run',
      goal: 'Test goal',
      status: 'executing',
      rosterConfigured: true,
      updatedAt: '2026-05-16T20:00:00Z',
      creation: {
        source: 'folder_store',
        createdAt: '2026-05-16T19:51:02Z',
      },
    },
    roster: {
      architect: { role: 'architect', status: 'idle', currentTaskId: null },
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' },
    },
    tasks: [
      {
        id: 'T1',
        title: 'Done task',
        description: 'desc',
        role: 'developer',
        status: 'done',
        folderStatus: 'done',
        stateStatus: 'done',
        boardColumn: 'done',
        ownedPaths: ['src/x.ts'],
        dependsOn: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        notes: [],
        comments: [],
        evidence: { summary: 'shipped', touchedFiles: [], commandsRan: [], results: [] },
        activity: [
          { id: 'ACT-1', type: 'claim', actor: 'developer-1', message: 'claimed', timestamp: '2026-05-16T19:50:00Z' },
          { id: 'ACT-2', type: 'status_change', actor: 'developer-1', message: 'moved to done', status: 'done', timestamp: '2026-05-16T19:55:00Z' },
        ],
        startedAt: '2026-05-16T19:50:00Z',
        completedAt: '2026-05-16T19:55:00Z',
        ownerAgentId: 'developer-1',
      },
      {
        id: 'T2',
        title: 'Ready task',
        description: '',
        role: 'frontend',
        status: 'ready',
        folderStatus: 'ready',
        stateStatus: 'todo',
        boardColumn: 'ready',
        ownedPaths: [],
        dependsOn: ['T1'],
        acceptanceCriteria: [],
        implementationNotes: [],
        notes: [],
        comments: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        activity: [],
        startedAt: null,
        completedAt: null,
        ownerAgentId: null,
      },
      {
        id: 'T3',
        title: 'Task under self-review',
        description: '',
        role: 'developer',
        status: 'review',
        folderStatus: 'review',
        stateStatus: 'review',
        boardColumn: 'review',
        ownedPaths: [],
        dependsOn: ['T1'],
        acceptanceCriteria: [],
        implementationNotes: [],
        notes: [],
        comments: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        activity: [],
        startedAt: null,
        completedAt: null,
        ownerAgentId: null,
      },
    ],
    artifacts: [],
    locks: {
      locks: [
        { name: 'state', exists: true, stale: false, ageSeconds: 1.5, owner: { pid: 1234, createdAt: '2026-05-16T19:59:30Z' } },
      ],
      warnings: [
        { name: 'state', message: 'state lock appears stale.', ageSeconds: 360 },
      ],
    },
    activity: [
      { id: 'EVT-1', type: 'task_added', actor: 'architect', message: 'added T1', timestamp: '2026-05-16T19:40:00Z' },
    ],
    ...overrides,
  }
}

// normalizeSprintEngineProjection rebuilds the renderer-facing SprintEngineState
// shape from a folder-store projection.json payload.
const projection = fakeProjection()
const state = normalizeSprintEngineProjection(projection, 'fallback-name')

assert.ok(state, 'projection should normalize to a state')
assert.equal(state!.name, 'Sample Run')
assert.equal(state!.goal, 'Test goal')
assert.equal(state!.rosterConfigured, true)
assert.equal(state!.projection?.source, 'folder_store')
assert.equal(state!.projection?.generatedAt, '2026-05-16T20:00:00Z')
assert.equal(state!.locks?.warnings.length, 1)
assert.equal(state!.locks?.warnings[0]?.ageSeconds, 360)
assert.equal(state!.creation?.source, 'folder_store')
assert.equal(state!.tasks.length, 3)

// The per-task execution model/CLI (MC-1448) propagates through the projection
// normalizer when present, and is absent (not fabricated) when the task carries
// none — the CLI-default case.
const modelState = normalizeSprintEngineProjection(fakeProjection({
  tasks: [
    {
      id: 'T-model', title: 'Modelled', description: 'd', role: 'developer',
      status: 'in_progress', folderStatus: 'in_progress', stateStatus: 'in_progress', boardColumn: 'in_progress',
      ownedPaths: [], dependsOn: [], acceptanceCriteria: [], implementationNotes: [], notes: [], comments: [],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] }, activity: [],
      ownerAgentId: 'developer-1', model: 'claude-fable-5', cli: 'claude-code',
    },
    {
      id: 'T-default', title: 'CLI default', description: 'd', role: 'developer',
      status: 'todo', folderStatus: 'todo', stateStatus: 'todo', boardColumn: 'todo',
      ownedPaths: [], dependsOn: [], acceptanceCriteria: [], implementationNotes: [], notes: [], comments: [],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] }, activity: [],
      ownerAgentId: null,
    },
  ],
}))
assert.equal(modelState!.tasks[0]?.model, 'claude-fable-5')
assert.equal(modelState!.tasks[0]?.cli, 'claude-code')
assert.equal(modelState!.tasks[1]?.model, undefined)
assert.equal(modelState!.tasks[1]?.cli, undefined)

// Lazy roster: creation seeds ONLY the single planning seat regardless of
// enabled worker counts. Workers are minted task-scoped by the Python assignment
// op and reviewer ids register on their first gate, so no worker/reviewer record
// exists at creation. Which planner is seated follows the staffed selection.
const lazyRoster = buildSprintEngineAgentRoster({ architect: 1, developer: 3, tester: 1 })
assert.deepEqual(
  lazyRoster.map((agent) => agent.id),
  ['architect'],
  'a specialist selection seeds only the architect planner'
)
const generalRoster = buildSprintEngineAgentRoster({ general: 1 })
assert.deepEqual(
  generalRoster.map((agent) => ({ id: agent.id, role: agent.role })),
  [{ id: 'general', role: 'general' }],
  'a general-default selection seeds the bare general planning seat, not an architect'
)
assert.equal(sprintEnginePlannerRole({ general: 1, developer: 1 }), 'general', 'general is the planner when staffed')
assert.equal(sprintEnginePlannerRole({ architect: 1, general: 1 }), 'architect', 'architect wins the planner tie-break')
assert.equal(sprintEnginePlannerRole({ developer: 1 }), 'architect', 'architect is the planner floor when nothing else can plan')

// enabledRoles encodes exactly the staffed selection — this feeds Python
// `configuredRoles`. Architect is no longer unconditional.
assert.deepEqual(
  sprintEngineEnabledRoles({ architect: 1, developer: 1, tester: 1 }).sort(),
  ['architect', 'developer', 'tester'],
  'a specialist selection = architect + every role with count > 0'
)
assert.deepEqual(
  sprintEngineEnabledRoles({ architect: 1, developer: 0 }),
  ['architect'],
  'a disabled role (count 0) is not enabled'
)
assert.deepEqual(
  sprintEngineEnabledRoles({ general: 1 }),
  ['general'],
  'a general-only selection is exactly [general] — no phantom architect'
)
assert.deepEqual(
  sprintEngineEnabledRoles({ general: 1, developer: 1 }).sort(),
  ['developer', 'general'],
  'general + worker selection carries no architect'
)
// Sweep toggles ride in via additionalRoles; an unselected sweep never appears.
assert.deepEqual(
  sprintEngineEnabledRoles({ general: 1 }, ['security']).sort(),
  ['general', 'security'],
  'a toggled-on sweep appends; an unselected sweep is absent'
)
assert.deepEqual(
  sprintEngineEnabledRoles({ developer: 1 }),
  ['developer', 'architect'],
  'a plannerless selection gets the architect floor',
)

// normalizeSprintEngineRoleCounts stops force-seating the architect once a
// general is staffed, so a general-only selection survives round-tripping.
assert.equal(normalizeSprintEngineRoleCounts({ general: 1 }).architect, 0, 'general-only normalizes with architect off')
assert.equal(normalizeSprintEngineRoleCounts({ general: 1 }).general, 1, 'general-only keeps the general seat')
assert.equal(normalizeSprintEngineRoleCounts({ developer: 1 }).architect, 1, 'a plannerless selection still floors to architect')
assert.equal(normalizeSprintEngineRoleCounts({ architect: 1, general: 1 }).architect, 1, 'an explicit architect is preserved')

// Allocator (D-Naming): the first minted worker of a role is `<role>-1` — no
// bare-id short-circuit — matching the Python allocator (max matching index + 1,
// a bare `<role>` counting as index 1). Bare `<role>` is the reviewer id.
const rt = (role: string) => ({ role, status: 'idle' as const, currentTaskId: null })
assert.equal(
  getNextSprintEngineAgentId('developer', { architect: rt('architect') }),
  'developer-1',
  'first worker on an empty developer roster is developer-1',
)
assert.equal(
  getNextSprintEngineAgentId('developer', { architect: rt('architect'), 'developer-1': rt('developer') }),
  'developer-2',
  'the next worker steps past developer-1',
)
assert.equal(
  getNextSprintEngineAgentId('security', { security: rt('security') }),
  'security-2',
  'a seated bare role id counts as index 1, so a worker mint steps to -2',
)

// MC-1450: run.roleRuntimes (run.yaml per-role {model, cli}) rides the
// projection into SprintEngineState so every reconcile/spawn resolves the
// roster's picks — and survives a normalize round-trip (projection replaces
// the state wholesale every poll, so dropping it here IS the original bug).
const roleRuntimesState = normalizeSprintEngineProjection(fakeProjection({
  run: {
    id: 'run-id', name: 'Sample Run', goal: 'Test goal', status: 'executing',
    rosterConfigured: true, updatedAt: '2026-05-16T20:00:00Z',
    roleRuntimes: {
      developer: { model: ' claude-opus-4-8 ', cli: ' claude-code ' },
      product: { cli: 'claude-code' },
      growth_engineer: { model: 'claude-fable-5' },
      tester: { model: '', cli: '' },
      security: 'bogus-not-an-object',
    },
  },
}))
assert.deepEqual(roleRuntimesState!.roleRuntimes, {
  developer: { model: 'claude-opus-4-8', cli: 'claude-code' },
  product: { cli: 'claude-code' },
  growth_engineer: { model: 'claude-fable-5' },
})
const reNormalized = normalizeSprintEngineState(roleRuntimesState)
assert.deepEqual(reNormalized!.roleRuntimes, roleRuntimesState!.roleRuntimes)
// Legacy payload without the map normalizes cleanly with the field absent.
assert.equal(normalizeSprintEngineProjection(fakeProjection())!.roleRuntimes, undefined)

// run.configuredRoles (the run's enabled role set) rides the projection so the
// roster view can show configured-but-unseated roles under the lazy
// roster. De-duped, registry-validated, order-stable, and survives re-normalize.
const configuredRolesState = normalizeSprintEngineProjection(fakeProjection({
  run: {
    id: 'run-id', name: 'Sample Run', goal: 'Test goal', status: 'executing',
    rosterConfigured: true, updatedAt: '2026-05-16T20:00:00Z',
    configuredRoles: ['architect', 'developer', 'security', 'developer', 'tester', '  ', 42],
  },
}))
assert.deepEqual(configuredRolesState!.configuredRoles, ['architect', 'developer', 'security', 'tester'])
assert.deepEqual(
  normalizeSprintEngineState(configuredRolesState)!.configuredRoles,
  configuredRolesState!.configuredRoles,
)
// Legacy payload without the list normalizes cleanly with the field absent.
assert.equal(normalizeSprintEngineProjection(fakeProjection())!.configuredRoles, undefined)

// T6 (Slice 3: status vocabulary). `recorded` is a real Python artifact status
// the projection emits; the renderer used to drop it as unknown. It must now
// survive normalization, and the optional `approvalMode` (manual|policy) must
// ride through so the Inbox can split the approved glyph.
const artifactStatusState = normalizeSprintEngineProjection(fakeProjection({
  artifacts: [
    { id: 'A-recorded', kind: 'code_review', title: 'Gate evidence', path: 'evidence/a.md', status: 'recorded', createdBy: 'security', taskId: 'T1' },
    { id: 'A-manual', kind: 'design_notes', title: 'Manual', path: 'd.md', status: 'approved', createdBy: 'frontend', taskId: 'T1', approvedAt: '2026-05-16T20:00:00Z', approvalMode: 'manual' },
    { id: 'A-policy', kind: 'design_notes', title: 'Policy', path: 'p.md', status: 'approved', createdBy: 'frontend', taskId: 'T1', approvedAt: '2026-05-16T20:00:00Z', approvalMode: 'policy' },
    { id: 'A-legacy', kind: 'design_notes', title: 'Legacy', path: 'l.md', status: 'approved', createdBy: 'frontend', taskId: 'T1' },
    { id: 'A-bogusmode', kind: 'design_notes', title: 'Bogus', path: 'b.md', status: 'approved', createdBy: 'frontend', taskId: 'T1', approvalMode: 'sideways' },
  ],
}))
const artifactsById = Object.fromEntries((artifactStatusState!.artifacts ?? []).map((a) => [a.id, a]))
assert.equal(artifactsById['A-recorded']?.status, 'recorded', 'recorded artifact survives normalization (not dropped)')
assert.equal(artifactsById['A-manual']?.approvalMode, 'manual', 'manual approvalMode rides through')
assert.equal(artifactsById['A-policy']?.approvalMode, 'policy', 'policy approvalMode rides through')
assert.equal(artifactsById['A-legacy']?.approvalMode, undefined, 'a legacy approval omits approvalMode')
assert.equal(artifactsById['A-bogusmode']?.approvalMode, undefined, 'an out-of-enum approvalMode is dropped, not carried')

// run.source / run.sourceBundle (seed docs recorded at run creation) ride the
// projection so the Sprint Inbox "Started from" section can surface them.
// Validated per-item (kind/origin/path required); malformed entries drop.
const sourceState = normalizeSprintEngineProjection(fakeProjection({
  run: {
    id: 'run-id', name: 'Sample Run', goal: 'Test goal', status: 'executing',
    rosterConfigured: true, updatedAt: '2026-05-16T20:00:00Z',
    source: {
      kind: 'markdown', origin: 'file', planKind: 'epic',
      path: 'product-requirements.md', originalPath: 'docs/plan.md',
      capturedAt: '2026-05-16T20:00:00Z',
    },
    sourceBundle: [
      { kind: 'html_mockup', origin: 'reference', path: 'docs/mockup.html', capturedAt: '2026-05-16T20:00:00Z' },
      { kind: 'design_notes', origin: 'file', path: '' },
      'bogus-not-an-object',
    ],
  },
}))
assert.deepEqual(sourceState!.source, {
  kind: 'markdown', origin: 'file', planKind: 'epic',
  path: 'product-requirements.md', originalPath: 'docs/plan.md',
  capturedAt: '2026-05-16T20:00:00Z',
})
assert.deepEqual(sourceState!.sourceBundle, [
  { kind: 'html_mockup', origin: 'reference', path: 'docs/mockup.html', capturedAt: '2026-05-16T20:00:00Z' },
])
assert.deepEqual(normalizeSprintEngineState(sourceState)!.source, sourceState!.source)
assert.deepEqual(normalizeSprintEngineState(sourceState)!.sourceBundle, sourceState!.sourceBundle)
// A source missing a required field drops entirely rather than half-forming.
const partialSourceState = normalizeSprintEngineProjection(fakeProjection({
  run: {
    id: 'run-id', name: 'Sample Run', goal: 'Test goal', status: 'executing',
    rosterConfigured: true, updatedAt: '2026-05-16T20:00:00Z',
    source: { kind: 'markdown', origin: 'file' },
  },
}))
assert.equal(partialSourceState!.source, undefined)
// Legacy payload without seed docs normalizes cleanly with both fields absent.
assert.equal(normalizeSprintEngineProjection(fakeProjection())!.source, undefined)
assert.equal(normalizeSprintEngineProjection(fakeProjection())!.sourceBundle, undefined)

const externalNeedsInputState = normalizeSprintEngineProjection(fakeProjection({
  tasks: [
    {
      id: 'T-needs-input',
      title: 'Device validation',
      description: '',
      role: 'developer',
      status: 'needs_input',
      folderStatus: 'needs_input',
      stateStatus: 'needs_input',
      boardColumn: 'needs_input',
      ownedPaths: [],
      dependsOn: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      notes: [],
      comments: [],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
      activity: [],
      startedAt: null,
      completedAt: null,
      ownerAgentId: 'developer-1',
      needsInput: {
        kind: 'external_validation',
        reason: 'A real device or supported simulator is required.',
        question: 'Can a tester verify native calendar side effects?',
        suggestedResolution: 'Run the app on a supported device.',
        reportedBy: 'developer-1',
        reportedAt: '2026-05-25T17:55:16Z',
      },
    },
  ],
}))
// Legacy `external_validation` kind normalizes to the first-class `user` route
// (the human is the actor being waited on); `owner` likewise folds to
// `architect`. The fixture feeds the legacy value to prove the mapping holds.
assert.equal(externalNeedsInputState?.tasks[0]?.needsInput?.kind, 'user')
assert.equal(externalNeedsInputState?.tasks[0]?.needsInput?.reason, 'A real device or supported simulator is required.')
assert.equal(externalNeedsInputState?.tasks[0]?.needsInput?.question, 'Can a tester verify native calendar side effects?')

// sprintEngineRunAwaitsHumanInput: external_validation/user needs_input awaits a
// human (drives the Backlog needs-input glyph); architect-routed does not.
assert.equal(sprintEngineRunAwaitsHumanInput(externalNeedsInputState!), true)
assert.equal(
  sprintEngineRunAwaitsHumanInput({
    tasks: externalNeedsInputState!.tasks.map((task) => ({
      ...task,
      needsInput: task.needsInput ? { ...task.needsInput, kind: 'architect' } : undefined,
    })),
  }),
  false,
)
assert.equal(
  sprintEngineRunAwaitsHumanInput({
    tasks: externalNeedsInputState!.tasks.map((task) => ({ ...task, status: 'done', needsInput: undefined })),
  }),
  false,
)

// deriveSprintEngineRunGlyph: the run-level rollup shared by the Backlog and
// the workspace sidebar. Human-routed needs_input outranks a running runner;
// runtime states map to the lifecycle vocabulary; an idle/missing runner
// yields null so each surface keeps its own fallback.
const runningAutoState = { desiredMode: 'run_agents' as const, runtimeState: 'running' as const }
assert.deepEqual(
  deriveSprintEngineRunGlyph({ sprintEngineState: externalNeedsInputState, autoState: runningAutoState }),
  { state: 'needs_input', live: false, label: 'Needs input' },
)
assert.deepEqual(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [] }, autoState: runningAutoState }),
  { state: 'in_progress', live: true, label: 'Running' },
)
assert.equal(
  deriveSprintEngineRunGlyph({
    sprintEngineState: { tasks: [] },
    autoState: { desiredMode: 'manual', runtimeState: 'idle' },
  }),
  null,
)
assert.equal(deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [] }, autoState: null }), null)
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [] }, autoState: { desiredMode: 'run_agents', runtimeState: 'blocked' } })?.state,
  'needs_input',
)
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [] }, autoState: { desiredMode: 'run_agents', runtimeState: 'failed' } })?.state,
  'failed',
)
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [] }, autoState: { desiredMode: 'run_agents', runtimeState: 'paused' } })?.state,
  'paused',
)
assert.deepEqual(
  deriveSprintEngineRunGlyph({ sprintEngineState: null, autoState: { desiredMode: 'run_agents', runtimeState: 'complete' } }),
  { state: 'done', live: false, label: 'Complete' },
)

// Board-driven rollup: progress is derived from the task board, not terminals,
// so a manual run (idle runner) still reflects its real state.
const boardTask = (status: SprintEngineTask['status']): SprintEngineTask => ({ status }) as SprintEngineTask
const manualIdle = { desiredMode: 'manual' as const, runtimeState: 'idle' as const }
// An in-flight task → in_progress, static (no live runner asserted on a manual run).
assert.deepEqual(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [boardTask('in_progress')] }, autoState: manualIdle }),
  { state: 'in_progress', live: false, label: 'In progress' },
)
// Quality-gate columns count as in-flight too.
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [boardTask('review')] }, autoState: manualIdle })?.state,
  'in_progress',
)
// A *paused* runner with a task still mid-flight reads as paused — NOT the static
// in_progress arc (a spinner that looks stuck). The paused runner must win over
// the active-work branch so the glyph is a pause icon.
const pausedRunner = { desiredMode: 'run_agents' as const, runtimeState: 'paused' as const }
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [boardTask('review')] }, autoState: pausedRunner })?.state,
  'paused',
)
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [boardTask('in_progress'), boardTask('todo')] }, autoState: pausedRunner })?.state,
  'paused',
)
// …but a paused runner whose tasks are all done still reads as done, not paused.
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [boardTask('done')] }, autoState: pausedRunner })?.state,
  'done',
)
// A task in `review` is active work: its own owner is reviewing the diff it just
// published, so the run reads as in progress rather than idle.
assert.deepEqual(
  deriveSprintEngineRunGlyph({
    sprintEngineState: { tasks: [boardTask('review'), boardTask('in_progress')] },
    autoState: manualIdle,
  }),
  { state: 'in_progress', live: false, label: 'In progress' },
)
// Some done + nothing running → paused.
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [boardTask('done'), boardTask('todo')] }, autoState: manualIdle })?.state,
  'paused',
)
// All todo, idle runner → never started, no run signal yet.
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [boardTask('todo'), boardTask('todo')] }, autoState: manualIdle }),
  null,
)
// All done → done, even with an idle manual runner.
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [boardTask('done'), boardTask('done')] }, autoState: manualIdle })?.state,
  'done',
)

// isCanceledSprintEngineRun reads the stored run flag, never task-completeness.
assert.equal(isCanceledSprintEngineRun({ canceled: true }), true)
assert.equal(isCanceledSprintEngineRun({ canceled: false }), false)
assert.equal(isCanceledSprintEngineRun({}), false)

// Cancellation is a decided terminal: the stored flag outranks needs_input,
// in-flight tasks, and completion, and reads as the plain `archived` mark
// (distinct from the green `done` completion tick).
assert.deepEqual(
  deriveSprintEngineRunGlyph({
    sprintEngineState: { canceled: true, tasks: [boardTask('canceled'), boardTask('done'), boardTask('in_progress')] },
    autoState: runningAutoState,
  }),
  { state: 'archived', live: false, label: 'Canceled' },
)
// A canceled run whose one task happens to await user input still reads Canceled,
// not Needs input — cancellation wins.
assert.equal(
  deriveSprintEngineRunGlyph({
    sprintEngineState: { canceled: true, tasks: [{ status: 'needs_input', needsInput: { kind: 'user' } } as SprintEngineTask] },
    autoState: manualIdle,
  })?.label,
  'Canceled',
)
// The terminal `canceled` runtime state also yields the Canceled glyph before the
// projection carries the flag (cold reopen reading persisted lifecycle only).
assert.deepEqual(
  deriveSprintEngineRunGlyph({ sprintEngineState: null, autoState: { desiredMode: 'run_agents', runtimeState: 'canceled' } }),
  { state: 'archived', live: false, label: 'Canceled' },
)
// Completed worktree run: merged → purple `done_merged` ("Merged"); not-yet-
// merged → outline `done_unmerged` ("Ready for review"); no worktree stays
// filled green `done` ("Complete").
const worktreeVcs = (extra: Record<string, unknown>) =>
  ({ mode: 'run_worktree', worktreePath: '.x/worktree', branchName: 'sprintengine/x', ...extra }) as never
assert.deepEqual(
  deriveSprintEngineRunGlyph({
    sprintEngineState: { tasks: [boardTask('done')], vcs: worktreeVcs({ pullRequestState: 'merged', pullRequestUrl: 'https://x/pull/1' }) },
    autoState: manualIdle,
  }),
  { state: 'done_merged', live: false, label: 'Merged' },
)
assert.deepEqual(
  deriveSprintEngineRunGlyph({
    sprintEngineState: { tasks: [boardTask('done')], vcs: worktreeVcs({ pullRequestState: 'open', pullRequestUrl: 'https://x/pull/1' }) },
    autoState: manualIdle,
  }),
  { state: 'done_unmerged', live: false, label: 'Ready for review' },
)
assert.deepEqual(
  deriveSprintEngineRunGlyph({
    sprintEngineState: { tasks: [boardTask('done')], vcs: worktreeVcs({ pullRequestUrl: null }) },
    autoState: manualIdle,
  }),
  { state: 'done_unmerged', live: false, label: 'Ready for review' },
)
// A run spanning projects (MC-1613) merges only when its LAST branch does. The
// three cases above also pin the legacy read: `worktreeVcs` carries no `repos`, so
// they prove a persisted pre-`repos` vcs still rolls up as its one repo.
const repo = (id: string, pullRequestState: string | null) =>
  ({ id, root: id === 'primary' ? '.' : `../${id}`, worktreePath: `.x/worktree-${id}`, branchName: 'sprintengine/x', pullRequestState })
const multiRepoVcs = (...repos: unknown[]) =>
  ({ mode: 'run_worktree', worktreePath: '.x/worktree', branchName: 'sprintengine/x', pullRequestState: 'merged', repos }) as never
// The regression this exists for: the primary merged, the sibling still open. The
// flat `pullRequestState` says 'merged' — reading it alone called the whole run
// merged while another project's branch was still out.
assert.deepEqual(
  deriveSprintEngineRunGlyph({
    sprintEngineState: {
      tasks: [boardTask('done')],
      vcs: multiRepoVcs(repo('primary', 'merged'), repo('mobile', 'open')),
    },
    autoState: manualIdle,
  }),
  { state: 'done_unmerged', live: false, label: 'Ready for review · 1 project left to merge' },
)
// Nothing merged yet: the count names every project still out, and pluralizes.
assert.deepEqual(
  deriveSprintEngineRunGlyph({
    sprintEngineState: {
      tasks: [boardTask('done')],
      vcs: multiRepoVcs(repo('primary', 'open'), repo('mobile', null), repo('multiauth', 'open')),
    },
    autoState: manualIdle,
  }),
  { state: 'done_unmerged', live: false, label: 'Ready for review · 3 projects left to merge' },
)
// Every project merged: the run is merged, and says so without a count.
assert.deepEqual(
  deriveSprintEngineRunGlyph({
    sprintEngineState: {
      tasks: [boardTask('done')],
      vcs: multiRepoVcs(repo('primary', 'merged'), repo('mobile', 'merged')),
    },
    autoState: manualIdle,
  }),
  { state: 'done_merged', live: false, label: 'Merged' },
)
// A run in ONE project keeps the bare label: there is no second project to count.
assert.deepEqual(
  deriveSprintEngineRunGlyph({
    sprintEngineState: { tasks: [boardTask('done')], vcs: multiRepoVcs(repo('primary', 'open')) },
    autoState: manualIdle,
  }),
  { state: 'done_unmerged', live: false, label: 'Ready for review' },
)
// The rollup itself: null when there is no branch to merge at all, which is what
// keeps a non-worktree run on plain "Complete" rather than a permanent "unmerged".
assert.equal(deriveSprintEngineRepoMergeRollup(null), null)
assert.deepEqual(
  deriveSprintEngineRepoMergeRollup(multiRepoVcs(repo('primary', 'merged'), repo('mobile', 'open'))),
  { total: 2, merged: 1, unmerged: 1, allMerged: false },
)
// An architect-routed needs_input task (no user question) is in-flight work, not
// a user prompt — it reads in_progress, not needs_input.
assert.equal(
  deriveSprintEngineRunGlyph({ sprintEngineState: { tasks: [boardTask('needs_input')] }, autoState: manualIdle })?.state,
  'in_progress',
)

const dispatchState = normalizeSprintEngineProjection(fakeProjection({
  roster: {
    'frontend-3': {
      role: 'frontend',
      status: 'running',
      currentTaskId: 'T4',
      currentDispatch: {
        dispatchId: 'DISP-6ed51f5daa40b4bd',
        targetKind: 'task',
        role: 'frontend',
        reason: 'task_claimed',
        taskId: 'T4',
        assignedAt: '2026-05-20T21:49:44Z',
      },
    },
  },
}))
assert.deepEqual(dispatchState?.sprintEngineAgents['frontend-3']?.currentDispatch, {
  dispatchId: 'DISP-6ed51f5daa40b4bd',
  targetKind: 'task',
  role: 'frontend',
  reason: 'task_claimed',
  taskId: 'T4',
  assignedAt: '2026-05-20T21:49:44Z',
})

const runnerState = normalizeSprintEngineProjection(fakeProjection({
  run: {
    id: 'run-id',
    name: 'Sample Run',
    goal: 'Test goal',
    status: 'executing',
    rosterConfigured: true,
    updatedAt: '2026-05-16T20:00:00Z',
    runner: {
      mode: 'auto',
      pollIntervalSeconds: 4,
      idleBackoffSeconds: 12,
      maxBackoffSeconds: 90,
      stopWhenComplete: false,
    },
  },
}))
assert.deepEqual(runnerState?.runner, {
  // Input projection used legacy `mode: 'auto'`; the renderer normalizer
  // translates it to the new `cliWatchPolling: 'enabled'` shape. Validates
  // the backward-compat read.
  cliWatchPolling: 'enabled',
  pollIntervalSeconds: 4,
  idleBackoffSeconds: 12,
  maxBackoffSeconds: 90,
  stopWhenComplete: false,
})

const doneTask = state!.tasks.find((task) => task.id === 'T1')!
assert.equal(doneTask.boardColumn, 'done')
assert.equal(doneTask.folderStatus, 'done')

const diffState = normalizeSprintEngineProjection(fakeProjection({
  tasks: [
    {
      id: 'T1',
      title: 'Diff task',
      description: '',
      role: 'developer',
      status: 'done',
      folderStatus: 'done',
      stateStatus: 'done',
      boardColumn: 'done',
      ownedPaths: [],
      dependsOn: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      notes: [],
      comments: [],
      evidence: {
        summary: 'Diff captured',
        touchedFiles: ['src/example.ts'],
        commandsRan: [],
        results: [],
        diffs: [
          {
            path: 'src/example.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            capturedAt: '2026-05-19T10:00:00Z',
            capturedBy: 'developer-1',
            source: 'working_tree',
            binary: false,
            truncated: false,
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [
                  { type: 'removed', oldLine: 1, newLine: null, content: 'old' },
                  { type: 'added', oldLine: null, newLine: 1, content: 'new' },
                ],
              },
            ],
          },
          { path: '', status: 'modified' },
        ],
      },
      activity: [],
      startedAt: null,
      completedAt: null,
      ownerAgentId: null,
    },
  ],
}))
assert.equal(diffState?.tasks[0]?.evidence.diffs?.length, 1)
assert.equal(diffState?.tasks[0]?.evidence.diffs?.[0]?.path, 'src/example.ts')
assert.equal(diffState?.tasks[0]?.evidence.diffs?.[0]?.hunks[0]?.lines[1]?.type, 'added')
assert.equal(doneTask.stateStatus, 'done')
assert.equal(doneTask.status, 'done')
assert.equal(doneTask.activity?.length, 2)

const readyTask = state!.tasks.find((task) => task.id === 'T2')!
assert.equal(readyTask.boardColumn, 'ready')
assert.equal(readyTask.folderStatus, 'ready')
assert.equal(readyTask.stateStatus, 'todo')
// Semantic status mirrors stateStatus when present, not the board column.
assert.equal(readyTask.status, 'todo')

const reviewTask = state!.tasks.find((task) => task.id === 'T3')!
assert.equal(reviewTask.boardColumn, 'review')
assert.equal(reviewTask.folderStatus, 'review')
assert.equal(reviewTask.stateStatus, 'review')
assert.equal(reviewTask.status, 'review')

// getSprintEngineTaskBoardColumn prefers the projection's authoritative boardColumn.
assert.equal(getSprintEngineTaskBoardColumn(readyTask, state!.tasks), 'ready')
assert.equal(getSprintEngineTaskBoardColumn(reviewTask, state!.tasks), 'review')
assert.equal(getSprintEngineTaskBoardColumn(doneTask, state!.tasks), 'done')
assert.deepEqual(
  orderSprintEngineBoardColumnTasks('done', [
    { ...doneTask, id: 'OLD', completedAt: '2026-05-16T19:50:00Z' },
    { ...doneTask, id: 'MISSING', completedAt: null },
    { ...doneTask, id: 'NEW', completedAt: '2026-05-16T20:05:00Z' },
    { ...doneTask, id: 'SAME_A', completedAt: '2026-05-16T20:05:00Z' },
    { ...doneTask, id: 'INVALID', completedAt: 'not-a-date' },
  ]).map((task) => task.id),
  ['NEW', 'SAME_A', 'OLD', 'MISSING', 'INVALID'],
)
assert.deepEqual(
  orderSprintEngineBoardColumnTasks('ready', [
    { ...readyTask, id: 'SECOND', completedAt: '2026-05-16T20:05:00Z' },
    { ...readyTask, id: 'FIRST', completedAt: '2026-05-16T19:50:00Z' },
  ]).map((task) => task.id),
  ['SECOND', 'FIRST'],
)
assert.equal(isSprintEngineTaskLaunchable(readyTask, state!), true)
// A task in `review` is owned by its implementer through `done` — never free work.
assert.equal(isSprintEngineTaskLaunchable(reviewTask, state!), false)
assert.equal(isSprintEngineTaskLaunchable(doneTask, state!), false)

assert.equal(getSprintEngineStartupCommandMode('developer', 'developer-1', state), 'join')
assert.equal(getSprintEngineStartupCommandMode('architect', 'architect-2', state), 'join')
assert.equal(getSprintEngineStartupCommandMode('architect', 'architect', null), 'init')
assert.equal(getSprintEngineStartupCommandMode('architect', 'architect', { tasks: [] }), 'init')
assert.equal(
  getSprintEngineStartupCommandMode('architect', 'architect', {
    tasks: [
      {
        id: 'T0',
        title: 'Review architect plan artifact',
        description: '',
        role: 'architect',
        status: 'todo',
        ownerAgentId: null,
        dependsOn: [],
        ownedPaths: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        notes: [],
        comments: [],
        startedAt: null,
        completedAt: null,
      },
    ],
  }),
  'join'
)

// Task without a boardColumn falls back to the computed column.
const taskWithoutBoardColumn: SprintEngineTask = {
  id: 'L1',
  title: 'Task without board column',
  description: '',
  role: 'developer',
  status: 'todo',
  ownerAgentId: null,
  dependsOn: ['T1'],
  ownedPaths: [],
  acceptanceCriteria: [],
  implementationNotes: [],
  evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
  notes: [],
  comments: [],
  startedAt: null,
  completedAt: null,
}
assert.equal(getSprintEngineTaskBoardColumn(taskWithoutBoardColumn, state!.tasks), 'ready')

// MC-1542 (R1): a canceled task is terminal. Its authoritative board column is
// preserved, it is never launchable, and it never falls through to ready/todo —
// even when its dependencies are complete, which a pre-fix build would have
// materialized into the ready queue and counted as remaining/launchable work.
const canceledTaskWithColumn: SprintEngineTask = {
  ...taskWithoutBoardColumn,
  id: 'C1',
  title: 'Canceled task (authoritative column)',
  status: 'canceled',
  boardColumn: 'canceled',
  dependsOn: [],
}
assert.equal(getSprintEngineTaskBoardColumn(canceledTaskWithColumn, state!.tasks), 'canceled')
assert.equal(isSprintEngineTaskLaunchable(canceledTaskWithColumn, state!), false)

// No projected boardColumn, deps satisfied (T1 is done): status pass-through must
// still return 'canceled' rather than recomputing 'ready'.
const canceledTaskDepsDone: SprintEngineTask = {
  ...taskWithoutBoardColumn,
  id: 'C2',
  title: 'Canceled task (deps done, no board column)',
  status: 'canceled',
  dependsOn: ['T1'],
}
assert.equal(getSprintEngineTaskBoardColumn(canceledTaskDepsDone, state!.tasks), 'canceled')
assert.notEqual(getSprintEngineTaskBoardColumn(canceledTaskDepsDone, state!.tasks), 'ready')
assert.equal(isSprintEngineTaskLaunchable(canceledTaskDepsDone, state!), false)
// Terminal, not active work: excluded from the rendered board lanes entirely, so
// it can never land in a to-do/ready/in-progress column count.
assert.equal(sprintEngineTaskBoardColumns.some((column) => column.key === 'canceled'), false)

// Activity is returned newest-first.
const sortedActivity = getSprintEngineTaskActivityDescending(doneTask)
assert.equal(sortedActivity[0].id, 'ACT-2')
assert.equal(sortedActivity[1].id, 'ACT-1')

// Open feedback helpers ignore resolved/applied entries.
const openIssues = getOpenSprintEngineFeedbackIssues({
  schemaVersion: 1,
  capturedAt: '2026-05-16T20:00:00Z',
  source: 'agent_self_report',
  agentId: 'developer-1',
  role: 'developer',
  scores: {},
  issues: [
    { id: 'i1', category: 'task_card', severity: 'high', title: 'A', detail: 'd', status: 'new' },
    { id: 'i2', category: 'task_card', severity: 'low', title: 'B', detail: 'd', status: 'applied' },
    { id: 'i3', category: 'task_card', severity: 'high', title: 'C', detail: 'd', status: 'rejected' },
  ],
})
assert.deepEqual(openIssues.map((i) => i.id), ['i1'])

const openFindings = getOpenSprintEngineFeedbackFindings({
  schemaVersion: 1,
  capturedAt: '2026-05-16T20:00:00Z',
  source: 'agent_self_report',
  agentId: 'developer-1',
  role: 'developer',
  scores: {},
  findings: [
    { id: 'f1', kind: 'code_bug', severity: 'high', area: 'frontend', title: 'A', detail: 'd' },
    { id: 'f2', kind: 'code_bug', severity: 'low', area: 'frontend', title: 'B', detail: 'd', status: 'fixed' },
    { id: 'f3', kind: 'code_bug', severity: 'low', area: 'frontend', title: 'C', detail: 'd', status: 'accepted' },
  ],
})
assert.deepEqual(openFindings.map((f) => f.id), ['f1', 'f3'])

// formatSprintEngineLockAge produces compact, unit-aware labels.
assert.equal(formatSprintEngineLockAge(45), '45s')
assert.equal(formatSprintEngineLockAge(120), '2m')
assert.equal(formatSprintEngineLockAge(3700), '1h')
assert.equal(formatSprintEngineLockAge(null), 'unknown age')
assert.equal(formatSprintEngineLockAge(-5), 'unknown age')

// Unavailable projection source rolls through normalization without throwing.
const unavailable = normalizeSprintEngineProjection({
  ...fakeProjection(),
  source: 'unavailable',
  tasks: [],
  roster: {},
})
assert.equal(unavailable?.projection?.source, 'unavailable')

// --- Review-task projection normalization ---
// MC-1542 single-owner tasks deleted quality gates (qualityPolicy / qualityGates
// / qualityGateSummary and the changes_requested / testing / product statuses).
// What survives — and this block still pins — is the `review` board column
// round-trip, stateStatus driving the semantic status while a task lives in the
// review folder, and the comment / feedback / recorded-artifact surfaces.
const reviewProjection = fakeProjection({
  run: {
    id: 'run-id',
    name: 'Sample Run',
    goal: 'Test goal',
    status: 'executing',
    rosterConfigured: true,
    updatedAt: '2026-05-16T20:00:00Z',
  },
  roster: {
    architect: { role: 'architect', status: 'idle', currentTaskId: null },
    'developer-1': { role: 'developer', status: 'running', currentTaskId: 'G1' },
  },
  tasks: [
    {
      id: 'G1',
      title: 'Implementation under review',
      description: 'Task whose owner is reviewing its own diff',
      role: 'developer',
      status: 'review',
      folderStatus: 'review',
      stateStatus: 'in_progress',
      boardColumn: 'review',
      ownedPaths: [],
      dependsOn: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      notes: [],
      comments: [
        {
          id: 'C1',
          type: 'implementation_summary',
          actor: 'developer-1',
          authorAgentId: 'developer-1',
          authorRole: 'developer',
          source: 'agent',
          body: 'Initial implementation complete; ready for review.',
          createdAt: '2026-05-16T19:50:00Z',
        },
        {
          id: 'C2',
          type: 'review_feedback',
          actor: 'security',
          authorAgentId: 'security',
          authorRole: 'security',
          source: 'agent',
          body: 'Found a missing edge case in projection normalization.',
          createdAt: '2026-05-16T19:55:00Z',
          data: { status: 'open' },
        },
      ],
      latestComments: [
        {
          id: 'C2',
          type: 'review_feedback',
          actor: 'security',
          authorAgentId: 'security',
          authorRole: 'security',
          source: 'agent',
          body: 'Found a missing edge case in projection normalization.',
          createdAt: '2026-05-16T19:55:00Z',
          data: { status: 'open' },
        },
      ],
      latestOpenFeedback: [
        {
          id: 'C2',
          type: 'review_feedback',
          actor: 'security',
          authorAgentId: 'security',
          authorRole: 'security',
          source: 'agent',
          body: 'Found a missing edge case in projection normalization.',
          createdAt: '2026-05-16T19:55:00Z',
          data: { status: 'open' },
        },
      ],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
      activity: [],
      startedAt: '2026-05-16T19:30:00Z',
      completedAt: null,
      ownerAgentId: 'developer-1',
      recordedArtifacts: [
        {
          id: 'R1',
          kind: 'code_review',
          title: 'Self review pass 1',
          path: '.multi-code/sprintengine/run-id/reviews/code-review-1.md',
          createdBy: 'developer-1',
          createdAt: '2026-05-16T19:55:00Z',
        },
      ],
    },
  ],
})

const reviewState = normalizeSprintEngineProjection(reviewProjection)
assert.ok(reviewState, 'review projection should normalize')

const reviewFolderTask = reviewState!.tasks.find((task) => task.id === 'G1')!
assert.equal(reviewFolderTask.boardColumn, 'review', 'review boardColumn round-trips')
assert.equal(reviewFolderTask.status, 'in_progress', 'semantic stateStatus drives status while task lives in review folder')
assert.equal(getSprintEngineTaskBoardColumn(reviewFolderTask, reviewState!.tasks), 'review')

const latestSummary = getLatestSprintEngineTaskComment(reviewFolderTask, 'implementation_summary')
assert.ok(latestSummary, 'implementation_summary surfaces via getLatestSprintEngineTaskComment')
assert.equal(latestSummary!.actor, 'developer-1')

const openFeedback = getOpenSprintEngineFeedbackComments(reviewFolderTask)
assert.equal(openFeedback.length, 1)
assert.equal(openFeedback[0].type, 'review_feedback')
assert.equal(openFeedback[0].authorAgentId, 'security')

assert.equal(reviewFolderTask.recordedArtifacts?.length, 1)
assert.equal(reviewFolderTask.recordedArtifacts?.[0]?.kind, 'code_review')

// --- Registry-keyed role behavior (T2) ---

// Predicate boundaries: any non-empty trimmed string is a valid role id;
// `isBundledSprintEngineRole` stays strict so config types still narrow.
assert.equal(isSprintEngineRoleId('marketer'), true)
assert.equal(isSprintEngineRoleId('frontend'), true)
assert.equal(isSprintEngineRoleId('   '), false)
assert.equal(isSprintEngineRoleId(''), false)
assert.equal(isSprintEngineRoleId(undefined), false)
assert.equal(isSprintEngineRoleId(42), false)
assert.equal(isBundledSprintEngineRole('frontend'), true)
assert.equal(isBundledSprintEngineRole('marketer'), false)
assert.equal(isBundledSprintEngineRole(null), false)

// Humanization fallback: registry-keyed ids without metadata render as a
// title-cased label, never as a raw `growth_engineer` identifier.
assert.equal(humanizeSprintEngineRoleId('marketer'), 'Marketer')
assert.equal(humanizeSprintEngineRoleId('growth_engineer'), 'Growth Engineer')
assert.equal(humanizeSprintEngineRoleId('content-writer'), 'Content Writer')

// Safe accessors fall back to bundled labels for bundled roles, humanized
// strings for custom roles, and 'Unknown role' for missing input. The
// accent and glyph kind never throw on unknown ids.
assert.equal(getSprintEngineRoleLabel('frontend'), 'Frontend Engineer')
assert.equal(getSprintEngineRoleLabel('marketer'), 'Marketer')
assert.equal(getSprintEngineRoleLabel(null), 'Unknown role')
assert.equal(getSprintEngineRoleLabel('  '), 'Unknown role')
assert.equal(getSprintEngineRoleAccent('marketer'), sprintEngineNeutralRoleAccent)
assert.notEqual(getSprintEngineRoleAccent('architect'), sprintEngineNeutralRoleAccent)
assert.equal(getSprintEngineRoleGlyphKind('marketer'), 'unknown')
assert.equal(getSprintEngineRoleGlyphKind('frontend'), 'frontend')
assert.equal(getSprintEngineRoleGlyphKind(null), 'unknown')

// Registry builder: well-formed payload yields a lookup keyed by canonical
// id, with aliases preserved only when they point at known roles. The
// `growth-engineer` alias here points at the configured `growth_engineer`
// role and should round-trip; `unknown-target` aliases are dropped.
const registry: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({
  roles: [
    {
      id: 'marketer',
      label: 'Brand Marketer',
      aliases: ['marketing-lead'],
      icon: null,
      source: { layer: 'workspace' },
    },
    {
      id: 'growth_engineer',
      label: 'Growth Engineer',
      aliases: [],
      icon: 'developer',
      summary: 'Owns growth experiments.',
      source: { layer: 'plugin' },
      shadowedSources: [{ layer: 'bundled' }],
    },
    // Malformed entry: missing id — dropped without throwing.
    { label: 'Ghost', source: { layer: 'workspace' } },
    null,
  ],
  aliases: {
    'growth-engineer': 'growth_engineer',
    'marketing-lead': 'marketer',
    bogus: 'unknown-target',
  },
  warnings: [
    { code: 'shadowed', message: 'Bundled growth_engineer shadowed by plugin.', roleId: 'growth_engineer', sourceLayer: 'bundled' },
    // Malformed warning (missing code) — dropped.
    { message: 'no code' },
  ],
})
assert.deepEqual(Object.keys(registry.roles).sort(), ['growth_engineer', 'marketer'])
assert.equal(registry.aliases['growth-engineer'], 'growth_engineer')
assert.equal(registry.aliases['marketing-lead'], 'marketer')
assert.equal(registry.aliases.bogus, undefined)
assert.equal(registry.warnings.length, 1)
assert.equal(registry.warnings[0]?.code, 'shadowed')

// Registry-aware label/accent/glyph: registry label overrides the
// humanized fallback; registry icon snaps to a bundled glyph kind when it
// matches a bundled role name.
assert.equal(getSprintEngineRoleLabel('marketer', registry), 'Brand Marketer')
assert.equal(getSprintEngineRoleLabel('growth_engineer', registry), 'Growth Engineer')
assert.equal(getSprintEngineRoleGlyphKind('growth_engineer', registry), 'developer')
assert.equal(getSprintEngineRoleGlyphKind('marketer', registry), 'unknown')
// Alias lookup: `growth-engineer` resolves through `aliases` to the
// canonical entry without touching the static maps.
assert.equal(getSprintEngineRoleLabel('growth-engineer', registry), 'Growth Engineer')

// Direct metadata lookup is supported for hand-constructed callers (e.g.
// the inspector passing a single role's metadata rather than the full
// registry directory).
assert.equal(
  getSprintEngineRoleLabel('marketer', registry.roles.marketer),
  'Brand Marketer',
)

// Malformed registry payloads do not throw and produce an empty directory
// rather than a half-built lookup with surprising entries.
const emptyRegistry = buildSprintEngineRoleRegistry({ roles: 'not-an-array', aliases: null, warnings: 'oops' })
assert.deepEqual(emptyRegistry.roles, {})
assert.deepEqual(emptyRegistry.aliases, {})
assert.deepEqual(emptyRegistry.warnings, [])
const nullRegistry = buildSprintEngineRoleRegistry(null)
assert.deepEqual(nullRegistry.roles, {})
assert.deepEqual(nullRegistry.aliases, {})

// Projection normalization preserves a custom role id (`marketer`) across
// tasks, gates, agents, comments, feedback, and quality-policy gates.
const customRoleProjection = fakeProjection({
  run: {
    id: 'run-custom',
    name: 'Custom Roster',
    goal: 'Custom-role coverage',
    status: 'executing',
    rosterConfigured: true,
    updatedAt: '2026-05-20T20:00:00Z',
  },
  roster: {
    architect: { role: 'architect', status: 'idle', currentTaskId: null },
    marketer: { role: 'marketer', status: 'running', currentTaskId: 'M1' },
  },
  tasks: [
    {
      id: 'M1',
      title: 'Custom-role task',
      description: '',
      role: 'marketer',
      status: 'in_progress',
      folderStatus: 'in_progress',
      stateStatus: 'in_progress',
      boardColumn: 'in_progress',
      ownedPaths: [],
      dependsOn: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      notes: [],
      comments: [
        {
          id: 'C1',
          actor: 'marketer',
          source: 'agent',
          body: 'Custom-role comment preserved.',
          createdAt: '2026-05-20T20:01:00Z',
          authorRole: 'marketer',
          type: 'implementation_summary',
        },
      ],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
      feedback: {
        schemaVersion: 1,
        capturedAt: '2026-05-20T20:01:30Z',
        source: 'agent_self_report',
        agentId: 'marketer',
        role: 'marketer',
        scores: { taskClarityPct: 80 },
      },
      triage: {
        summary: 'Custom-role triage',
        suggestedRole: 'marketer',
        acceptanceCriteria: [],
        likelyAffectedAreas: [],
        missingInformation: [],
        riskRating: 'low',
        readyRecommendation: true,
        triagedBy: 'architect',
        triagedAt: '2026-05-20T20:01:00Z',
      },
      activity: [],
      startedAt: '2026-05-20T20:00:30Z',
      completedAt: null,
      ownerAgentId: 'marketer',
    },
  ],
  artifacts: [],
  activity: [],
})
const customRoleState = normalizeSprintEngineProjection(customRoleProjection)
assert.ok(customRoleState, 'custom-role projection normalizes')
const customRoleTask = customRoleState!.tasks.find((task) => task.id === 'M1')!
assert.equal(customRoleTask.role, 'marketer', 'task.role preserved as custom id')
assert.equal(customRoleTask.comments[0]?.authorRole, 'marketer', 'comment.authorRole preserved')
assert.equal(customRoleTask.feedback?.role, 'marketer', 'feedback.role preserved')
assert.equal(customRoleTask.triage?.suggestedRole, 'marketer', 'triage.suggestedRole preserved')
assert.equal(customRoleState!.sprintEngineAgents.marketer?.role, 'marketer', 'runtime agent role preserved')
assert.equal(
  taskGraphEndEdgeStyle(customRoleTask).color,
  sprintEngineNeutralRoleAccent,
  'custom-role graph end edge uses the neutral safe accent instead of static-map undefined',
)
const customDependencyTask: SprintEngineTask = {
  ...customRoleTask,
  id: 'M0',
  status: 'todo',
  role: 'growth_engineer',
}
assert.equal(
  taskGraphEdgeStyle(customDependencyTask, customRoleTask).color,
  sprintEngineNeutralRoleAccent,
  'custom-role graph dependency edge uses the neutral safe accent',
)

// Roster builder includes custom-role agents and labels them with the
// registry metadata when provided.
const customRosterWithoutRegistry = buildSprintEngineAgentRosterFromRuntimeAgents(customRoleState!.sprintEngineAgents)
assert.ok(customRosterWithoutRegistry.some((agent) => agent.role === 'marketer'), 'custom role appears in roster')
const marketerWithoutRegistry = customRosterWithoutRegistry.find((agent) => agent.role === 'marketer')!
assert.equal(marketerWithoutRegistry.label, 'Marketer', 'custom role uses humanized label without registry')

const customRosterWithRegistry = buildSprintEngineAgentRosterFromRuntimeAgents(
  customRoleState!.sprintEngineAgents,
  registry,
)
const marketerWithRegistry = customRosterWithRegistry.find((agent) => agent.role === 'marketer')!
assert.equal(marketerWithRegistry.label, 'Brand Marketer', 'registry label wins when available')

// Malformed comment entries with empty or missing role are dropped during
// normalization, but valid sibling entries still survive.
const malformedProjection = fakeProjection({
  tasks: [
    {
      id: 'MAL',
      title: 'Malformed surface',
      description: '',
      role: 'marketer',
      status: 'in_progress',
      folderStatus: 'in_progress',
      stateStatus: 'in_progress',
      boardColumn: 'in_progress',
      ownedPaths: [],
      dependsOn: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      notes: [],
      comments: [
        // Empty author role — comment body kept, role dropped.
        { id: 'C1', actor: 'marketer', source: 'agent', body: 'kept', createdAt: '2026-05-20T20:02:00Z', authorRole: '' },
        // Valid registry role — survives intact.
        { id: 'C2', actor: 'marketer', source: 'agent', body: 'kept-with-role', createdAt: '2026-05-20T20:02:30Z', authorRole: 'marketer' },
      ],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
      activity: [],
      startedAt: null,
      completedAt: null,
      ownerAgentId: null,
    },
  ],
})
const malformedState = normalizeSprintEngineProjection(malformedProjection)
const malformedTask = malformedState!.tasks.find((task) => task.id === 'MAL')!
assert.equal(malformedTask.comments.length, 2, 'comment bodies survive even when authorRole is malformed')
assert.equal(malformedTask.comments[0]?.authorRole, undefined, 'empty authorRole dropped')
assert.equal(malformedTask.comments[1]?.authorRole, 'marketer', 'valid custom authorRole preserved')

// --- Settings role enablement (T3) -----------------------------------------
// `getUserDisabledSprintEngineRoleIds` collects user-toggled-off ids and
// silently excludes architect so a stale or hostile setting cannot strand
// new rosters without a planner.
{
  const disabled = getUserDisabledSprintEngineRoleIds({
    enabled: {
      architect: false,
      frontend: false,
      developer: true,
      marketer: false,
    },
  })
  assert.equal(disabled.has('frontend'), true, 'bundled frontend disablement honored')
  assert.equal(disabled.has('marketer'), true, 'custom registry role disablement honored')
  assert.equal(disabled.has('developer'), false, 'explicitly enabled role excluded')
  assert.equal(disabled.has('architect'), false, 'architect can never appear in disabled set')
  assert.equal(disabled.size, 2)
}

// Nullable/empty inputs are tolerated.
assert.equal(getUserDisabledSprintEngineRoleIds(null).size, 0)
assert.equal(getUserDisabledSprintEngineRoleIds(undefined).size, 0)
assert.equal(getUserDisabledSprintEngineRoleIds({ enabled: {} }).size, 0)

// `orderSprintEngineRosterRoles` filters bundled and custom roles by the
// disabled set but always keeps architect, even if the caller passes a set
// that includes it (the helper is the last line of defense against a stray
// caller).
{
  const customRegistry: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({
    roles: [
      { id: 'marketer', label: 'Marketer', aliases: [], source: { layer: 'workspace' } },
      { id: 'analyst', label: 'Analyst', aliases: [], source: { layer: 'workspace' } },
    ],
  })
  const visible = orderSprintEngineRosterRoles(
    customRegistry,
    new Set<string>(['frontend', 'marketer', 'architect']),
  )
  assert.equal(visible.includes('architect'), true, 'architect always returned even if disabled set includes it')
  assert.equal(visible.includes('frontend'), false, 'bundled frontend hidden when user disabled')
  assert.equal(visible.includes('marketer'), false, 'custom marketer hidden when user disabled')
  assert.equal(visible.includes('analyst'), true, 'untouched custom role still visible')
  // Bundled order is preserved at the head.
  assert.equal(visible[0], 'architect', 'bundled order preserved')
  assert.equal(
    visible.filter((role) => sprintEngineRoleOrder.includes(role as never)).length,
    sprintEngineRoleOrder.length - 1, // frontend removed
  )
}

// Manifest-disabled registry roles stay hidden regardless of user settings.
{
  const registry: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({
    roles: [
      { id: 'marketer', label: 'Marketer', aliases: [], source: { layer: 'workspace' }, enabled: false },
    ],
  })
  const visible = orderSprintEngineRosterRoles(registry, new Set<string>())
  assert.equal(visible.includes('marketer'), false, 'manifest-disabled role hidden even with no user override')
}

// `applyUserDisabledSprintEngineRoleCounts` zeros out counts for disabled
// roles and leaves the rest of the object alone. Architect is never in the
// disabled set, so an architect:1 baseline survives.
{
  const masked = applyUserDisabledSprintEngineRoleCounts(
    { architect: 1, developer: 2, frontend: 1, tester: 0 } as Record<string, number>,
    new Set<string>(['developer', 'frontend']),
  )
  assert.equal(masked.architect, 1, 'architect untouched')
  assert.equal(masked.developer, 0, 'disabled developer zeroed')
  assert.equal(masked.frontend, 0, 'disabled frontend zeroed')
  assert.equal(masked.tester, 0, 'unrelated role untouched')
}

// Empty disabled set is a no-op (same reference returned).
{
  const counts = { architect: 1, developer: 1 } as Record<string, number>
  assert.strictEqual(
    applyUserDisabledSprintEngineRoleCounts(counts, new Set<string>()),
    counts,
    'empty disabled set returns the original reference',
  )
}

// AC4 — projection rendering safety. Even when the user has disabled a role,
// the canonical projection still renders any task/agent already configured
// with that role. `normalizeSprintEngineProjection` does not consult app
// settings, so a developer task survives normalization regardless of how
// the disabled set is configured downstream.
{
  const projectionWithDeveloper = fakeProjection()
  const normalized = normalizeSprintEngineProjection(projectionWithDeveloper)
  const developerTask = normalized?.tasks.find((task) => task.id === 'T1')
  assert.ok(developerTask, 'projection still includes disabled-role task')
  assert.equal(developerTask?.role, 'developer')
  // Re-running the disabled-set helper does not mutate the projection;
  // settings filtering is selection-only.
  const disabledIds = getUserDisabledSprintEngineRoleIds({
    enabled: { developer: false },
  })
  assert.equal(disabledIds.has('developer'), true)
  const stillThere = normalized?.tasks.find((task) => task.id === 'T1')
  assert.equal(stillThere?.role, 'developer', 'projection unchanged by user role settings')
}

// ---------------------------------------------------------------------------
// Sprint Engine role option derivation (extracted utility)
// ---------------------------------------------------------------------------
type FakeRoster = { role: string }[]
type FakeTask = { role: string; status: SprintEngineTask['status'] }

// An installed specialist pack: the registry resolves every historical
// bundled role, in the canonical order. Post un-ship, specialist roles surface
// in pickers only through the registry, so tests that once leaned on a bundled
// fallback now model an installed pack explicitly. Sweep roles carry a `sweep`
// block so registry `isSweep` classification stays exercised.
const INSTALLED_SPECIALIST_PACK_REGISTRY: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({
  roles: sprintEngineRoleOrder.map((id) => ({
    id,
    label: getSprintEngineRoleLabel(id, null),
    aliases: [],
    source: { layer: 'user' },
    ...(BUNDLED_SPRINT_ENGINE_SWEEP_ROLE_IDS.includes(id) ? { sweep: {} } : {}),
  })),
})

// AC: post un-ship the bundled fallback advertises no specialist roles — every
// specialist role now travels in the installable pack, and the plain `general`
// agent is spliced in separately. A caller with no registry therefore offers
// no specialist role that cannot resolve.
{
  assert.deepEqual(
    [...BUNDLED_SPRINT_ENGINE_ADDABLE_ROLES],
    [],
    'bundled addable roles are empty post un-ship (specialists ship in the pack)',
  )
}

// AC: `buildSprintEngineAddMemberOptions` returns one option per registry-
// resolvable role in canonical order, computes counts from roster + tasks, and
// falls back to bundled summary copy when no override is provided. With the
// pack installed the registry resolves every specialist role.
{
  const roster: FakeRoster = [
    { role: 'architect' },
    { role: 'developer' },
    { role: 'developer' },
  ]
  const tasks: FakeTask[] = [
    { role: 'developer', status: 'in_progress' },
    { role: 'developer', status: 'done' },
    { role: 'frontend', status: 'todo' },
  ]
  const options = buildSprintEngineAddMemberOptions({
    registry: INSTALLED_SPECIALIST_PACK_REGISTRY,
    roster,
    tasks,
  })
  // Pack installed, no disabled set → canonical order, with the plain `general`
  // agent spliced in right after `architect` (MC-1585: addable on the board).
  const optionRoles = options.map((option) => option.role)
  assert.equal(optionRoles.includes('general'), true, 'general is an add-member option on the board')
  assert.equal(optionRoles.indexOf('general'), optionRoles.indexOf('architect') + 1, 'general sits right after architect')
  assert.deepEqual(
    optionRoles.filter((role) => role !== 'general'),
    [...sprintEngineRoleOrder],
    'the rest of the options preserve the canonical registry role order',
  )
  const developer = options.find((option) => option.role === 'developer')
  assert.ok(developer)
  assert.equal(developer.activeForRole, 2, 'roster counts collapse duplicates')
  assert.equal(developer.openTasksForRole, 1, 'done tasks excluded from open count')
  assert.equal(
    developer.summary,
    BUNDLED_SPRINT_ENGINE_BOARD_ROLE_SUMMARIES.developer,
    'bundled board summary used as default',
  )
  const frontend = options.find((option) => option.role === 'frontend')
  assert.equal(frontend?.activeForRole, 0)
  assert.equal(frontend?.openTasksForRole, 1)
  const architect = options.find((option) => option.role === 'architect')
  assert.equal(architect?.label, 'Architect', 'bundled label resolves from registry helper')
}

// AC1: with no specialist pack installed the roster offers `general` alone and
// advertises no un-shipped specialist role — not even architect, which now
// travels in the pack. A loaded-but-empty registry resolves nothing.
{
  const emptyRegistry: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({ roles: [] })
  const fromEmptyRegistry = listSprintEngineAddableRoles(emptyRegistry)
  assert.deepEqual(fromEmptyRegistry, ['general'], 'empty registry offers general alone')

  // No registry object at all degrades to the same general-only roster.
  const fromNoRegistry = listSprintEngineAddableRoles()
  assert.deepEqual(fromNoRegistry, ['general'], 'no registry offers general alone')

  // The board option builder mirrors it: general only, no specialist role.
  const options = buildSprintEngineAddMemberOptions({
    registry: emptyRegistry,
    roster: [],
    tasks: [{ role: 'frontend', status: 'todo' }],
  })
  assert.deepEqual(options.map((option) => option.role), ['general'], 'no un-shipped specialist surfaces without a pack')
}

// AC4: custom registry roles appear in add-member options without rendering
// React. Manifest-disabled registry roles stay hidden.
{
  const registry: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({
    roles: [
      {
        id: 'marketer',
        label: 'Marketer',
        aliases: [],
        summary: 'Owns positioning and copy.',
        source: { layer: 'workspace' },
      },
      {
        id: 'analyst',
        label: 'Analyst',
        aliases: [],
        source: { layer: 'workspace' },
        enabled: false,
      },
    ],
  })
  const options = buildSprintEngineAddMemberOptions({
    registry,
    roster: [{ role: 'marketer' }],
    tasks: [{ role: 'marketer', status: 'in_progress' }],
  })
  const marketer = options.find((option) => option.role === 'marketer')
  assert.ok(marketer, 'custom role appears in options')
  assert.equal(marketer.label, 'Marketer', 'registry label used for custom role')
  assert.equal(marketer.summary, 'Owns positioning and copy.', 'registry summary used when no override')
  assert.equal(marketer.activeForRole, 1)
  assert.equal(marketer.openTasksForRole, 1)
  assert.equal(
    options.some((option) => option.role === 'analyst'),
    false,
    'manifest-disabled registry role hidden',
  )
}

// AC: with the pack installed, a disabled-role set hides specialist and custom
// roles but never architect (the registry resolves both, then the disabled set
// filters all but the protected architect).
{
  const registry: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({
    roles: [
      { id: 'architect', label: 'Architect', aliases: [], source: { layer: 'user' } },
      { id: 'frontend', label: 'Frontend', aliases: [], source: { layer: 'user' } },
      { id: 'marketer', label: 'Marketer', aliases: [], source: { layer: 'workspace' } },
    ],
  })
  const options = buildSprintEngineAddMemberOptions({
    registry,
    disabledRoleIds: new Set(['frontend', 'marketer', 'architect']),
    roster: [],
    tasks: [],
  })
  const ids = options.map((option) => option.role)
  assert.equal(ids.includes('architect'), true, 'architect survives disabled set')
  assert.equal(ids.includes('frontend'), false, 'specialist disabled role removed')
  assert.equal(ids.includes('marketer'), false, 'custom disabled role removed')
}

// AC: `findFirstUncoveredSprintEngineRole` picks the first registry-resolvable
// role with open tasks but no agent on the roster, in canonical order.
{
  const tasks: FakeTask[] = [
    { role: 'frontend', status: 'todo' },
    { role: 'developer', status: 'in_progress' },
  ]
  const roster: FakeRoster = [{ role: 'developer' }]
  const uncovered = findFirstUncoveredSprintEngineRole({
    registry: INSTALLED_SPECIALIST_PACK_REGISTRY,
    roster,
    tasks,
  })
  assert.equal(uncovered, 'frontend', 'uncovered frontend selected over staffed developer')
}

// `findFirstUncoveredSprintEngineRole` returns null when every open task is
// already covered by an active agent.
{
  const uncovered = findFirstUncoveredSprintEngineRole({
    registry: INSTALLED_SPECIALIST_PACK_REGISTRY,
    roster: [{ role: 'developer' }],
    tasks: [{ role: 'developer', status: 'todo' }],
  })
  assert.equal(uncovered, null, 'covered role returns null')
}

// AC: the live board's Add Member path surfaces a custom enabled registry
// role and selects it as the uncovered default when an open task names that
// role. Mirrors the inputs `SprintEngineBoardPanel` threads into
// `useSprintEngineBoardModel` (`registry` + `disabledRoleIds`).
{
  const registry: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({
    roles: [
      {
        id: 'marketer',
        label: 'Marketer',
        aliases: [],
        summary: 'Owns positioning and copy.',
        source: { layer: 'workspace' },
      },
    ],
  })
  // Workspace settings disable a bundled role; the live board must respect
  // the disabled set while still surfacing custom enabled registry roles.
  const disabledRoleIds = new Set<SprintEngineRoleId>(['frontend'])
  const liveBoardInput = {
    registry,
    disabledRoleIds,
    roster: [{ role: 'architect' as SprintEngineRoleId }],
    tasks: [
      { role: 'marketer' as SprintEngineRoleId, status: 'todo' as SprintEngineTask['status'] },
    ],
  }

  const options = buildSprintEngineAddMemberOptions(liveBoardInput)
  const marketerOption = options.find((option) => option.role === 'marketer')
  assert.ok(marketerOption, 'custom enabled registry role appears in live board Add Member options')
  assert.equal(marketerOption.label, 'Marketer', 'registry label used for custom role in live board')
  assert.equal(marketerOption.openTasksForRole, 1, 'open marketer task counted in live board options')
  assert.equal(marketerOption.activeForRole, 0, 'no marketer on roster yet')
  assert.equal(
    options.some((option) => option.role === 'frontend'),
    false,
    'workspace-disabled bundled role hidden from live board Add Member',
  )

  const uncovered = findFirstUncoveredSprintEngineRole(liveBoardInput)
  assert.equal(uncovered, 'marketer', 'custom enabled registry role is the uncovered default for its open task')
}

// `buildSprintEngineRosterCountByRole` mirrors the option builder: with the
// pack installed, zero-count registry roles still appear.
{
  const counts = buildSprintEngineRosterCountByRole({
    registry: INSTALLED_SPECIALIST_PACK_REGISTRY,
    roster: [{ role: 'developer' }, { role: 'developer' }, { role: 'architect' }],
    tasks: [],
  })
  assert.equal(counts.developer, 2)
  assert.equal(counts.architect, 1)
  assert.equal(counts.frontend, 0, 'zero-count registry roles still appear')
}

// `listSprintEngineAddableRoles` is the registry-authoritative list helper used
// by callers that just need the ordered role ids. MC-1585: the plain `general`
// agent is spliced in right after `architect` — it is addable everywhere new
// agents are configured, the wizard AND the live board. With the pack installed
// the registry resolves the specialist roles in canonical order.
{
  const ids = listSprintEngineAddableRoles(INSTALLED_SPECIALIST_PACK_REGISTRY)
  assert.equal(ids.includes('general'), true, 'general is addable (board + wizard)')
  assert.equal(ids.indexOf('general'), ids.indexOf('architect') + 1, 'general sits right after architect')
  assert.deepEqual(
    ids.filter((role) => role !== 'general'),
    [...sprintEngineRoleOrder],
    'the rest of the list keeps the canonical registry order',
  )
}

// AC2: new-workspace roster wizard consumes the shared utility. It calls
// `listSprintEngineAddableRoles(registry, disabledRoleIds)` and resolves
// summaries via `getSprintEngineWizardRoleSummary`, so custom registry roles
// and disabled-set semantics stay aligned with the live board without
// rendering React.
{
  const registry: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({
    roles: [
      {
        id: 'marketer',
        label: 'Marketer',
        aliases: [],
        summary: 'Owns positioning and launch copy.',
        source: { layer: 'workspace' },
      },
      {
        id: 'analyst',
        label: 'Analyst',
        aliases: [],
        source: { layer: 'workspace' },
        enabled: false,
      },
    ],
  })
  const wizardRoles = listSprintEngineAddableRoles(registry, new Set<string>(['developer']))
  assert.equal(wizardRoles.includes('developer'), false, 'disabled bundled role hidden from wizard')
  assert.equal(wizardRoles.includes('marketer'), true, 'custom enabled role appears in wizard')
  assert.equal(wizardRoles.includes('analyst'), false, 'manifest-disabled role hidden from wizard')

  // Wizard summary copy is the wizard table, not the board table.
  assert.equal(
    getSprintEngineWizardRoleSummary('frontend'),
    BUNDLED_SPRINT_ENGINE_WIZARD_ROLE_SUMMARIES.frontend,
    'bundled wizard summary used for bundled role',
  )
  assert.notEqual(
    getSprintEngineWizardRoleSummary('frontend'),
    BUNDLED_SPRINT_ENGINE_BOARD_ROLE_SUMMARIES.frontend,
    'wizard summary distinct from board summary',
  )
  assert.equal(
    getSprintEngineWizardRoleSummary('marketer', registry),
    'Owns positioning and launch copy.',
    'registry summary used when bundled wizard copy is unavailable',
  )
  assert.equal(
    getSprintEngineWizardRoleSummary('unknown_role'),
    'Custom registry role.',
    'unknown role falls back to generic wizard label',
  )
}

// The plain General is offered as a wizard roster choice (T6 / backlog 131 §7)
// and — since MC-1585 — on the live board too, surfaced right after `architect`
// once the pack resolves one. With no pack, general is the sole roster choice.
{
  const wizardRoles = listSprintEngineWizardRoles(INSTALLED_SPECIALIST_PACK_REGISTRY)
  assert.equal(wizardRoles.includes('general'), true, 'general appears as a wizard roster choice')
  assert.equal(
    wizardRoles.indexOf('general'),
    wizardRoles.indexOf('architect') + 1,
    'general is surfaced immediately after architect',
  )
  assert.deepEqual(
    listSprintEngineWizardRoles(),
    ['general'],
    'general is the sole wizard roster choice when no pack is installed',
  )
  assert.equal(
    listSprintEngineAddableRoles(INSTALLED_SPECIALIST_PACK_REGISTRY).includes('general'),
    true,
    'general is addable on the live board too (MC-1585)',
  )
  // General is not duplicated when a registry already provides it.
  const registryWithGeneral: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({
    roles: [{ id: 'general', label: 'General', aliases: [], source: { layer: 'workspace' } }],
  })
  assert.equal(
    listSprintEngineWizardRoles(registryWithGeneral).filter((role) => role === 'general').length,
    1,
    'general is never duplicated when the registry already lists it',
  )

  // Wizard copy states the solo self-review trade-off plainly, in plain
  // user-facing language — "soul"/"soulless" is internal vocabulary and must
  // never reach this surface.
  const generalSummary = getSprintEngineWizardRoleSummary('general')
  assert.match(generalSummary, /self-review/iu, 'general summary names the self-review trade-off')
  assert.doesNotMatch(generalSummary, /soul/iu, 'general summary avoids internal soul/soulless vocabulary')
}

// Planning-role floor: a roster must keep at least one planning-capable agent
// (architect or general), but the two trade places freely.
{
  assert.equal(sprintEngineRosterHasPlanningRole({ architect: 1 }), true, 'architect satisfies the planner requirement')
  assert.equal(sprintEngineRosterHasPlanningRole({ general: 2 }), true, 'general satisfies the planner requirement')
  assert.equal(sprintEngineRosterHasPlanningRole({ developer: 3 }), false, 'a roster of only workers has no planner')
  assert.equal(sprintEngineRosterHasPlanningRole({}), false, 'an empty roster has no planner')

  // Architect is the sole planner -> cannot drop below 1.
  assert.equal(sprintEngineRosterRoleFloor('architect', { architect: 1 }), 1, 'sole architect floors at 1')
  // Once a general is staffed, architect can drop to 0 (and vice versa).
  assert.equal(sprintEngineRosterRoleFloor('architect', { architect: 1, general: 1 }), 0, 'architect frees up when a general is staffed')
  assert.equal(sprintEngineRosterRoleFloor('general', { architect: 1, general: 1 }), 0, 'general frees up when an architect is staffed')
  // Sole general -> cannot drop below 1; general-only roster is valid.
  assert.equal(sprintEngineRosterRoleFloor('general', { general: 1 }), 1, 'sole general floors at 1')
  // Non-planning roles always floor at 0.
  assert.equal(sprintEngineRosterRoleFloor('developer', { architect: 1 }), 0, 'worker roles always floor at 0')
}

// ---------------------------------------------------------------------------
// Sprint Engine plan review / spawn prompt builders (extracted utility)
// ---------------------------------------------------------------------------

// Recovery prompt: points at the canonical CLI, no statePath/workspaceRoot.
{
  const prompt = buildSprintEngineRecoveryAuditPrompt()
  assert.ok(prompt.includes('sprintengine recover'), 'recovery prompt names the CLI verb')
  assert.equal(prompt.includes('statePath'), false, 'recovery prompt must not include statePath')
  assert.equal(prompt.includes('workspaceRoot'), false, 'recovery prompt must not include workspaceRoot')
}

// Plan review prompt: role + agent id are interpolated, no routing fields.
{
  const prompt = buildSprintEnginePlanReviewStartupPrompt('frontend', 'frontend-1')
  assert.ok(prompt.includes('--role frontend'), 'role flag present')
  assert.ok(prompt.includes('--id frontend-1'), 'agent id flag present')
  assert.equal(prompt.includes('statePath'), false)
  assert.equal(prompt.includes('workspaceRoot'), false)
}

// Address-plan-reviews prompt: architect actor, no routing fields.
{
  const prompt = buildSprintEngineAddressPlanReviewsPrompt()
  assert.ok(prompt.includes('--actor architect'), 'architect actor selected')
  assert.equal(prompt.includes('statePath'), false)
  assert.equal(prompt.includes('workspaceRoot'), false)
}

// Plan-revision prompt for a user-enabled role: bundled label and registry
// label both flow, and no deleted roster-membership tool is ever named (the
// role is enabled via the app-owned `roster enable` before the prompt fires).
{
  const bundled = buildSprintEnginePlanRevisionForNewMemberPrompt({
    role: 'frontend',
    agentId: 'frontend-1',
    teamSlug: 'team-x',
  })
  assert.ok(bundled.includes('Frontend Engineer'), 'bundled role label used')
  assert.ok(bundled.includes('team-x'), 'team slug interpolated')
  assert.ok(bundled.includes('configuredRoles'), 'prompt states the role is already enabled')
  assert.equal(bundled.includes('roster add'), false, 'deleted roster-membership tool never named')
  assert.equal(bundled.includes('statePath'), false)
  assert.equal(bundled.includes('workspaceRoot'), false)

  const registry: SprintEngineRoleRegistry = buildSprintEngineRoleRegistry({
    roles: [
      { id: 'marketer', label: 'Brand Marketer', aliases: [], source: { layer: 'workspace' } },
    ],
  })
  const custom = buildSprintEnginePlanRevisionForNewMemberPrompt({
    role: 'marketer',
    agentId: 'marketer-1',
    teamSlug: 'team-y',
    registry,
  })
  assert.ok(custom.includes('Brand Marketer'), 'registry label flows into custom-role prompt')
  assert.ok(custom.includes('(`marketer`)'), 'role id still emitted verbatim')
}

// New-role gate: the architect is only nudged when the added role is not
// already covered by the roster or a pending spawn. Reinforcing an existing
// role must stay quiet so it does not churn the plan.
{
  const roster = [
    { id: 'architect-1', label: 'Architect', role: 'architect' },
    { id: 'developer-1', label: 'Developer', role: 'developer' },
    { id: 'tester-1', label: 'Tester', role: 'tester' },
  ]

  assert.equal(
    isNewSprintEngineRoleForRun({ role: 'tester', roster }),
    false,
    'adding another tester is reinforcement, not a new role',
  )
  assert.equal(
    isNewSprintEngineRoleForRun({ role: 'security', roster }),
    true,
    'a role absent from the roster is new to the run',
  )
  assert.equal(
    isNewSprintEngineRoleForRun({ role: 'security', roster, pendingRoles: ['security'] }),
    false,
    'a role already queued as a pending spawn is not new',
  )
  assert.equal(
    isNewSprintEngineRoleForRun({ role: 'frontend', roster, pendingRoles: ['security'] }),
    true,
    'unrelated pending spawns do not suppress a genuinely new role',
  )
}

// ---------------------------------------------------------------------------
// Agent inspector aggregation helpers
// ---------------------------------------------------------------------------

// Removed: gate-attempt normalization, gate-attempt visual-state, and
// getSprintEngineTasksReviewedByAgent tests exercised deleted quality-gate
// machinery (MC-1542 single-owner tasks — quality gates and their attempts no
// longer exist).

// getSprintEngineTasksWorkedOnByAgent collects every task where the agent
// appears as an activity actor, including tasks now in `done` (covering the
// ownerAgentId-cleared regression).
{
  const tasks: SprintEngineTask[] = [
    {
      id: 'T1',
      title: 'Completed',
      description: '',
      role: 'developer',
      status: 'done',
      ownerAgentId: null,
      dependsOn: [],
      ownedPaths: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
      notes: [],
      comments: [],
      startedAt: null,
      completedAt: null,
      activity: [
        {
          id: 'A1',
          timestamp: '2026-05-27T07:22:00Z',
          type: 'claim',
          actor: 'developer-1',
          message: '',
        },
        {
          id: 'A2',
          timestamp: '2026-05-27T07:24:00Z',
          type: 'evidence',
          actor: 'developer-1',
          message: '',
        },
      ],
    },
    {
      id: 'T2',
      title: 'Touched by someone else',
      description: '',
      role: 'developer',
      status: 'in_progress',
      ownerAgentId: 'developer-2',
      dependsOn: [],
      ownedPaths: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
      notes: [],
      comments: [],
      startedAt: null,
      completedAt: null,
      activity: [
        {
          id: 'A1',
          timestamp: '2026-05-27T08:00:00Z',
          type: 'claim',
          actor: 'developer-2',
          message: '',
        },
      ],
    },
  ]
  const worked = getSprintEngineTasksWorkedOnByAgent('developer-1', tasks)
  assert.equal(worked.length, 1, 'finds T1 even though ownerAgentId is null')
  assert.equal(worked[0]?.task.id, 'T1')
  assert.equal(worked[0]?.latestActivityAt, '2026-05-27T07:24:00Z', 'tracks the latest stamp')

  const empty = getSprintEngineTasksWorkedOnByAgent('developer-3', tasks)
  assert.equal(empty.length, 0, 'agent with no activity returns nothing')
}

// getSprintEngineAgentActivityDescending decorates entries with task context
// and sorts newest-first.
{
  const tasks: SprintEngineTask[] = [
    {
      id: 'T1',
      title: 'First',
      description: '',
      role: 'developer',
      status: 'done',
      ownerAgentId: null,
      dependsOn: [],
      ownedPaths: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
      notes: [],
      comments: [],
      startedAt: null,
      completedAt: null,
      activity: [
        { id: 'A1', timestamp: '2026-05-27T07:00:00Z', type: 'claim', actor: 'developer-1', message: '' },
        { id: 'A2', timestamp: '2026-05-27T08:00:00Z', type: 'evidence', actor: 'developer-1', message: '' },
        { id: 'A3', timestamp: '2026-05-27T09:00:00Z', type: 'claim', actor: 'developer-2', message: '' },
      ],
    },
    {
      id: 'T2',
      title: 'Second',
      description: '',
      role: 'developer',
      status: 'review',
      ownerAgentId: null,
      dependsOn: [],
      ownedPaths: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
      notes: [],
      comments: [],
      startedAt: null,
      completedAt: null,
      activity: [
        { id: 'A1', timestamp: '2026-05-27T10:00:00Z', type: 'comment', actor: 'developer-1', message: 'hi' },
      ],
    },
  ]
  const entries = getSprintEngineAgentActivityDescending('developer-1', tasks)
  assert.equal(entries.length, 3, 'collects only developer-1 entries')
  assert.deepEqual(
    entries.map((e) => e.entry.id),
    ['A1', 'A2', 'A1'],
    'newest-first ordering',
  )
  assert.deepEqual(
    entries.map((e) => e.taskId),
    ['T2', 'T1', 'T1'],
    'decorated with task id',
  )
  assert.equal(entries[0]?.taskTitle, 'Second', 'task title carried through')
}

// getSprintEngineBoardRunPhase resolves the board hero phase from task
// completion and active runtime agent states.
{
  const emptyState = { tasks: [] as SprintEngineTask[] }
  assert.equal(
    getSprintEngineBoardRunPhase(emptyState, []),
    'Planning',
    'no tasks, no runtime → Planning',
  )

  const taskedState = {
    tasks: [
      { ...({} as SprintEngineTask), status: 'todo' as const },
      { ...({} as SprintEngineTask), status: 'review' as const },
    ],
  }
  assert.equal(
    getSprintEngineBoardRunPhase(taskedState, []),
    'Tasked',
    'tasks present but no runtime activity → Tasked',
  )

  assert.equal(
    getSprintEngineBoardRunPhase(taskedState, [
      { agentId: 'developer-1', role: 'developer' as const, status: 'running' },
    ]),
    'Running',
    'any running agent → Running',
  )

  assert.equal(
    getSprintEngineBoardRunPhase(taskedState, [
      { agentId: 'developer-1', role: 'developer' as const, status: 'needs_input' },
    ]),
    'Running',
    'needs_input agent counts as active → Running',
  )

  const completeState = {
    tasks: [
      { ...({} as SprintEngineTask), status: 'done' as const },
      { ...({} as SprintEngineTask), status: 'done' as const },
    ],
  }
  assert.equal(
    getSprintEngineBoardRunPhase(completeState, [
      { agentId: 'developer-1', role: 'developer' as const, status: 'running' },
    ]),
    'Complete',
    'all tasks done overrides runtime state → Complete',
  )
}

// getSprintEngineTaskOwnerLabel: owner -> roster label, done -> role label,
// otherwise -> sentinel.
{
  const rosterById = {
    'developer-1': { label: 'Dev One' },
    'frontend-2': { label: 'Front Two' },
  }
  const ownedTask = { ownerAgentId: 'developer-1', role: 'developer' as const, status: 'in_progress' as const }
  assert.equal(getSprintEngineTaskOwnerLabel(ownedTask, rosterById), 'Dev One')

  const ownedUnknown = { ownerAgentId: 'ghost-9', role: 'developer' as const, status: 'in_progress' as const }
  assert.equal(
    getSprintEngineTaskOwnerLabel(ownedUnknown, rosterById),
    'ghost-9',
    'unknown roster id falls back to the agent id',
  )

  const doneUnowned = { ownerAgentId: null, role: 'frontend' as const, status: 'done' as const }
  assert.equal(
    getSprintEngineTaskOwnerLabel(doneUnowned, rosterById),
    getSprintEngineRoleLabel('frontend'),
    'done + no owner → role label',
  )

  // Detached owner: a review task resolves to the last implementer.
  for (const status of ['review'] as const) {
    const detached = {
      ownerAgentId: null,
      lastImplementedByAgentId: 'developer-1',
      role: 'developer' as const,
      status,
    }
    assert.equal(
      getSprintEngineTaskOwnerLabel(detached, rosterById),
      'Dev One',
      `detached ${status} task resolves to the last implementer`,
    )
  }

  // Reassignment: when a different worker reclaims the rework, the active owner
  // takes precedence over the prior implementer (worker retires → another picks
  // up the task and is shown as the owner).
  const reassigned = {
    ownerAgentId: 'frontend-2',
    lastImplementedByAgentId: 'developer-1',
    role: 'developer' as const,
    status: 'in_progress' as const,
  }
  assert.equal(
    getSprintEngineTaskOwnerLabel(reassigned, rosterById),
    'Front Two',
    'active claim outranks the prior implementer after reassignment',
  )

  const inFlightUnowned = { ownerAgentId: null, role: 'developer' as const, status: 'review' as const }
  assert.equal(
    getSprintEngineTaskOwnerLabel(inFlightUnowned, rosterById),
    'No active worker',
    'in-flight + never implemented → sentinel',
  )
}

// getSprintEngineTaskImplementerTimeline: one row per worker, active first,
// then by most-recent pass; each worker keeps their own tick count.
{
  type TimelineTask = Parameters<typeof getSprintEngineTaskImplementerTimeline>[0]
  const runtime = [
    { agentId: 'developer-1', label: 'Dev One', role: 'developer' as const, status: 'running' },
    { agentId: 'frontend-2', label: 'Front Two', role: 'frontend' as const, status: 'running' },
  ]

  // Empty: a task nobody has implemented yet.
  assert.deepEqual(
    getSprintEngineTaskImplementerTimeline(
      { comments: [], ownerAgentId: null, lastImplementedByAgentId: null, role: 'developer' } as TimelineTask,
      runtime,
    ),
    [],
    'no comments and no owner → empty timeline',
  )

  // Single active worker mid-rework: one row, active, with their own passes.
  {
    const single = getSprintEngineTaskImplementerTimeline(
      {
        role: 'developer',
        ownerAgentId: 'developer-1',
        lastImplementedByAgentId: 'developer-1',
        comments: [
          { type: 'implementation_summary', authorAgentId: 'developer-1', createdAt: '2026-05-16T19:50:00Z' },
          { type: 'review_feedback', authorAgentId: 'security-1', createdAt: '2026-05-16T19:52:00Z' },
        ],
      } as TimelineTask,
      runtime,
    )
    assert.equal(single.length, 1, 'feedback comments do not create rows')
    assert.equal(single[0]?.agentId, 'developer-1')
    assert.equal(single[0]?.passCount, 1, 'counts only implementation comments')
    assert.equal(single[0]?.isActive, true)
    assert.equal(single[0]?.runtimeStatus, 'running')
    assert.equal(single[0]?.label, 'Dev One')
  }

  // Reassignment: Dev One implemented once, Front Two reclaimed and is active.
  // Front Two sorts first; each keeps their own tick count.
  {
    const reassigned = getSprintEngineTaskImplementerTimeline(
      {
        role: 'developer',
        ownerAgentId: 'frontend-2',
        lastImplementedByAgentId: 'developer-1',
        comments: [
          { type: 'implementation_summary', authorAgentId: 'developer-1', createdAt: '2026-05-16T19:50:00Z' },
        ],
      } as TimelineTask,
      runtime,
    )
    assert.equal(reassigned.length, 2)
    assert.equal(reassigned[0]?.agentId, 'frontend-2', 'active worker sorts first')
    assert.equal(reassigned[0]?.isActive, true)
    assert.equal(reassigned[0]?.passCount, 0, 'new owner has no passes yet')
    assert.equal(reassigned[1]?.agentId, 'developer-1')
    assert.equal(reassigned[1]?.passCount, 1, 'prior worker keeps their own tick')
    assert.equal(reassigned[1]?.isActive, false)
    assert.equal(reassigned[1]?.runtimeStatus, null, 'runtime status only resolved for active row')
  }

  // Detached (in review): no active owner, ordered by most-recent pass desc.
  {
    const detached = getSprintEngineTaskImplementerTimeline(
      {
        role: 'developer',
        ownerAgentId: null,
        lastImplementedByAgentId: 'frontend-2',
        comments: [
          { type: 'implementation_summary', authorAgentId: 'developer-1', createdAt: '2026-05-16T19:50:00Z' },
          { type: 'implementation_response', authorAgentId: 'frontend-2', createdAt: '2026-05-16T20:10:00Z' },
        ],
      } as TimelineTask,
      runtime,
    )
    assert.equal(detached[0]?.agentId, 'frontend-2', 'most recent pass on top')
    assert.equal(detached.every((entry) => entry.isActive === false), true, 'no active row when detached')
    assert.equal(detached[0]?.lastActivityAt, '2026-05-16T20:10:00Z')
  }

  // Author falls back to `actor` when authorAgentId is absent; lastImplementedBy
  // with no matching comment still surfaces a row.
  {
    const fallback = getSprintEngineTaskImplementerTimeline(
      {
        role: 'developer',
        ownerAgentId: null,
        lastImplementedByAgentId: 'ghost-9',
        comments: [
          { type: 'implementation_summary', actor: 'developer-1', createdAt: '2026-05-16T19:50:00Z' },
        ],
      } as TimelineTask,
      runtime,
    )
    const ids = fallback.map((entry) => entry.agentId).sort()
    assert.deepEqual(ids, ['developer-1', 'ghost-9'], 'actor fallback + seeded last implementer')
    const ghost = fallback.find((entry) => entry.agentId === 'ghost-9')
    assert.equal(ghost?.label, 'ghost-9', 'unknown agent falls back to its id as label')
    assert.equal(ghost?.passCount, 0)
  }
}

// lastImplementedByAgentId survives projection normalization so a detached
// in-review task can still resolve its owning worker.
{
  const detachedProjection = fakeProjection({
    tasks: [
      {
        id: 'T1',
        title: 'In review task',
        description: '',
        role: 'developer',
        status: 'review',
        folderStatus: 'review',
        stateStatus: 'review',
        boardColumn: 'review',
        ownedPaths: [],
        dependsOn: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        notes: [],
        comments: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        activity: [],
        startedAt: '2026-05-16T19:50:00Z',
        completedAt: null,
        ownerAgentId: null,
        lastImplementedByAgentId: 'developer-1',
      },
    ],
  })
  const detachedState = normalizeSprintEngineProjection(detachedProjection, 'fallback-name')
  assert.ok(detachedState, 'projection normalizes')
  assert.equal(
    detachedState?.tasks[0]?.lastImplementedByAgentId,
    'developer-1',
    'detached owner id is preserved through normalization',
  )
}

// getSprintEngineKanbanEmptyMessage covers every board column (MC-1542: the
// changes_requested/testing/product columns were deleted with quality gates).
{
  assert.match(getSprintEngineKanbanEmptyMessage('ready'), /No ready work/)
  assert.match(getSprintEngineKanbanEmptyMessage('in_progress'), /actively claiming/)
  assert.match(getSprintEngineKanbanEmptyMessage('review'), /reviewing their own work/)
  assert.match(getSprintEngineKanbanEmptyMessage('needs_input'), /No blocked tasks/)
  assert.match(getSprintEngineKanbanEmptyMessage('done'), /Completed work/)
  assert.match(getSprintEngineKanbanEmptyMessage('todo'), /waiting on dependencies/)
  assert.match(getSprintEngineKanbanEmptyMessage('canceled'), /Canceled tasks/)
}

// bracketedTerminalPaste wraps text in xterm bracketed-paste markers and
// normalizes CRLF newlines.
{
  const result = bracketedTerminalPaste('line1\r\nline2\nline3')
  assert.equal(result.startsWith('\x1b[200~'), true, 'starts with bracket-open')
  assert.equal(result.endsWith('\x1b[201~\r'), true, 'ends with bracket-close + CR')
  assert.ok(!result.includes('\r\n'), 'CRLF normalized to LF inside the payload')
}

// isPathInsideOrEqual handles equality, nesting, slash normalization, and
// drive-letter casing on Windows-style paths.
{
  assert.equal(isPathInsideOrEqual('/team', '/team'), true, 'equal paths count as inside')
  assert.equal(isPathInsideOrEqual('/team', '/team/sub/file.md'), true, 'nested under parent')
  assert.equal(isPathInsideOrEqual('/team', '/teamx/file.md'), false, 'sibling with shared prefix is not inside')
  assert.equal(isPathInsideOrEqual('/team', '/team/'), true, 'trailing slash on parent is normalized')
  assert.equal(isPathInsideOrEqual('C:\\Team', 'c:/team/sub'), true, 'mixed slashes and drive-letter casing match')
  assert.equal(isPathInsideOrEqual('/team', '/other'), false, 'unrelated path is not inside')
}

// resolveSprintEngineArtifactEditorPath: clamps to the team directory and
// rejects remote URLs, traversal, and absolute paths outside the team root.
{
  const helpers = {
    parentPath: (p: string) => {
      const idx = p.replace(/\\/g, '/').lastIndexOf('/')
      return idx <= 0 ? '/' : p.slice(0, idx)
    },
    joinFilePath: (a: string, b: string) => `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`,
    isAbsoluteFilePath: (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p),
  }
  // statePath is `<workspaceRoot>/.multi-code/sprintengine/<team>/run.yaml`.
  // teamDirectory = `<workspaceRoot>/.multi-code/sprintengine/<team>`.
  // workspaceRoot = parentPath x 3 of teamDirectory.
  const statePath = '/root/.multi-code/sprintengine/team-1/run.yaml'
  const teamDir = '/root/.multi-code/sprintengine/team-1'

  // Relative artifact path resolves under team directory.
  const resolved = resolveSprintEngineArtifactEditorPath(statePath, 'designs/mockup.html', helpers)
  assert.equal(resolved, `${teamDir}/designs/mockup.html`)

  // Empty input throws.
  assert.throws(() => resolveSprintEngineArtifactEditorPath(statePath, '   ', helpers), /required/i)

  // Remote URLs throw.
  assert.throws(
    () => resolveSprintEngineArtifactEditorPath(statePath, 'https://example.com/a.md', helpers),
    /Remote artifact/,
  )

  // Parent-relative traversal throws.
  assert.throws(
    () => resolveSprintEngineArtifactEditorPath(statePath, '../escape.md', helpers),
    /must stay inside/,
  )

  // Absolute path outside team directory throws.
  assert.throws(
    () => resolveSprintEngineArtifactEditorPath(statePath, '/etc/passwd', helpers),
    /must stay inside/,
  )

  // Schemed non-file paths throw (e.g. mailto:, weird drive-letter-looking strings).
  assert.throws(
    () => resolveSprintEngineArtifactEditorPath(statePath, 'mailto:foo@bar', helpers),
    /Only workspace artifact file paths/,
  )
}

// Regression (GolfGPS T5): an artifact whose kind this build does not know —
// e.g. an agent-invented "frontend_design" stored through the MCP path —
// must survive normalization so the needs_input review surface can show it
// and the user can approve it manually. It must never be auto-approvable.
{
  const unknownKindProjection = fakeProjection({
    artifacts: [
      {
        id: 'A3',
        kind: 'frontend_design',
        title: 'UI design notes',
        path: 'design/ui-design-notes.md',
        status: 'ready_for_review',
        createdBy: 'frontend',
        taskId: 'T1',
        fingerprint: 'abc',
        reviewHistory: [],
        recommendedTasks: [],
        createdAt: '2026-06-10T23:28:12Z',
        updatedAt: '2026-06-10T23:28:19Z',
      },
    ],
  })
  const unknownKindState = normalizeSprintEngineProjection(unknownKindProjection, 'fallback-name')
  assert.ok(unknownKindState, 'projection with unknown artifact kind should normalize')
  assert.equal(unknownKindState!.artifacts.length, 1, 'unknown-kind artifact is retained, not silently dropped')
  assert.equal(unknownKindState!.artifacts[0]!.kind, 'frontend_design')
  assert.equal(
    getReviewableSprintEngineArtifacts(unknownKindState!.artifacts).length,
    1,
    'unknown-kind artifact stays on review surfaces for manual approval'
  )
  const eligibility = getSprintEngineArtifactAutoApprovalEligibility(unknownKindState!.artifacts[0]!)
  assert.equal(eligibility.eligible, false, 'unknown-kind artifact is not auto-approvable')
  assert.equal(eligibility.reason, 'Unknown artifact type.')
  assert.equal(sprintEngineArtifactKindLabel('frontend_design'), 'frontend_design', 'unknown kind labels fall back to the raw value')
  assert.equal(sprintEngineArtifactKindLabel('design_notes'), 'Design Notes')
}

// shouldResumeRecordedRosterSession — B4 mid-run re-open resume (T6 tester rework)
{
  const task = (id: string, status: string): SprintEngineTask => ({ id, status } as unknown as SprintEngineTask)
  const ownedBy = (lastOwnedTaskId: string | null): SprintEngineState['sprintEngineAgents'][string] =>
    ({ lastOwnedTaskId } as unknown as SprintEngineState['sprintEngineAgents'][string])
  const state = (
    tasks: SprintEngineTask[],
    agents: Record<string, SprintEngineState['sprintEngineAgents'][string]>,
  ): SprintEngineState => ({ tasks, sprintEngineAgents: agents } as unknown as SprintEngineState)

  // 1. Whole run complete → resume regardless of the agent's own task.
  assert.equal(
    shouldResumeRecordedRosterSession({
      sprintEngineState: state([task('T1', 'done')], {}),
      autoRuntimeState: undefined,
      agentId: 'developer-1',
    }),
    true,
    'a completed run resumes any recorded roster session',
  )

  // 2. Mid-run: the departed worker's own task is done → resume (B4 regression).
  assert.equal(
    shouldResumeRecordedRosterSession({
      sprintEngineState: state(
        [task('T1', 'done'), task('T2', 'in_progress')],
        { 'developer-1': ownedBy('T1') },
      ),
      autoRuntimeState: undefined,
      agentId: 'developer-1',
    }),
    true,
    'mid-run departed worker whose own task is done resumes its recorded session',
  )

  // 3. Mid-run: the owner's task is still in its verdict/rework window → fresh.
  assert.equal(
    shouldResumeRecordedRosterSession({
      sprintEngineState: state(
        [task('T1', 'review'), task('T2', 'in_progress')],
        { 'developer-1': ownedBy('T1') },
      ),
      autoRuntimeState: undefined,
      agentId: 'developer-1',
    }),
    false,
    'a worker still in its rework window is not treated as departed',
  )

  // 4. Stale prior-run entry: the id has not re-owned a done task this run → fresh.
  assert.equal(
    shouldResumeRecordedRosterSession({
      sprintEngineState: state([task('T1', 'in_progress')], { 'developer-1': ownedBy(null) }),
      autoRuntimeState: undefined,
      agentId: 'developer-1',
    }),
    false,
    'a recorded id with no done owned task this run cannot hijack a fresh spawn',
  )

  // 4b. Agent absent from this run's roster entirely → fresh.
  assert.equal(
    shouldResumeRecordedRosterSession({
      sprintEngineState: state([task('T1', 'in_progress')], {}),
      autoRuntimeState: undefined,
      agentId: 'developer-1',
    }),
    false,
    'an id absent from this run\'s roster is not resumed',
  )

  // 5. Cold reopen (projection not hydrated) but persisted lifecycle complete → resume.
  assert.equal(
    shouldResumeRecordedRosterSession({ sprintEngineState: null, autoRuntimeState: 'complete', agentId: 'developer-1' }),
    true,
    'cold reopen of a complete run resumes from the persisted lifecycle state',
  )

  // 6. Cold reopen, lifecycle not complete → fresh.
  assert.equal(
    shouldResumeRecordedRosterSession({ sprintEngineState: null, autoRuntimeState: undefined, agentId: 'developer-1' }),
    false,
    'cold reopen without a complete lifecycle spawns fresh',
  )
}

// willResumeRecordedRosterSession — the shared Resume-vs-Spawn gate (T12). Must
// match spawnAgent's real resume gate: lifecycle wants resume AND a recorded
// session with a cliSessionId exists for a resume-capable CLI. This is the gate
// the roster label and spawnAgent both read, so they can never drift.
{
  const task = (id: string, status: string): SprintEngineTask => ({ id, status } as unknown as SprintEngineTask)
  const ownedBy = (lastOwnedTaskId: string | null): SprintEngineState['sprintEngineAgents'][string] =>
    ({ lastOwnedTaskId } as unknown as SprintEngineState['sprintEngineAgents'][string])
  const state = (
    tasks: SprintEngineTask[],
    agents: Record<string, SprintEngineState['sprintEngineAgents'][string]>,
  ): SprintEngineState => ({ tasks, sprintEngineAgents: agents } as unknown as SprintEngineState)
  const session = (cli: AgentCli, cliSessionId: string): SprintEngineRosterSession =>
    ({ cli, cliSessionId, recordedAt: 0 } as SprintEngineRosterSession)

  const completeRun = state([task('T1', 'done')], {})

  // Resume capability is now resolved from the manifest by the caller and passed
  // in; these mirror the bundled values (claude-code/codex resume, unknown off).
  const claudeCaps = { resumeSession: true, sessionIdFromCaller: true }
  const codexCaps = { resumeSession: true, sessionIdFromCaller: false }

  // 1. Run wants resume + recorded resume-capable session → resume.
  assert.equal(
    willResumeRecordedRosterSession({
      sprintEngineState: completeRun,
      autoRuntimeState: undefined,
      recorded: session('claude-code', 'sess-1'),
      agentId: 'developer-1',
      resumeCapabilities: claudeCaps,
    }),
    true,
    'a completed run with a recorded resume-capable session resumes',
  )

  // 2. Run wants resume but NO recorded session → fresh (post-completion
  //    never-run id): the exact inverse-mislabel the shared gate fixes.
  assert.equal(
    willResumeRecordedRosterSession({
      sprintEngineState: completeRun,
      autoRuntimeState: undefined,
      recorded: undefined,
      agentId: 'developer-1',
      resumeCapabilities: undefined,
    }),
    false,
    'a post-completion id with no recorded session spawns fresh, not Resume',
  )

  // 3. Recorded session but a resume-incapable CLI (no manifest caps) → fresh.
  assert.equal(
    willResumeRecordedRosterSession({
      sprintEngineState: completeRun,
      autoRuntimeState: undefined,
      recorded: session('gemini', 'sess-1'),
      agentId: 'developer-1',
      resumeCapabilities: undefined,
    }),
    false,
    'a resume-incapable recorded CLI spawns fresh',
  )

  // 4. Recorded session missing its cliSessionId → fresh.
  assert.equal(
    willResumeRecordedRosterSession({
      sprintEngineState: completeRun,
      autoRuntimeState: undefined,
      recorded: { cli: 'claude-code', cliSessionId: '', recordedAt: 0 } as SprintEngineRosterSession,
      agentId: 'developer-1',
      resumeCapabilities: claudeCaps,
    }),
    false,
    'a recorded session without a cliSessionId spawns fresh',
  )

  // 5. Resumable session present but the lifecycle does not want resume (owner's
  //    task still open) → fresh: the session gate cannot override shouldResume.
  assert.equal(
    willResumeRecordedRosterSession({
      sprintEngineState: state([task('T1', 'in_progress')], { 'developer-1': ownedBy(null) }),
      autoRuntimeState: undefined,
      recorded: session('claude-code', 'sess-1'),
      agentId: 'developer-1',
      resumeCapabilities: claudeCaps,
    }),
    false,
    'a recorded session does not resume while the lifecycle wants a fresh spawn',
  )

  // 6. Mid-run departed worker (own done task) + resumable session → resume.
  assert.equal(
    willResumeRecordedRosterSession({
      sprintEngineState: state(
        [task('T1', 'done'), task('T2', 'in_progress')],
        { 'developer-1': ownedBy('T1') },
      ),
      autoRuntimeState: undefined,
      recorded: session('codex', 'sess-1'),
      agentId: 'developer-1',
      resumeCapabilities: codexCaps,
    }),
    true,
    'a mid-run departed worker with a resumable session resumes',
  )
}

// eslint-disable-next-line no-console
console.log('sprintengine.test.ts: ok')
