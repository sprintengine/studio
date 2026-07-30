import assert from 'node:assert/strict'

import {
  DEFAULT_ROADMAP_POLICY,
  ROADMAP_TYPE,
  isRoadmapContent,
  isRoadmapRelativePath,
  nextEligible,
  parseRoadmap,
  qualifiedRef,
  renderRoadmapBody,
  resolveEntryRoster,
  roadmapRefSlug,
  setRoadmapPolicy,
  setRoadmapProjects,
  validateRoadmap,
  type ProjectKey,
  type RoadmapItemState,
  type RoadmapRunState,
} from './roadmap'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// A roadmap referencing two epics (auth, billing) + three loose items (foo, bar,
// baz). Every entry is a BARE reference (MC-2031) — an epic step stores no
// membership. Its body is exactly what renderRoadmapBody emits, so the canonical
// round-trip below is a byte check, not just a structural one.
const CANONICAL_BODY = `# Payments roadmap

## Backend
- backlog/foo.md
- backlog/epics/auth.md

## Frontend
- backlog/bar.md
- backlog/epics/billing.md
- backlog/baz.md
`

// The same plan as a pre-MC-2031 file wrote it: each epic followed by the member
// snapshot it used to store. It must still parse, and the snapshot must vanish on
// the next structural write — no on-disk migration exists or is needed.
const LEGACY_SNAPSHOT_BODY = `# Payments roadmap

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

run('parse: policy, lanes, bare entries', () => {
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
    backend.entries.map((entry) => ({ kind: entry.kind, ref: entry.ref })),
    [
      { kind: 'item', ref: 'backlog/foo.md' },
      { kind: 'epic', ref: 'backlog/epics/auth.md' },
    ],
  )
  assert.equal(frontend.entries.length, 3)
  assert.equal(frontend.entries[1].kind, 'epic')
  assert.equal(frontend.entries[1].ref, 'backlog/epics/billing.md')
})

run('parse: a stored member snapshot is read, ignored, and dropped on the next write', () => {
  const legacy = parseRoadmap(`---\ntype: roadmap\n---\n${LEGACY_SNAPSHOT_BODY}`)
  // Never an error, and never a phantom step: the indented lines are inert.
  assert.deepEqual(legacy.issues, [])
  assert.deepEqual(legacy.lanes, parseRoadmap(`---\ntype: roadmap\n---\n${CANONICAL_BODY}`).lanes)
  // The next structural write emits the bare plan — that IS the migration.
  assert.equal(renderRoadmapBody(legacy), CANONICAL_BODY)
})

run('parse: a deeper subheading is not treated as a lane', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## Backend\n- backlog/a.md\n### Notes\n- backlog/b.md\n',
  )
  assert.equal(roadmap.lanes.length, 1)
  assert.equal(roadmap.lanes[0].title, 'Backend')
  // Both entries stay in the single `##` lane; the `###` line is opaque prose.
  assert.deepEqual(roadmap.lanes[0].entries.map((entry) => entry.ref), ['backlog/a.md', 'backlog/b.md'])
})

run('parse: policy defaults when frontmatter omits them', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n\n## Lane\n- backlog/a.md\n')
  assert.deepEqual(roadmap.policy, DEFAULT_ROADMAP_POLICY)
  assert.equal(roadmap.status, undefined)
})

