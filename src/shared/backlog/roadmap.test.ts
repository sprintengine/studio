import assert from 'node:assert/strict'

import {
  DEFAULT_ROADMAP_POLICY,
  ROADMAP_TYPE,
  isRoadmapContent,
  isRoadmapRelativePath,
  nextEligible,
  parseRoadmap,
  renderRoadmapBody,
  roadmapEpicDrift,
  roadmapRefSlug,
  setRoadmapPolicy,
  validateRoadmap,
  type RoadmapItemState,
  type RoadmapRunState,
} from './roadmap'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// A roadmap referencing two epics (auth, billing) + three loose items (foo, bar,
// baz). Its body is exactly what renderRoadmapBody emits, so the canonical
// round-trip below is a byte check, not just a structural one.
const CANONICAL_BODY = `# Payments roadmap

## Backend
- backlog/foo.md
- backlog/epics/auth.md
  - backlog/auth-login.md
  - backlog/auth-logout.md

## Frontend
- backlog/bar.md
- backlog/epics/billing.md
  - backlog/bill-setup.md
- backlog/baz.md
`

// The stored file: realistic frontmatter with the customary blank line before the
// body. `setRoadmapPolicy` must preserve everything after the frontmatter block
// byte-for-byte, including that leading blank line.
const ROADMAP_FILE = `---
type: roadmap
status: ready
id: 1700
advance: approve
merge: manual
concurrency: 1
---

${CANONICAL_BODY}`

function bodyOf(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)
  return match ? content.slice(match[0].length) : content
}

// ---------------------------------------------------------------------------
// Format + discovery
// ---------------------------------------------------------------------------

run('discovery: roadmap path and type detection', () => {
  assert.equal(ROADMAP_TYPE, 'roadmap')
  assert.equal(isRoadmapRelativePath('backlog/roadmaps/payments.md'), true)
  assert.equal(isRoadmapRelativePath('backlog/foo.md'), false)
  assert.equal(isRoadmapRelativePath('backlog/epics/auth.md'), false)
  // A roadmap file OR a `type: roadmap` frontmatter both count.
  assert.equal(isRoadmapContent('backlog/roadmaps/x.md', undefined), true)
  assert.equal(isRoadmapContent('backlog/x.md', 'roadmap'), true)
  assert.equal(isRoadmapContent('backlog/x.md', 'feature'), false)
})

run('slug derivation matches filename stem', () => {
  assert.equal(roadmapRefSlug('backlog/epics/auth.md'), 'auth')
  assert.equal(roadmapRefSlug('backlog/2026-07-15-thing.md'), '2026-07-15-thing')
  assert.equal(roadmapRefSlug('backlog/checkout.html'), 'checkout')
})

run('parse: policy, lanes, entries, epic children', () => {
  const roadmap = parseRoadmap(ROADMAP_FILE)
  assert.deepEqual(roadmap.policy, { advance: 'approve', merge: 'manual', concurrency: 1 })
  assert.equal(roadmap.status, 'ready')
  assert.equal(roadmap.numericId, 1700)
  assert.equal(roadmap.title, 'Payments roadmap')
  assert.equal(roadmap.issues.length, 0)

  assert.equal(roadmap.lanes.length, 2)
  const [backend, frontend] = roadmap.lanes
  assert.equal(backend.title, 'Backend')
  assert.deepEqual(
    backend.entries.map((entry) => ({ kind: entry.kind, ref: entry.ref, children: entry.children })),
    [
      { kind: 'item', ref: 'backlog/foo.md', children: [] },
      { kind: 'epic', ref: 'backlog/epics/auth.md', children: ['backlog/auth-login.md', 'backlog/auth-logout.md'] },
    ],
  )
  assert.equal(frontend.entries.length, 3)
  assert.equal(frontend.entries[1].kind, 'epic')
  assert.deepEqual(frontend.entries[1].children, ['backlog/bill-setup.md'])
})

run('parse: policy defaults when frontmatter omits them', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n\n## Lane\n- backlog/a.md\n')
  assert.deepEqual(roadmap.policy, DEFAULT_ROADMAP_POLICY)
  assert.equal(roadmap.status, undefined)
})

run('parse: structural issues are surfaced, not thrown', () => {
  const entryBeforeLane = parseRoadmap('---\ntype: roadmap\n---\n- backlog/a.md\n')
  assert.equal(entryBeforeLane.issues[0]?.kind, 'entry_before_lane')

  const childUnderItem = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/a.md\n  - backlog/b.md\n')
  assert.equal(childUnderItem.issues[0]?.kind, 'child_under_non_epic')
  // The stray child is not silently attached to the item entry.
  assert.deepEqual(childUnderItem.lanes[0].entries[0].children, [])
})

// ---------------------------------------------------------------------------
// Round-trip (acceptance #1): parse -> render -> edit -> save byte-stable
// ---------------------------------------------------------------------------

