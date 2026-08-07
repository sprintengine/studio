import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRoadmapOrchestrator,
  type RoadmapAuditEntry,
  type RoadmapBacklogItem,
  type RoadmapItemOutcome,
  type RoadmapMergeOutcome,
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
  // The FULL startSprint input, so a test can assert on staffing + permissions
  // rather than only on which item started (MC-1883, MC-1900).
  startInputs: Array<{ root: string; rel: string; roster?: string; permissionPreset: string }>
  // Injected start refusal (e.g. an unknown roster name), cleared when null.
  setStartFailure: (message: string | null) => void
  diagnostics: Array<{ level: string; title: string; message: string }>
  merges: string[]
  notices: Array<{ severity: string; title: string; body?: string }>
  audits: RoadmapAuditEntry[]
  // Every completed-on-merge write the orchestrator made (MC-1904), in order.
  statusWrites: Array<{ root: string; rel: string; status: string }>
  // Every abandonRun the orchestrator made — the path that must NEVER fire for the
  // same run a delivery does.
  abandons: Array<{ root: string; rel: string }>
  // Injected merge refusal; null means the merge succeeds.
  mergeFailure: RoadmapMergeOutcome | null
  setMergeFailure: (outcome: RoadmapMergeOutcome | null) => void
  // Per-run task→item mapping the delivered-on-merge write consults, keyed by
  // state path (MC-1904's honesty constraint).
  itemOutcomes: Map<string, Map<string, RoadmapItemOutcome>>
  getRoadmap: () => string
  setRoadmap: (content: string) => void
  roadmapFiles: Map<string, string>
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

  // MC-1901: horizon.create writes a NEW roadmap file, so the harness has to hold
  // more than one. Keyed by relative path; ROADMAP_REF is the pre-existing one.
  const roadmapFiles = new Map<string, string>([[ROADMAP_REF, initialRoadmap]])
  const links = new Map<string, RoadmapRunRef>()
  const runs = new Map<string, RoadmapRunSnapshot>()
  const store = new Map<string, Map<string, RoadmapLaneRuntime>>()
  const starts: string[] = []
  const startCalls: Array<{ root: string; rel: string }> = []
  const startInputs: Array<{ root: string; rel: string; roster?: string; permissionPreset: string }> = []
  const diagnostics: Array<{ level: string; title: string; message: string }> = []
  let startFailure: string | null = null
  const merges: string[] = []
  const notices: Array<{ severity: string; title: string; body?: string }> = []
  const audits: RoadmapAuditEntry[] = []
  const statusWrites: Array<{ root: string; rel: string; status: string }> = []
  const abandons: Array<{ root: string; rel: string }> = []
  const itemOutcomes = new Map<string, Map<string, RoadmapItemOutcome>>()
  let mergeFailure: RoadmapMergeOutcome | null = null

  const statePathFor = (root: string, rel: string): string =>
    `${root}/.multi-code/sprintengine/team-${rel.replace(/[^a-z]/g, '')}/run.yaml`

  const ports: RoadmapOrchestratorPorts = {
    getHomeProjectRoot: () => ROOT,
    listWorkspaceRoots: () => roots,
    listBacklogItems: async (root) => {
      const projItems = [...(itemsByRoot.get(root)?.values() ?? [])]
      if (root !== ROOT) return projItems
      // Each roadmap file reports its REAL frontmatter status, so activation
      // (promote one, demote the rest) is exercised rather than assumed.
      const roadmaps = [...roadmapFiles.entries()].map(([relativePath, content], index) => ({
        relativePath,
        status: (/^status:\s*(\S+)/m.exec(content)?.[1] ?? 'idea') as RoadmapBacklogItem['status'],
        isRoadmap: true,
        numericId: 100 + index,
      }))
      return [...roadmaps, ...projItems]
    },
    readRoadmapFile: async (_root, relativePath) => roadmapFiles.get(relativePath) ?? null,
    writeRoadmapFile: async (_root, relativePath, content) => {
      roadmapFiles.set(relativePath, content)
    },
    deleteRoadmapFile: async (_root, relativePath) => {
      roadmapFiles.delete(relativePath)
    },
    appendAudit: async (_roadmapRef, entry) => {
      audits.push(entry)
    },
    resolveExecutionLink: async (root, rel) => links.get(linkKey(root, rel)) ?? null,
    observeRun: async (runRef) => runs.get(runRef.statePath) ?? null,
    mergePullRequest: async (statePath) => {
      merges.push(statePath)
      if (mergeFailure) return mergeFailure
      const snapshot = runs.get(statePath)
      if (snapshot) runs.set(statePath, { ...snapshot, prAllMerged: true })
      return { ok: true }
    },
    readRunItemOutcomes: async (runRef) => new Map(itemOutcomes.get(runRef.statePath) ?? new Map()),
    setBacklogStatus: async (root, rel, status) => {
      statusWrites.push({ root, rel, status })
      const projItems = itemsByRoot.get(root)
      const item = projItems?.get(rel)
      if (item && projItems) projItems.set(rel, { ...item, status })
    },
    startSprint: async ({ workspaceRoot, itemRelativePath, roster, permissionPreset }) => {
      startInputs.push({
        root: workspaceRoot,
        rel: itemRelativePath,
        ...(roster !== undefined ? { roster } : {}),
        permissionPreset,
      })
      if (startFailure) return { ok: false, message: startFailure }
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
      abandons.push({ root, rel })
      links.delete(linkKey(root, rel))
      const projItems = itemsByRoot.get(root)
      const item = projItems?.get(rel)
      if (item && projItems) projItems.set(rel, { ...item, status: 'ready' })
    },
    readLaneRuntime: async (roadmapRef) => new Map(store.get(roadmapRef) ?? new Map()),
    writeLaneRuntime: async (roadmapRef, lanes) => {
      store.set(roadmapRef, new Map([...lanes].map(([k, v]) => [k, { ...v }])))
    },
    notify: (input) => notices.push({ severity: input.severity, title: input.title, ...(input.body ? { body: input.body } : {}) }),
    logDiagnostic: (input) => diagnostics.push({ level: input.level, title: input.title, message: input.message }),
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
    startInputs,
    diagnostics,
    setStartFailure: (message) => {
      startFailure = message
    },
    merges,
    notices,
    audits,
    statusWrites,
    abandons,
    itemOutcomes,
    get mergeFailure() {
      return mergeFailure
    },
    setMergeFailure: (outcome) => {
      mergeFailure = outcome
    },
    getRoadmap: () => roadmapFiles.get(ROADMAP_REF) ?? '',
    setRoadmap: (content) => {
      roadmapFiles.set(ROADMAP_REF, content)
    },
    roadmapFiles,
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
  assert.ok(h.notices.some((n) => n.title === 'Horizon paused'))
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
  assert.ok(h.notices.some((n) => n.title === 'Horizon paused'))

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
  assert.ok(h.notices.some((n) => n.title === 'Horizon ready to continue'))

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

test('addStep adds an epic as ONE bare step, capturing no membership', async () => {
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
  // Its members are members by their own `epic:` frontmatter; nothing about them
  // is written into the plan, so nothing can go stale (MC-2031).
  assert.doesNotMatch(h.getRoadmap(), /^\s+- /m)
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
  failDeleteOn?: (relativePath: string) => boolean
  // The persisted lane-runtime sidecar, keyed by roadmapRef then lane. Lets a
  // mutation test stand a horizon up with a live run on it without reconciling.
  laneRuntimes?: Record<string, Record<string, RoadmapLaneRuntime>>
  // Make the sidecar read fail, to drive the fail-closed branch of deleteRoadmap.
  failRuntimeRead?: boolean
}): {
  ports: RoadmapOrchestratorPorts
  runtimeWrites: Array<{ roadmapRef: string; lanes: string[] }>
  statusOf: (relativePath: string) => string
  exists: (relativePath: string) => boolean
  contentOf: (relativePath: string) => string | undefined
  activeCount: () => number
} {
  const home = options.home === undefined ? ROOT : options.home
  const contents = new Map<string, string>()
  for (const [rel, file] of Object.entries(options.files ?? {})) contents.set(rel, roadmapFileWith(file.status, file.id))
  const idByRef = new Map(Object.entries(options.files ?? {}).map(([rel, file]) => [rel, file.id]))
  const runtimeWrites: Array<{ roadmapRef: string; lanes: string[] }> = []

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
    deleteRoadmapFile: async (_root, relativePath) => {
      if (options.failDeleteOn?.(relativePath)) throw new Error(`permission denied deleting ${relativePath}`)
      contents.delete(relativePath)
    },
    appendAudit: async () => undefined,
    resolveExecutionLink: async () => null,
    observeRun: async () => null,
    mergePullRequest: async () => ({ ok: true }),
    readRunItemOutcomes: async () => new Map(),
    setBacklogStatus: async () => undefined,
    startSprint: async () => ({ ok: true }),
    abandonRun: async () => undefined,
    readLaneRuntime: async (roadmapRef) => {
      if (options.failRuntimeRead) throw new Error('sidecar unreadable')
      return new Map(Object.entries(options.laneRuntimes?.[roadmapRef] ?? {}))
    },
    writeLaneRuntime: async (roadmapRef, lanes) => {
      runtimeWrites.push({ roadmapRef, lanes: [...lanes.keys()] })
    },
    notify: () => undefined,
    logDiagnostic: () => undefined,
    now: () => new Date('2026-07-18T12:00:00Z'),
  }

  return {
    ports,
    runtimeWrites,
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

// --- MC-1917: deleting a horizon --------------------------------------------

test('deleteRoadmap removes the plan file and clears its lane-runtime sidecar', async () => {
  const h = mutationHarness({
    files: {
      'backlog/roadmaps/current.md': { status: 'ready', id: 1 },
      'backlog/roadmaps/draft.md': { status: 'idea', id: 2 },
    },
  })
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const result = await orchestrator.deleteRoadmap({ roadmapRef: 'backlog/roadmaps/draft.md' })
  assert.equal(result.ok, true)
  assert.ok(!h.exists('backlog/roadmaps/draft.md'))
  // Only the named plan goes; every other horizon is untouched.
  assert.ok(h.exists('backlog/roadmaps/current.md'))
  assert.equal(h.statusOf('backlog/roadmaps/current.md'), 'ready')
  // The sidecar is cleared alongside the file, so a later horizon that reuses this
  // ref can never inherit this one's parks and pending approvals.
  assert.deepEqual(
    h.runtimeWrites.filter((write) => write.roadmapRef === 'backlog/roadmaps/draft.md'),
    [{ roadmapRef: 'backlog/roadmaps/draft.md', lanes: [] }],
  )
})

// Deleting the plan under a live run would strand that run with nothing left to
// reconcile it against, and there is no undo for the file — so the op refuses and
// names the track rather than doing it.
test('deleteRoadmap refuses while a sprint is running on it, and names the track', async () => {
  const h = mutationHarness({
    files: { 'backlog/roadmaps/current.md': { status: 'ready', id: 1 } },
    laneRuntimes: {
      'backlog/roadmaps/current.md': {
        Delivery: { lane: 'Delivery', activeStatePath: '/w/app/.multi-code/run.yaml' },
      },
    },
  })

  const result = await createRoadmapOrchestrator(h.ports).deleteRoadmap({
    roadmapRef: 'backlog/roadmaps/current.md',
  })
  assert.equal(result.ok, false)
  assert.ok(result.message?.includes('Delivery'), `expected the track named, got: ${result.message}`)
  assert.ok(h.exists('backlog/roadmaps/current.md'))
})

// A PARKED lane holds no live run, so it is not a reason to refuse — the horizon
// the human wants gone is exactly the one that is stuck.
test('deleteRoadmap allows a horizon whose lanes are parked but not running', async () => {
  const h = mutationHarness({
    files: { 'backlog/roadmaps/current.md': { status: 'ready', id: 1 } },
    laneRuntimes: {
      'backlog/roadmaps/current.md': {
        Delivery: {
          lane: 'Delivery',
          parked: { reason: 'start_failed', itemRef: 'backlog/a.md', at: '2026-07-18T00:00:00Z' },
        },
      },
    },
  })

  assert.equal(
    (await createRoadmapOrchestrator(h.ports).deleteRoadmap({ roadmapRef: 'backlog/roadmaps/current.md' })).ok,
    true,
  )
  assert.ok(!h.exists('backlog/roadmaps/current.md'))
})

// The one roadmap op with no undo, so "couldn't check" must never read as
// "nothing is running": an unreadable sidecar refuses the delete.
test('deleteRoadmap fails CLOSED when it cannot tell whether a sprint is running', async () => {
  const h = mutationHarness({
    files: { 'backlog/roadmaps/current.md': { status: 'ready', id: 1 } },
    failRuntimeRead: true,
  })
  const result = await createRoadmapOrchestrator(h.ports).deleteRoadmap({
    roadmapRef: 'backlog/roadmaps/current.md',
  })
  assert.equal(result.ok, false)
  assert.ok(result.message?.includes('sidecar unreadable'))
  assert.ok(h.exists('backlog/roadmaps/current.md'))
})

test('deleteRoadmap is idempotent, and a failed unlink is reported rather than swallowed', async () => {
  // Already gone is the caller's intent, not a failure: two windows racing the same
  // delete must not surface an error to the second.
  const gone = mutationHarness({ files: { 'backlog/roadmaps/a.md': { status: 'ready', id: 1 } } })
  assert.equal(
    (await createRoadmapOrchestrator(gone.ports).deleteRoadmap({ roadmapRef: 'backlog/roadmaps/gone.md' })).ok,
    true,
  )
  assert.ok(gone.exists('backlog/roadmaps/a.md'))

  const denied = mutationHarness({
    files: { 'backlog/roadmaps/a.md': { status: 'ready', id: 1 } },
    failDeleteOn: (relativePath) => relativePath === 'backlog/roadmaps/a.md',
  })
  const failed = await createRoadmapOrchestrator(denied.ports).deleteRoadmap({
    roadmapRef: 'backlog/roadmaps/a.md',
  })
  assert.equal(failed.ok, false)
  assert.ok(failed.message?.includes('permission denied'))
  assert.ok(denied.exists('backlog/roadmaps/a.md'))

  const noHome = mutationHarness({ home: null })
  assert.equal((await createRoadmapOrchestrator(noHome.ports).deleteRoadmap({ roadmapRef: 'x.md' })).ok, false)
})

// --- MC-1909: the lane merge path ------------------------------------------

test('a merge refusal parks with the repo, branch and reason, and notifies', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed' })
  h.setMergeFailure({ ok: false, message: 'gh: merge conflict with base branch', repo: 'multicode', branch: 'sprintengine/alpha' })

  await orchestrator.reconcile()

  const parked = lane(h)?.parked
  assert.equal(parked?.reason, 'merge_failed')
  assert.equal(parked?.detail, 'multicode (sprintengine/alpha): gh: merge conflict with base branch')
  const notice = h.notices.find((n) => n.title === 'Horizon paused')
  assert.ok(notice, 'a merge failure on an unwatched horizon must notify')
  assert.match(notice?.body ?? '', /multicode \(sprintengine\/alpha\): gh: merge conflict with base branch/)
})

test('resume after a merge failure retries THE MERGE and never abandons the delivered run', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed' })
  h.setMergeFailure({ ok: false, message: 'the main checkout was on another branch' })
  await orchestrator.reconcile()
  assert.equal(lane(h)?.parked?.reason, 'merge_failed')

  const startsBefore = h.starts.length
  const mergesBefore = h.merges.length
  h.setMergeFailure(null)
  const resumed = await orchestrator.resumeLane(ROADMAP_REF, 'Backend')

  assert.equal(resumed.ok, true)
  assert.equal(h.merges.length, mergesBefore + 1, 'resume must retry the merge')
  assert.deepEqual(h.abandons, [], 'a delivered run is never abandoned')
  assert.equal(h.starts.length, startsBefore, 'no fresh sprint is planned over a delivered run')
  assert.equal(lane(h)?.parked, undefined)
  // Still linked to the run it delivered — resume did not throw the run away.
  assert.ok(h.links.has(linkKey(ROOT, 'backlog/a.md')))
})

