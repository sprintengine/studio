import assert from 'node:assert/strict'

import { parseRoadmap, renderRoadmapBody } from '../../../../shared/backlog/roadmap'
import type { BacklogItem } from '../../utils/backlog'
import {
  addEntry,
  addLane,
  addLibraryEntry,
  authoredRef,
  buildRoadmapEntry,
  composeRoadmapSaveContent,
  draftContainsRef,
  draftFromRoadmap,
  entryPickerOptions,
  entryPickerOptionsMulti,
  isDraftDirty,
  makeEntry,
  makeProjectEntry,
  mergeLaneDown,
  moveEntry,
  newRoadmapFileContent,
  policyChanged,
  projectsChanged,
  refDisplayMapMulti,
  removeEntry,
  removeLane,
  roadmapItemStates,
  roadmapProjectAlias,
  setEntryRoster,
  splitLane,
  structureChanged,
  type RoadmapProjectItems,
} from './roadmapAuthoring'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// Minimal BacklogItem factory — only the fields the authoring helpers read. The
// cast is the justified boundary: constructing a full scan item needs fs stats we
// have no use for here.
function item(partial: Partial<BacklogItem> & { relativePath: string }): BacklogItem {
  return {
    id: partial.relativePath,
    title: partial.title ?? partial.relativePath,
    status: partial.status ?? 'ready',
    isEpic: partial.isEpic ?? false,
    ...partial,
  } as BacklogItem
}

// The acceptance fixture: two epics (auth, billing) + three loose items (foo, bar,
// baz) across two tracks. The body is exactly what renderRoadmapBody emits, so the
// no-op save below is a true byte check.
const CANONICAL_BODY = `# Payments roadmap

## Backend
- backlog/foo.md
- backlog/epics/auth.md

## Frontend
- backlog/bar.md
- backlog/epics/billing.md
- backlog/baz.md
`

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

const SCAN: BacklogItem[] = [
  item({ relativePath: 'backlog/foo.md', title: 'Foo', displayId: 'MC-1' }),
  item({ relativePath: 'backlog/bar.md', title: 'Bar', displayId: 'MC-2' }),
  item({ relativePath: 'backlog/baz.md', title: 'Baz', displayId: 'MC-3' }),
  item({ relativePath: 'backlog/epics/auth.md', title: 'Auth', isEpic: true }),
  item({ relativePath: 'backlog/auth-login.md', title: 'Login', epic: 'auth' }),
  item({ relativePath: 'backlog/auth-logout.md', title: 'Logout', epic: 'auth' }),
  item({ relativePath: 'backlog/epics/billing.md', title: 'Billing', isEpic: true }),
  item({ relativePath: 'backlog/bill-setup.md', title: 'Billing setup', epic: 'billing' }),
]

// ---------------------------------------------------------------------------
// Round-trip byte-stability (acceptance criterion 1)
// ---------------------------------------------------------------------------

run('round-trip: a no-op save reproduces the file byte-for-byte', () => {
  const roadmap = parseRoadmap(ROADMAP_FILE)
  const baseline = draftFromRoadmap(roadmap)
  const draft = draftFromRoadmap(roadmap)
  assert.equal(isDraftDirty(baseline, draft), false)
  assert.equal(composeRoadmapSaveContent(ROADMAP_FILE, baseline, draft), ROADMAP_FILE)
})

run('round-trip: a policy-only edit preserves the body byte-for-byte', () => {
  const roadmap = parseRoadmap(ROADMAP_FILE)
  const baseline = draftFromRoadmap(roadmap)
  const draft = draftFromRoadmap(roadmap)
  draft.policy = { ...draft.policy, advance: 'auto', concurrency: 2 }
  assert.equal(policyChanged(baseline, draft), true)
  assert.equal(structureChanged(baseline, draft), false)
  const saved = composeRoadmapSaveContent(ROADMAP_FILE, baseline, draft)
  // Frontmatter scalars changed…
  assert.match(saved, /advance: auto/)
  assert.match(saved, /concurrency: 2/)
  // …but the body is untouched, and unrelated frontmatter (id) survives.
  assert.equal(bodyOf(saved), bodyOf(ROADMAP_FILE))
  assert.match(saved, /id: 1700/)
})

