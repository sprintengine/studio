import assert from 'node:assert/strict'
import { getSprintEngineStartupCommandMode } from './agentPrompt'
import {
  applyUserDisabledSprintEngineRoleCounts,
  buildSprintEngineAgentRosterFromRuntimeAgents,
  buildSprintEngineRoleRegistry,
  formatSprintEngineLockAge,
  getActiveSprintEngineLifecyclePhases,
  getLatestSprintEngineTaskComment,
  getOpenSprintEngineFeedbackComments,
  getOpenSprintEngineFeedbackFindings,
  getOpenSprintEngineFeedbackIssues,
  getOpenSprintEngineQualityGates,
  getSprintEngineRoleAccent,
  getSprintEngineRoleGlyphKind,
  getSprintEngineRoleLabel,
  getSprintEngineTaskActivityDescending,
  getSprintEngineTaskBoardColumn,
  getSprintEngineTaskQualityGates,
  getSprintEngineVisibleBoardColumns,
  getUserDisabledSprintEngineRoleIds,
  humanizeSprintEngineRoleId,
  isBundledSprintEngineRole,
  isSprintEngineRoleId,
  isSprintEngineTaskLaunchable,
  normalizeSprintEngineProjection,
  orderSprintEngineRosterRoles,
  sprintEngineNeutralRoleAccent,
  sprintEngineRoleOrder,
} from './sprintengine'
import { taskGraphEdgeStyle, taskGraphEndEdgeStyle } from '../components/panels/sprintEngineTaskGraph'
import type { SprintEngineRoleRegistry, SprintEngineTask } from '../types/workspace'

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
assert.equal(state!.creation?.source, 'folder_store')
assert.equal(state!.tasks.length, 3)

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
  roster: {
    architect: { role: 'architect', status: 'idle', currentTaskId: null },
    code_reviewer: { role: 'code_reviewer', status: 'idle', currentTaskId: null },
    tester: { role: 'tester', status: 'idle', currentTaskId: null },
    'developer-1': { role: 'developer', status: 'running', currentTaskId: 'G1' },
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

const noProductRosterState = normalizeSprintEngineProjection(fakeProjection({
  run: {
    id: 'run-id',
    name: 'No Product Roster Run',
    goal: 'Test goal',
    status: 'executing',
    rosterConfigured: true,
    updatedAt: '2026-05-16T20:00:00Z',
    qualityPolicy: {
      enabled: true,
      rosterDriven: true,
      lifecyclePhases: ['review', 'testing', 'product'],
      gates: {
        architect: { phase: 'review', role: 'architect', required: true },
        code_reviewer: { phase: 'review', role: 'code_reviewer', required: true },
        spec_reviewer: { phase: 'review', role: 'spec_reviewer', required: true },
        tester: { phase: 'testing', role: 'tester', required: true },
        product: { phase: 'product', role: 'product', required: true },
      },
    },
  },
  roster: {
    architect: { role: 'architect', status: 'idle', currentTaskId: null },
    code_reviewer: { role: 'code_reviewer', status: 'idle', currentTaskId: null },
    spec_reviewer: { role: 'spec_reviewer', status: 'idle', currentTaskId: null },
    tester: { role: 'tester', status: 'idle', currentTaskId: null },
    'developer-1': { role: 'developer', status: 'idle', currentTaskId: null },
  },
  tasks: [],
}))
assert.deepEqual(
  getActiveSprintEngineLifecyclePhases(noProductRosterState!),
  ['review', 'testing'],
  'roster-driven policy hides product when no product role is rostered'
)
assert.deepEqual(
  getSprintEngineVisibleBoardColumns(noProductRosterState!).map((column) => column.key),
  ['todo', 'ready', 'changes_requested', 'in_progress', 'review', 'testing', 'needs_input', 'done'],
)

const frontendOnlyGateState = normalizeSprintEngineProjection(fakeProjection({
  run: {
    id: 'run-id',
    name: 'Frontend Gate Run',
    goal: 'Test goal',
    status: 'executing',
    rosterConfigured: true,
    updatedAt: '2026-05-16T20:00:00Z',
    qualityPolicy: {
      enabled: true,
      rosterDriven: true,
      lifecyclePhases: ['review', 'testing', 'product'],
      gates: {
        code_reviewer: { phase: 'review', role: 'code_reviewer', required: true },
        tester: { phase: 'testing', role: 'tester', required: true },
        product: { phase: 'product', role: 'product', required: true },
      },
    },
  },
  roster: {
    frontend: { role: 'frontend', status: 'idle', currentTaskId: null },
    'developer-1': { role: 'developer', status: 'idle', currentTaskId: null },
  },
  tasks: [
    {
      id: 'F1',
      title: 'Frontend implementation',
      description: '',
      role: 'frontend',
      status: 'todo',
      folderStatus: 'todo',
      stateStatus: 'todo',
      boardColumn: 'todo',
      ownedPaths: ['src/renderer/src/components/Foo.tsx'],
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
      qualityGates: [
        {
          id: 'frontend_review',
          phase: 'review',
          role: 'frontend',
          status: 'pending',
          required: true,
          allowSelfReview: true,
          attempts: [],
        },
      ],
    },
  ],
}))
assert.deepEqual(
  getActiveSprintEngineLifecyclePhases(frontendOnlyGateState!),
  ['review'],
  'task-level frontend gates keep review visible even when static policy roles are absent'
)

const noProductRosterWithActiveProductTask = normalizeSprintEngineProjection(fakeProjection({
  run: {
    id: 'run-id',
    name: 'Active Product Task Run',
    goal: 'Test goal',
    status: 'executing',
    rosterConfigured: true,
    updatedAt: '2026-05-16T20:00:00Z',
    qualityPolicy: noProductRosterState!.qualityPolicy,
  },
  roster: {
    architect: { role: 'architect', status: 'idle', currentTaskId: null },
    tester: { role: 'tester', status: 'idle', currentTaskId: null },
  },
  tasks: [
    {
      id: 'P1',
      title: 'Legacy task in product',
      description: '',
      role: 'developer',
      status: 'product',
      folderStatus: 'product',
      stateStatus: 'in_progress',
      boardColumn: 'product',
      ownedPaths: [],
      dependsOn: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      notes: [],
      comments: [],
      evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
      activity: [],
      startedAt: '2026-05-16T19:30:00Z',
      completedAt: null,
      ownerAgentId: 'developer-1',
    },
  ],
}))
assert.deepEqual(
  getActiveSprintEngineLifecyclePhases(noProductRosterWithActiveProductTask!),
  ['review', 'testing', 'product'],
  'active product-folder tasks keep the product column visible for compatibility'
)

const reviewTaskWithoutBoardColumnState = normalizeSprintEngineProjection({
  ...fakeProjection({
    run: { rosterConfigured: false },
    tasks: [
      {
        id: 'LEGACY-REVIEW',
        title: 'Task in review without board column',
        description: '',
        role: 'developer',
        status: 'review',
        ownedPaths: [],
        dependsOn: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        notes: [],
        comments: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        startedAt: null,
        completedAt: null,
        ownerAgentId: 'developer-1',
      },
    ],
  }),
})
assert.deepEqual(
  getActiveSprintEngineLifecyclePhases(reviewTaskWithoutBoardColumnState!),
  ['review'],
  'review status keeps review column visible even without boardColumn'
)

// When neither policy nor tasks call for lifecycle phases, the board hides
// review/testing/product entirely.
const ungatedState = normalizeSprintEngineProjection(fakeProjection())
const ungatedVisibleColumns = getSprintEngineVisibleBoardColumns(ungatedState!).map((column) => column.key)
assert.deepEqual(
  ungatedVisibleColumns,
  ['todo', 'ready', 'changes_requested', 'in_progress', 'needs_input', 'done'],
)

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
    qualityPolicy: {
      enabled: true,
      rosterDriven: true,
      lifecyclePhases: ['review'],
      gates: {
        marketer_review: { phase: 'review', role: 'marketer', required: true, focus: 'launch readiness' },
      },
    },
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
      qualityGates: [
        {
          id: 'GATE-1',
          phase: 'review',
          role: 'marketer',
          status: 'pending',
          required: true,
          allowSelfReview: false,
          attempts: [],
        },
      ],
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
assert.equal(customRoleTask.qualityGates?.[0]?.role, 'marketer', 'gate.role preserved')
assert.equal(customRoleTask.comments[0]?.authorRole, 'marketer', 'comment.authorRole preserved')
assert.equal(customRoleTask.feedback?.role, 'marketer', 'feedback.role preserved')
assert.equal(customRoleTask.triage?.suggestedRole, 'marketer', 'triage.suggestedRole preserved')
assert.equal(customRoleState!.sprintEngineAgents.marketer?.role, 'marketer', 'runtime agent role preserved')
assert.equal(customRoleState!.qualityPolicy?.gates.marketer_review?.role, 'marketer', 'policy gate.role preserved')
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

// Unknown but configured role ids do not crash the lifecycle-phase
// resolver: the policy gate's `marketer` role is part of the configured
// roster, so the review column stays visible.
assert.deepEqual(
  getActiveSprintEngineLifecyclePhases(customRoleState!),
  ['review'],
  'custom-role policy gate keeps review column visible',
)

// Malformed comment/gate entries with empty or missing role are dropped
// during normalization, but valid sibling entries still survive.
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
      qualityGates: [
        // Missing role — dropped.
        { id: 'BAD', phase: 'review', role: '', status: 'pending', required: true, allowSelfReview: false, attempts: [] },
        // Custom role — preserved.
        { id: 'OK', phase: 'review', role: 'marketer', status: 'pending', required: true, allowSelfReview: false, attempts: [] },
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
assert.equal(malformedTask.qualityGates?.length, 1, 'gate with missing role dropped')
assert.equal(malformedTask.qualityGates?.[0]?.role, 'marketer', 'custom-role gate preserved')

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

// eslint-disable-next-line no-console
console.log('sprintengine.test.ts: ok')
