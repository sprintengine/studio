import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRoadmapOrchestrator,
  type RoadmapBacklogItem,
  type RoadmapOrchestratorPorts,
  type RoadmapRunRef,
  type RoadmapRunSnapshot,
} from './roadmap-orchestrator'
import type { RoadmapLaneRuntime } from '../shared/sprintengine/roadmap-orchestrator'

const ROOT = '/w'
const ROADMAP_REF = 'backlog/roadmaps/r.md'

function roadmapFile(advance: 'approve' | 'auto', merge: 'manual' | 'auto', items = '- backlog/a.md\n- backlog/b.md'): string {
  return `---\ntype: roadmap\nstatus: ready\nadvance: ${advance}\nmerge: ${merge}\n---\n\n## Backend\n${items}\n`
}

type Harness = {
  ports: RoadmapOrchestratorPorts
  items: Map<string, RoadmapBacklogItem>
  links: Map<string, RoadmapRunRef>
  runs: Map<string, RoadmapRunSnapshot>
  store: Map<string, Map<string, RoadmapLaneRuntime>>
  starts: string[]
  merges: string[]
  notices: Array<{ severity: string; title: string }>
  setRoadmap: (content: string) => void
}

function harness(initialRoadmap: string): Harness {
  const items = new Map<string, RoadmapBacklogItem>([
    ['backlog/a.md', { relativePath: 'backlog/a.md', status: 'ready' }],
    ['backlog/b.md', { relativePath: 'backlog/b.md', status: 'ready' }],
  ])
  let roadmapContent = initialRoadmap
  const links = new Map<string, RoadmapRunRef>()
  const runs = new Map<string, RoadmapRunSnapshot>()
  const store = new Map<string, Map<string, RoadmapLaneRuntime>>()
  const starts: string[] = []
  const merges: string[] = []
  const notices: Array<{ severity: string; title: string }> = []

  const statePathFor = (itemRef: string): string =>
    `/w/.multi-code/sprintengine/team-${itemRef.replace(/[^a-z]/g, '')}/run.yaml`

  const ports: RoadmapOrchestratorPorts = {
    listWorkspaceRoots: () => [ROOT],
    listBacklogItems: async () => [
      { relativePath: ROADMAP_REF, status: 'ready', isRoadmap: true },
      ...items.values(),
    ],
    readRoadmapFile: async (_root, relativePath) => (relativePath === ROADMAP_REF ? roadmapContent : null),
    resolveExecutionLink: async (_root, itemRef) => links.get(itemRef) ?? null,
    observeRun: async (runRef) => runs.get(runRef.statePath) ?? null,
    mergePullRequest: async (statePath) => {
      merges.push(statePath)
      const snapshot = runs.get(statePath)
      if (snapshot) runs.set(statePath, { ...snapshot, prAllMerged: true })
      return { ok: true }
    },
    startSprint: async ({ itemRef }) => {
      starts.push(itemRef)
      const statePath = statePathFor(itemRef)
      const teamSlug = `team-${itemRef.replace(/[^a-z]/g, '')}`
      links.set(itemRef, { statePath, teamSlug })
      runs.set(statePath, { mode: 'worktree', lifecycle: 'executing', repoId: 'primary' })
      const item = items.get(itemRef)
      if (item) items.set(itemRef, { ...item, status: 'in_progress' })
      return { ok: true }
    },
    abandonRun: async (_root, itemRef) => {
      // Mirror the real port: drop the execution link and reset the item so the
      // lane re-plans a fresh sprint instead of re-adopting the dead run.
      links.delete(itemRef)
      const item = items.get(itemRef)
      if (item) items.set(itemRef, { ...item, status: 'ready' })
    },
    readLaneRuntime: async (_root, roadmapRef) => new Map(store.get(roadmapRef) ?? new Map()),
    writeLaneRuntime: async (_root, roadmapRef, lanes) => {
      store.set(roadmapRef, new Map([...lanes].map(([k, v]) => [k, { ...v }])))
    },
    notify: (input) => notices.push({ severity: input.severity, title: input.title }),
    logDiagnostic: () => undefined,
    now: () => new Date('2026-07-18T00:00:00Z'),
  }

  return {
    ports,
    items,
    links,
    runs,
    store,
    starts,
    merges,
    notices,
    setRoadmap: (content) => {
      roadmapContent = content
    },
  }
}

function lane(h: Harness): RoadmapLaneRuntime | undefined {
  return h.store.get(ROADMAP_REF)?.get('Backend')
}

test('auto+auto: full lane walks start → merge → advance → complete', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  // 1. First reconcile starts item a.
  await orchestrator.reconcile()
  assert.deepEqual(h.starts, ['backlog/a.md'])
  assert.equal(lane(h)?.activeItemRef, 'backlog/a.md')

  // 2. a still executing → no new action.
  await orchestrator.reconcile()
  assert.equal(h.starts.length, 1)

  // 3. a completes (unmerged worktree) → auto-merge (merge flips prAllMerged).
  h.runs.set(h.links.get('backlog/a.md')!.statePath, {
    mode: 'worktree',
    lifecycle: 'completed',
    repoId: 'primary',
  })
  await orchestrator.reconcile()
  assert.equal(h.merges.length, 1)

  // 4. a's item goes completed; the next reconcile observes it merged and clears
  //    the active handle (advancement is next-tick, matching the 60s cadence).
  h.items.set('backlog/a.md', { relativePath: 'backlog/a.md', status: 'completed' })
  await orchestrator.reconcile()
  assert.equal(lane(h)?.activeItemRef, undefined)

  // 5. With a merged, the following reconcile starts b.
  await orchestrator.reconcile()
  assert.deepEqual(h.starts, ['backlog/a.md', 'backlog/b.md'])
  assert.equal(lane(h)?.activeItemRef, 'backlog/b.md')
})

