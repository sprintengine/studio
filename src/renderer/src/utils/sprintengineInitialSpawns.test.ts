import assert from 'node:assert/strict'
import { normalizeSprintEngineProjection } from './sprintengine'
import { canLaunchSprintEngineInitialSpawn } from './sprintengineInitialSpawns'

const DEFAULT_ROSTER: Record<string, Record<string, unknown>> = {
  architect: { role: 'architect', status: 'idle', currentTaskId: null },
  product: { role: 'product', status: 'idle', currentTaskId: null },
  tester: { role: 'tester', status: 'idle', currentTaskId: null },
}

function projection(
  tasks: Array<Record<string, unknown>>,
  roster: Record<string, Record<string, unknown>> = DEFAULT_ROSTER,
) {
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
    roster,
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
assert.equal(
  canLaunchSprintEngineInitialSpawn(undefined, emptyState),
  false,
  'an agent with no role does not launch off the planning-role predicate — the coordinator seat answers that, and wiring it into bootstrap is MC-2050',
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

// Removed: the quality-gate-claimable launch case tested deleted gate machinery
// (MC-1542 single-owner tasks — a role's only launchable work is now a task
// assigned to it, never a separate reviewer-shaped gate).

console.log('sprintengineInitialSpawns.test.ts: ok')