run('parse: structural issues are surfaced, not thrown', () => {
  const entryBeforeLane = parseRoadmap('---\ntype: roadmap\n---\n- backlog/a.md\n')
  assert.equal(entryBeforeLane.issues[0]?.kind, 'entry_before_lane')

  // An indented ref under a non-epic entry was an issue while entries stored
  // members; now it is simply not a step. Inert, not an error.
  const indentedUnderItem = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/a.md\n  - backlog/b.md\n')
  assert.deepEqual(indentedUnderItem.issues, [])
  assert.deepEqual(indentedUnderItem.lanes[0].entries.map((entry) => entry.ref), ['backlog/a.md'])
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

// SEAM (MC-1880): the Horizon roster picker writes through this exact path —
// setPolicy({ roster }) -> policyDiff -> setRoadmapPolicy. Picking a roster must
// write `roster:` and NOTHING else, and must not touch the body.
run('a roster pick writes only the roster key, body byte-identical', () => {
  const picked = setRoadmapPolicy(ROADMAP_FILE, { roster: 'opus' })
  assert.equal(bodyOf(picked), bodyOf(ROADMAP_FILE), 'the body is untouched')
  const roadmap = parseRoadmap(picked)
  assert.equal(roadmap.policy.roster, 'opus')
  // Every other policy scalar is exactly what it was.
  const before = parseRoadmap(ROADMAP_FILE).policy
  assert.equal(roadmap.policy.advance, before.advance)
  assert.equal(roadmap.policy.merge, before.merge)
  assert.equal(roadmap.policy.concurrency, before.concurrency)
  assert.deepEqual(roadmap.lanes, parseRoadmap(ROADMAP_FILE).lanes)

  // Choosing "No roles" clears the key rather than writing a magic name, so an
  // unset roster stays the honest representation of the default. Key PRESENCE
  // (not definedness) is what decides removal.
  const cleared = setRoadmapPolicy(picked, { roster: undefined })
  assert.equal(parseRoadmap(cleared).policy.roster, undefined, 'No roles clears the key')
  assert.doesNotMatch(cleared, /^roster:/m, 'and leaves no roster line behind')
  assert.equal(bodyOf(cleared), bodyOf(ROADMAP_FILE), 'clearing also leaves the body alone')
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

// A member of `epic`, stated the only way membership is stated: up-pointing
// frontmatter on the child. An epic STEP resolves its members from these.
function member(
  ref: string,
  epic: string,
  status: RoadmapItemState['status'],
  dependsOn?: string[],
): RoadmapItemState {
  return { ref, status, epic, ...(dependsOn ? { dependsOn } : {}) }
}

function projectItem(
  projectKey: ProjectKey,
  ref: string,
  status: RoadmapItemState['status'],
  dependsOn?: string[],
): RoadmapItemState {
  return { ref, status, projectKey, ...(dependsOn ? { dependsOn } : {}) }
}

// Run links are keyed by qualifiedRef; these helpers spell that so a test reads
// like the roadmap ref it means.
function homeRuns(entries: Array<[string, RoadmapRunState]>): Map<string, RoadmapRunState> {
  return new Map(entries.map(([ref, state]) => [qualifiedRef(null, ref), state]))
}

run('validate: dangling references surfaced, never dropped', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/known.md\n- backlog/ghost.md\n')
  const result = validateRoadmap(roadmap, [item('backlog/known.md', 'ready')])
  assert.deepEqual(result.danglingRefs, ['backlog/ghost.md'])
  assert.equal(result.hasCycle, false)
})

run('validate: a stale epic entry ref is surfaced as dangling', () => {
  // Members can never be dangling now — they are resolved FROM the known items —
  // so only the entry ref itself can name nothing. Legacy indented lines are
  // inert and must not be reported as refs the author has to clear.
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/gone.md\n  - backlog/known.md\n  - backlog/ghost.md\n',
  )
  const result = validateRoadmap(roadmap, [item('backlog/known.md', 'ready')])
  assert.deepEqual(result.danglingRefs, ['backlog/epics/gone.md'])
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
  // The auth STEP runs before loose item z (lane order); z is a prerequisite of
  // auth's member c1. Members collapse onto their step's node, so step -> z
  // (order) and z -> step (member dep) closes a cycle on the step itself.
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n- backlog/z.md\n',
  )
  const result = validateRoadmap(roadmap, [
    member('backlog/c1.md', 'auth', 'ready', ['z']),
    item('backlog/z.md', 'ready'),
  ])
  assert.equal(result.hasCycle, true)
  assert.deepEqual([...result.cycleRefs].sort(), ['backlog/epics/auth.md', 'backlog/z.md'])
})

// ---------------------------------------------------------------------------
// Eligibility (acceptance #2)
// ---------------------------------------------------------------------------

const NO_RUNS: ReadonlyMap<string, RoadmapRunState> = new Map()

run('eligibility: lane blocked by an unmerged worktree predecessor', () => {
  // foo finished but its PR has not merged; bar must not become eligible.
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/foo.md\n- backlog/bar.md\n')
  const runs = homeRuns([['backlog/foo.md', { mode: 'worktree', prMerged: false }]])
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
  const runs = homeRuns([['backlog/foo.md', { mode: 'worktree', prMerged: true }]])
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
  const runs = homeRuns([['backlog/foo.md', { mode: 'shared' }]])
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

run('eligibility: an epic step is ONE dispatch unit — the epic itself is eligible', () => {
  // A step runs as a single sprint. Mixed member statuses (one delivered, one
  // ready) make the epic's effective status `ready`, so the STEP is dispatched —
  // never an individual child.
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n')
  const [lane] = nextEligible(
    roadmap,
    [
      item('backlog/epics/auth.md', 'idea'),
      member('backlog/c1.md', 'auth', 'completed'),
      member('backlog/c2.md', 'auth', 'ready'),
      member('backlog/c3.md', 'auth', 'idea'),
    ],
    NO_RUNS,
  )
  assert.equal(lane.reason, 'eligible')
  assert.equal(lane.eligibleRef, 'backlog/epics/auth.md')
})

run('eligibility: an epic step with a live sprint reports in_progress', () => {
  // The execution link stamps the epic in_progress at start; the step must not
  // re-dispatch while its one sprint runs.
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n')
  const [lane] = nextEligible(
    roadmap,
    [
      item('backlog/epics/auth.md', 'in_progress'),
      member('backlog/c1.md', 'auth', 'completed'),
      member('backlog/c2.md', 'auth', 'ready'),
    ],
    NO_RUNS,
  )
  assert.equal(lane.reason, 'in_progress')
  assert.equal(lane.eligibleRef, null)
})

run('eligibility: epic lane completes only when every child is terminal', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n')
  const [lane] = nextEligible(
    roadmap,
    [
      // The epic's own frontmatter may lag behind its members: derived
      // completion (all members terminal) still finishes the lane.
      item('backlog/epics/auth.md', 'in_progress'),
      member('backlog/c1.md', 'auth', 'completed'),
      member('backlog/c2.md', 'auth', 'archived'),
    ],
    NO_RUNS,
  )
  assert.equal(lane.reason, 'lane_complete')
  assert.equal(lane.eligibleRef, null)
})

run('eligibility: a member’s outside prerequisite gates the epic step', () => {
  // c2 depends on loose item z (another lane, not a member): the STEP must not
  // dispatch until z is delivered. c1's dep on sibling c2 is intra-epic — the
  // sprint's own ordering — and never a gate.
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n## M\n- backlog/z.md\n',
  )
  const blocked = nextEligible(
    roadmap,
    [
      item('backlog/epics/auth.md', 'idea'),
      member('backlog/c1.md', 'auth', 'ready', ['c2']),
      member('backlog/c2.md', 'auth', 'ready', ['z']),
      item('backlog/z.md', 'ready'),
    ],
    NO_RUNS,
  )
  assert.equal(blocked[0].reason, 'blocked')
  assert.equal(blocked[0].eligibleRef, null)

  const unblocked = nextEligible(
    roadmap,
    [
      item('backlog/epics/auth.md', 'idea'),
      member('backlog/c1.md', 'auth', 'ready', ['c2']),
      member('backlog/c2.md', 'auth', 'ready', ['z']),
      item('backlog/z.md', 'completed'),
    ],
    NO_RUNS,
  )
  assert.equal(unblocked[0].reason, 'eligible')
  assert.equal(unblocked[0].eligibleRef, 'backlog/epics/auth.md')
})

run('eligibility: a pre-migration child-keyed worktree run still holds the epic step', () => {
  // A run started under the old per-child granularity keyed its link on the
  // MEMBER. Its unmerged PR must keep the lane on this step, and the following
  // step queued, even though the members all read terminal by status.
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n- backlog/z.md\n',
  )
  const runs = homeRuns([['backlog/c1.md', { mode: 'worktree', prMerged: false }]])
  const [lane] = nextEligible(
    roadmap,
    [
      item('backlog/epics/auth.md', 'in_progress'),
      member('backlog/c1.md', 'auth', 'completed'),
      item('backlog/z.md', 'ready'),
    ],
    runs,
  )
  assert.equal(lane.frontierRef, 'backlog/epics/auth.md')
  assert.notEqual(lane.eligibleRef, 'backlog/z.md')
})