test('idempotent start: a pre-existing live run is adopted, not duplicated', async () => {
  const h = harness(roadmapFile('auto', 'manual'))
  // Simulate a run already started for a (link + executing run) with NO persisted
  // lane runtime — the kill/restart-mid-create case.
  const statePath = '/w/.multi-code/sprintengine/team-a/run.yaml'
  h.links.set('backlog/a.md', { statePath, teamSlug: 'team-a' })
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'executing', repoId: 'primary' })
  h.items.set('backlog/a.md', { relativePath: 'backlog/a.md', status: 'in_progress' })

  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  // The reducer sees no active handle and emits start; the driver adopts the
  // existing run instead of creating a second.
  assert.equal(h.starts.length, 0)
  assert.equal(lane(h)?.activeItemRef, 'backlog/a.md')
  assert.equal(lane(h)?.activeStatePath, statePath)
})

test('run failure parks the lane with a notification; resume re-plans a NEW sprint', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile() // starts a
  const statePath = h.links.get('backlog/a.md')!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'failed', repoId: 'primary' })

  await orchestrator.reconcile()
  assert.equal(lane(h)?.parked?.reason, 'run_failed')
  assert.ok(h.notices.some((n) => n.title === 'Roadmap paused'))

  // Parked → no further starts even as ticks pass.
  const startsBefore = h.starts.length
  await orchestrator.reconcile()
  assert.equal(h.starts.length, startsBefore)

  // Resume re-plans: abandonRun (real port) drops the dead run's link + resets
  // the item, so the next reconcile starts a FRESH sprint from the same item and
  // never re-adopts the dead run. No manual link/status surgery in the test.
  await orchestrator.resumeLane(ROOT, ROADMAP_REF, 'Backend')
  assert.equal(lane(h)?.parked, undefined)
  assert.equal(h.starts.length, startsBefore + 1)
})

test('resume re-plans a needs_input park instead of re-adopting the blocked run', async () => {
  const h = harness(roadmapFile('auto', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile() // starts a
  const statePath = h.links.get('backlog/a.md')!.statePath
  // The run blocks on the human — an ADOPTABLE lifecycle, unlike canceled.
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'needs_input_user', repoId: 'primary' })

  await orchestrator.reconcile()
  assert.equal(lane(h)?.parked?.reason, 'needs_input')
  const startsBefore = h.starts.length

  await orchestrator.resumeLane(ROOT, ROADMAP_REF, 'Backend')
  // Without abandonRun, the adoption pass would re-adopt the still-blocked run
  // and re-park. With it, the link is gone + item reset → a fresh start.
  assert.equal(lane(h)?.parked, undefined)
  assert.equal(h.starts.length, startsBefore + 1)
})

test('approve gate: queues approval, then a human approval starts', async () => {
  const h = harness(roadmapFile('approve', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile()
  assert.equal(h.starts.length, 0)
  assert.equal(lane(h)?.pendingApprovalRef, 'backlog/a.md')
  assert.ok(h.notices.some((n) => n.title === 'Roadmap ready to continue'))

  await orchestrator.approveStart(ROOT, ROADMAP_REF, 'Backend')
  assert.deepEqual(h.starts, ['backlog/a.md'])
  assert.equal(lane(h)?.activeItemRef, 'backlog/a.md')
  assert.equal(lane(h)?.pendingApprovalRef, undefined)
})

test('merge:manual waits; the human merge command merges and advances', async () => {
  const h = harness(roadmapFile('auto', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile() // starts a
  const statePath = h.links.get('backlog/a.md')!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed', repoId: 'primary' })

  await orchestrator.reconcile()
  assert.equal(h.merges.length, 0) // manual → the orchestrator does not merge

  const merged = await orchestrator.mergeLane(ROOT, ROADMAP_REF, 'Backend')
  assert.equal(merged.ok, true)
  assert.deepEqual(h.merges, [statePath])
})

test('crash-safe: persisted active handle re-observes on a fresh orchestrator', async () => {
  const h = harness(roadmapFile('auto', 'manual'))
  const first = createRoadmapOrchestrator(h.ports)
  await first.reconcile() // starts a, persists activeItemRef + statePath
  assert.equal(lane(h)?.activeItemRef, 'backlog/a.md')

  // A new orchestrator (app restart) reads the persisted runtime and re-derives:
  // the run is still executing, so it watches, never re-starts.
  const startsBefore = h.starts.length
  const second = createRoadmapOrchestrator(h.ports)
  await second.reconcile()
  assert.equal(h.starts.length, startsBefore)
  assert.equal(lane(h)?.activeItemRef, 'backlog/a.md')
})

test('readRoadmapStates surfaces parked + active lanes for the board', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()

  const views = await orchestrator.readRoadmapStates(ROOT)
  assert.equal(views.length, 1)
  assert.equal(views[0].roadmapRef, ROADMAP_REF)
  assert.equal(views[0].lanes[0].activeItemRef, 'backlog/a.md')
})