run('round-trip: a structural edit re-emits a canonical body under the same frontmatter', () => {
  const roadmap = parseRoadmap(ROADMAP_FILE)
  const baseline = draftFromRoadmap(roadmap)
  const draft = draftFromRoadmap(roadmap)
  // Append a loose item to the first track.
  draft.lanes = addEntry(draft.lanes, 0, makeEntry('backlog/bar.md'))
  assert.equal(structureChanged(baseline, draft), true)
  const saved = composeRoadmapSaveContent(ROADMAP_FILE, baseline, draft)
  // Frontmatter block preserved exactly; body is the re-parsed canonical form.
  assert.equal(saved.slice(0, saved.indexOf('# Payments')), ROADMAP_FILE.slice(0, ROADMAP_FILE.indexOf('# Payments')))
  const reparsed = parseRoadmap(saved)
  assert.deepEqual(reparsed.lanes[0].entries.map((e) => e.ref), [
    'backlog/foo.md',
    'backlog/epics/auth.md',
    'backlog/bar.md',
  ])
  // The saved body (past its frontmatter separator) is the canonical render.
  assert.equal(renderRoadmapBody(reparsed), bodyOf(saved).replace(/^\n+/, ''))
  // And re-saving the reparsed draft is a fixed point (idempotent).
  const rebaseline = draftFromRoadmap(reparsed)
  assert.equal(composeRoadmapSaveContent(saved, rebaseline, rebaseline), saved)
})

// ---------------------------------------------------------------------------
// Entry construction: epic steps are BARE references (MC-2031)
// ---------------------------------------------------------------------------

run('makeEntry: an epic ref is a bare step, carrying no membership', () => {
  const entry = makeEntry('backlog/epics/auth.md')
  assert.equal(entry.kind, 'epic')
  assert.deepEqual(Object.keys(entry).sort(), ['kind', 'projectKey', 'ref', 'relativePath'])
})

run('makeEntry: an item ref is an item step', () => {
  assert.equal(makeEntry('backlog/foo.md').kind, 'item')
})

run('makeEntry: an unresolved ref is still added (surfaced as dangling later)', () => {
  const entry = makeEntry('backlog/ghost.md')
  assert.equal(entry.kind, 'item')
})

// ---------------------------------------------------------------------------
// Track / step transforms
// ---------------------------------------------------------------------------

function twoTracks() {
  return [
    { title: 'A', entries: [makeEntry('backlog/foo.md'), makeEntry('backlog/bar.md')] },
    { title: 'B', entries: [makeEntry('backlog/baz.md')] },
  ]
}

run('moveEntry: reorder within a track adjusts for the removal', () => {
  const lanes = twoTracks()
  // Move foo (0) to the end of its track — dropping just past bar is index 2.
  const next = moveEntry(lanes, { lane: 0, index: 0 }, { lane: 0, index: 2 })
  assert.deepEqual(next[0].entries.map((e) => e.ref), ['backlog/bar.md', 'backlog/foo.md'])
})

run('moveEntry: move across tracks', () => {
  const lanes = twoTracks()
  const next = moveEntry(lanes, { lane: 0, index: 1 }, { lane: 1, index: 0 })
  assert.deepEqual(next[0].entries.map((e) => e.ref), ['backlog/foo.md'])
  assert.deepEqual(next[1].entries.map((e) => e.ref), ['backlog/bar.md', 'backlog/baz.md'])
})

run('removeEntry drops the targeted step only', () => {
  const next = removeEntry(twoTracks(), 0, 0)
  assert.deepEqual(next[0].entries.map((e) => e.ref), ['backlog/bar.md'])
})

run('splitLane peels the tail into a new track after it', () => {
  const next = splitLane(twoTracks(), 0, 1)
  assert.equal(next.length, 3)
  assert.deepEqual(next[0].entries.map((e) => e.ref), ['backlog/foo.md'])
  assert.deepEqual(next[1].entries.map((e) => e.ref), ['backlog/bar.md'])
  assert.equal(next[1].title, 'A (cont.)')
})

run('splitLane at a track boundary is a no-op', () => {
  assert.deepEqual(splitLane(twoTracks(), 0, 0), twoTracks())
})

run('mergeLaneDown appends into the next track, keeping its title', () => {
  const next = mergeLaneDown(twoTracks(), 0)
  assert.equal(next.length, 1)
  assert.equal(next[0].title, 'B')
  assert.deepEqual(next[0].entries.map((e) => e.ref), ['backlog/foo.md', 'backlog/bar.md', 'backlog/baz.md'])
})

run('mergeLaneDown on the last track is a no-op', () => {
  assert.deepEqual(mergeLaneDown(twoTracks(), 1), twoTracks())
})

run('addLane appends an empty track with a unique title', () => {
  const next = addLane([{ title: 'Up next', entries: [] }])
  assert.equal(next.length, 2)
  assert.equal(next[1].title, 'Up next 2')
})