run('canonical body round-trips through render', () => {
  const roadmap = parseRoadmap(ROADMAP_FILE)
  assert.equal(renderRoadmapBody(roadmap), CANONICAL_BODY)
  // parse(render(...)) reproduces the same lanes/entries — structural fixpoint.
  const reparsed = parseRoadmap(`---\ntype: roadmap\n---\n${renderRoadmapBody(roadmap)}`)
  assert.deepEqual(reparsed.lanes, roadmap.lanes)
})

run('policy edit preserves the body byte-for-byte', () => {
  const edited = setRoadmapPolicy(ROADMAP_FILE, { advance: 'auto', concurrency: 2 })
  // Only the frontmatter scalars changed; the body is byte-identical.
  assert.equal(bodyOf(edited), bodyOf(ROADMAP_FILE))
  const roadmap = parseRoadmap(edited)
  assert.equal(roadmap.policy.advance, 'auto')
  assert.equal(roadmap.policy.concurrency, 2)
  assert.equal(roadmap.policy.merge, 'manual')
  // Lanes are untouched by a policy edit.
  assert.deepEqual(roadmap.lanes, parseRoadmap(ROADMAP_FILE).lanes)
})

run('a no-op policy edit is byte-identical (backlog-service precedent)', () => {
  assert.equal(setRoadmapPolicy(ROADMAP_FILE, {}), ROADMAP_FILE)
})

run('setRoadmapPolicy rejects a non-positive concurrency', () => {
  assert.throws(() => setRoadmapPolicy(ROADMAP_FILE, { concurrency: 0 }))
})

// ---------------------------------------------------------------------------
// Validation: dangling refs + cycles
// ---------------------------------------------------------------------------

function item(ref: string, status: RoadmapItemState['status'], dependsOn?: string[]): RoadmapItemState {
  return { ref, status, ...(dependsOn ? { dependsOn } : {}) }
}

run('validate: dangling references surfaced, never dropped', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/known.md\n- backlog/ghost.md\n')
  const result = validateRoadmap(roadmap, [item('backlog/known.md', 'ready')])
  assert.deepEqual(result.danglingRefs, ['backlog/ghost.md'])
  assert.equal(result.hasCycle, false)
})

run('validate: a stale epic entry ref and child are both surfaced as dangling', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/gone.md\n  - backlog/known.md\n  - backlog/ghost.md\n',
  )
  const result = validateRoadmap(roadmap, [item('backlog/known.md', 'ready')])
  assert.deepEqual(result.danglingRefs, ['backlog/epics/gone.md', 'backlog/ghost.md'])
})

run('validate: no cycle when roadmap order agrees with dependsOn', () => {
  // Lane orders x before y; y dependsOn x — consistent, acyclic.
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/x.md\n- backlog/y.md\n')
  const result = validateRoadmap(roadmap, [
    item('backlog/x.md', 'completed'),
    item('backlog/y.md', 'ready', ['x']),
  ])
  assert.equal(result.hasCycle, false)
  assert.deepEqual(result.cycleRefs, [])
})

run('validate: cycle across roadmap order + dependsOn is detected', () => {
  // Lane orders x before y (edge x->y); x dependsOn y (edge y->x) — a cycle.
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/x.md\n- backlog/y.md\n')
  const result = validateRoadmap(roadmap, [
    item('backlog/x.md', 'ready', ['y']),
    item('backlog/y.md', 'ready'),
  ])
  assert.equal(result.hasCycle, true)
  assert.deepEqual([...result.cycleRefs].sort(), ['backlog/x.md', 'backlog/y.md'])
})

run('validate: cycle detection spans epic children in lane order', () => {
  // auth's child c1 runs before loose item z (lane order); z is a prerequisite of
  // c1 (edge z->c1). c1 -> z (order) and z -> c1 (dep) closes a cycle.
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n  - backlog/c1.md\n- backlog/z.md\n',
  )
  const result = validateRoadmap(roadmap, [
    item('backlog/c1.md', 'ready', ['z']),
    item('backlog/z.md', 'ready'),
  ])
  assert.equal(result.hasCycle, true)
  assert.deepEqual([...result.cycleRefs].sort(), ['backlog/c1.md', 'backlog/z.md'])
})

// ---------------------------------------------------------------------------
// Eligibility (acceptance #2)
// ---------------------------------------------------------------------------

const NO_RUNS: ReadonlyMap<string, RoadmapRunState> = new Map()

run('eligibility: lane blocked by an unmerged worktree predecessor', () => {
  // foo finished but its PR has not merged; bar must not become eligible.
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/foo.md\n- backlog/bar.md\n')
  const runs = new Map<string, RoadmapRunState>([['backlog/foo.md', { mode: 'worktree', prMerged: false }]])
  const [lane] = nextEligible(
    roadmap,
    [item('backlog/foo.md', 'completed'), item('backlog/bar.md', 'ready')],
    runs,
  )
  assert.equal(lane.reason, 'awaiting_merge')
  assert.equal(lane.eligibleRef, null)
  assert.equal(lane.frontierRef, 'backlog/foo.md')
})

