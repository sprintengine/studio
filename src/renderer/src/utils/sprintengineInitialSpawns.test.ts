import assert from 'node:assert/strict'
import { normalizeSprintEngineProjection } from './sprintengine'
import { canLaunchSprintEngineInitialSpawn } from './sprintengineInitialSpawns'

function projection(tasks: Array<Record<string, unknown>>) {
  return {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: '2026-06-16T11:00:00Z',
    updatedAt: '2026-06-16T11:00:00Z',
    run: {
      id: 'run-id',
      name: 'Initial Spawn Run',
      goal: 'Test initial spawn gating.',
      status: 'executing',
      rosterConfigured: true,
      updatedAt: '2026-06-16T11:00:00Z',
    },
    roster: {
      architect: { role: 'architect', status: 'idle', currentTaskId: null },
      product: { role: 'product', status: 'idle', currentTaskId: null },
      tester: { role: 'tester', status: 'idle', currentTaskId: null },
    },
    tasks,
    artifacts: [],
    activity: [],
  }
}

function task(overrides: Record<string, unknown>) {
  return {
    id: 'T1',
    title: 'Task',
    description: '',
    role: 'product',
    status: 'ready',
    boardColumn: 'ready',
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
    ...overrides,
  }
}

const emptyState = normalizeSprintEngineProjection(projection([]), 'Initial Spawn Run')
assert.ok(emptyState)
assert.equal(
  canLaunchSprintEngineInitialSpawn('architect', emptyState),
  true,
  'architect may start as the bootstrap/orchestration role before claimable role work exists',
)
assert.equal(
  canLaunchSprintEngineInitialSpawn('tester', emptyState),
  false,
  'non-architect roles cannot launch against an initialized run with no claimable role work',
)

const productReadyState = normalizeSprintEngineProjection(projection([
  task({ id: 'T1', role: 'product', status: 'ready', boardColumn: 'ready' }),
]), 'Initial Spawn Run')
assert.ok(productReadyState)
assert.equal(
  canLaunchSprintEngineInitialSpawn('product', productReadyState),
  true,
  'a non-architect role can launch when its implementation task is claimable',
)
assert.equal(
  canLaunchSprintEngineInitialSpawn('tester', productReadyState),
  false,
  'unrelated roster roles still wait',
)

const testingGateState = normalizeSprintEngineProjection(projection([
  task({
    id: 'T2',
    role: 'developer',
    status: 'testing',
    boardColumn: 'testing',
    qualityGates: [
      {
        id: 'gate-tester',
        phase: 'testing',
        role: 'tester',
        status: 'pending',
        required: true,
        allowSelfReview: false,
        attempts: [],
      },
    ],
  }),
]), 'Initial Spawn Run')
assert.ok(testingGateState)
assert.equal(
  canLaunchSprintEngineInitialSpawn('tester', testingGateState),
  true,
  'a non-architect role can launch when its quality gate is claimable',
)

console.log('sprintengineInitialSpawns.test.ts: ok')
