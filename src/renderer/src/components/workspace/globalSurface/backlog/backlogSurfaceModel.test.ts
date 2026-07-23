import assert from 'node:assert/strict'
import test from 'node:test'

import type { BacklogItem } from '../../../../utils/backlog'
import type { BacklogSort, BacklogView } from '../../../../utils/backlogTriage'
import { compareBacklogItems, matchesBacklogView } from '../../../../utils/backlogTriage'
import {
  backlogDependencyState,
  deriveBacklogDependencies,
  epicBlockedRollupBySlug,
} from '../../../../utils/backlogDependencies'
import { isRoadmapContent } from '../../../../../../shared/backlog/roadmap'
import type { BacklogProjectFeed, BacklogProjectRef } from '../../../../hooks/useAllProjectsBacklog'
import {
  ALL_PROJECTS,
  anyProjectNeedsInput,
  buildBacklogDoorList,
  matchesBacklogQuery,
  orderProjectFeed,
} from './backlogSurfaceModel'

// ── fixtures ─────────────────────────────────────────────────────────────────

let seq = 0
function mk(over: Partial<BacklogItem> & { id: string }): BacklogItem {
  seq += 1
  const relativePath = over.relativePath ?? `backlog/${over.id}.md`
  return {
    objectId: `obj-${over.id}`,
    path: `/x/${relativePath}`,
    relativePath,
    title: over.title ?? over.id,
    kind: 'markdown',
    status: 'ready',
    isEpic: false,
    metadata: {},
    links: [],
    excerpt: '',
    modifiedAt: 1000 + seq,
    createdAtMs: 1000 + seq,
    ...over,
  } as BacklogItem
}

// The dependency-derived blocked set, computed exactly as T8's feed derivation
// and the panel both compute it, so a feed built here carries the same
// blockedPaths the real aggregate would.
function computeBlockedPaths(items: ReadonlyArray<BacklogItem>): Set<string> {
  const graph = deriveBacklogDependencies([...items])
  const epicBlocked = epicBlockedRollupBySlug(graph)
  const blocked = new Set<string>()
  for (const node of graph.nodes) {
    const state = backlogDependencyState(node, node.item.isEpic ? epicBlocked.get(node.slug) : undefined)
    if (state === 'blocked') blocked.add(node.item.relativePath)
  }
  return blocked
}

function mkFeed(rootKey: string, name: string, items: ReadonlyArray<BacklogItem>): BacklogProjectFeed {
  const project: BacklogProjectRef = { key: name.slice(0, 2).toUpperCase(), name, root: `/${name}`, rootKey }
  return {
    projectKey: project.key,
    projectName: name,
    root: project.root,
    rootKey,
    items: items.map((item) => ({ project, item })),
    derived: {
      dependencyStateById: new Map(),
      blockedPaths: computeBlockedPaths(items),
      epicProgressBySlug: new Map(),
      epicMetaBySlug: new Map(),
      epicBlockedBySlug: new Map(),
    },
    loading: false,
  }
}

// A faithful inline replica of BacklogPanel's `filtered` memo (the golden
// reference the model must match for a single project).
function panelFilteredIds(items: ReadonlyArray<BacklogItem>, view: BacklogView, sort: BacklogSort, rawQuery: string): string[] {
  const query = rawQuery.trim().toLowerCase()
  const matched = items.filter((item) => {
    if (isRoadmapContent(item.relativePath, item.rawType)) return false
    if (item.relativePath.startsWith('backlog/mockups/')) return false
    if (!matchesBacklogView(item, view)) return false
    if (query && !matchesBacklogQuery(item, query)) return false
    return true
  })
  if (sort === 'dependency') {
    const graph = deriveBacklogDependencies([...items])
    const visible = new Set(matched.map((item) => item.id))
    return graph.order.filter((item) => visible.has(item.id)).map((item) => item.id)
  }
  const blocked = computeBlockedPaths(items)
  return [...matched]
    .sort((a, b) => compareBacklogItems(a, b, sort, (entry) => blocked.has(entry.relativePath)))
    .map((item) => item.id)
}

// A realistically messy single project: mixed statuses, sizes, a roadmap object
// and a mockup attachment (both must be excluded), an epic + members, and a
// dependency chain that blocks a ready item.
function sampleProject(): BacklogItem[] {
  return [
    mk({ id: 'a', status: 'needs_input', difficulty: 's', criticality: 'high', risk: 'low', modifiedAt: 50 }),
    mk({ id: 'b', status: 'in_progress', difficulty: 'l', criticality: 'critical', risk: 'normal', modifiedAt: 90 }),
    mk({ id: 'c', status: 'ready', difficulty: 'xs', criticality: 'low', risk: 'low', modifiedAt: 70, dependsOn: ['d'] }),
    mk({ id: 'd', status: 'in_progress', difficulty: 'm', criticality: 'normal', modifiedAt: 60 }),
    mk({ id: 'e', status: 'completed', difficulty: 'xl', criticality: 'high', modifiedAt: 40 }),
    mk({ id: 'f', status: 'archived', difficulty: 's', criticality: 'normal', modifiedAt: 30 }),
    mk({ id: 'g', status: 'idea', modifiedAt: 80 }),
    mk({ id: 'epic1', isEpic: true, type: 'epic', rawType: 'epic', status: 'in_progress', modifiedAt: 95 }),
    mk({ id: 'm1', status: 'ready', epic: 'epic1', difficulty: 's', criticality: 'high', modifiedAt: 75 }),
    // Excluded: a roadmap object and a mockup attachment.
    mk({ id: 'road', relativePath: 'backlog/roadmaps/plan.md', rawType: 'roadmap', status: 'ready' }),
    mk({ id: 'mock', relativePath: 'backlog/mockups/x.html', status: 'ready' }),
  ]
}

