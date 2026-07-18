import assert from 'node:assert/strict'
import test from 'node:test'

import { parseRoadmap, type RoadmapItemState, type RoadmapRunState } from '../backlog/roadmap'
import {
  reconcileRoadmap,
  type RoadmapLaneRuntime,
  type RoadmapReconcileInput,
  type RoadmapRunObservation,
} from './roadmap-orchestrator'

const NOW = '2026-07-18T00:00:00Z'

// A single-lane roadmap over two loose items, `merge`/`advance` from frontmatter.
function roadmap(advance: 'approve' | 'auto', merge: 'manual' | 'auto') {
  return parseRoadmap(
    `---\ntype: roadmap\nadvance: ${advance}\nmerge: ${merge}\n---\n\n## Backend\n- backlog/a.md\n- backlog/b.md\n`,
  )
}

function item(ref: string, status: RoadmapItemState['status'], dependsOn?: string[]): RoadmapItemState {
  return dependsOn ? { ref, status, dependsOn } : { ref, status }
}

function baseInput(overrides: Partial<RoadmapReconcileInput>): RoadmapReconcileInput {
  return {
    roadmap: roadmap('auto', 'manual'),
    items: [item('backlog/a.md', 'ready'), item('backlog/b.md', 'ready')],
    runLinks: new Map<string, RoadmapRunState>(),
    observations: new Map<string, RoadmapRunObservation>(),
    laneRuntimes: new Map<string, RoadmapLaneRuntime>(),
    approvedRefs: new Set<string>(),
    repoBusy: () => false,
    repoForLane: () => 'primary',
    now: NOW,
    ...overrides,
  }
}

function observation(overrides: Partial<RoadmapRunObservation>): RoadmapRunObservation {
  return {
    itemRef: 'backlog/a.md',
    statePath: '/w/.multi-code/sprintengine/team-a/run.yaml',
    teamSlug: 'team-a',
    mode: 'worktree',
    lifecycle: 'executing',
    repoId: 'primary',
    ...overrides,
  }
}

test('auto + eligible frontier → start, claims the frontier', () => {
  const result = reconcileRoadmap(baseInput({}))
  assert.equal(result.actions.length, 1)
  assert.deepEqual(result.actions[0], { kind: 'start', lane: 'Backend', itemRef: 'backlog/a.md' })
  assert.equal(result.laneRuntimes.get('Backend')?.activeItemRef, 'backlog/a.md')
  assert.equal(result.laneRuntimes.get('Backend')?.activeRepoId, 'primary')
})

test('approve + eligible → queue_approval once, then waits', () => {
  const first = reconcileRoadmap(baseInput({ roadmap: roadmap('approve', 'manual') }))
  assert.deepEqual(first.actions[0], { kind: 'queue_approval', lane: 'Backend', itemRef: 'backlog/a.md' })
  assert.equal(first.laneRuntimes.get('Backend')?.pendingApprovalRef, 'backlog/a.md')

  // Same state again: no duplicate approval, just waits.
  const second = reconcileRoadmap(
    baseInput({ roadmap: roadmap('approve', 'manual'), laneRuntimes: first.laneRuntimes }),
  )
  assert.equal(second.actions.length, 0)
})

test('approve + human-approved ref → start, clears pending', () => {
  const pending = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', pendingApprovalRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      roadmap: roadmap('approve', 'manual'),
      laneRuntimes: pending,
      approvedRefs: new Set(['backlog/a.md']),
    }),
  )
  assert.deepEqual(result.actions[0], { kind: 'start', lane: 'Backend', itemRef: 'backlog/a.md' })
  assert.equal(result.laneRuntimes.get('Backend')?.pendingApprovalRef, undefined)
  assert.equal(result.laneRuntimes.get('Backend')?.activeItemRef, 'backlog/a.md')
})

