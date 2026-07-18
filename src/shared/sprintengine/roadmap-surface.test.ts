import assert from 'node:assert/strict'

import { parseRoadmap } from '../backlog/roadmap'
import type { BacklogItemStatusPayload } from '../electron-api'
import type { SprintEngineVcsRepo } from './run-types'
import {
  buildRoadmapBoardModel,
  deriveRepoMergeBlockers,
  skipRoadmapEntry,
  type RoadmapBoardItemInfo,
  type RoadmapLaneStateView,
} from './roadmap-surface'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// A two-lane roadmap: Backend runs three loose items, Platform runs an epic
// (two snapshotted children) then a loose item.
const ROADMAP = parseRoadmap(
  `---
type: roadmap
---
# Platform roadmap

## Backend
- backlog/foo.md
- backlog/bar.md
- backlog/baz.md

## Platform
- backlog/epics/auth.md
  - backlog/auth-1.md
  - backlog/auth-2.md
- backlog/ship.md
`,
)

function infoMap(entries: Record<string, { status: BacklogItemStatusPayload; title?: string; prUrl?: string }>) {
  return (ref: string): RoadmapBoardItemInfo | undefined => {
    const found = entries[ref]
    if (!found) return undefined
    return { status: found.status, title: found.title ?? ref, ...(found.prUrl ? { prUrl: found.prUrl } : {}) }
  }
}

run('board: frontier splits done from up next; running overlay wins', () => {
  const info = infoMap({
    'backlog/foo.md': { status: 'completed', prUrl: 'https://gh/pr/1' },
    'backlog/bar.md': { status: 'in_progress' },
    'backlog/baz.md': { status: 'ready' },
    'backlog/epics/auth.md': { status: 'ready' },
    'backlog/auth-1.md': { status: 'ready' },
    'backlog/auth-2.md': { status: 'ready' },
    'backlog/ship.md': { status: 'ready' },
  })
  const runtime = new Map<string, RoadmapLaneStateView>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/bar.md', activeStatePath: '/runs/bar/run.yaml' }],
  ])
  const lanes = buildRoadmapBoardModel(ROADMAP, info, runtime)
  const backend = lanes.find((lane) => lane.lane === 'Backend')
  assert.ok(backend)
  // foo delivered, bar running (runtime overlay), baz queued behind the frontier.
  assert.equal(backend.units[0].state, 'done')
  assert.equal(backend.units[0].prUrl, 'https://gh/pr/1')
  assert.equal(backend.units[1].state, 'running')
  assert.equal(backend.units[2].state, 'queued')
  assert.equal(backend.doneCount, 1)
  assert.equal(backend.total, 3)
  assert.equal(backend.runningRef, 'backlog/bar.md')
  assert.equal(backend.activeStatePath, '/runs/bar/run.yaml')
})

run('board: eligible frontier is up_next with no runtime', () => {
  const info = infoMap({
    'backlog/foo.md': { status: 'completed' },
    'backlog/bar.md': { status: 'ready' },
    'backlog/baz.md': { status: 'ready' },
    'backlog/epics/auth.md': { status: 'ready' },
    'backlog/auth-1.md': { status: 'ready' },
    'backlog/auth-2.md': { status: 'ready' },
    'backlog/ship.md': { status: 'ready' },
  })
  const lanes = buildRoadmapBoardModel(ROADMAP, info, new Map())
  const backend = lanes.find((lane) => lane.lane === 'Backend')
  assert.ok(backend)
  assert.equal(backend.units[1].state, 'up_next')
  assert.equal(backend.upNextRef, 'backlog/bar.md')
  assert.equal(backend.reason, 'eligible')
  assert.equal(backend.attention, 'none')
})

run('board: epic children flatten into the lane in order', () => {
  const info = infoMap({
    'backlog/foo.md': { status: 'ready' },
    'backlog/bar.md': { status: 'ready' },
    'backlog/baz.md': { status: 'ready' },
    'backlog/epics/auth.md': { status: 'ready' },
    'backlog/auth-1.md': { status: 'completed' },
    'backlog/auth-2.md': { status: 'ready' },
    'backlog/ship.md': { status: 'ready' },
  })
  const lanes = buildRoadmapBoardModel(ROADMAP, info, new Map())
  const platform = lanes.find((lane) => lane.lane === 'Platform')
  assert.ok(platform)
  // auth-1 done, auth-2 up next, ship queued.
  assert.equal(platform.units[0].ref, 'backlog/auth-1.md')
  assert.equal(platform.units[0].epicRef, 'backlog/epics/auth.md')
  assert.equal(platform.units[0].state, 'done')
  assert.equal(platform.units[1].state, 'up_next')
  assert.equal(platform.units[2].ref, 'backlog/ship.md')
  assert.equal(platform.units[2].state, 'queued')
})