test('a merge retry that fails again re-parks with THIS attempt’s reason', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed' })
  h.setMergeFailure({ ok: false, message: 'first reason', repo: 'multicode', branch: 'b' })
  await orchestrator.reconcile()

  h.setMergeFailure({ ok: false, message: 'second reason', repo: 'multicode', branch: 'b' })
  const resumed = await orchestrator.resumeLane(ROADMAP_REF, 'Backend')

  assert.equal(resumed.ok, false)
  assert.match(resumed.message ?? '', /second reason/)
  assert.equal(lane(h)?.parked?.detail, 'multicode (b): second reason')
  assert.deepEqual(h.abandons, [])
})

test('resume over a COMPLETED run asks first, then re-plans only when confirmed', async () => {
  // A needs_input park whose run then completed: the abandon path, guarded.
  const h = harness(roadmapFile('auto', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'needs_input_user' })
  await orchestrator.reconcile()
  assert.equal(lane(h)?.parked?.reason, 'needs_input')

  // The run finished while parked — resuming would discard it.
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed' })
  const refused = await orchestrator.resumeLane(ROADMAP_REF, 'Backend')
  assert.equal(refused.ok, false)
  assert.equal(refused.confirm, 'replan_delivered_run')
  assert.deepEqual(h.abandons, [])
  assert.equal(lane(h)?.parked?.reason, 'needs_input', 'a refused resume changes nothing')

  const confirmed = await orchestrator.resumeLane(ROADMAP_REF, 'Backend', 'user', { replanDeliveredRun: true })
  assert.equal(confirmed.ok, true)
  assert.deepEqual(h.abandons, [{ root: ROOT, rel: 'backlog/a.md' }])
})