run('removeLane drops the track', () => {
  assert.equal(removeLane(twoTracks(), 0).length, 1)
})

// ---------------------------------------------------------------------------
// Adapters + creation
// ---------------------------------------------------------------------------

run('entryPickerOptions excludes roadmaps and archived items', () => {
  const scan = [
    ...SCAN,
    item({ relativePath: 'backlog/roadmaps/other.md', title: 'Other', rawType: 'roadmap' }),
    item({ relativePath: 'backlog/old.md', title: 'Old', status: 'archived' }),
  ]
  const values = entryPickerOptions(scan).map((o) => o.value)
  assert.ok(!values.includes('backlog/roadmaps/other.md'))
  assert.ok(!values.includes('backlog/old.md'))
  assert.ok(values.includes('backlog/epics/auth.md'))
})

run('draftContainsRef finds an added entry', () => {
  const lanes = addEntry([{ title: 'A', entries: [] }], 0, makeEntry('backlog/foo.md'))
  assert.equal(draftContainsRef(lanes, 'backlog/foo.md'), true)
  assert.equal(draftContainsRef(lanes, 'backlog/bar.md'), false)
})

run('roadmapItemStates carries status, dependsOn and epic membership from the scan', () => {
  const states = roadmapItemStates([
    item({ relativePath: 'backlog/x.md', status: 'ready', dependsOn: ['foo'] }),
    item({ relativePath: 'backlog/bill-setup.md', status: 'ready', epic: 'billing' }),
  ])
  assert.deepEqual(states[0], { ref: 'backlog/x.md', status: 'ready', dependsOn: ['foo'] })
  // `epic` is the axis an epic STEP resolves its members through — without it the
  // horizon would have no membership at all.
  assert.equal(states[1].epic, 'billing')
})

run('newRoadmapFileContent parses into a roadmap with default policy and one empty track', () => {
  const content = newRoadmapFileContent('My roadmap')
  const roadmap = parseRoadmap(content)
  assert.equal(roadmap.title, 'My roadmap')
  assert.equal(roadmap.policy.advance, 'approve')
  assert.equal(roadmap.policy.merge, 'manual')
  assert.equal(roadmap.policy.concurrency, 1)
  assert.equal(roadmap.lanes.length, 1)
  assert.equal(roadmap.lanes[0].entries.length, 0)
  assert.match(content, /type: roadmap/)
})

// ---------------------------------------------------------------------------
// Cross-project planning (MC-1690 / T3)
// ---------------------------------------------------------------------------

const HOME: RoadmapProjectItems = { projectKey: null, projectName: 'multicode', path: '/abs/home', items: SCAN }
const MOBILE: RoadmapProjectItems = {
  projectKey: 'mobile',
  projectName: 'multicode-mobile',
  path: '/abs/mobile',
  items: [
    item({ relativePath: 'backlog/epics/sync.md', title: 'Sync', isEpic: true }),
    item({ relativePath: 'backlog/sync-a.md', title: 'Sync A', epic: 'sync' }),
    item({ relativePath: 'backlog/sync-b.md', title: 'Sync B', epic: 'sync' }),
    item({ relativePath: 'backlog/phone.md', title: 'Phone', displayId: 'MB-9' }),
    item({ relativePath: 'backlog/roadmaps/mobile.md', title: 'Mobile plan', rawType: 'roadmap' }),
    item({ relativePath: 'backlog/gone.md', title: 'Gone', status: 'archived' }),
  ],
}

run('authoredRef: home stays unqualified, an alias keeps its prefix', () => {
  assert.equal(authoredRef(null, 'backlog/foo.md'), 'backlog/foo.md')
  assert.equal(authoredRef('mobile', 'backlog/foo.md'), 'mobile:backlog/foo.md')
})

run('roadmapProjectAlias: slugifies and dedupes against taken aliases', () => {
  assert.equal(roadmapProjectAlias('multicode-mobile', new Set()), 'multicode-mobile')
  assert.equal(roadmapProjectAlias('multicode mobile', new Set(['multicode-mobile'])), 'multicode-mobile-2')
})

run('makeProjectEntry: a home epic is unqualified; a mobile epic is alias-qualified', () => {
  const home = makeProjectEntry(HOME, 'backlog/epics/auth.md')
  assert.equal(home.ref, 'backlog/epics/auth.md')
  assert.equal(home.projectKey, null)
  const mobile = makeProjectEntry(MOBILE, 'backlog/epics/sync.md')
  assert.equal(mobile.ref, 'mobile:backlog/epics/sync.md')
  assert.equal(mobile.projectKey, 'mobile')
})