run('eligibility: an unmerged worktree run on an epic step gates on the PR', () => {
  // One sprint delivered the whole step but its PR has not merged — the lane
  // waits on the merge, keyed by the EPIC's run link.
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n- backlog/z.md\n',
  )
  const runs = homeRuns([['backlog/epics/auth.md', { mode: 'worktree', prMerged: false }]])
  const [lane] = nextEligible(
    roadmap,
    [
      item('backlog/epics/auth.md', 'completed'),
      member('backlog/c1.md', 'auth', 'completed'),
      item('backlog/z.md', 'ready'),
    ],
    runs,
  )
  assert.equal(lane.reason, 'awaiting_merge')
  assert.equal(lane.frontierRef, 'backlog/epics/auth.md')
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
// Project-qualified refs (instance-global model, MC-1688)
// ---------------------------------------------------------------------------

const MULTI_PROJECT_FILE = `---
type: roadmap
status: in_progress
projects:
  mobile: /abs/multicode-mobile
  web: /abs/multicode-web
---
# Cross-project roadmap

## Ship
- backlog/home-1.md
- mobile:backlog/m-1.md
- web:backlog/w-1.md
`

run('parse: an existing single-project roadmap has no projects and home entries', () => {
  const roadmap = parseRoadmap(ROADMAP_FILE)
  assert.deepEqual(roadmap.projects, [])
  for (const lane of roadmap.lanes) {
    for (const entry of lane.entries) {
      assert.equal(entry.projectKey, null)
      assert.equal(entry.relativePath, entry.ref)
    }
  }
})

run('parse: projects map + alias-qualified entry refs resolve to project + path', () => {
  const roadmap = parseRoadmap(MULTI_PROJECT_FILE)
  assert.deepEqual(roadmap.projects, [
    { alias: 'mobile', path: '/abs/multicode-mobile' },
    { alias: 'web', path: '/abs/multicode-web' },
  ])
  const [home, mobile, web] = roadmap.lanes[0].entries
  assert.deepEqual(
    [home, mobile, web].map((entry) => [entry.ref, entry.projectKey, entry.relativePath]),
    [
      ['backlog/home-1.md', null, 'backlog/home-1.md'],
      ['mobile:backlog/m-1.md', 'mobile', 'backlog/m-1.md'],
      ['web:backlog/w-1.md', 'web', 'backlog/w-1.md'],
    ],
  )
  assert.equal(roadmap.issues.length, 0)
})

run('parse: alias-qualified refs round-trip through render byte-stably', () => {
  const roadmap = parseRoadmap(MULTI_PROJECT_FILE)
  const reparsed = parseRoadmap(`---\ntype: roadmap\n---\n${renderRoadmapBody(roadmap)}`)
  assert.deepEqual(
    reparsed.lanes[0].entries.map((entry) => entry.ref),
    ['backlog/home-1.md', 'mobile:backlog/m-1.md', 'web:backlog/w-1.md'],
  )
})

run('parse: inline projects map form is tolerated', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\nprojects: { mobile: /abs/m, web: /abs/w }\n---\n## L\n- mobile:backlog/x.md\n',
  )
  assert.deepEqual(roadmap.projects, [
    { alias: 'mobile', path: '/abs/m' },
    { alias: 'web', path: '/abs/w' },
  ])
})