test('resume over a DEAD run still abandons without asking', async () => {
  const h = harness(roadmapFile('auto', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'failed' })
  await orchestrator.reconcile()

  const resumed = await orchestrator.resumeLane(ROADMAP_REF, 'Backend')
  assert.equal(resumed.ok, true)
  assert.equal(resumed.confirm, undefined)
  assert.deepEqual(h.abandons, [{ root: ROOT, rel: 'backlog/a.md' }])
})

// --- MC-1904: delivered work reads completed --------------------------------

// A roadmap whose single step is an epic with two snapshotted members.
// An epic step is a BARE reference (MC-2031); `login`/`logout` are its members
// purely by their own `epic: auth` frontmatter below.
const EPIC_LANE = '## Backend\n- backlog/epics/auth.md'
const EPIC_ITEMS: RoadmapBacklogItem[] = [
  { relativePath: 'backlog/epics/auth.md', status: 'ready', isEpic: true, title: 'Auth' },
  { relativePath: 'backlog/login.md', status: 'ready', epic: 'auth', title: 'Login' },
  { relativePath: 'backlog/logout.md', status: 'ready', epic: 'auth', title: 'Logout' },
]

test('an epic step that delivers flips its MEMBERS to completed, never the epic file', async () => {
  const h = harness(roadmapFile('auto', 'auto', EPIC_LANE), { itemsByRoot: { [ROOT]: EPIC_ITEMS } })
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/epics/auth.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed' })

  await orchestrator.reconcile() // auto-merge → delivery

  assert.deepEqual(
    h.statusWrites.map((write) => write.rel).sort(),
    ['backlog/login.md', 'backlog/logout.md'],
  )
  assert.ok(h.statusWrites.every((write) => write.status === 'completed' && write.root === ROOT))
  // The epic derives its status from its members; writing it directly would paper
  // over that derivation.
  assert.ok(!h.statusWrites.some((write) => write.rel === 'backlog/epics/auth.md'))
})

