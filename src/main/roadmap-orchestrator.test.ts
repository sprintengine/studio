import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRoadmapOrchestrator,
  type RoadmapBacklogItem,
  type RoadmapOrchestratorPorts,
  type RoadmapRunRef,
  type RoadmapRunSnapshot,
} from './roadmap-orchestrator'
import { qualifiedRef, type ProjectKey } from '../shared/backlog/roadmap'
import type { RoadmapLaneRuntime } from '../shared/sprintengine/roadmap-orchestrator'

const ROOT = '/w/home'
const MOBILE_ROOT = '/w/mobile'
const ROADMAP_REF = 'backlog/roadmaps/r.md'
const qref = (ref: string, projectKey: ProjectKey = null): string => qualifiedRef(projectKey, ref)

function roadmapFile(
  advance: 'approve' | 'auto',
  merge: 'manual' | 'auto',
  body = '## Backend\n- backlog/a.md\n- backlog/b.md',
  frontmatterExtra = '',
): string {
  return `---\ntype: roadmap\nstatus: ready\nid: 100\nadvance: ${advance}\nmerge: ${merge}\n${frontmatterExtra}---\n\n${body}\n`
}

type Harness = {
  ports: RoadmapOrchestratorPorts
  itemsByRoot: Map<string, Map<string, RoadmapBacklogItem>>
  links: Map<string, RoadmapRunRef>
  runs: Map<string, RoadmapRunSnapshot>
  store: Map<string, Map<string, RoadmapLaneRuntime>>
  starts: string[]
  startCalls: Array<{ root: string; rel: string }>
  merges: string[]
  notices: Array<{ severity: string; title: string }>
  setRoadmap: (content: string) => void
}

const linkKey = (root: string, rel: string): string => `${root}::${rel}`

// A backlog universe across one or more project roots. `home` items live in ROOT;
// extra roots (e.g. MOBILE_ROOT) carry alias-project items.
function harness(
  initialRoadmap: string,
  options: { roots?: string[]; itemsByRoot?: Record<string, RoadmapBacklogItem[]> } = {},
): Harness {
  const roots = options.roots ?? [ROOT]
  const itemsByRoot = new Map<string, Map<string, RoadmapBacklogItem>>()
  const seed = options.itemsByRoot ?? {
    [ROOT]: [
      { relativePath: 'backlog/a.md', status: 'ready' },
      { relativePath: 'backlog/b.md', status: 'ready' },
    ],
  }
  for (const [root, list] of Object.entries(seed)) {
    itemsByRoot.set(root, new Map(list.map((item) => [item.relativePath, item])))
  }

  let roadmapContent = initialRoadmap
  const links = new Map<string, RoadmapRunRef>()
  const runs = new Map<string, RoadmapRunSnapshot>()
  const store = new Map<string, Map<string, RoadmapLaneRuntime>>()
  const starts: string[] = []
  const startCalls: Array<{ root: string; rel: string }> = []
  const merges: string[] = []
  const notices: Array<{ severity: string; title: string }> = []

  const statePathFor = (root: string, rel: string): string =>
    `${root}/.multi-code/sprintengine/team-${rel.replace(/[^a-z]/g, '')}/run.yaml`

  const ports: RoadmapOrchestratorPorts = {
    getHomeProjectRoot: () => ROOT,
    listWorkspaceRoots: () => roots,
    listBacklogItems: async (root) => {
      const projItems = [...(itemsByRoot.get(root)?.values() ?? [])]
      return root === ROOT
        ? [{ relativePath: ROADMAP_REF, status: 'ready', isRoadmap: true, numericId: 100 }, ...projItems]
        : projItems
    },
    readRoadmapFile: async (_root, relativePath) => (relativePath === ROADMAP_REF ? roadmapContent : null),
    resolveExecutionLink: async (root, rel) => links.get(linkKey(root, rel)) ?? null,
    observeRun: async (runRef) => runs.get(runRef.statePath) ?? null,
    mergePullRequest: async (statePath) => {
      merges.push(statePath)
      const snapshot = runs.get(statePath)
      if (snapshot) runs.set(statePath, { ...snapshot, prAllMerged: true })
      return { ok: true }
    },
    startSprint: async ({ workspaceRoot, itemRelativePath }) => {
      starts.push(itemRelativePath)
      startCalls.push({ root: workspaceRoot, rel: itemRelativePath })
      const statePath = statePathFor(workspaceRoot, itemRelativePath)
      const teamSlug = `team-${itemRelativePath.replace(/[^a-z]/g, '')}`
      links.set(linkKey(workspaceRoot, itemRelativePath), { statePath, teamSlug })
      runs.set(statePath, { mode: 'worktree', lifecycle: 'executing' })
      const projItems = itemsByRoot.get(workspaceRoot)
      const item = projItems?.get(itemRelativePath)
      if (item && projItems) projItems.set(itemRelativePath, { ...item, status: 'in_progress' })
      return { ok: true }
    },
    abandonRun: async (root, rel) => {
      links.delete(linkKey(root, rel))
      const projItems = itemsByRoot.get(root)
      const item = projItems?.get(rel)
      if (item && projItems) projItems.set(rel, { ...item, status: 'ready' })
    },
    readLaneRuntime: async (roadmapRef) => new Map(store.get(roadmapRef) ?? new Map()),
    writeLaneRuntime: async (roadmapRef, lanes) => {
      store.set(roadmapRef, new Map([...lanes].map(([k, v]) => [k, { ...v }])))
    },
    notify: (input) => notices.push({ severity: input.severity, title: input.title }),
    logDiagnostic: () => undefined,
    now: () => new Date('2026-07-18T00:00:00Z'),
  }

  return {
    ports,
    itemsByRoot,
    links,
    runs,
    store,
    starts,
    startCalls,
    merges,
    notices,
    setRoadmap: (content) => {
      roadmapContent = content
    },
  }
}

