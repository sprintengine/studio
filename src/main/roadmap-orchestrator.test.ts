import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRoadmapOrchestrator,
  type RoadmapAuditEntry,
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
  audits: RoadmapAuditEntry[]
  getRoadmap: () => string
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
  const audits: RoadmapAuditEntry[] = []

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
    writeRoadmapFile: async (_root, relativePath, content) => {
      if (relativePath === ROADMAP_REF) roadmapContent = content
    },
    appendAudit: async (_roadmapRef, entry) => {
      audits.push(entry)
    },
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
    audits,
    getRoadmap: () => roadmapContent,
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

// --- Agent read + plan + steer surface (roadmap.* tools, MC-1693) ---

test('readBoard builds the board model with per-step state + project tags', async () => {
  const h = harness(roadmapFile('approve', 'manual', '## Backend\n- backlog/a.md\n- backlog/b.md'), {
    itemsByRoot: {
      [ROOT]: [
        { relativePath: 'backlog/a.md', status: 'completed', title: 'First' },
        { relativePath: 'backlog/b.md', status: 'ready', title: 'Second' },
      ],
    },
  })
  const orchestrator = createRoadmapOrchestrator(h.ports)
  const board = await orchestrator.readBoard()
  assert.ok(board)
  assert.equal(board?.roadmapRef, ROADMAP_REF)
  const backend = board?.lanes[0]
  assert.equal(backend?.units[0].state, 'done') // completed predecessor
  assert.equal(backend?.units[0].title, 'First')
  assert.equal(backend?.units[1].state, 'up_next') // ready frontier
  assert.equal(backend?.units[1].projectName, 'home') // basename('/w/home')
})

test('readBoard returns null when no roadmap is active', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const noHome: RoadmapOrchestratorPorts = { ...h.ports, getHomeProjectRoot: () => null }
  assert.equal(await createRoadmapOrchestrator(noHome).readBoard(), null)
})

test('addStep appends an item and audits the agent action', async () => {
  const h = harness(roadmapFile('approve', 'manual', '## Backend\n- backlog/a.md'), {
    itemsByRoot: { [ROOT]: [{ relativePath: 'backlog/a.md', status: 'ready' }, { relativePath: 'backlog/c.md', status: 'ready' }] },
  })
  const orchestrator = createRoadmapOrchestrator(h.ports)
  const result = await orchestrator.addStep({ ref: 'backlog/c.md', actor: 'automation' })
  assert.equal(result.ok, true)
  assert.equal(result.ref, 'backlog/c.md')
  assert.match(h.getRoadmap(), /- backlog\/c\.md/)
  assert.equal(h.audits.at(-1)?.action, 'add_step')
  assert.equal(h.audits.at(-1)?.ref, 'backlog/c.md')
})

test('addStep rejects an unknown item without touching the file', async () => {
  const before = roadmapFile('approve', 'manual', '## Backend\n- backlog/a.md')
  const h = harness(before, { itemsByRoot: { [ROOT]: [{ relativePath: 'backlog/a.md', status: 'ready' }] } })
  const orchestrator = createRoadmapOrchestrator(h.ports)
  const missing = await orchestrator.addStep({ ref: 'backlog/ghost.md' })
  assert.equal(missing.ok, false)
  assert.match(missing.message ?? '', /No backlog item/)
  const malformed = await orchestrator.addStep({ ref: 'notes/x.txt' })
  assert.equal(malformed.ok, false)
  assert.equal(h.getRoadmap(), before) // never written
  assert.equal(h.audits.length, 0)
})

test('addStep from another project registers its alias and qualifies the ref', async () => {
  const h = harness(roadmapFile('approve', 'manual', '## Ship\n- backlog/a.md'), {
    roots: [ROOT, MOBILE_ROOT],
    itemsByRoot: {
      [ROOT]: [{ relativePath: 'backlog/a.md', status: 'ready' }],
      [MOBILE_ROOT]: [{ relativePath: 'backlog/m.md', status: 'ready' }],
    },
  })
  const orchestrator = createRoadmapOrchestrator(h.ports)
  const result = await orchestrator.addStep({ ref: 'backlog/m.md', projectPath: MOBILE_ROOT })
  assert.equal(result.ok, true)
  assert.equal(result.ref, 'mobile:backlog/m.md')
  assert.match(h.getRoadmap(), /projects:/)
  assert.match(h.getRoadmap(), /mobile: \/w\/mobile/)
  assert.match(h.getRoadmap(), /- mobile:backlog\/m\.md/)
})