test('a member the run did not deliver stays un-flipped', async () => {
  const h = harness(roadmapFile('auto', 'auto', EPIC_LANE), { itemsByRoot: { [ROOT]: EPIC_ITEMS } })
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/epics/auth.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed' })
  h.itemOutcomes.set(statePath, new Map([['backlog/logout.md', 'skipped']]))

  await orchestrator.reconcile()

  assert.deepEqual(h.statusWrites.map((write) => write.rel), ['backlog/login.md'])
  assert.equal(h.itemsByRoot.get(ROOT)?.get('backlog/logout.md')?.status, 'ready')
})

test('an ITEM step flips itself completed on merge', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed' })

  await orchestrator.reconcile()

  assert.deepEqual(h.statusWrites, [{ root: ROOT, rel: 'backlog/a.md', status: 'completed' }])
})

test('a shared run delivers on completion, with no PR to merge', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'shared', lifecycle: 'completed' })

  await orchestrator.reconcile()

  assert.equal(h.merges.length, 0)
  assert.deepEqual(h.statusWrites, [{ root: ROOT, rel: 'backlog/a.md', status: 'completed' }])
})

test('a run that VANISHES marks nothing completed', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.delete(statePath)
  h.links.delete(linkKey(ROOT, 'backlog/a.md'))

  // One missed tick is NOT proof of deletion — a live run can be invisible for a
  // tick (projection not loaded, workspace not restored). Releasing the handle
  // here is what started a second sprint beside a live one (MC-2178), so the
  // lane holds on and starts nothing.
  await orchestrator.reconcile()
  assert.notEqual(lane(h)?.activeItemRef, undefined, 'handle survives a single miss')
  assert.deepEqual(h.starts, ['backlog/a.md'], 'and above all: no SECOND run is started')

  // Still gone on the next tick — now it is real, and the lane recovers.
  await orchestrator.reconcile()

  assert.equal(lane(h)?.activeItemRef, undefined)
  assert.deepEqual(h.statusWrites, [], 'nothing shipped, so nothing may read as shipped')
})

