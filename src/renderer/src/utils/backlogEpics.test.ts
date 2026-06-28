import assert from 'node:assert/strict'

import { createBacklogItem, type BacklogItem } from './backlog'
import {
  backlogHeaderNavId,
  childrenOfEpic,
  epicGroupKey,
  groupItemsByEpic,
  groupedBacklogRows,
  isBacklogHeaderNavId,
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

run('items with no epic collapse into a single trailing No epic group', () => {
  const groups = groupItemsByEpic([
    mk('backlog/a.md', { status: 'idea' }),
    mk('backlog/b.md', { status: 'completed' }),
  ])
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
  assert.deepEqual(groups.map((group) => group.title), ['Zeta', 'Alpha', 'Beta', 'Unknown epic', 'No epic'])
  assert.deepEqual(groups.map((group) => group.kind), ['epic', 'epic', 'epic', 'unknown', 'none'])
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
