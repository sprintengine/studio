import assert from 'node:assert/strict'
import {
  pickNextAutoRuns,
  pickSprintEngineBootstrapCandidate,
} from './sprintengineAutoRun'
import type {
  SprintEngineRuntimeAgent,
  SprintEngineState,
  SprintEngineTask,
  Workspace,
} from '../types/workspace'

// Minimal fixtures (the sprintengineAutoRun.test.ts equivalents are file-local).
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
    runningAgentIds: new Set<string>(),
    inFlightSpawns: new Set<string>(),
  }
}

function bootstrapOptions(): Parameters<typeof pickSprintEngineBootstrapCandidate>[2] {
  return { runningAgentIds: new Set<string>(), inFlightSpawnKeys: new Set<string>() }
}

// (1) Single-owner tasks (MC-1542): a task in `review` still belongs to the agent
// that published it — the picker never re-dispatches it (its owner finishes it
// through the dispatch/respawn paths). The idle General takes the ready task.
function testOwnedReviewTaskIsNotRedispatchedAndReadyTaskIsTaken(): void {
  const reviewTask = task({ id: 'T-review', status: 'review', boardColumn: 'review', ownerAgentId: 'general-1' })
  const candidates = pickNextAutoRuns(
    workspace(),
    state({ tasks: [readyTask(), reviewTask], sprintEngineAgents: { 'general-1': agent('general') } }),
    pickInput()
  )
  assert.equal(candidates.length, 1, 'the single General is routed to exactly one piece of work')
  assert.equal(candidates[0].taskId, 'T-ready', 'the owner-held review task is not re-dispatched')
  assert.equal(candidates[0].role, 'general')
  assert.equal(candidates[0].agentId, 'general-1')
}

// (2) Specialist runs: each role's ready task goes to its own idle agent, one
// task per agent per pass.
function testSpecialistReadyTasksSplitAcrossRoles(): void {
  const candidates = pickNextAutoRuns(
    workspace(),
    state({
      tasks: [
        readyTask({ id: 'T-dev', role: 'developer' }),
        readyTask({ id: 'T-test', role: 'tester' }),
      ],
      sprintEngineAgents: {
        'developer-1': agent('developer'),
        'tester-1': agent('tester'),
      },
    }),
    pickInput()
  )
  const devCandidate = candidates.find((candidate) => candidate.taskId === 'T-dev')
  const testerCandidate = candidates.find((candidate) => candidate.taskId === 'T-test')
  assert.ok(devCandidate, 'developer takes its ready task')
  assert.equal(devCandidate!.agentId, 'developer-1')
  assert.ok(testerCandidate, 'tester takes its ready task')
  assert.equal(testerCandidate!.agentId, 'tester-1')
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

testOwnedReviewTaskIsNotRedispatchedAndReadyTaskIsTaken()
testSpecialistReadyTasksSplitAcrossRoles()
testOneGeneralRunBootstrapsTheGeneral()

console.log('sprintengineAutoRunGeneralOrdering.test.ts: ok')