test('cancel/abandon and delivered-on-merge never both fire for one run', async () => {
  const h = harness(roadmapFile('auto', 'auto'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/a.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'canceled' })

  await orchestrator.reconcile()
  assert.equal(lane(h)?.parked?.reason, 'run_canceled')
  assert.deepEqual(h.statusWrites, [])

  await orchestrator.resumeLane(ROADMAP_REF, 'Backend')
  assert.deepEqual(h.abandons, [{ root: ROOT, rel: 'backlog/a.md' }])
  assert.deepEqual(h.statusWrites, [], 'the abandoned run never marks its items completed')
})

// --- SEAM: MC-1909 x MC-1904 ------------------------------------------------

test('SEAM: a lane merge — including one recovered by resume — flips the epic members', async () => {
  // The two items meeting: 1909 owns the merge path, 1904 owns the write that
  // follows a merge. This drives the whole recovery the owner had to do by hand —
  // merge refused, lane parked, human resumes, merge lands, members read completed —
  // through the orchestrator, and asserts the BACKLOG, not the lane runtime.
  const h = harness(roadmapFile('auto', 'auto', EPIC_LANE), { itemsByRoot: { [ROOT]: EPIC_ITEMS } })
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/epics/auth.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed' })
  h.setMergeFailure({ ok: false, message: 'gh: base branch was modified', repo: 'multicode', branch: 'sprintengine/auth' })

  // 1. The auto-merge is refused: the lane parks, saying what failed.
  await orchestrator.reconcile()
  assert.equal(lane(h)?.parked?.detail, 'multicode (sprintengine/auth): gh: base branch was modified')
  assert.deepEqual(h.statusWrites, [], 'an unmerged step marks nothing completed')

  // 2. The human resumes. The merge lands this time.
  h.setMergeFailure(null)
  const resumed = await orchestrator.resumeLane(ROADMAP_REF, 'Backend')
  assert.equal(resumed.ok, true)

  // 3. The members read completed in the backlog — the end of the manual rescue.
  const items = h.itemsByRoot.get(ROOT)
  assert.equal(items?.get('backlog/login.md')?.status, 'completed')
  assert.equal(items?.get('backlog/logout.md')?.status, 'completed')
  assert.deepEqual(h.abandons, [])

  // 4. And the lane moves on: the epic derives completed from its members, so the
  //    board reads the step done rather than still holding the frontier.
  await orchestrator.reconcile()
  assert.equal(lane(h)?.activeItemRef, undefined)
  const board = await orchestrator.readBoard()
  assert.equal(board?.lanes[0].units[0].state, 'done')
  assert.deepEqual(board?.lanes[0].units[0].children?.map((child) => child.done), [true, true])
  assert.equal(board?.lanes[0].doneCount, 1)
})

test('a lane still keyed on an epic MEMBER (pre-step-granularity) marks that member, not nothing', async () => {
  // The migration case the substrate's own `isMerged` guard exists for: a lane
  // runtime written when runs were keyed per member. Matching only top-level steps
  // would mark nothing and say nothing — a delivery that quietly does not land.
  const h = harness(roadmapFile('auto', 'auto', EPIC_LANE), { itemsByRoot: { [ROOT]: EPIC_ITEMS } })
  const statePath = `${ROOT}/.multi-code/sprintengine/team-legacy/run.yaml`
  h.store.set(
    ROADMAP_REF,
    new Map([
      [
        'Backend',
        {
          lane: 'Backend',
          activeItemRef: qref('backlog/login.md'),
          activeStatePath: statePath,
          activeTeamSlug: 'team-legacy',
          activeRepoId: ROOT,
        },
      ],
    ]),
  )
  h.links.set(linkKey(ROOT, 'backlog/login.md'), { statePath, teamSlug: 'team-legacy' })
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed', prAllMerged: true })

  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()

  assert.deepEqual(h.statusWrites, [{ root: ROOT, rel: 'backlog/login.md', status: 'completed' }])
})

