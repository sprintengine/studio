import assert from 'node:assert/strict'

import { createBacklogItem, type BacklogItem } from './backlog'
import {
  backlogHeaderNavId,
  childrenOfEpic,
  epicGroupKey,
  epicMetaBySlug,
  epicProgressBySlug,
  epicSlug,
  groupItemsByEpic,
  groupedBacklogRows,
  isBacklogHeaderNavId,
  planEpicArchive,
  type BacklogEpicGroup,
} from './backlogEpics'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// Build a real BacklogItem through the read model so grouping is tested against
// the same frontmatter parsing the app uses (isEpic, epic slug, difficulty,
// status, and the epic file's color/order all derive from sourceContent).
function mk(
  relativePath: string,
  opts: {
    type?: string
    status?: string
    difficulty?: string
    epic?: string
    order?: string
    color?: string
    title?: string
  } = {},
): BacklogItem {
  const lines: string[] = []
  if (opts.type) lines.push(`type: ${opts.type}`)
  if (opts.status) lines.push(`status: ${opts.status}`)
  if (opts.difficulty) lines.push(`difficulty: ${opts.difficulty}`)
  if (opts.epic) lines.push(`epic: ${opts.epic}`)
  if (opts.order) lines.push(`order: ${opts.order}`)
  if (opts.color) lines.push(`color: ${opts.color}`)
  const front = lines.length ? `---\n${lines.join('\n')}\n---\n` : ''
  const title = opts.title ?? relativePath
  return createBacklogItem({
    path: `/repo/${relativePath}`,
    relativePath,
    sourceContent: `${front}# ${title}`,
    stats: { modifiedAtMs: 1, sizeBytes: 1 },
  })
}

run('no items yields no groups', () => {
  assert.deepEqual(groupItemsByEpic([]), [])
})

run('epicMetaBySlug maps each epic slug to its title and frontmatter colour', () => {
  const meta = epicMetaBySlug([
    mk('backlog/epics/auth-revamp.md', { type: 'epic', title: 'Auth revamp', color: 'blue' }),
    mk('backlog/epics/onboarding.md', { type: 'epic', title: 'Onboarding polish' }),
    // A leaf pointing at the epic must not appear in the map (epics only).
    mk('backlog/x.md', { epic: 'auth-revamp', color: 'red' }),
  ])
  assert.equal(meta.size, 2)
  assert.deepEqual(meta.get('auth-revamp'), { title: 'Auth revamp', color: 'blue' })
  // An epic with no `color:` carries a null colour (title still resolves).
  assert.deepEqual(meta.get('onboarding'), { title: 'Onboarding polish', color: null })
  assert.equal(meta.has('backlog/x'), false)
})

run('epicMetaBySlug carries the epic display id when the scan has allocated one', () => {
  // displayId is set by the scan-time allocation pass; the member pill labels
  // itself with it. Absent (no id) the key is omitted, not set to undefined.
  const epic = { ...mk('backlog/epics/auth-revamp.md', { type: 'epic', title: 'Auth revamp' }), displayId: 'MC-42' }
  const meta = epicMetaBySlug([epic])
  assert.deepEqual(meta.get('auth-revamp'), { title: 'Auth revamp', color: null, displayId: 'MC-42' })
})

run('items with no epic collapse into a single trailing No epic group', () => {
  const groups = groupItemsByEpic([mk('backlog/a.md', { status: 'idea' }), mk('backlog/b.md', { status: 'completed' })])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'none')
  assert.equal(groups[0].slug, null)
  assert.equal(groups[0].title, 'No epic')
  assert.deepEqual(groups[0].progress, { done: 1, total: 2 })
})