run('parse: an alias with no projects entry is flagged unknown_alias, never dropped', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- ghost:backlog/x.md\n')
  // The entry survives (never silently dropped) and carries the alias key.
  assert.equal(roadmap.lanes[0].entries[0].projectKey, 'ghost')
  assert.equal(roadmap.issues.some((issue) => issue.kind === 'unknown_alias'), true)
})

run('parse: a duplicate alias is flagged once', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\nprojects:\n  mobile: /abs/a\n  mobile: /abs/b\n---\n## L\n- mobile:backlog/x.md\n',
  )
  assert.equal(roadmap.issues.filter((issue) => issue.kind === 'duplicate_alias').length, 1)
})

run('eligibility: same-named items in different projects never satisfy each other', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\nprojects:\n  mobile: /abs/m\n---\n## L\n- backlog/foo.md\n- mobile:backlog/foo.md\n',
  )
  const resolvable = new Set<ProjectKey>([null, 'mobile'])
  // Home foo completed (merged, shared) → frontier moves to mobile foo, which is
  // ready → eligible. The home item does NOT satisfy the mobile entry.
  const [lane] = nextEligible(
    roadmap,
    [projectItem(null, 'backlog/foo.md', 'completed'), projectItem('mobile', 'backlog/foo.md', 'ready')],
    homeRuns([['backlog/foo.md', { mode: 'shared' }]]),
    resolvable,
  )
  assert.equal(lane.reason, 'eligible')
  assert.equal(lane.eligible?.projectKey, 'mobile')
  assert.equal(lane.eligible?.relativePath, 'backlog/foo.md')
  assert.equal(lane.eligibleRef, 'mobile:backlog/foo.md')
})