// ── golden: single-project filter == that project's panel ────────────────────

const VIEWS: BacklogView[] = ['active', 'all', 'epics', 'quick_wins', 'unestimated', 'completed', 'archived']
const SORTS: BacklogSort[] = ['best', 'recent', 'created', 'status', 'priority', 'largest', 'smallest', 'dependency']

test('filtering the door to one project reproduces that project’s panel list (visible set + order)', () => {
  const items = sampleProject()
  const feed = mkFeed('proj-a', 'multicode', items)
  for (const view of VIEWS) {
    for (const sort of SORTS) {
      const modelIds = orderProjectFeed(feed, view, sort, '').map((row) => row.item.id)
      assert.deepEqual(modelIds, panelFilteredIds(items, view, sort, ''), `lens=${view} sort=${sort}`)

      // …and the door builder, filtered to that project's rootKey, is identical.
      const built = buildBacklogDoorList([feed], 'proj-a', view, sort, '')
      assert.deepEqual(built.rows.map((row) => row.item.id), modelIds, `door filter lens=${view} sort=${sort}`)
    }
  }
})

test('the aggregate search narrows a project’s rows exactly like the panel', () => {
  const items = sampleProject()
  const feed = mkFeed('proj-a', 'multicode', items)
  for (const q of ['a', 'epic', 'backlog/']) {
    const modelIds = orderProjectFeed(feed, 'all', 'recent', q).map((row) => row.item.id)
    assert.deepEqual(modelIds, panelFilteredIds(items, 'all', 'recent', q), `query=${q}`)
  }
})

test('roadmap objects and mockup attachments never appear as door rows', () => {
  const feed = mkFeed('proj-a', 'multicode', sampleProject())
  const ids = orderProjectFeed(feed, 'all', 'recent', '').map((row) => row.item.id)
  assert.ok(!ids.includes('road'), 'roadmap object excluded')
  assert.ok(!ids.includes('mock'), 'mockup attachment excluded')
})

// ── cross-project merge ──────────────────────────────────────────────────────

test('All projects merges rows and orders them project-independently (status lens)', () => {
  const a = mkFeed('a', 'multicode', [
    mk({ id: 'a-idea', status: 'idea', relativePath: 'backlog/a1.md' }),
    mk({ id: 'a-need', status: 'needs_input', relativePath: 'backlog/a2.md' }),
  ])
  const b = mkFeed('b', 'multiauth', [
    mk({ id: 'b-prog', status: 'in_progress', relativePath: 'backlog/b1.md' }),
    mk({ id: 'b-need', status: 'needs_input', relativePath: 'backlog/b2.md' }),
  ])
  const list = buildBacklogDoorList([a, b], ALL_PROJECTS, 'all', 'status', '')
  // needs_input (both projects) lead, then in_progress, then idea — the project a
  // row does not clump ahead of project b's just because it is listed first.
  const statuses = list.rows.map((row) => row.item.status)
  assert.deepEqual(statuses, ['needs_input', 'needs_input', 'in_progress', 'idea'])
  assert.equal(list.total, 4)
  assert.equal(list.countsByProject.get('a'), 2)
  assert.equal(list.countsByProject.get('b'), 2)
})

test('a single-project filter selects only that project’s rows', () => {
  const a = mkFeed('a', 'multicode', [mk({ id: 'a1', relativePath: 'backlog/a1.md' })])
  const b = mkFeed('b', 'multiauth', [mk({ id: 'b1', relativePath: 'backlog/b1.md' })])
  const list = buildBacklogDoorList([a, b], 'b', 'all', 'recent', '')
  assert.deepEqual(list.rows.map((row) => row.item.id), ['b1'])
  // Counts still cover every project, so the chips keep their numbers.
  assert.equal(list.countsByProject.get('a'), 1)
})

test('Dependency order stays per-project and concatenates projects in feed order', () => {
  const a = mkFeed('a', 'multicode', [
    mk({ id: 'a-dep', status: 'ready', relativePath: 'backlog/a-dep.md', dependsOn: ['a-pre'] }),
    mk({ id: 'a-pre', status: 'ready', relativePath: 'backlog/a-pre.md' }),
  ])
  const b = mkFeed('b', 'multiauth', [mk({ id: 'b1', status: 'ready', relativePath: 'backlog/b1.md' })])
  const ids = buildBacklogDoorList([a, b], ALL_PROJECTS, 'all', 'dependency', '').rows.map((row) => row.item.id)
  // Project a's chain (prerequisite before dependent) stays intact and whole,
  // then project b — never interleaved across the project boundary.
  const aChunk = ids.filter((id) => id.startsWith('a-'))
  assert.deepEqual(aChunk, ['a-pre', 'a-dep'])
  assert.equal(ids[ids.length - 1], 'b1')
})

test('anyProjectNeedsInput is the cross-project needs_input signal for the door dot', () => {
  const calm = [mkFeed('a', 'p', [mk({ id: 'x', status: 'ready' })])]
  const waiting = [
    mkFeed('a', 'p', [mk({ id: 'x', status: 'ready' })]),
    mkFeed('b', 'q', [mk({ id: 'y', status: 'needs_input' })]),
  ]
  assert.equal(anyProjectNeedsInput(calm), false)
  assert.equal(anyProjectNeedsInput(waiting), true)
})