test('SEAM: a restart between the merge and the completion write still marks the members', async () => {
  // The kill/restart property, applied to the new write. The merge lands, then the
  // process dies before anything is recorded. A FRESH orchestrator re-derives from
  // the persisted lane runtime + the run's own PR state and completes the job —
  // which is why the delivery write lives on the reducer's `clear_active` and not
  // only inside the merge action.
  const h = harness(roadmapFile('auto', 'manual', EPIC_LANE), { itemsByRoot: { [ROOT]: EPIC_ITEMS } })
  const first = createRoadmapOrchestrator(h.ports)
  await first.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/epics/auth.md'))!.statePath

  // The PR merged out-of-band (on GitHub, or by the merge that raced the crash);
  // nothing was written to the backlog.
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed', prAllMerged: true })
  // Length, not `deepEqual(…, [])`: under `assert/strict` deepEqual carries an
  // `asserts actual is T` signature, which would narrow statusWrites to never[]
  // for the rest of this scope and break the real assertion below.
  assert.equal(h.statusWrites.length, 0)

  const afterRestart = createRoadmapOrchestrator(h.ports)
  await afterRestart.reconcile()

  assert.deepEqual(
    h.statusWrites.map((write) => write.rel).sort(),
    ['backlog/login.md', 'backlog/logout.md'],
  )
  assert.equal(lane(h)?.activeItemRef, undefined)
})

test('SEAM: the completion write is idempotent — a second reconcile re-asserts, never double-counts', async () => {
  const h = harness(roadmapFile('auto', 'auto', EPIC_LANE), { itemsByRoot: { [ROOT]: EPIC_ITEMS } })
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  const statePath = h.links.get(linkKey(ROOT, 'backlog/epics/auth.md'))!.statePath
  h.runs.set(statePath, { mode: 'worktree', lifecycle: 'completed' })

  await orchestrator.reconcile() // merge → delivery recorded here
  const afterMerge = h.statusWrites.length
  await orchestrator.reconcile() // clear_active → delivery re-asserted, same values
  await orchestrator.reconcile()

  const items = h.itemsByRoot.get(ROOT)
  assert.equal(items?.get('backlog/login.md')?.status, 'completed')
  assert.equal(items?.get('backlog/logout.md')?.status, 'completed')
  // Re-asserting is fine; changing its mind is not.
  assert.ok(h.statusWrites.every((write) => write.status === 'completed'))
  assert.ok(h.statusWrites.length >= afterMerge)
})

// ---------------------------------------------------------------------------
// Per-step roster + permissions reach the launch (MC-1883, MC-1900)
// ---------------------------------------------------------------------------

const STAFFED_BODY = '## Backend\n- backlog/a.md  @roster=Mobile UI\n- backlog/b.md'