run('acceptance #1: drag an item from A and an epic from B, reorder — file reflects the order with project-qualified refs + a projects map', () => {
  const content = newRoadmapFileContent('Cross plan')
  const baseline = draftFromRoadmap(parseRoadmap(content))
  // Drag home item, then mobile epic, into the one default track.
  let draft = addLibraryEntry(baseline, 0, HOME, 'backlog/foo.md')
  draft = addLibraryEntry(draft, 0, MOBILE, 'backlog/epics/sync.md')
  assert.equal(projectsChanged(baseline, draft), true)
  // Reorder: move the mobile epic (index 1) above the home item (index 0).
  draft = { ...draft, lanes: moveEntry(draft.lanes, { lane: 0, index: 1 }, { lane: 0, index: 0 }) }

  const saved = composeRoadmapSaveContent(content, baseline, draft)
  const reparsed = parseRoadmap(saved)
  assert.deepEqual(reparsed.lanes[0].entries.map((e) => e.ref), ['mobile:backlog/epics/sync.md', 'backlog/foo.md'])
  const epicEntry = reparsed.lanes[0].entries[0]
  assert.equal(epicEntry.projectKey, 'mobile')
  assert.deepEqual(reparsed.projects, [{ alias: 'mobile', path: '/abs/mobile' }])
  // No parse issues: the alias resolves against the projects map it wrote.
  assert.deepEqual(reparsed.issues, [])
})

run('addLibraryEntry: a home row adds no alias; a duplicate ref is a no-op', () => {
  const baseline = draftFromRoadmap(parseRoadmap(newRoadmapFileContent('P')))
  const once = addLibraryEntry(baseline, 0, HOME, 'backlog/foo.md')
  assert.equal(once.projects.length, 0)
  const twice = addLibraryEntry(once, 0, HOME, 'backlog/foo.md')
  assert.equal(twice, once)
})

run('composeRoadmapSaveContent: a projects-only churn does not perturb the body', () => {
  // Adding then removing structure but keeping an alias would still write the block;
  // here we just confirm a saved cross-project plan is a re-save fixed point.
  const content = newRoadmapFileContent('P')
  const baseline = draftFromRoadmap(parseRoadmap(content))
  const draft = addLibraryEntry(baseline, 0, MOBILE, 'backlog/phone.md')
  const saved = composeRoadmapSaveContent(content, baseline, draft)
  const rebaseline = draftFromRoadmap(parseRoadmap(saved))
  assert.equal(composeRoadmapSaveContent(saved, rebaseline, rebaseline), saved)
  assert.match(saved, /projects:/)
  assert.match(saved, /mobile: \/abs\/mobile/)
})

run('refDisplayMapMulti + entryPickerOptionsMulti: keyed by authored ref across projects', () => {
  const display = refDisplayMapMulti([HOME, MOBILE])
  assert.equal(display.get('backlog/foo.md')?.title, 'Foo')
  assert.equal(display.get('mobile:backlog/phone.md')?.title, 'Phone')
  const values = entryPickerOptionsMulti([HOME, MOBILE]).map((o) => o.value)
  assert.ok(values.includes('backlog/foo.md'))
  assert.ok(values.includes('mobile:backlog/phone.md'))
  // Archived + roadmap excluded from the picker.
  assert.ok(!values.includes('mobile:backlog/gone.md'))
  assert.ok(!values.includes('mobile:backlog/roadmaps/mobile.md'))
})

run('addLibraryEntry: an epic lands as one bare step, whatever its members are doing', () => {
  const project: RoadmapProjectItems = {
    projectKey: null,
    projectName: 'multicode',
    path: '/abs/home',
    items: [
      item({ relativePath: 'backlog/epics/hardening.md', title: 'Hardening', isEpic: true }),
      item({ relativePath: 'backlog/open-a.md', title: 'Open A', epic: 'hardening' }),
      item({ relativePath: 'backlog/done-b.md', title: 'Done B', epic: 'hardening', status: 'completed' }),
    ],
  }
  const baseline = draftFromRoadmap(parseRoadmap(newRoadmapFileContent('P')))
  const draft = addLibraryEntry(baseline, 0, project, 'backlog/epics/hardening.md')
  const entry = draft.lanes[0].entries[0]
  assert.equal(entry.kind, 'epic')
  // Nothing about the epic's membership is captured, so nothing can go stale.
  assert.deepEqual(Object.keys(entry).sort(), ['kind', 'projectKey', 'ref', 'relativePath'])
  const saved = composeRoadmapSaveContent(newRoadmapFileContent('P'), baseline, draft)
  assert.doesNotMatch(saved, /^\s+- /m, 'the written plan carries no indented member lines')
})

