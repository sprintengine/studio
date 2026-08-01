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
  // The run's enabled role set. Absent (the default) is a legacy/headless store,
  // which keeps the architect seat; an explicit `[]` is a deliberate no-roles run.
  configuredRoles?: string[],
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
      ...(configuredRoles ? { configuredRoles } : {}),
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
  canLaunchSprintEngineInitialSpawn({ id: 'architect', role: 'architect' }, emptyState),
  true,
  'the architect holds the coordinator seat, so it may start before claimable role work exists',
)
assert.equal(
  canLaunchSprintEngineInitialSpawn({ id: 'tester-1', role: 'tester' }, emptyState),
  false,
  'a specialist cannot launch against an initialized run with no claimable role work',
)

// A ROLELESS run (MC-2050): the seat is `coordinator`, answered by id because it
// has no role to match on, and a minted roleless worker is not it.
const rolelessEmptyState = normalizeSprintEngineProjection(
  projection([], { coordinator: { status: 'idle', currentTaskId: null } }, []),
  'Initial Spawn Run',
)
assert.ok(rolelessEmptyState)
assert.equal(
  canLaunchSprintEngineInitialSpawn({ id: 'coordinator' }, rolelessEmptyState),
  true,
  'the roleless coordinator starts the run without matching a planning role',
)
assert.equal(
  canLaunchSprintEngineInitialSpawn({ id: 'agent-1' }, rolelessEmptyState),
  false,
  'a minted roleless worker waits for claimable work, exactly like a named specialist',
)

const productReadyState = normalizeSprintEngineProjection(projection([
  task({ id: 'T1', role: 'product', status: 'ready', boardColumn: 'ready' }),
]), 'Initial Spawn Run')
assert.ok(productReadyState)
assert.equal(
  canLaunchSprintEngineInitialSpawn({ id: 'product-1', role: 'product' }, productReadyState),
  true,
  'a non-architect role can launch when its implementation task is claimable',
)
assert.equal(
  canLaunchSprintEngineInitialSpawn({ id: 'tester-1', role: 'tester' }, productReadyState),
  false,
  'unrelated roster roles still wait',
)

// Removed: the quality-gate-claimable launch case tested deleted gate machinery
// (MC-1542 single-owner tasks — a role's only launchable work is now a task
// assigned to it, never a separate reviewer-shaped gate).

console.log('sprintengineInitialSpawns.test.ts: ok')