run('eligibility: merged worktree predecessor unblocks the next entry', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/foo.md\n- backlog/bar.md\n')
  const runs = new Map<string, RoadmapRunState>([['backlog/foo.md', { mode: 'worktree', prMerged: true }]])
  const [lane] = nextEligible(
    roadmap,
    [item('backlog/foo.md', 'completed'), item('backlog/bar.md', 'ready')],
    runs,
  )
  assert.equal(lane.reason, 'eligible')
  assert.equal(lane.eligibleRef, 'backlog/bar.md')
})

run('eligibility: non-worktree predecessor is merged when completed (MC-1439)', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/foo.md\n- backlog/bar.md\n')
  const runs = new Map<string, RoadmapRunState>([['backlog/foo.md', { mode: 'shared' }]])
  const [lane] = nextEligible(
    roadmap,
    [item('backlog/foo.md', 'completed'), item('backlog/bar.md', 'ready')],
    runs,
  )
  assert.equal(lane.reason, 'eligible')
  assert.equal(lane.eligibleRef, 'backlog/bar.md')
})

run('eligibility: an in-progress frontier reports in_progress, not eligible', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/foo.md\n')
  const [lane] = nextEligible(roadmap, [item('backlog/foo.md', 'in_progress')], NO_RUNS)
  assert.equal(lane.reason, 'in_progress')
  assert.equal(lane.eligibleRef, null)
})

run('eligibility: dependsOn resolved across lanes', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## A\n- backlog/a1.md\n## B\n- backlog/b1.md\n',
  )
  const resolved = nextEligible(
    roadmap,
    [item('backlog/a1.md', 'completed'), item('backlog/b1.md', 'ready', ['a1'])],
    NO_RUNS,
  )
  assert.equal(resolved[0].reason, 'lane_complete')
  assert.equal(resolved[1].reason, 'eligible')
  assert.equal(resolved[1].eligibleRef, 'backlog/b1.md')

  // Flip the cross-lane prerequisite back to active work: b1 is now blocked.
  const blocked = nextEligible(
    roadmap,
    [item('backlog/a1.md', 'in_progress'), item('backlog/b1.md', 'ready', ['a1'])],
    NO_RUNS,
  )
  assert.equal(blocked[0].reason, 'in_progress')
  assert.equal(blocked[1].reason, 'blocked')
  assert.equal(blocked[1].eligibleRef, null)
})

run('eligibility: epic entry with mixed children resolves to the first runnable child', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n  - backlog/c1.md\n  - backlog/c2.md\n  - backlog/c3.md\n',
  )
  const runs = new Map<string, RoadmapRunState>([['backlog/c1.md', { mode: 'shared' }]])
  const [lane] = nextEligible(
    roadmap,
    [
      item('backlog/c1.md', 'completed'), // merged (shared + completed) — skipped
      item('backlog/c2.md', 'ready'), // the first runnable child
      item('backlog/c3.md', 'idea'),
    ],
    runs,
  )
  assert.equal(lane.reason, 'eligible')
  assert.equal(lane.eligibleRef, 'backlog/c2.md')
})

run('eligibility: epic lane completes only when every child is terminal', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n  - backlog/c1.md\n  - backlog/c2.md\n',
  )
  const [lane] = nextEligible(
    roadmap,
    [item('backlog/c1.md', 'completed'), item('backlog/c2.md', 'archived')],
    NO_RUNS,
  )
  assert.equal(lane.reason, 'lane_complete')
  assert.equal(lane.eligibleRef, null)
})

run('eligibility: a dangling frontier reports dangling', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/ghost.md\n')
  const [lane] = nextEligible(roadmap, [], NO_RUNS)
  assert.equal(lane.reason, 'dangling')
  assert.equal(lane.frontierRef, 'backlog/ghost.md')
  assert.equal(lane.eligibleRef, null)
})

run('eligibility: an empty lane reports empty', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n')
  const [lane] = nextEligible(roadmap, [], NO_RUNS)
  assert.equal(lane.reason, 'empty')
})

// ---------------------------------------------------------------------------
// Static-plan drift
// ---------------------------------------------------------------------------

run('roadmapEpicDrift: reports gained and removed children vs the snapshot', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n  - backlog/c1.md\n  - backlog/c2.md\n',
  )
  const entry = roadmap.lanes[0].entries[0]
  // Live membership dropped c2 and gained c3.
  const drift = roadmapEpicDrift(entry, ['backlog/c1.md', 'backlog/c3.md'])
  assert.deepEqual(drift.gained, ['backlog/c3.md'])
  assert.deepEqual(drift.removed, ['backlog/c2.md'])
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
  console.error(`\n${failures} of ${tests.length} roadmap tests failed`)
  process.exit(1)
}
console.log(`\n${tests.length} roadmap tests passed`)