run('board: pending approval surfaces attention=approval', () => {
  const info = infoMap({
    'backlog/foo.md': { status: 'completed' },
    'backlog/bar.md': { status: 'ready' },
    'backlog/baz.md': { status: 'ready' },
    'backlog/epics/auth.md': { status: 'ready' },
    'backlog/auth-1.md': { status: 'ready' },
    'backlog/auth-2.md': { status: 'ready' },
    'backlog/ship.md': { status: 'ready' },
  })
  const runtime = new Map<string, RoadmapLaneStateView>([
    ['Backend', { lane: 'Backend', pendingApprovalRef: 'backlog/bar.md' }],
  ])
  const backend = buildRoadmapBoardModel(ROADMAP, info, runtime).find((lane) => lane.lane === 'Backend')
  assert.ok(backend)
  assert.equal(backend.attention, 'approval')
  assert.equal(backend.pendingApprovalRef, 'backlog/bar.md')
})

run('board: a still-active delivered item reads attention=merge (awaiting human merge)', () => {
  const info = infoMap({
    'backlog/foo.md': { status: 'completed' },
    // bar delivered (terminal) but the lane still holds it active → awaiting merge.
    'backlog/bar.md': { status: 'completed' },
    'backlog/baz.md': { status: 'ready' },
    'backlog/epics/auth.md': { status: 'ready' },
    'backlog/auth-1.md': { status: 'ready' },
    'backlog/auth-2.md': { status: 'ready' },
    'backlog/ship.md': { status: 'ready' },
  })
  const runtime = new Map<string, RoadmapLaneStateView>([
    ['Backend', { lane: 'Backend', activeItemRef: 'backlog/bar.md', activeStatePath: '/runs/bar/run.yaml' }],
  ])
  const backend = buildRoadmapBoardModel(ROADMAP, info, runtime).find((lane) => lane.lane === 'Backend')
  assert.ok(backend)
  assert.equal(backend.attention, 'merge')
})

run('board: parked lane marks its item paused and attention=paused', () => {
  const info = infoMap({
    'backlog/foo.md': { status: 'completed' },
    'backlog/bar.md': { status: 'in_progress' },
    'backlog/baz.md': { status: 'ready' },
    'backlog/epics/auth.md': { status: 'ready' },
    'backlog/auth-1.md': { status: 'ready' },
    'backlog/auth-2.md': { status: 'ready' },
    'backlog/ship.md': { status: 'ready' },
  })
  const runtime = new Map<string, RoadmapLaneStateView>([
    ['Backend', { lane: 'Backend', parked: { reason: 'run_failed', itemRef: 'backlog/bar.md', at: '2026-07-18T00:00:00Z' } }],
  ])
  const backend = buildRoadmapBoardModel(ROADMAP, info, runtime).find((lane) => lane.lane === 'Backend')
  assert.ok(backend)
  assert.equal(backend.attention, 'paused')
  assert.equal(backend.units[1].state, 'paused')
})

run('board: dangling frontier reads unknown, never dropped', () => {
  const info = infoMap({
    'backlog/foo.md': { status: 'completed' },
    // bar is missing from the backlog universe (dangling).
    'backlog/baz.md': { status: 'ready' },
    'backlog/epics/auth.md': { status: 'ready' },
    'backlog/auth-1.md': { status: 'ready' },
    'backlog/auth-2.md': { status: 'ready' },
    'backlog/ship.md': { status: 'ready' },
  })
  const backend = buildRoadmapBoardModel(ROADMAP, info, new Map()).find((lane) => lane.lane === 'Backend')
  assert.ok(backend)
  assert.equal(backend.units[1].kind, 'unknown')
  assert.equal(backend.units[1].state, 'unknown')
  assert.equal(backend.reason, 'dangling')
})

// --- Merge order -----------------------------------------------------------

const repo = (id: string, over: Partial<SprintEngineVcsRepo> = {}): SprintEngineVcsRepo => ({
  id,
  root: id === 'primary' ? '.' : id,
  worktreePath: `/wt/${id}`,
  branchName: `sprintengine/${id}`,
  pullRequestUrl: `https://gh/${id}`,
  lastCommitSha: 'abc',
  pullRequestState: 'open',
  ...over,
})