test('concurrency guard: repo busy → no start', () => {
  const result = reconcileRoadmap(baseInput({ repoBusy: () => true }))
  assert.equal(result.actions.length, 0)
  assert.equal(result.laneRuntimes.get('Backend')?.activeItemRef, undefined)
})

test('active run executing → watch, no action', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      items: [item('backlog/a.md', 'in_progress'), item('backlog/b.md', 'ready')],
      laneRuntimes: runtimes,
      observations: new Map([['backlog/a.md', observation({ lifecycle: 'executing' })]]),
    }),
  )
  assert.equal(result.actions.length, 0)
})

test('active run failed → park run_failed', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      laneRuntimes: runtimes,
      observations: new Map([['backlog/a.md', observation({ lifecycle: 'failed' })]]),
    }),
  )
  assert.deepEqual(result.actions[0], {
    kind: 'park',
    lane: 'Backend',
    reason: 'run_failed',
    itemRef: 'backlog/a.md',
  })
  assert.equal(result.laneRuntimes.get('Backend')?.parked?.reason, 'run_failed')
})

test('active run canceled → park run_canceled', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      laneRuntimes: runtimes,
      observations: new Map([['backlog/a.md', observation({ lifecycle: 'canceled' })]]),
    }),
  )
  assert.equal(result.laneRuntimes.get('Backend')?.parked?.reason, 'run_canceled')
})

test('active run needs_input(user) → park needs_input', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      laneRuntimes: runtimes,
      observations: new Map([['backlog/a.md', observation({ lifecycle: 'needs_input_user' })]]),
    }),
  )
  assert.equal(result.laneRuntimes.get('Backend')?.parked?.reason, 'needs_input')
})

test('shared run completed → clear_active (advances next tick)', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      laneRuntimes: runtimes,
      observations: new Map([['backlog/a.md', observation({ mode: 'shared', lifecycle: 'completed' })]]),
    }),
  )
  assert.deepEqual(result.actions[0], { kind: 'clear_active', lane: 'Backend' })
  assert.equal(result.laneRuntimes.get('Backend')?.activeItemRef, undefined)
})

test('worktree run completed + PR merged → clear_active', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      laneRuntimes: runtimes,
      observations: new Map([
        ['backlog/a.md', observation({ lifecycle: 'completed', prAllMerged: true })],
      ]),
    }),
  )
  assert.deepEqual(result.actions[0], { kind: 'clear_active', lane: 'Backend' })
})

test('worktree run completed + PR closed unmerged → park pr_closed', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      laneRuntimes: runtimes,
      observations: new Map([
        ['backlog/a.md', observation({ lifecycle: 'completed', prClosedUnmerged: true })],
      ]),
    }),
  )
  assert.equal(result.laneRuntimes.get('Backend')?.parked?.reason, 'pr_closed')
})

test('worktree completed awaiting merge + merge:manual → wait', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      roadmap: roadmap('auto', 'manual'),
      laneRuntimes: runtimes,
      observations: new Map([['backlog/a.md', observation({ lifecycle: 'completed' })]]),
    }),
  )
  assert.equal(result.actions.length, 0)
})

test('worktree completed awaiting merge + merge:auto → merge action', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      roadmap: roadmap('auto', 'auto'),
      laneRuntimes: runtimes,
      observations: new Map([['backlog/a.md', observation({ lifecycle: 'completed' })]]),
    }),
  )
  assert.deepEqual(result.actions[0], {
    kind: 'merge',
    lane: 'Backend',
    itemRef: 'backlog/a.md',
    statePath: '/w/.multi-code/sprintengine/team-a/run.yaml',
  })
})

test('parked lane stays parked (never auto-unparks)', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', parked: { reason: 'run_failed', itemRef: 'backlog/a.md', at: NOW } }],
  ])
  const result = reconcileRoadmap(baseInput({ laneRuntimes: runtimes }))
  assert.equal(result.actions.length, 0)
  assert.equal(result.laneRuntimes.get('Backend')?.parked?.reason, 'run_failed')
})

