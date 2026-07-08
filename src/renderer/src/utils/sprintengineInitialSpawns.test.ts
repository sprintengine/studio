import assert from 'node:assert/strict'
import { normalizeSprintEngineProjection } from './sprintengine'
import { pickSprintEngineBootstrapCandidate } from './sprintengineAutoRun'
import type { Workspace } from '../types/workspace'
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
  canLaunchSprintEngineInitialSpawn('general', emptyState),
  true,
  'general is a planning-capable role and may bootstrap a soulless-General run before any task work exists',
)

// A fresh one-General run (no architect) bootstraps the General itself instead
// of stalling on a missing planner.
const oneGeneralState = normalizeSprintEngineProjection(
  projection([], { general: { role: 'general', status: 'idle', currentTaskId: null } }),
  'Initial Spawn Run',
)
assert.ok(oneGeneralState)
const generalWorkspace = { id: 'workspace-1', agents: {} } as unknown as Workspace
const bootstrap = pickSprintEngineBootstrapCandidate(generalWorkspace, oneGeneralState, {
  runningAgentIds: new Set<string>(),
  inFlightSpawnKeys: new Set<string>(),
})
assert.equal(bootstrap.kind, 'spawn', 'a fresh one-General run bootstraps rather than stalling')
assert.equal(
  bootstrap.kind === 'spawn' ? bootstrap.candidate.role : null,
  'general',
  'the General is the bootstrap planner when no architect is rostered',
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