run('an epic with no children is still a header group, and never a leaf', () => {
  const epic = mk('backlog/epics/auth-revamp.md', { type: 'epic', title: 'Auth revamp' })
  const groups = groupItemsByEpic([epic])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'epic')
  assert.equal(groups[0].slug, 'auth-revamp')
  assert.equal(groups[0].title, 'Auth revamp')
  assert.equal(groups[0].epic, epic)
  assert.deepEqual(groups[0].progress, { done: 0, total: 0 })
  assert.equal(groups[0].aggregateSize, 0)
  // The epic concept file is surfaced only as a header, never inside children.
  assert.ok(groups.every((group) => !group.children.includes(epic)))
})

run('a dangling epic slug becomes an Unknown epic group and never drops the item', () => {
  const orphan = mk('backlog/x.md', { epic: 'ghost', status: 'idea' })
  const groups = groupItemsByEpic([orphan])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'unknown')
  assert.equal(groups[0].slug, 'ghost')
  assert.equal(groups[0].title, 'Unknown epic')
  assert.deepEqual(groups[0].children, [orphan])
})

run(
  'epicProgressBySlug rolls up the FULL scan: completed/total per slug, 0/0 for childless epics, dangling slugs included',
  () => {
    const progress = epicProgressBySlug([
      mk('backlog/epics/auth.md', { type: 'epic', title: 'Auth' }),
      mk('backlog/epics/empty.md', { type: 'epic', title: 'Empty' }),
      mk('backlog/c1.md', { epic: 'auth', status: 'completed' }),
      mk('backlog/c2.md', { epic: 'auth', status: 'in_progress' }),
      mk('backlog/c3.md', { epic: 'auth', status: 'completed' }),
      mk('backlog/d1.md', { epic: 'ghost', status: 'completed' }),
      mk('backlog/loose.md', { status: 'idea' }),
    ])
    assert.deepEqual(progress.get('auth'), { done: 2, total: 3 })
    // A childless epic still resolves — an accurate 0/0, never a missing entry.
    assert.deepEqual(progress.get('empty'), { done: 0, total: 0 })
    // A dangling slug (Unknown-epic group) rolls up too.
    assert.deepEqual(progress.get('ghost'), { done: 1, total: 1 })
    // No-epic items belong to no slug.
    assert.equal(progress.size, 3)
  },
)

run('progress counts completed children and aggregateSize rolls up difficulty', () => {
  const epic = mk('backlog/epics/auth.md', { type: 'epic', title: 'Auth' })
  const items = [
    epic,
    mk('backlog/c1.md', { epic: 'auth', status: 'completed', difficulty: 's' }),
    mk('backlog/c2.md', { epic: 'auth', status: 'in_progress', difficulty: 'l' }),
    mk('backlog/c3.md', { epic: 'auth', status: 'completed' }), // no difficulty -> 0 points
  ]
  const group = groupItemsByEpic(items)[0]
  assert.deepEqual(group.progress, { done: 2, total: 3 })
  // s(2) + l(4) + 0 = 6
  assert.equal(group.aggregateSize, 6)
  assert.deepEqual(
    childrenOfEpic(items, 'auth').map((item) => item.relativePath),
    ['backlog/c1.md', 'backlog/c2.md', 'backlog/c3.md'],
  )
  // childrenOfEpic never returns the epic header itself.
  assert.ok(!childrenOfEpic(items, 'auth').includes(epic))
})

run('groups order by epic order then title, with Unknown epic then No epic last', () => {
  const groups = groupItemsByEpic([
    mk('backlog/n.md', {}),
    mk('backlog/epics/beta.md', { type: 'epic', title: 'Beta' }), // no order -> after ordered epics
    mk('backlog/o.md', { epic: 'ghost' }),
    mk('backlog/epics/alpha.md', { type: 'epic', title: 'Alpha', order: '2' }),
    mk('backlog/epics/zeta.md', { type: 'epic', title: 'Zeta', order: '1' }),
  ])
  // order 1 (Zeta) before order 2 (Alpha) — order beats alphabetical; Beta (no
  // order) sorts after both by title; then Unknown, then No epic last.
  assert.deepEqual(
    groups.map((group) => group.title),
    ['Zeta', 'Alpha', 'Beta', 'Unknown epic', 'No epic'],
  )
  assert.deepEqual(
    groups.map((group) => group.kind),
    ['epic', 'epic', 'epic', 'unknown', 'none'],
  )
})