run('eligibility: a frontier whose alias is not resolvable parks unknown_project', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\nprojects:\n  mobile: /abs/gone\n---\n## L\n- mobile:backlog/x.md\n',
  )
  // `mobile` is declared but its path is not among the resolvable projects.
  const [lane] = nextEligible(roadmap, [], NO_RUNS, new Set<ProjectKey>([null]))
  assert.equal(lane.reason, 'unknown_project')
  assert.equal(lane.frontier?.projectKey, 'mobile')
  assert.equal(lane.eligibleRef, null)
})

run('eligibility: cross-project dependsOn resolves within each project', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\nprojects:\n  mobile: /abs/m\n---\n## L\n- backlog/a.md\n- mobile:backlog/b.md\n',
  )
  const resolvable = new Set<ProjectKey>([null, 'mobile'])
  // mobile b dependsOn slug `a`. There is a home `a` (completed) AND a mobile `a`
  // (in_progress). The prerequisite must resolve to the MOBILE a (same project),
  // which is not terminal → b is blocked, not eligible.
  const resolved = nextEligible(
    roadmap,
    [
      projectItem(null, 'backlog/a.md', 'completed'),
      projectItem('mobile', 'backlog/b.md', 'ready', ['a']),
      projectItem('mobile', 'backlog/a.md', 'in_progress'),
    ],
    homeRuns([['backlog/a.md', { mode: 'shared' }]]),
    resolvable,
  )
  assert.equal(resolved[0].reason, 'blocked')
})

run('validate: an alias-qualified dangling ref is surfaced with its raw ref', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\nprojects:\n  mobile: /abs/m\n---\n## L\n- mobile:backlog/ghost.md\n',
  )
  const result = validateRoadmap(roadmap, [projectItem('mobile', 'backlog/other.md', 'ready')])
  assert.deepEqual(result.danglingRefs, ['mobile:backlog/ghost.md'])
})

run('setRoadmapProjects: writes a block, round-trips, and no-ops when unchanged', () => {
  const base = '---\ntype: roadmap\nstatus: ready\n---\n\n## L\n- backlog/x.md\n'
  const withProjects = setRoadmapProjects(base, [{ alias: 'mobile', path: '/abs/m' }])
  const parsed = parseRoadmap(withProjects)
  assert.deepEqual(parsed.projects, [{ alias: 'mobile', path: '/abs/m' }])
  // Body + other frontmatter preserved.
  assert.equal(bodyOf(withProjects), bodyOf(base))
  assert.ok(withProjects.includes('status: ready'))
  // Re-writing the same map is byte-identical.
  assert.equal(setRoadmapProjects(withProjects, [{ alias: 'mobile', path: '/abs/m' }]), withProjects)
  // Clearing removes the block.
  assert.equal(bodyOf(setRoadmapProjects(withProjects, [])), bodyOf(base))
  assert.equal(parseRoadmap(setRoadmapProjects(withProjects, [])).projects.length, 0)
})

// ---------------------------------------------------------------------------
// Golden: live epic membership must decide exactly what the stored snapshot did
// ---------------------------------------------------------------------------

// This fixture states the SAME membership twice: once as the indented child
// lines a pre-MC-2031 plan stored, and once as the `epic:` frontmatter pointer
// each member carries. It was written and run against the snapshot
// implementation BEFORE that implementation was deleted, so the literals below
// are the old engine's own answers — an equality proof between the two, not a
// re-baselined expectation.
const GOLDEN_PLAN = `---
type: roadmap
---
## Build
- backlog/epics/auth.md
  - backlog/auth-login.md
  - backlog/auth-logout.md
  - backlog/auth-reset.md
- backlog/after.md

## Ship
- backlog/z.md

## Shipped
- backlog/epics/billing.md
  - backlog/bill-setup.md
`