function lane(h: Harness, name = 'Backend'): RoadmapLaneRuntime | undefined {
  return h.store.get(ROADMAP_REF)?.get(name)
}

function setItem(h: Harness, root: string, item: RoadmapBacklogItem): void {
  const projItems = h.itemsByRoot.get(root) ?? new Map<string, RoadmapBacklogItem>()
  projItems.set(item.relativePath, item)
  h.itemsByRoot.set(root, projItems)
}

test('auto+auto: full lane walks start → merge → advance → complete', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile()
  assert.deepEqual(h.starts, ['backlog/a.md'])
  assert.equal(lane(h)?.activeItemRef, qref('backlog/a.md'))
  assert.equal(lane(h)?.activeRepoId, ROOT)

  await orchestrator.reconcile()
  assert.equal(h.starts.length, 1)

  h.runs.set(h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath, { mode: 'worktree', lifecycle: 'completed' })
  await orchestrator.reconcile()
  assert.equal(h.merges.length, 1)

  setItem(h, ROOT, { relativePath: 'backlog/a.md', status: 'completed' })
  await orchestrator.reconcile()
  assert.equal(lane(h)?.activeItemRef, undefined)

  await orchestrator.reconcile()
  assert.deepEqual(h.starts, ['backlog/a.md', 'backlog/b.md'])
  assert.equal(lane(h)?.activeItemRef, qref('backlog/b.md'))
})

test('cross-project: a lane advances from the home project into another project', async () => {
  // Ship runs a home item then a mobile-project item; the sprints start in each
  // entry's OWN project root.
  const h = harness(
    roadmapFile('auto', 'auto', '## Ship\n- backlog/a.md\n- mobile:backlog/m.md', 'projects:\n  mobile: /w/mobile\n'),
    {
      roots: [ROOT, MOBILE_ROOT],
      itemsByRoot: {
        [ROOT]: [{ relativePath: 'backlog/a.md', status: 'ready' }],
        [MOBILE_ROOT]: [{ relativePath: 'backlog/m.md', status: 'ready' }],
      },
    },
  )
  const orchestrator = createRoadmapOrchestrator(h.ports)

  // 1. Home item a starts in the home root.
  await orchestrator.reconcile()
  assert.deepEqual(h.startCalls, [{ root: ROOT, rel: 'backlog/a.md' }])

  // 2. a completes + merges, its item goes terminal.
  h.runs.set(h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath, { mode: 'worktree', lifecycle: 'completed' })
  await orchestrator.reconcile() // auto-merge
  setItem(h, ROOT, { relativePath: 'backlog/a.md', status: 'completed' })
  await orchestrator.reconcile() // clears active
  // 3. The mobile item now starts — in the MOBILE root, not the home root.
  await orchestrator.reconcile()
  assert.deepEqual(h.startCalls.at(-1), { root: MOBILE_ROOT, rel: 'backlog/m.md' })
  assert.equal(lane(h, 'Ship')?.activeItemRef, qref('backlog/m.md', 'mobile'))
  assert.equal(lane(h, 'Ship')?.activeRepoId, MOBILE_ROOT)
})