run('epic color comes from frontmatter; an invalid color falls back to null', () => {
  const colored = groupItemsByEpic([mk('backlog/epics/auth.md', { type: 'epic', title: 'Auth', color: 'blue' })])
  assert.equal(colored[0].color, 'blue')
  const bad = groupItemsByEpic([mk('backlog/epics/p.md', { type: 'epic', title: 'P', color: 'mauve' })])
  assert.equal(bad[0].color, null)
})

const NONE_COLLAPSED = (): boolean => false

run('groupedBacklogRows flattens headers + children into one render+nav order', () => {
  const groups = groupItemsByEpic([
    mk('backlog/epics/auth.md', { type: 'epic', title: 'Auth', order: '1' }),
    mk('backlog/a.md', { epic: 'auth', status: 'idea' }),
    mk('backlog/b.md', { epic: 'auth', status: 'completed' }),
    mk('backlog/loose.md', { status: 'idea' }), // No epic group
  ])
  const rows = groupedBacklogRows(groups, NONE_COLLAPSED)
  // Header, its two children, then the No-epic header + its child — depth-first.
  assert.deepEqual(
    rows.map((row) => (row.kind === 'header' ? `H:${row.group.title}` : `I:${row.item.relativePath}`)),
    ['H:Auth', 'I:backlog/a.md', 'I:backlog/b.md', 'H:No epic', 'I:backlog/loose.md'],
  )
  // An epic header borrows its epic item id; the No-epic header gets a synthetic
  // one. Cross-group j/k walks every navId in order with no gaps.
  const navOrder = rows.map((row) => row.navId)
  assert.equal(navOrder[0], 'backlog/epics/auth.md')
  assert.ok(isBacklogHeaderNavId(navOrder[3]))
  assert.equal(new Set(navOrder).size, navOrder.length)
})

run('collapsing a group hides its children from the render+nav order but keeps the header', () => {
  const groups = groupItemsByEpic([
    mk('backlog/epics/auth.md', { type: 'epic', title: 'Auth' }),
    mk('backlog/a.md', { epic: 'auth', status: 'idea' }),
    mk('backlog/loose.md', { status: 'idea' }),
  ])
  const collapsed = new Set([epicGroupKey({ kind: 'epic', slug: 'auth' })])
  const rows = groupedBacklogRows(groups, (group) => collapsed.has(epicGroupKey(group)))
  assert.deepEqual(
    rows.map((row) => (row.kind === 'header' ? `H:${row.group.title}` : `I:${row.item.relativePath}`)),
    ['H:Auth', 'H:No epic', 'I:backlog/loose.md'],
  )
  // The collapsed header is still navigable and reports its collapsed flag.
  const authHeader = rows[0]
  assert.equal(authHeader.kind, 'header')
  assert.equal(authHeader.kind === 'header' && authHeader.collapsed, true)
})

run('header nav ids: epic borrows the epic id, none/unknown are synthetic + stable', () => {
  const groups = groupItemsByEpic([
    mk('backlog/epics/auth.md', { type: 'epic', title: 'Auth' }),
    mk('backlog/x.md', { epic: 'ghost' }), // unknown
    mk('backlog/loose.md', {}), // none
  ])
  const byKind = (kind: BacklogEpicGroup['kind']): BacklogEpicGroup =>
    groups.find((group) => group.kind === kind) as BacklogEpicGroup
  assert.equal(backlogHeaderNavId(byKind('epic')), 'backlog/epics/auth.md')
  assert.equal(isBacklogHeaderNavId(backlogHeaderNavId(byKind('epic'))), false)
  assert.equal(isBacklogHeaderNavId(backlogHeaderNavId(byKind('unknown'))), true)
  assert.equal(isBacklogHeaderNavId(backlogHeaderNavId(byKind('none'))), true)
  assert.equal(epicGroupKey({ kind: 'none', slug: null }), '__none__')
})