function goldenItems(zStatus: RoadmapItemState['status']): RoadmapItemState[] {
  return [
    { ref: 'backlog/epics/auth.md', status: 'idea' },
    // Terminal member: delivered before the step ran.
    { ref: 'backlog/auth-login.md', status: 'completed', epic: 'auth' },
    // Gates the step — `z` is not a member, so it is an OUTSIDE prerequisite.
    { ref: 'backlog/auth-logout.md', status: 'ready', dependsOn: ['z'], epic: 'auth' },
    // Intra-epic dependency: the sprint's own ordering, never a start gate.
    { ref: 'backlog/auth-reset.md', status: 'idea', dependsOn: ['auth-logout'], epic: 'auth' },
    { ref: 'backlog/after.md', status: 'ready' },
    { ref: 'backlog/z.md', status: zStatus },
    { ref: 'backlog/epics/billing.md', status: 'idea' },
    { ref: 'backlog/bill-setup.md', status: 'archived', epic: 'billing' },
  ]
}

const AUTH_UNIT = {
  key: ':backlog/epics/auth.md',
  ref: 'backlog/epics/auth.md',
  projectKey: null,
  relativePath: 'backlog/epics/auth.md',
}

run('golden: an unchanged epic yields the identical eligibility, member-gate and all', () => {
  // `z` outstanding: the member's outside prerequisite holds the whole step.
  assert.deepEqual(nextEligible(parseRoadmap(GOLDEN_PLAN), goldenItems('ready'), NO_RUNS), [
    {
      lane: 'Build',
      eligibleRef: null,
      eligible: null,
      reason: 'blocked',
      frontierRef: 'backlog/epics/auth.md',
      frontier: AUTH_UNIT,
    },
    {
      lane: 'Ship',
      eligibleRef: 'backlog/z.md',
      eligible: { key: ':backlog/z.md', ref: 'backlog/z.md', projectKey: null, relativePath: 'backlog/z.md' },
      reason: 'eligible',
      frontierRef: 'backlog/z.md',
      frontier: { key: ':backlog/z.md', ref: 'backlog/z.md', projectKey: null, relativePath: 'backlog/z.md' },
    },
    // Every member terminal → the step is derived complete, so is its track.
    { lane: 'Shipped', eligibleRef: null, eligible: null, reason: 'lane_complete', frontierRef: null, frontier: null },
  ])

  // `z` delivered: the gate lifts and the step (never a member) is dispatched.
  const unblocked = nextEligible(parseRoadmap(GOLDEN_PLAN), goldenItems('completed'), NO_RUNS)
  assert.deepEqual(unblocked[0], {
    lane: 'Build',
    eligibleRef: 'backlog/epics/auth.md',
    eligible: AUTH_UNIT,
    reason: 'eligible',
    frontierRef: 'backlog/epics/auth.md',
    frontier: AUTH_UNIT,
  })
})

run('a child added to an epic mid-flight joins its step immediately', () => {
  // The whole point of MC-2031: no stored set for a new member to fail to join,
  // and therefore nothing to re-sync. The SAME plan text answers differently the
  // moment the item universe does.
  const roadmap = parseRoadmap('---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n- backlog/next.md\n')
  const delivered = [
    item('backlog/epics/auth.md', 'in_progress'),
    member('backlog/c1.md', 'auth', 'completed'),
    item('backlog/next.md', 'ready'),
  ]
  // Every member terminal → the step is delivered and the lane moves on.
  assert.equal(nextEligible(roadmap, delivered, NO_RUNS)[0].eligibleRef, 'backlog/next.md')

  // A sprint mints one more member. The step is no longer complete, so the lane
  // holds at it rather than advancing past work nobody has done.
  const withNewMember = [...delivered, member('backlog/c2.md', 'auth', 'ready')]
  const [held] = nextEligible(roadmap, withNewMember, NO_RUNS)
  assert.equal(held.frontierRef, 'backlog/epics/auth.md')
  assert.equal(held.reason, 'in_progress')
})

// ---------------------------------------------------------------------------
// Per-step roster (MC-1881) — the round-trip is the whole risk surface
// ---------------------------------------------------------------------------

const ROSTERED_BODY = `# Staffed roadmap

## Up next
- backlog/auth-api.md
- mobile:backlog/epics/login.md  @roster=Mobile UI
- backlog/epics/payments.md  @roster=General agents
`

function parseBody(body: string): ReturnType<typeof parseRoadmap> {
  return parseRoadmap(`---\ntype: roadmap\nprojects:\n  mobile: /tmp/mobile\n---\n${body}`)
}