test('an alias whose path is not a known root parks the lane unknown_project', async () => {
  const h = harness(
    roadmapFile('auto', 'auto', '## Ship\n- ghost:backlog/x.md', 'projects:\n  ghost: /w/does-not-exist\n'),
    { roots: [ROOT], itemsByRoot: { [ROOT]: [] } },
  )
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  assert.equal(lane(h, 'Ship')?.parked?.reason, 'unknown_project')
  assert.equal(h.starts.length, 0)
  assert.ok(h.notices.some((n) => n.title === 'Roadmap paused'))
})

test('idempotent start: a pre-existing live run is adopted, not duplicated', async () => {
  const h = harness(roadmapFile('auto', 'manual'))
  const statePath = `${ROOT}/.multi-code/sprintengine/team-a/run.yaml`
  h.links.set(linkKey(ROOT, 'backlog/a.md'), { statePath, teamSlug: 'team-a' })
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'executing' })
  setItem(h, ROOT, { relativePath: 'backlog/a.md', status: 'in_progress' })

  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  assert.equal(h.starts.length, 0)
  assert.equal(lane(h)?.activeItemRef, qref('backlog/a.md'))
  assert.equal(lane(h)?.activeStatePath, statePath)
})

test('run failure parks the lane with a notification; resume re-plans a NEW sprint', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'failed' })

  await orchestrator.reconcile()
  assert.equal(lane(h)?.parked?.reason, 'run_failed')
  assert.ok(h.notices.some((n) => n.title === 'Roadmap paused'))

  const startsBefore = h.starts.length
  await orchestrator.reconcile()
  assert.equal(h.starts.length, startsBefore)

  await orchestrator.resumeLane(ROADMAP_REF, 'Backend')
  assert.equal(lane(h)?.parked, undefined)
  assert.equal(h.starts.length, startsBefore + 1)
})

test('resume re-plans a needs_input park instead of re-adopting the blocked run', async () => {
  const h = harness(roadmapFile('auto', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'needs_input_user' })

  await orchestrator.reconcile()
  assert.equal(lane(h)?.parked?.reason, 'needs_input')
  const startsBefore = h.starts.length

  await orchestrator.resumeLane(ROADMAP_REF, 'Backend')
  assert.equal(lane(h)?.parked, undefined)
  assert.equal(h.starts.length, startsBefore + 1)
})

test('approve gate: queues approval, then a human approval starts', async () => {
  const h = harness(roadmapFile('approve', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile()
  assert.equal(h.starts.length, 0)
  assert.equal(lane(h)?.pendingApprovalRef, qref('backlog/a.md'))
  assert.ok(h.notices.some((n) => n.title === 'Roadmap ready to continue'))

  await orchestrator.approveStart(ROADMAP_REF, 'Backend')
  assert.deepEqual(h.starts, ['backlog/a.md'])
  assert.equal(lane(h)?.activeItemRef, qref('backlog/a.md'))
  assert.equal(lane(h)?.pendingApprovalRef, undefined)
})

test('merge:manual waits; the human merge command merges and advances', async () => {
  const h = harness(roadmapFile('auto', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed' })

  await orchestrator.reconcile()
  assert.equal(h.merges.length, 0)

  const merged = await orchestrator.mergeLane(ROADMAP_REF, 'Backend')
  assert.equal(merged.ok, true)
  assert.deepEqual(h.merges, [statePath])
})

test('crash-safe: persisted active handle re-observes on a fresh orchestrator', async () => {
  const h = harness(roadmapFile('auto', 'manual'))
  const first = createRoadmapOrchestrator(h.ports)
  await first.reconcile()
  assert.equal(lane(h)?.activeItemRef, qref('backlog/a.md'))

  const startsBefore = h.starts.length
  const second = createRoadmapOrchestrator(h.ports)
  await second.reconcile()
  assert.equal(h.starts.length, startsBefore)
  assert.equal(lane(h)?.activeItemRef, qref('backlog/a.md'))
})

test('readRoadmapStates surfaces the single instance roadmap for the board', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()

  const views = await orchestrator.readRoadmapStates()
  assert.equal(views.length, 1)
  assert.equal(views[0].roadmapRef, ROADMAP_REF)
  assert.equal(views[0].lanes[0].activeItemRef, qref('backlog/a.md'))
})

test('no home project configured → no roadmaps, no work', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const noHome: RoadmapOrchestratorPorts = { ...h.ports, getHomeProjectRoot: () => null }
  const orchestrator = createRoadmapOrchestrator(noHome)
  await orchestrator.reconcile()
  assert.equal(h.starts.length, 0)
  assert.deepEqual(await orchestrator.readRoadmapStates(), [])
})