test('active run vanished from observations → clear_active (recover, not park)', () => {
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(baseInput({ laneRuntimes: runtimes, observations: new Map() }))
  assert.deepEqual(result.actions[0], { kind: 'clear_active', lane: 'Backend' })
  assert.equal(result.laneRuntimes.get('Backend')?.activeItemRef, undefined)
})

test('dangling frontier → park eligibility_contradiction', () => {
  const result = reconcileRoadmap(
    baseInput({
      // The roadmap references backlog/a.md, but the known universe omits it.
      items: [item('backlog/b.md', 'ready')],
    }),
  )
  assert.equal(result.laneRuntimes.get('Backend')?.parked?.reason, 'eligibility_contradiction')
})

test('blocked frontier (unresolved prerequisite) → wait, no park', () => {
  const result = reconcileRoadmap(
    baseInput({
      items: [item('backlog/a.md', 'ready', ['dep']), item('backlog/b.md', 'ready')],
    }),
  )
  // a depends on unknown slug `dep` → unresolved → blocked, not eligible.
  assert.equal(result.actions.length, 0)
  assert.equal(result.laneRuntimes.get('Backend')?.parked, undefined)
})

test('lane complete → no action', () => {
  const runLinks = new Map<string, RoadmapRunState>([
    ['backlog/a.md', { mode: 'shared' }],
    ['backlog/b.md', { mode: 'shared' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      items: [item('backlog/a.md', 'completed'), item('backlog/b.md', 'completed')],
      runLinks,
    }),
  )
  assert.equal(result.actions.length, 0)
})

test('two eligible lanes on the same repo → only one starts this reconcile', () => {
  const twoLanes = parseRoadmap(
    '---\ntype: roadmap\nadvance: auto\n---\n\n## Backend\n- backlog/a.md\n\n## Infra\n- backlog/c.md\n',
  )
  const result = reconcileRoadmap(
    baseInput({
      roadmap: twoLanes,
      items: [item('backlog/a.md', 'ready'), item('backlog/c.md', 'ready')],
      repoForLane: () => 'primary', // both lanes target the same repo
    }),
  )
  const starts = result.actions.filter((action) => action.kind === 'start')
  assert.equal(starts.length, 1)
})

test('two eligible lanes on distinct repos → both start', () => {
  const twoLanes = parseRoadmap(
    '---\ntype: roadmap\nadvance: auto\n---\n\n## Backend\n- backlog/a.md\n\n## Mobile\n- backlog/c.md\n',
  )
  const result = reconcileRoadmap(
    baseInput({
      roadmap: twoLanes,
      items: [item('backlog/a.md', 'ready'), item('backlog/c.md', 'ready')],
      repoForLane: (lane) => (lane === 'Mobile' ? 'mobile' : 'primary'),
    }),
  )
  const starts = result.actions.filter((action) => action.kind === 'start')
  assert.equal(starts.length, 2)
})

test('stale pending approval is cleared when the frontier moves on', () => {
  // Pending approval points at a.md, but a.md is already merged so the frontier
  // is now b.md — the stale a.md approval must not linger.
  const runLinks = new Map<string, RoadmapRunState>([['backlog/a.md', { mode: 'shared' }]])
  const runtimes = new Map<string, RoadmapLaneRuntime>([
    ['Backend', { lane: 'Backend', pendingApprovalRef: 'backlog/a.md' }],
  ])
  const result = reconcileRoadmap(
    baseInput({
      roadmap: roadmap('approve', 'manual'),
      items: [item('backlog/a.md', 'completed'), item('backlog/b.md', 'idea')],
      runLinks,
      laneRuntimes: runtimes,
    }),
  )
  // b is idea → blocked; the stale a.md approval is dropped.
  assert.equal(result.laneRuntimes.get('Backend')?.pendingApprovalRef, undefined)
})
