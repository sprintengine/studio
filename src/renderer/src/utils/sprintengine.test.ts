import assert from 'node:assert/strict'
import {
  formatSprintEngineLockAge,
  getActiveSprintEngineLifecyclePhases,
  getLatestSprintEngineTaskComment,
  getOpenSprintEngineFeedbackComments,
  getOpenSprintEngineFeedbackFindings,
  getOpenSprintEngineFeedbackIssues,
  getOpenSprintEngineQualityGates,
  getSprintEngineTaskActivityDescending,
  getSprintEngineTaskBoardColumn,
  getSprintEngineTaskQualityGates,
  getSprintEngineVisibleBoardColumns,
  isSprintEngineTaskLaunchable,
  normalizeSprintEngineProjection,
} from './sprintengine'
import type { SprintEngineTask } from '../types/workspace'

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
      migration: {
        source: 'state.yaml',
        createdAt: '2026-05-16T19:51:02Z',
        migratedAt: '2026-05-16T20:00:14Z',
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
        title: 'Rework task',
        description: '',
        role: 'developer',
        status: 'changes_requested',
        folderStatus: 'changes_requested',
        stateStatus: 'changes_requested',
        boardColumn: 'changes_requested',
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
assert.equal(state!.migration?.source, 'state.yaml')
assert.equal(state!.tasks.length, 3)

const doneTask = state!.tasks.find((task) => task.id === 'T1')!
assert.equal(doneTask.boardColumn, 'done')
assert.equal(doneTask.folderStatus, 'done')
assert.equal(doneTask.stateStatus, 'done')
assert.equal(doneTask.status, 'done')
assert.equal(doneTask.activity?.length, 2)

const readyTask = state!.tasks.find((task) => task.id === 'T2')!
assert.equal(readyTask.boardColumn, 'ready')
assert.equal(readyTask.folderStatus, 'ready')
assert.equal(readyTask.stateStatus, 'todo')
// Semantic status mirrors stateStatus when present, not the board column.
assert.equal(readyTask.status, 'todo')

const changesRequestedTask = state!.tasks.find((task) => task.id === 'T3')!
assert.equal(changesRequestedTask.boardColumn, 'changes_requested')
assert.equal(changesRequestedTask.folderStatus, 'changes_requested')
assert.equal(changesRequestedTask.stateStatus, 'changes_requested')
assert.equal(changesRequestedTask.status, 'changes_requested')

// getSprintEngineTaskBoardColumn prefers the projection's authoritative boardColumn.
assert.equal(getSprintEngineTaskBoardColumn(readyTask, state!.tasks), 'ready')
assert.equal(getSprintEngineTaskBoardColumn(changesRequestedTask, state!.tasks), 'changes_requested')
assert.equal(getSprintEngineTaskBoardColumn(doneTask, state!.tasks), 'done')
assert.equal(isSprintEngineTaskLaunchable(readyTask, state!), true)
assert.equal(isSprintEngineTaskLaunchable(changesRequestedTask, state!), true)
assert.equal(isSprintEngineTaskLaunchable(doneTask, state!), false)

// Legacy task without a boardColumn falls back to the computed column.
const legacyTask: SprintEngineTask = {
  id: 'L1',
  title: 'Legacy',
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
assert.equal(getSprintEngineTaskBoardColumn(legacyTask, state!.tasks), 'ready')

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

// --- Quality gate projection normalization ---

const gatedProjection = fakeProjection({
  run: {
    id: 'run-id',
    name: 'Sample Run',
    goal: 'Test goal',
    status: 'executing',
    rosterConfigured: true,
    updatedAt: '2026-05-16T20:00:00Z',
    qualityPolicy: {
      enabled: true,
      rosterDriven: true,
      lifecyclePhases: ['review', 'testing'],
      gates: {
        code_reviewer: { phase: 'review', role: 'code_reviewer', required: true, focus: 'integration risk' },
        tester: { phase: 'testing', role: 'tester', required: true },
      },
    },
  },
  tasks: [
    {
      id: 'G1',
      title: 'Gated implementation',
      description: 'Task waiting on review gate',
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
          actor: 'code_reviewer',
          authorAgentId: 'code_reviewer',
          authorRole: 'code_reviewer',
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
          actor: 'code_reviewer',
          authorAgentId: 'code_reviewer',
          authorRole: 'code_reviewer',
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
          actor: 'code_reviewer',
          authorAgentId: 'code_reviewer',
          authorRole: 'code_reviewer',
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
      qualityGates: [
        {
          id: 'code_reviewer',
          phase: 'review',
          role: 'code_reviewer',
          status: 'changes_requested',
          required: true,
          allowSelfReview: false,
          focus: 'integration risk',
          attempts: [
            {
              id: 'A1',
              status: 'changes_requested',
              actor: 'code_reviewer',
              verdict: 'changes_requested',
              startedAt: '2026-05-16T19:50:00Z',
              completedAt: '2026-05-16T19:55:00Z',
            },
          ],
        },
        {
          id: 'tester',
          phase: 'testing',
          role: 'tester',
          status: 'pending',
          required: true,
          allowSelfReview: false,
          attempts: [],
        },
      ],
      qualityGateSummary: {
        total: 2,
        required: 2,
        openRequired: 2,
        byPhase: { review: 1, testing: 1 },
        byStatus: { changes_requested: 1, pending: 1 },
      },
      recordedArtifacts: [
        {
          id: 'R1',
          kind: 'code_review',
          title: 'Code review pass 1',
          path: '.multi-code/sprintengine/run-id/reviews/code-review-1.md',
          gateId: 'code_reviewer',
          createdBy: 'code_reviewer',
          createdAt: '2026-05-16T19:55:00Z',
        },
      ],
    },
    {
      id: 'CR1',
      title: 'Rework after review',
      description: 'Rework after a code review verdict',
      role: 'developer',
      status: 'changes_requested',
      folderStatus: 'changes_requested',
      stateStatus: 'changes_requested',
      boardColumn: 'changes_requested',
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
      ownerAgentId: null,
    },
  ],
})

const gatedState = normalizeSprintEngineProjection(gatedProjection)
assert.ok(gatedState, 'gated projection should normalize')
assert.deepEqual(
  gatedState!.qualityPolicy?.lifecyclePhases,
  ['review', 'testing'],
  'qualityPolicy.lifecyclePhases passes through normalization'
)
assert.equal(gatedState!.qualityPolicy?.gates.code_reviewer?.focus, 'integration risk')

const gatedTask = gatedState!.tasks.find((task) => task.id === 'G1')!
assert.equal(gatedTask.boardColumn, 'review', 'review boardColumn round-trips')
assert.equal(gatedTask.status, 'in_progress', 'semantic stateStatus drives status while task lives in review folder')
assert.equal(getSprintEngineTaskBoardColumn(gatedTask, gatedState!.tasks), 'review')

const gates = getSprintEngineTaskQualityGates(gatedTask)
assert.equal(gates.length, 2)
assert.equal(gates[0].id, 'code_reviewer')
assert.equal(gates[0].status, 'changes_requested')
assert.equal(gates[0].attempts.length, 1)
assert.equal(gates[0].attempts[0].verdict, 'changes_requested')
assert.equal(getOpenSprintEngineQualityGates(gatedTask).length, 2, 'pending + changes_requested gates both count as open')

const latestSummary = getLatestSprintEngineTaskComment(gatedTask, 'implementation_summary')
assert.ok(latestSummary, 'implementation_summary surfaces via getLatestSprintEngineTaskComment')
assert.equal(latestSummary!.actor, 'developer-1')

const openFeedback = getOpenSprintEngineFeedbackComments(gatedTask)
assert.equal(openFeedback.length, 1)
assert.equal(openFeedback[0].type, 'review_feedback')
assert.equal(openFeedback[0].authorAgentId, 'code_reviewer')

assert.equal(gatedTask.recordedArtifacts?.length, 1)
assert.equal(gatedTask.recordedArtifacts?.[0]?.gateId, 'code_reviewer')

// changes_requested stays distinct from ready in the task graph + board projection.
const reworkTask = gatedState!.tasks.find((task) => task.id === 'CR1')!
assert.equal(reworkTask.status, 'changes_requested')
assert.equal(getSprintEngineTaskBoardColumn(reworkTask, gatedState!.tasks), 'changes_requested')
assert.equal(isSprintEngineTaskLaunchable(reworkTask, gatedState!), true, 'rework task is launchable')

// Lifecycle phase column visibility: review appears because the gated task lives in
// the review folder; testing appears because the policy declared it; product is
// hidden because neither policy nor any active task requires it.
const visiblePhases = getActiveSprintEngineLifecyclePhases(gatedState!)
assert.deepEqual(visiblePhases, ['review', 'testing'])
const visibleColumns = getSprintEngineVisibleBoardColumns(gatedState!).map((column) => column.key)
assert.deepEqual(
  visibleColumns,
  ['todo', 'ready', 'changes_requested', 'in_progress', 'review', 'testing', 'needs_input', 'done'],
)

// When neither policy nor tasks call for lifecycle phases, the board hides
// review/testing/product entirely.
const ungatedState = normalizeSprintEngineProjection(fakeProjection())
const ungatedVisibleColumns = getSprintEngineVisibleBoardColumns(ungatedState!).map((column) => column.key)
assert.deepEqual(
  ungatedVisibleColumns,
  ['todo', 'ready', 'changes_requested', 'in_progress', 'needs_input', 'done'],
)

// eslint-disable-next-line no-console
console.log('sprintengine.test.ts: ok')