run('merge: consumer blocked by unmerged producer', () => {
  // mobile task depends on a primary task → primary produces, mobile consumes.
  const tasks = [
    { id: 't1', repo: 'primary', dependsOn: [] },
    { id: 't2', repo: 'mobile', dependsOn: ['t1'] },
  ]
  const repos = [repo('primary'), repo('mobile')]
  const { blockedBy } = deriveRepoMergeBlockers(tasks, repos)
  assert.deepEqual(blockedBy.get('mobile'), ['primary'])
  assert.equal(blockedBy.has('primary'), false)
})

run('merge: merged producer stops blocking', () => {
  const tasks = [
    { id: 't1', repo: 'primary', dependsOn: [] },
    { id: 't2', repo: 'mobile', dependsOn: ['t1'] },
  ]
  const repos = [repo('primary', { pullRequestState: 'merged' }), repo('mobile')]
  const { blockedBy } = deriveRepoMergeBlockers(tasks, repos)
  assert.equal(blockedBy.has('mobile'), false)
})

run('merge: a producer that delivered nothing blocks nobody', () => {
  const tasks = [
    { id: 't1', repo: 'primary', dependsOn: [] },
    { id: 't2', repo: 'mobile', dependsOn: ['t1'] },
  ]
  // primary delivered nothing (no PR, no commit) → transparent.
  const repos = [repo('primary', { pullRequestUrl: null, lastCommitSha: null }), repo('mobile')]
  const { blockedBy } = deriveRepoMergeBlockers(tasks, repos)
  assert.equal(blockedBy.has('mobile'), false)
})

run('merge: transitive producers surface through a no-op middle repo', () => {
  // a → b → c dependency chain; b delivered nothing so c must wait on a.
  const tasks = [
    { id: 'ta', repo: 'a', dependsOn: [] },
    { id: 'tb', repo: 'b', dependsOn: ['ta'] },
    { id: 'tc', repo: 'c', dependsOn: ['tb'] },
  ]
  const repos = [repo('a'), repo('b', { pullRequestUrl: null, lastCommitSha: null }), repo('c')]
  const { blockedBy } = deriveRepoMergeBlockers(tasks, repos)
  assert.deepEqual(blockedBy.get('c'), ['a'])
})

// --- Skip ------------------------------------------------------------------

run('skip: removes the entry and appends an inert audit note', () => {
  const content = `---
type: roadmap
status: in_progress
---
# Roadmap

## Backend
- backlog/foo.md
- backlog/bar.md
- backlog/baz.md
`
  const next = skipRoadmapEntry(content, 'backlog/bar.md', 'superseded by MC-9', '2026-07-18')
  const parsed = parseRoadmap(next)
  assert.deepEqual(
    parsed.lanes[0].entries.map((entry) => entry.ref),
    ['backlog/foo.md', 'backlog/baz.md'],
  )
  // Frontmatter preserved; audit note present and inert (no spurious lane/entry).
  assert.ok(next.includes('status: in_progress'))
  assert.ok(next.includes('<!-- skipped 2026-07-18: backlog/bar.md — superseded by MC-9 -->'))
  assert.equal(parsed.lanes.length, 1)
})

run('skip: removes an epic entry with its snapshotted children', () => {
  const content = `---
type: roadmap
---
## Platform
- backlog/epics/auth.md
  - backlog/auth-1.md
  - backlog/auth-2.md
- backlog/ship.md
`
  const next = skipRoadmapEntry(content, 'backlog/epics/auth.md', '', '2026-07-18')
  const parsed = parseRoadmap(next)
  assert.deepEqual(
    parsed.lanes[0].entries.map((entry) => entry.ref),
    ['backlog/ship.md'],
  )
})

run('skip: an unmatched ref leaves the file byte-identical', () => {
  const content = `---
type: roadmap
---
## Backend
- backlog/foo.md
`
  assert.equal(skipRoadmapEntry(content, 'backlog/missing.md', 'x', '2026-07-18'), content)
})

let failures = 0
for (const test of tests) {
  try {
    test.body()
    console.log(`ok - ${test.name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${test.name}`)
    console.error(error)
  }
}
if (failures > 0) {
  console.error(`\n${failures} of ${tests.length} roadmap-surface tests failed`)
  process.exit(1)
}
console.log(`\n${tests.length} roadmap-surface tests passed`)