test('addStep as one step snapshots an epic\'s children', async () => {
  const h = harness(roadmapFile('approve', 'manual', '## Backend\n- backlog/a.md'), {
    itemsByRoot: {
      [ROOT]: [
        { relativePath: 'backlog/a.md', status: 'ready' },
        { relativePath: 'backlog/epics/auth.md', status: 'ready', isEpic: true },
        { relativePath: 'backlog/login.md', status: 'ready', epic: 'auth' },
        { relativePath: 'backlog/logout.md', status: 'ready', epic: 'auth' },
      ],
    },
  })
  const orchestrator = createRoadmapOrchestrator(h.ports)
  const result = await orchestrator.addStep({ ref: 'backlog/epics/auth.md' })
  assert.equal(result.ok, true)
  assert.match(h.getRoadmap(), /- backlog\/epics\/auth\.md/)
  assert.match(h.getRoadmap(), /  - backlog\/login\.md/)
  assert.match(h.getRoadmap(), /  - backlog\/logout\.md/)
})

test('removeStep drops a step; reorderStep changes its position', async () => {
  const h = harness(roadmapFile('approve', 'manual', '## Backend\n- backlog/a.md\n- backlog/b.md\n- backlog/c.md'), {
    itemsByRoot: {
      [ROOT]: [
        { relativePath: 'backlog/a.md', status: 'ready' },
        { relativePath: 'backlog/b.md', status: 'ready' },
        { relativePath: 'backlog/c.md', status: 'ready' },
      ],
    },
  })
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const removed = await orchestrator.removeStep({ ref: 'backlog/b.md' })
  assert.equal(removed.ok, true)
  assert.doesNotMatch(h.getRoadmap(), /- backlog\/b\.md/)

  const reordered = await orchestrator.reorderStep({ ref: 'backlog/c.md', toIndex: 0 })
  assert.equal(reordered.ok, true)
  const backendLane = h.getRoadmap().split('## Backend')[1]
  assert.ok(backendLane.indexOf('backlog/c.md') < backendLane.indexOf('backlog/a.md'))

  const gone = await orchestrator.removeStep({ ref: 'backlog/zzz.md' })
  assert.equal(gone.ok, false)
})

test('skipStep removes a step and records an audit comment; steerLane pauses a lane', async () => {
  const h = harness(roadmapFile('approve', 'manual', '## Backend\n- backlog/a.md\n- backlog/b.md'), {
    itemsByRoot: {
      [ROOT]: [
        { relativePath: 'backlog/a.md', status: 'ready' },
        { relativePath: 'backlog/b.md', status: 'ready' },
      ],
    },
  })
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const skipped = await orchestrator.skipStep({ ref: 'backlog/b.md', reason: 'superseded', actor: 'automation' })
  assert.equal(skipped.ok, true)
  assert.doesNotMatch(h.getRoadmap(), /- backlog\/b\.md/)
  assert.match(h.getRoadmap(), /<!-- skipped 2026-07-18: backlog\/b\.md — superseded -->/)
  assert.equal(h.audits.at(-1)?.action, 'skip')

  // A manual pause parks the lane; steerLane derives the roadmap ref itself.
  const paused = await orchestrator.steerLane('Backend', 'pause', 'automation')
  assert.equal(paused.ok, true)
  assert.equal(lane(h)?.parked?.reason, 'paused')
  assert.equal(h.audits.at(-1)?.action, 'pause')
})

// --- activate / create: single atomic plan-file mutations (MC-1718) --------------

const ACTIVE_STATUSES = new Set(['ready', 'in_progress', 'needs_input'])
const parseStatus = (content: string): string => /^status:\s*(\S+)/m.exec(content)?.[1] ?? 'idea'
// A roadmap file with no steps: the mutation ops touch only frontmatter, and an
// empty body keeps the trailing reconcile a harmless no-op.
const roadmapFileWith = (status: string, id: number): string =>
  `---\ntype: roadmap\nstatus: ${status}\nid: ${id}\nadvance: approve\nmerge: manual\n---\n\n`

// A harness for the plan-file mutations. Roadmap files live in one map keyed by
// relative path; their status is parsed back out of the on-disk content, so a write
// is observed exactly as the next read would see it. `failWriteOn` injects a write
// failure to drive the failure-mid-operation invariant.
function mutationHarness(options: {
  files?: Record<string, { status: string; id: number }>
  home?: string | null
  roots?: string[]
  failWriteOn?: (relativePath: string) => boolean
}): {
  ports: RoadmapOrchestratorPorts
  statusOf: (relativePath: string) => string
  exists: (relativePath: string) => boolean
  contentOf: (relativePath: string) => string | undefined
  activeCount: () => number
} {
  const home = options.home === undefined ? ROOT : options.home
  const contents = new Map<string, string>()
  for (const [rel, file] of Object.entries(options.files ?? {})) contents.set(rel, roadmapFileWith(file.status, file.id))
  const idByRef = new Map(Object.entries(options.files ?? {}).map(([rel, file]) => [rel, file.id]))

  const ports: RoadmapOrchestratorPorts = {
    getHomeProjectRoot: () => home,
    listWorkspaceRoots: () => options.roots ?? [ROOT],
    listBacklogItems: async (root) =>
      root === home
        ? [...contents.entries()].map(([relativePath, content]): RoadmapBacklogItem => ({
            relativePath,
            status: parseStatus(content) as RoadmapBacklogItem['status'],
            isRoadmap: true,
            ...(idByRef.has(relativePath) ? { numericId: idByRef.get(relativePath) } : {}),
          }))
        : [],
    readRoadmapFile: async (_root, relativePath) => contents.get(relativePath) ?? null,
    writeRoadmapFile: async (_root, relativePath, content) => {
      if (options.failWriteOn?.(relativePath)) throw new Error(`disk full writing ${relativePath}`)
      contents.set(relativePath, content)
    },
    appendAudit: async () => undefined,
    resolveExecutionLink: async () => null,
    observeRun: async () => null,
    mergePullRequest: async () => ({ ok: true }),
    startSprint: async () => ({ ok: true }),
    abandonRun: async () => undefined,
    readLaneRuntime: async () => new Map(),
    writeLaneRuntime: async () => undefined,
    notify: () => undefined,
    logDiagnostic: () => undefined,
    now: () => new Date('2026-07-18T12:00:00Z'),
  }

  return {
    ports,
    statusOf: (relativePath) => parseStatus(contents.get(relativePath) ?? ''),
    exists: (relativePath) => contents.has(relativePath),
    contentOf: (relativePath) => contents.get(relativePath),
    activeCount: () => [...contents.values()].filter((content) => ACTIVE_STATUSES.has(parseStatus(content))).length,
  }
}