// ---------------------------------------------------------------------------
// Per-step roster transform (MC-1881)
// ---------------------------------------------------------------------------

// A three-step plan on one track, saved to disk, ready to be edited.
function rosterFixture(): { content: string; baseline: ReturnType<typeof draftFromRoadmap> } {
  const seed = newRoadmapFileContent('Staffing')
  let draft = draftFromRoadmap(parseRoadmap(seed))
  draft = addLibraryEntry(draft, 0, HOME, 'backlog/foo.md')
  draft = addLibraryEntry(draft, 0, HOME, 'backlog/bar.md')
  draft = addLibraryEntry(draft, 0, HOME, 'backlog/baz.md')
  const content = composeRoadmapSaveContent(seed, draftFromRoadmap(parseRoadmap(seed)), draft)
  return { content, baseline: draftFromRoadmap(parseRoadmap(content)) }
}

run('SEAM(1881x1882): a roster edit takes the BODY save path, not the frontmatter-only one', () => {
  const { content, baseline } = rosterFixture()
  const draft = { ...baseline, lanes: setEntryRoster(baseline.lanes, 0, 1, 'Mobile UI') }
  // The whole point: a roster edit must NOT take the frontmatter-only save path,
  // or the edit silently does not persist.
  assert.equal(structureChanged(baseline, draft), true)
  assert.equal(policyChanged(baseline, draft), false)

  const saved = composeRoadmapSaveContent(content, baseline, draft)
  assert.deepEqual(
    parseRoadmap(saved).lanes[0].entries.map((entry) => entry.roster),
    [undefined, 'Mobile UI', undefined],
  )
})

run('SEAM(1881x1882): only the edited line changes; every other byte survives', () => {
  const { content, baseline } = rosterFixture()
  const draft = { ...baseline, lanes: setEntryRoster(baseline.lanes, 0, 1, 'Mobile UI') }
  const saved = composeRoadmapSaveContent(content, baseline, draft)

  const before = content.split('\n')
  const after = saved.split('\n')
  assert.equal(before.length, after.length)
  const changed = before.map((line, index) => [line, after[index]]).filter(([a, b]) => a !== b)
  assert.deepEqual(changed, [['- backlog/bar.md', '- backlog/bar.md  @roster=Mobile UI']])
})

run('SEAM(1881x1882): clearing removes the key, restoring the original file byte-for-byte', () => {
  const { content, baseline } = rosterFixture()
  const staffed = { ...baseline, lanes: setEntryRoster(baseline.lanes, 0, 1, 'Mobile UI') }
  const savedStaffed = composeRoadmapSaveContent(content, baseline, staffed)

  const rebaseline = draftFromRoadmap(parseRoadmap(savedStaffed))
  const cleared = { ...rebaseline, lanes: setEntryRoster(rebaseline.lanes, 0, 1, undefined) }
  assert.equal(structureChanged(rebaseline, cleared), true)
  assert.equal(composeRoadmapSaveContent(savedStaffed, rebaseline, cleared), content)
  // Cleared means the KEY is gone, not an empty string left behind.
  assert.equal('roster' in cleared.lanes[0].entries[1], false)
})

run('setEntryRoster: a blank name clears rather than storing an empty roster', () => {
  const { baseline } = rosterFixture()
  const lanes = setEntryRoster(setEntryRoster(baseline.lanes, 0, 0, 'Mobile UI'), 0, 0, '   ')
  assert.equal('roster' in lanes[0].entries[0], false)
})

run('setEntryRoster: an out-of-range index is a no-op, and other tracks are untouched', () => {
  const { baseline } = rosterFixture()
  const twoTracks = { ...baseline, lanes: addLane(baseline.lanes, 'Later') }
  const lanes = setEntryRoster(twoTracks.lanes, 0, 99, 'Mobile UI')
  assert.deepEqual(lanes[0].entries.map((entry) => entry.roster), [undefined, undefined, undefined])
  assert.equal(structureChanged(twoTracks, { ...twoTracks, lanes }), false)
})

run('buildRoadmapEntry: an optional roster rides the constructed entry', () => {
  assert.equal(buildRoadmapEntry(null, 'backlog/foo.md', 'Mobile UI').roster, 'Mobile UI')
  assert.equal('roster' in buildRoadmapEntry(null, 'backlog/foo.md'), false)
  assert.equal('roster' in buildRoadmapEntry(null, 'backlog/foo.md', '  '), false)
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
  console.error(`\n${failures} of ${tests.length} roadmap authoring tests failed`)
  process.exit(1)
}