run('epicSlug derives the filename stem regardless of directory (active or archived)', () => {
  assert.equal(epicSlug(mk('backlog/epics/auth-revamp.md', { type: 'epic' })), 'auth-revamp')
  // After the archive-epic rollup moves the file, the stem (slug) is preserved.
  assert.equal(epicSlug(mk('backlog/archived/auth-revamp.md', { type: 'epic' })), 'auth-revamp')
})

run('archive-epic rollup: an archived epic + its archived children group as one unit', () => {
  // The rollup moves the epic and children under backlog/archived/. The epic keeps
  // its slug (stem) and the children keep their `epic:` frontmatter, so the
  // Archived lens groups them as a single epic unit, not loose rows.
  const epic = mk('backlog/archived/auth-revamp.md', { type: 'epic', title: 'Auth revamp' })
  const groups = groupItemsByEpic([
    epic,
    mk('backlog/archived/checkout.md', { epic: 'auth-revamp' }),
    mk('backlog/archived/login.md', { epic: 'auth-revamp' }),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'epic')
  assert.equal(groups[0].slug, 'auth-revamp')
  assert.equal(groups[0].epic, epic)
  assert.deepEqual(
    groups[0].children.map((child) => child.relativePath),
    ['backlog/archived/checkout.md', 'backlog/archived/login.md'],
  )
})

run('planEpicArchive: no collision keeps the slug and re-points nothing', () => {
  const epic = mk('backlog/epics/auth.md', { type: 'epic', title: 'Auth' })
  const children = [mk('backlog/a.md', { epic: 'auth' }), mk('backlog/b.md', { epic: 'auth' })]
  const plan = planEpicArchive(epic, children, [])
  assert.equal(plan.epicArchivedRel, 'backlog/archived/auth.md')
  assert.equal(plan.epicArchivedSlug, 'auth')
  assert.equal(plan.slugChanged, false)
  assert.deepEqual(
    plan.children.map((move) => move.repointEpic),
    [null, null],
  )
  assert.deepEqual(
    plan.children.map((move) => move.archivedRel),
    ['backlog/archived/a.md', 'backlog/archived/b.md'],
  )
})

run('planEpicArchive: an archived-name collision renames the epic and re-points every child to the new stem', () => {
  const epic = mk('backlog/epics/auth.md', { type: 'epic', title: 'Auth' })
  const children = [mk('backlog/a.md', { epic: 'auth' }), mk('backlog/b.md', { epic: 'auth' })]
  // backlog/archived/auth.md already exists → the epic is renamed to auth-2.
  const plan = planEpicArchive(epic, children, ['backlog/archived/auth.md'])
  assert.equal(plan.epicArchivedRel, 'backlog/archived/auth-2.md')
  assert.equal(plan.epicArchivedSlug, 'auth-2')
  assert.equal(plan.slugChanged, true)
  // Both children are re-pointed to the renamed stem so they stay grouped.
  assert.deepEqual(
    plan.children.map((move) => move.repointEpic),
    ['auth-2', 'auth-2'],
  )
})

run('after a collision-rename + re-point, the archived epic + children still group as one unit (AC2)', () => {
  // Simulates the on-disk state the plan produces: epic at archived/auth-2.md
  // (slug auth-2) and children re-pointed to `epic: auth-2`. They must form one
  // group, not an empty epic + an Unknown-epic scatter.
  const groups = groupItemsByEpic([
    mk('backlog/archived/auth-2.md', { type: 'epic', title: 'Auth' }),
    mk('backlog/archived/a.md', { epic: 'auth-2' }),
    mk('backlog/archived/b.md', { epic: 'auth-2' }),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'epic')
  assert.equal(groups[0].slug, 'auth-2')
  assert.deepEqual(
    groups[0].children.map((child) => child.relativePath),
    ['backlog/archived/a.md', 'backlog/archived/b.md'],
  )
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('backlogEpics.test.ts: ok')
}

main()