test('activateRoadmap promotes the target and demotes every other active roadmap', async () => {
  const h = mutationHarness({
    files: {
      'backlog/roadmaps/current.md': { status: 'ready', id: 1 },
      'backlog/roadmaps/draft.md': { status: 'idea', id: 2 },
    },
  })
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const result = await orchestrator.activateRoadmap({ roadmapRef: 'backlog/roadmaps/draft.md' })
  assert.equal(result.ok, true)
  assert.equal(h.statusOf('backlog/roadmaps/draft.md'), 'ready')
  assert.equal(h.statusOf('backlog/roadmaps/current.md'), 'idea')
  assert.equal(h.activeCount(), 1)
})

// The load-bearing invariant (MC-1718): a write failure mid-operation must never
// strand ZERO active roadmaps. Promote-then-demote means the target is active
// before any demote, so a failed demote leaves TWO active (recoverable), never none.
test('activateRoadmap: a demote failure never strands zero active roadmaps', async () => {
  const h = mutationHarness({
    files: {
      'backlog/roadmaps/current.md': { status: 'ready', id: 1 },
      'backlog/roadmaps/draft.md': { status: 'idea', id: 2 },
    },
    // Fail the demote of the previously-active roadmap, after the target is promoted.
    failWriteOn: (relativePath) => relativePath === 'backlog/roadmaps/current.md',
  })
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const result = await orchestrator.activateRoadmap({ roadmapRef: 'backlog/roadmaps/draft.md' })
  assert.equal(result.ok, false)
  // The target was made active first, so it survives the failure...
  assert.equal(h.statusOf('backlog/roadmaps/draft.md'), 'ready')
  // ...and there is always at least one active roadmap — never zero.
  assert.ok(h.activeCount() >= 1, `expected >= 1 active roadmap, got ${h.activeCount()}`)
})

test('activateRoadmap rejects an unknown roadmap and a Multicode with no home', async () => {
  const missing = mutationHarness({ files: { 'backlog/roadmaps/a.md': { status: 'ready', id: 1 } } })
  const one = createRoadmapOrchestrator(missing.ports)
  assert.equal((await one.activateRoadmap({ roadmapRef: 'backlog/roadmaps/gone.md' })).ok, false)
  assert.equal(missing.statusOf('backlog/roadmaps/a.md'), 'ready')

  const noHome = mutationHarness({ home: null })
  assert.equal((await createRoadmapOrchestrator(noHome.ports).activateRoadmap({ roadmapRef: 'x.md' })).ok, false)
})

test('createRoadmap writes a draft, refuses an overwrite, and validates the project', async () => {
  const h = mutationHarness({})
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const created = await orchestrator.createRoadmap({ projectRoot: ROOT, name: 'My Plan' })
  assert.equal(created.ok, true)
  assert.ok(created.ok && /^backlog\/roadmaps\/\d{4}-\d{2}-\d{2}-my-plan\.md$/.test(created.roadmapRef))
  assert.ok(created.ok && h.exists(created.roadmapRef))
  // A fresh draft is idle, never active.
  assert.ok(created.ok && parseStatus(h.contentOf(created.roadmapRef) ?? '') === 'idea')

  // Same name again → refused, not silently overwritten.
  const again = await orchestrator.createRoadmap({ projectRoot: ROOT, name: 'My Plan' })
  assert.equal(again.ok, false)

  // No home set + a project that is not an open workspace → refused (fallback discipline).
  const noHome = mutationHarness({ home: null, roots: [ROOT] })
  const rejected = await createRoadmapOrchestrator(noHome.ports).createRoadmap({ projectRoot: '/w/unopened', name: 'X' })
  assert.equal(rejected.ok, false)
  assert.ok(!noHome.exists('backlog/roadmaps/2026-07-18-x.md'))
})
