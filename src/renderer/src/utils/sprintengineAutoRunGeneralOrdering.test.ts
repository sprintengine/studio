import assert from 'node:assert/strict'
import {
  pickNextAutoRuns,
  pickSprintEngineBootstrapCandidate,
} from './sprintengineAutoRun'
import type {
  SprintEngineQualityGate,
  SprintEngineRuntimeAgent,
  SprintEngineState,
  SprintEngineTask,
  Workspace,
} from '../types/workspace'

// Minimal fixtures (the sprintengineAutoRun.test.ts equivalents are file-local).
function gate(overrides: Partial<SprintEngineQualityGate> = {}): SprintEngineQualityGate {
  return {
    id: 'general_review',
    phase: 'review',
    role: 'general',
    status: 'pending',
    required: true,
    allowSelfReview: true,
    focus: '',
    attempts: [],
    ...overrides,
  }
}

function task(overrides: Partial<SprintEngineTask> = {}): SprintEngineTask {
  return {
    id: 'T1',
    title: 'Task',
    description: '',
    role: 'general',
    status: 'review',
    ownerAgentId: 'general-1',
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
    qualityGates: [],
    ...overrides,
  } as SprintEngineTask
}

function readyTask(overrides: Partial<SprintEngineTask> = {}): SprintEngineTask {
  return task({
    id: 'T-ready',
    status: 'todo',
    boardColumn: 'ready',
    ownerAgentId: null,
    dependsOn: [],
    qualityGates: [],
    ...overrides,
  })
}

function agent(role: string, overrides: Partial<SprintEngineRuntimeAgent> = {}): SprintEngineRuntimeAgent {
  return { role, status: 'idle', currentTaskId: null, ...overrides } as SprintEngineRuntimeAgent
}

function state(overrides: Partial<SprintEngineState> = {}): SprintEngineState {
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

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    name: 'Auto-run workspace',
    folderPath: '/tmp/workspace',
    sprintEngineContext: {
      teamSlug: 'team',
      teamRoot: '/tmp/workspace/.multi-code/sprintengine/team',
      statePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    },
    agents: {},
    ...overrides,
  } as Workspace
}

function pickInput(): Parameters<typeof pickNextAutoRuns>[2] {
  return {
    limit: 3,
    pendingSpawns: [],
    runningAgentIds: new Set<string>(),
    inFlightSpawns: new Set<string>(),
    continuationCapacityByRole: new Map(),
    continuationGraceByTask: new Map(),
  } as Parameters<typeof pickNextAutoRuns>[2]
}

function bootstrapOptions(): Parameters<typeof pickSprintEngineBootstrapCandidate>[2] {
  return { runningAgentIds: new Set<string>(), inFlightSpawnKeys: new Set<string>() }
}

// (1) One General: a pending self-review gate on its own task is ordered AHEAD
// of a fresh ready task, so the planner wakes it for the GATE, not the task.
function testIdleGeneralIsRoutedToItsGateBeforeAReadyTask(): void {
  const reviewTask = task({ id: 'T-review', status: 'review', boardColumn: 'review', qualityGates: [gate()] })
  const candidates = pickNextAutoRuns(
    workspace(),
    state({ tasks: [readyTask(), reviewTask], sprintEngineAgents: { 'general-1': agent('general') } }),
    pickInput()
  )
  assert.equal(candidates.length, 1, 'the single General is routed to exactly one piece of work')
  assert.equal(candidates[0].taskId, 'T-review', 'it is routed to the review task, not the ready task')
  assert.equal(candidates[0].gateId, 'general_review', 'specifically to the pending self-review gate')
  assert.equal(candidates[0].role, 'general')
  assert.equal(candidates[0].agentId, 'general-1')
}

// (2) Two Generals: one is routed to the gate and the other to the ready task —
// gates are claimed one-per-agent, so the work load-balances with no coordinator.
function testTwoGeneralsSplitGateAndReadyTask(): void {
  const reviewTask = task({ id: 'T-review', status: 'review', boardColumn: 'review', qualityGates: [gate()] })
  const candidates = pickNextAutoRuns(
    workspace(),
    state({
      tasks: [readyTask(), reviewTask],
      sprintEngineAgents: { 'general-1': agent('general'), 'general-2': agent('general') },
    }),
    pickInput()
  )
  assert.equal(candidates.length, 2, 'both Generals get work')
  const gateCandidate = candidates.find((candidate) => candidate.gateId === 'general_review')
  const readyCandidate = candidates.find((candidate) => candidate.taskId === 'T-ready')
  assert.ok(gateCandidate, 'one General is routed to the gate')
  assert.ok(readyCandidate, 'the other General is routed to the ready task')
  assert.notEqual(gateCandidate!.agentId, readyCandidate!.agentId, 'the two Generals take different work')
}

// (4) Specialist runs have no General, so the pre-pass is a no-op: the developer
// still takes the ready task and the reviewer takes the gate (today's order).
function testSpecialistDispatchOrderIsUnchanged(): void {
  const reviewTask = task({
    id: 'T-review',
    role: 'developer',
    status: 'review',
    boardColumn: 'review',
    ownerAgentId: 'developer-1',
    qualityGates: [gate({ id: 'code_reviewer', role: 'code_reviewer' })],
  })
  const candidates = pickNextAutoRuns(
    workspace(),
    state({
      tasks: [readyTask({ role: 'developer' }), reviewTask],
      sprintEngineAgents: {
        'developer-1': agent('developer'),
        'code_reviewer-1': agent('code_reviewer'),
      },
    }),
    pickInput()
  )
  const readyCandidate = candidates.find((candidate) => candidate.taskId === 'T-ready')
  const gateCandidate = candidates.find((candidate) => candidate.gateId === 'code_reviewer')
  assert.ok(readyCandidate, 'developer still takes the ready task')
  assert.equal(readyCandidate!.agentId, 'developer-1')
  assert.ok(gateCandidate, 'code reviewer still takes its gate')
  assert.equal(gateCandidate!.agentId, 'code_reviewer-1')
}

// (Bootstrap) A fresh one-General run plans itself: the General bootstraps
// instead of stalling, and a roster with no planner at all stalls 'no_planner'.
function testOneGeneralRunBootstrapsTheGeneral(): void {
  const decision = pickSprintEngineBootstrapCandidate(
    workspace(),
    state({ sprintEngineAgents: { 'general-1': agent('general') } }),
    bootstrapOptions()
  )
  assert.equal(decision.kind, 'spawn', 'a fresh one-General run bootstraps instead of stalling')
  if (decision.kind === 'spawn') {
    assert.equal(decision.candidate.role, 'general')
    assert.equal(decision.candidate.agentId, 'general-1')
  }

  const stall = pickSprintEngineBootstrapCandidate(
    workspace(),
    state({ sprintEngineAgents: { 'tester-1': agent('tester') } }),
    bootstrapOptions()
  )
  assert.deepEqual(stall, { kind: 'stall', reason: 'no_planner' }, 'no architect and no General stalls as no_planner')
}

testIdleGeneralIsRoutedToItsGateBeforeAReadyTask()
testTwoGeneralsSplitGateAndReadyTask()
testSpecialistDispatchOrderIsUnchanged()
testOneGeneralRunBootstrapsTheGeneral()

console.log('sprintengineAutoRunGeneralOrdering.test.ts: ok')