test('SEAM(1881x1883): the driver forwards the RESOLVED per-step roster to startSprint', async () => {
  const h = harness(roadmapFile('auto', 'manual', STAFFED_BODY, 'roster: General agents\n'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  // Step a overrides…
  await orchestrator.reconcile()
  assert.equal(h.startInputs.at(-1)?.rel, 'backlog/a.md')
  assert.equal(h.startInputs.at(-1)?.roster, 'Mobile UI')
  assert.equal(lane(h)?.activeRoster, 'Mobile UI')

  // …and its sibling, which does not, starts with the horizon's roster.
  setItem(h, ROOT, { relativePath: 'backlog/a.md', status: 'completed' })
  h.runs.set([...h.links.values()][0].statePath, { mode: 'shared', lifecycle: 'completed' })
  await orchestrator.reconcile()
  await orchestrator.reconcile()
  assert.equal(h.startInputs.at(-1)?.rel, 'backlog/b.md')
  assert.equal(h.startInputs.at(-1)?.roster, 'General agents')
  assert.equal(lane(h)?.activeRoster, 'General agents')
})

test('SEAM(1900x1883): a step launches with its own roster AND the horizon permission preset', async () => {
  const h = harness(roadmapFile('auto', 'manual', STAFFED_BODY, 'permissions: auto_workspace\n'))
  await createRoadmapOrchestrator(h.ports).reconcile()
  assert.deepEqual(h.startInputs, [
    { root: ROOT, rel: 'backlog/a.md', roster: 'Mobile UI', permissionPreset: 'auto_workspace' },
  ])
})

test('SEAM(1900x1883): a horizon with NO permissions policy spawns in bypass', async () => {
  const h = harness(roadmapFile('auto', 'manual', STAFFED_BODY))
  await createRoadmapOrchestrator(h.ports).reconcile()
  assert.equal(h.startInputs.at(-1)?.permissionPreset, 'bypass_all')
})

test('a typo in the permissions policy reads as unset (bypass), never as a third thing', async () => {
  const h = harness(roadmapFile('auto', 'manual', STAFFED_BODY, 'permissions: bypasss\n'))
  await createRoadmapOrchestrator(h.ports).reconcile()
  assert.equal(h.startInputs.at(-1)?.permissionPreset, 'bypass_all')
})

test('an unknown roster fails the start loudly: park + diagnostic, and the lane does NOT advance', async () => {
  const h = harness(roadmapFile('auto', 'manual', STAFFED_BODY))
  h.setStartFailure('Saved roster "Mobile UI" was not found.')
  const orchestrator = createRoadmapOrchestrator(h.ports)

  await orchestrator.reconcile()
  // It was attempted with the step's roster…
  assert.equal(h.startInputs.at(-1)?.roster, 'Mobile UI')
  // …no run was created…
  assert.deepEqual(h.starts, [])
  // …no execution link was written, so nothing can later adopt a phantom run…
  assert.equal(h.links.size, 0)
  // …the lane parked rather than advancing to the next step…
  assert.equal(lane(h)?.parked?.reason, 'start_failed')
  assert.equal(lane(h)?.parked?.itemRef, qref('backlog/a.md'))
  // …and it is visible in the UI, not just a console warning.
  assert.equal(h.notices.at(-1)?.title, 'Horizon paused')
  const diagnostic = h.diagnostics.at(-1)
  assert.equal(diagnostic?.title, 'Horizon step could not start')
  assert.match(diagnostic?.message ?? '', /Mobile UI/)

  // A parked lane never auto-unparks, so step b is never reached.
  await orchestrator.reconcile()
  assert.deepEqual(h.starts, [])
})

test('editing the horizon roster mid-run does not rewrite the running step’s recorded roster', async () => {
  const h = harness(roadmapFile('auto', 'manual', '## Backend\n- backlog/a.md\n- backlog/b.md', 'roster: General agents\n'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  assert.equal(lane(h)?.activeRoster, 'General agents')

  // The author restaffs the horizon while step a is still executing.
  h.setRoadmap(roadmapFile('auto', 'manual', '## Backend\n- backlog/a.md\n- backlog/b.md', 'roster: Mobile UI\n'))
  await orchestrator.reconcile()

  // The board must report what the run was STARTED with, not what the file says
  // now — the run's agents cannot be restaffed after the fact.
  assert.equal(lane(h)?.activeRoster, 'General agents')
  assert.equal(h.startInputs.length, 1)
})

test('a resumed lane drops the roster with the rest of the dead active handle', async () => {
  const h = harness(roadmapFile('auto', 'manual', STAFFED_BODY))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.reconcile()
  assert.equal(lane(h)?.activeRoster, 'Mobile UI')

  // The run fails; the lane parks; a human resumes it.
  h.runs.set([...h.links.values()][0].statePath, { mode: 'worktree', lifecycle: 'failed' })
  await orchestrator.reconcile()
  assert.equal(lane(h)?.parked?.reason, 'run_failed')
  await orchestrator.resumeLane(ROADMAP_REF, 'Backend', 'user')
  await orchestrator.reconcile()

  // Resume re-plans a fresh sprint, so the roster is re-resolved from the file
  // rather than inherited from the dead handle.
  assert.equal(h.startInputs.at(-1)?.roster, 'Mobile UI')
  assert.equal(h.startInputs.length, 2)
})

// ---------------------------------------------------------------------------
// Horizon authoring over MCP (MC-1901)
// ---------------------------------------------------------------------------

test('horizon.configure: a policy write leaves the plan body byte-identical', async () => {
  const h = harness(roadmapFile('approve', 'manual'))
  const before = h.getRoadmap()
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const outcome = await orchestrator.configureHorizon({
    policy: { roster: 'Mobile UI', permissions: 'bypass_all', merge: 'auto' },
  })
  assert.equal(outcome.ok, true)

  const after = h.getRoadmap()
  const bodyOf = (content: string): string => content.slice(content.indexOf('\n---\n') + 5)
  assert.equal(bodyOf(after), bodyOf(before), 'the plan must not be perturbed by a policy write')
  assert.match(after, /roster: Mobile UI/)
  assert.match(after, /permissions: bypass_all/)
  assert.match(after, /merge: auto/)
  // Unrelated frontmatter survives.
  assert.match(after, /id: 100/)
})

test('horizon.configure: clearing the roster removes the key, and an invalid value is refused', async () => {
  const h = harness(roadmapFile('approve', 'manual', '## Backend\n- backlog/a.md', 'roster: Mobile UI\n'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const bad = await orchestrator.configureHorizon({ policy: { permissions: 'bypass' as never } })
  assert.equal(bad.ok, false)
  assert.match(bad.message ?? '', /permissions must be/)
  assert.match(h.getRoadmap(), /roster: Mobile UI/, 'a refused write changes nothing')

  const cleared = await orchestrator.configureHorizon({ policy: { roster: undefined } })
  assert.equal(cleared.ok, true)
  assert.doesNotMatch(h.getRoadmap(), /roster:/)
})

test('horizon.create: lands advance approve and starts NOTHING, even with a ready plan', async () => {
  const h = harness(roadmapFile('auto', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const created = await orchestrator.createHorizon({
    name: 'Payments',
    steps: ['backlog/a.md', 'backlog/b.md'],
    // The caller ASKS for auto and does not pass `start` — the write must still
    // be gated. This is the live incident this default exists to prevent.
    policy: { advance: 'auto', roster: 'Mobile UI' },
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.advance, 'approve')
  assert.deepEqual(created.steps, ['backlog/a.md', 'backlog/b.md'])

  const written = h.roadmapFiles.get(created.roadmapRef) ?? ''
  assert.match(written, /advance: approve/)
  assert.match(written, /roster: Mobile UI/)
  assert.match(written, /- backlog\/a\.md/)
  // It is the ACTIVE horizon (so it is steerable), and the previous one was demoted.
  assert.match(written, /status: ready/)
  assert.match(h.roadmapFiles.get(ROADMAP_REF) ?? '', /status: idea/)

  // The decisive assertion: creating it spawned nothing.
  assert.deepEqual(h.starts, [])
  await orchestrator.reconcile()
  assert.deepEqual(h.starts, [], 'a created horizon must not start on the next tick either')
})

test('horizon.create: `start: true` is the single explicit exception', async () => {
  const h = harness(roadmapFile('approve', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const created = await orchestrator.createHorizon({
    name: 'Now please',
    steps: ['backlog/a.md'],
    start: true,
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.advance, 'auto')
  assert.match(h.roadmapFiles.get(created.roadmapRef) ?? '', /advance: auto/)

  await orchestrator.reconcile()
  assert.deepEqual(h.starts, ['backlog/a.md'])
})

test('horizon.create: an unknown step ref is rejected and named, not silently dropped', async () => {
  const h = harness(roadmapFile('approve', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  const before = new Set(h.roadmapFiles.keys())
  const activeBefore = h.getRoadmap()

  const created = await orchestrator.createHorizon({ name: 'Typo', steps: ['backlog/a.md', 'backlog/nope.md'] })
  assert.equal(created.ok, false)
  if (created.ok) return
  assert.match(created.message, /backlog\/nope\.md/)

  // And the refusal is a NO-OP, not a half-built horizon: every step is checked
  // BEFORE anything is written, so a typo in the second step cannot leave a new
  // active horizon on disk with the first step in it and the old one demoted.
  assert.match(created.message, /Nothing was created/)
  assert.deepEqual(new Set(h.roadmapFiles.keys()), before, 'no file may be created')
  assert.equal(h.getRoadmap(), activeBefore, 'the previously-active horizon must not be demoted')
})

test('horizon.create: an invalid policy value is refused before any file is written', async () => {
  const h = harness(roadmapFile('approve', 'manual'))
  const before = new Set(h.roadmapFiles.keys())
  const created = await createRoadmapOrchestrator(h.ports).createHorizon({
    name: 'Bad',
    policy: { merge: 'sometimes' as never },
  })
  assert.equal(created.ok, false)
  assert.deepEqual(new Set(h.roadmapFiles.keys()), before, 'no file may be created by a refused call')
})

test('horizon.create + configure are audited as agent actions', async () => {
  const h = harness(roadmapFile('approve', 'manual'))
  const orchestrator = createRoadmapOrchestrator(h.ports)
  await orchestrator.createHorizon({ name: 'Audited', steps: ['backlog/a.md'], actor: 'automation' })
  await orchestrator.configureHorizon({ policy: { merge: 'auto' }, actor: 'automation' })
  const actions = h.audits.map((entry) => entry.action)
  assert.ok(actions.includes('add_step'), 'the step add is audited')
  assert.ok(actions.includes('configure'), 'the policy write is audited')
  assert.ok(h.audits.every((entry) => entry.actor === 'automation'))
})

test('SEAM(1900x1808): adopting a LIVE run never re-starts it, so no preset flip is attempted', async () => {
  const h = harness(roadmapFile('auto', 'manual', STAFFED_BODY, 'permissions: default\n'))
  const orchestrator = createRoadmapOrchestrator(h.ports)

  // First tick starts the step under the horizon's gated policy.
  await orchestrator.reconcile()
  assert.equal(h.startInputs.length, 1)
  assert.equal(h.startInputs[0].permissionPreset, 'default')

  // The author now flips the horizon to bypass while that run is executing.
  h.setRoadmap(roadmapFile('auto', 'manual', STAFFED_BODY, 'permissions: bypass_all\n'))
  await orchestrator.reconcile()
  await orchestrator.reconcile()

  // Bypass is spawn-time-only (MC-1808): the live run is adopted through its
  // execution link, NOT restarted, so nothing tries to change its agents'
  // preset. A run started gated stays gated until it is cancelled and relaunched.
  assert.equal(h.startInputs.length, 1, 'a live run must never be re-started to change its permissions')
  assert.deepEqual(h.starts, ['backlog/a.md'])
})