run('roster: an annotated entry parses its roster and keeps its ref', () => {
  const roadmap = parseBody(ROSTERED_BODY)
  const entries = roadmap.lanes[0].entries
  assert.deepEqual(
    entries.map((entry) => [entry.ref, entry.roster]),
    [
      ['backlog/auth-api.md', undefined],
      ['mobile:backlog/epics/login.md', 'Mobile UI'],
      ['backlog/epics/payments.md', 'General agents'],
    ],
  )
  // The annotation never leaks into the ref or the project.
  assert.equal(entries[1].projectKey, 'mobile')
  assert.equal(entries[1].relativePath, 'backlog/epics/login.md')
  assert.deepEqual(roadmap.issues, [])
})

run('roster: an annotated body round-trips byte-identically, spaces and all', () => {
  const roadmap = parseBody(ROSTERED_BODY)
  assert.equal(renderRoadmapBody(roadmap), ROSTERED_BODY)
  const reparsed = parseBody(renderRoadmapBody(roadmap))
  assert.deepEqual(reparsed.lanes, roadmap.lanes)
})

run('roster: an un-annotated body renders exactly as it did before (no trailing space)', () => {
  const roadmap = parseRoadmap(`---\ntype: roadmap\n---\n${CANONICAL_BODY}`)
  const rendered = renderRoadmapBody(roadmap)
  assert.equal(rendered, CANONICAL_BODY)
  // Belt-and-braces on the byte claim: no entry line may end in whitespace.
  for (const line of rendered.split('\n')) assert.equal(line, line.replace(/\s+$/, ''))
})

run('roster: an annotated legacy child line is inert, not a staffing override', () => {
  const roadmap = parseRoadmap(
    '---\ntype: roadmap\n---\n## L\n- backlog/epics/auth.md\n  - backlog/c1.md  @roster=Mobile UI\n',
  )
  const entry = roadmap.lanes[0].entries[0]
  assert.equal(entry.roster, undefined, 'a stray annotation never staffs the step above it')
  assert.deepEqual(roadmap.issues, [])
})

run('roster: an empty @roster= raises empty_roster and does not read as inherit', () => {
  const roadmap = parseRoadmap('---\ntype: roadmap\nroster: Fallback\n---\n## L\n- backlog/foo.md  @roster=\n')
  const entry = roadmap.lanes[0].entries[0]
  assert.equal(entry.roster, undefined)
  assert.deepEqual(
    roadmap.issues.map((issue) => issue.kind),
    ['empty_roster'],
  )
  // It is an authoring error, not a staffing choice: resolution still inherits.
  assert.equal(resolveEntryRoster(entry, roadmap.policy), 'Fallback')
})

run('roster: forward-compat — the old first-token-only rule still yields every ref', () => {
  // Exactly what a build WITHOUT this item does: keep the first token, drop the
  // rest. Asserted against the annotated file so the "an older build reads the
  // plan correctly" claim is proven, not assumed.
  const legacyRefs = ROSTERED_BODY.split('\n')
    .map((line) => /^\s*-\s+(.*\S)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1].split(/\s+/)[0])
  assert.deepEqual(legacyRefs, [
    'backlog/auth-api.md',
    'mobile:backlog/epics/login.md',
    'backlog/epics/payments.md',
  ])
  // And no annotated line is mistaken for an unparseable entry.
  assert.equal(
    parseBody(ROSTERED_BODY).issues.filter((issue) => issue.kind === 'unparseable_entry').length,
    0,
  )
})

run('resolveEntryRoster: entry wins over policy; policy wins over nothing', () => {
  const step = { roster: 'Mobile UI' }
  const bare = {}
  assert.equal(resolveEntryRoster(step, { roster: 'General agents' }), 'Mobile UI')
  assert.equal(resolveEntryRoster(bare, { roster: 'General agents' }), 'General agents')
  assert.equal(resolveEntryRoster(bare, {}), undefined)
  assert.equal(resolveEntryRoster(step, {}), 'Mobile UI')
  // Whitespace-only on either tier is absence, never an empty roster name.
  assert.equal(resolveEntryRoster({ roster: '   ' }, { roster: 'General agents' }), 'General agents')
  assert.equal(resolveEntryRoster({ roster: '   ' }, { roster: '  ' }), undefined)
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
