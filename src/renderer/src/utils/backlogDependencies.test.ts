import assert from 'node:assert/strict'

import { createBacklogItem, type BacklogItem } from './backlog'
import {
  backlogDependencyState,
  deriveBacklogDependencies,
  epicBlockedRollupBySlug,
  isEpicFullyBlocked,
  orderItemsByDependencies,
  type BacklogDependencyNode,
} from './backlogDependencies'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// Build a real BacklogItem through the read model so derivation is tested against
// the same frontmatter parsing the app uses: `dependsOn` is parsed (trim/dedupe/
// self-drop) and `status`/recency derive from sourceContent + stats exactly as in
// production.
function mk(
  relativePath: string,
  opts: { status?: string; dependsOn?: string[]; type?: string; modifiedAtMs?: number } = {},
): BacklogItem {
  const lines: string[] = []
  if (opts.type) lines.push(`type: ${opts.type}`)
  if (opts.status) lines.push(`status: ${opts.status}`)
  if (opts.dependsOn && opts.dependsOn.length) lines.push(`dependsOn: ${opts.dependsOn.join(', ')}`)
  const front = lines.length ? `---\n${lines.join('\n')}\n---\n` : ''
  return createBacklogItem({
    path: `/repo/${relativePath}`,
    relativePath,
    sourceContent: `${front}# ${relativePath}`,
    stats: { modifiedAtMs: opts.modifiedAtMs ?? 1, sizeBytes: 1 },
  })
}

// A leaf item pointing up at an epic slug via `epic:` frontmatter, for the
// granular rollup tests.
function mkChild(
  relativePath: string,
  epic: string,
  opts: { status?: string; dependsOn?: string[]; modifiedAtMs?: number } = {},
): BacklogItem {
  const lines: string[] = [`epic: ${epic}`]
  if (opts.status) lines.push(`status: ${opts.status}`)
  if (opts.dependsOn && opts.dependsOn.length) lines.push(`dependsOn: ${opts.dependsOn.join(', ')}`)
  return createBacklogItem({
    path: `/repo/${relativePath}`,
    relativePath,
    sourceContent: `---\n${lines.join('\n')}\n---\n# ${relativePath}`,
    stats: { modifiedAtMs: opts.modifiedAtMs ?? 1, sizeBytes: 1 },
  })
}

function node(items: BacklogItem[], relativePath: string): BacklogDependencyNode {
  const graph = deriveBacklogDependencies(items)
  const found = graph.nodes.find((entry) => entry.item.relativePath === relativePath)
  assert.ok(found, `no node for ${relativePath}`)
  return found
}

const paths = (items: BacklogItem[]): string[] => items.map((item) => item.relativePath)

run('no items yields an empty graph', () => {
  const graph = deriveBacklogDependencies([])
  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.order, [])
  assert.equal(graph.hasCycle, false)
  assert.equal(graph.cycleItemIds.size, 0)
})

run('no-dependencies passthrough: every item present, frontier ordered by recency then path', () => {
  const items = [
    mk('backlog/a.md', { status: 'idea', modifiedAtMs: 100 }),
    mk('backlog/b.md', { status: 'idea', modifiedAtMs: 300 }),
    mk('backlog/c.md', { status: 'idea', modifiedAtMs: 200 }),
  ]
  const order = orderItemsByDependencies(items)
  // Most recent first; no edges so it is a pure recency sort.
  assert.deepEqual(paths(order), ['backlog/b.md', 'backlog/c.md', 'backlog/a.md'])
  // Nothing waiting, nothing blocked, no cycles.
  assert.ok(deriveBacklogDependencies(items).nodes.every((entry) => !entry.isWaiting && !entry.inCycle))
})

run('simple chain orders prerequisites before dependents', () => {
  // c -> b -> a (c dependsOn b, b dependsOn a). Recency is reversed to prove the
  // chain edges, not recency, drive the order.
  const items = [
    mk('backlog/c.md', { status: 'idea', dependsOn: ['b'], modifiedAtMs: 300 }),
    mk('backlog/b.md', { status: 'idea', dependsOn: ['a'], modifiedAtMs: 200 }),
    mk('backlog/a.md', { status: 'idea', modifiedAtMs: 100 }),
  ]
  assert.deepEqual(paths(orderItemsByDependencies(items)), ['backlog/a.md', 'backlog/b.md', 'backlog/c.md'])
})

run('reverse edges: a prerequisite knows the items it blocks', () => {
  const items = [
    mk('backlog/a.md', { status: 'idea' }),
    mk('backlog/b.md', { status: 'idea', dependsOn: ['a'] }),
    mk('backlog/c.md', { status: 'idea', dependsOn: ['a'] }),
  ]
  assert.deepEqual(paths(node(items, 'backlog/a.md').blocks), ['backlog/b.md', 'backlog/c.md'])
  assert.deepEqual(node(items, 'backlog/b.md').blocks, [])
})

run('waiting vs resolved: active prerequisite blocks, completed prerequisite frees', () => {
  const active = [
    mk('backlog/a.md', { status: 'in_progress' }),
    mk('backlog/b.md', { status: 'idea', dependsOn: ['a'] }),
  ]
  assert.equal(node(active, 'backlog/b.md').isWaiting, true)

  const completed = [
    mk('backlog/a.md', { status: 'completed' }),
    mk('backlog/b.md', { status: 'idea', dependsOn: ['a'] }),
  ]
  const resolved = node(completed, 'backlog/b.md')
  assert.equal(resolved.isWaiting, false)
  assert.equal(resolved.prerequisites[0].resolved, true)
  assert.equal(resolved.prerequisites[0].status, 'completed')
})

run('archived prerequisite is resolved too (removed from active work)', () => {
  const items = [mk('backlog/a.md', { status: 'archived' }), mk('backlog/b.md', { status: 'idea', dependsOn: ['a'] })]
  const dependent = node(items, 'backlog/b.md')
  assert.equal(dependent.isWaiting, false)
  assert.equal(dependent.prerequisites[0].resolved, true)
  assert.equal(dependent.prerequisites[0].status, 'archived')
})

run('completed and archived items are never waiting, even with an unresolved prerequisite', () => {
  const items = [
    mk('backlog/a.md', { status: 'in_progress' }),
    mk('backlog/done.md', { status: 'completed', dependsOn: ['a'] }),
    mk('backlog/gone.md', { status: 'archived', dependsOn: ['a'] }),
  ]
  assert.equal(node(items, 'backlog/done.md').isWaiting, false)
  assert.equal(node(items, 'backlog/gone.md').isWaiting, false)
  // The edge is still unresolved (a is active); waiting is gated by the dependent's own status.
  assert.equal(node(items, 'backlog/done.md').prerequisites[0].resolved, false)
})

run('dangling prerequisite is surfaced as unknown and keeps the item waiting', () => {
  const items = [mk('backlog/b.md', { status: 'idea', dependsOn: ['ghost'] })]
  const dependent = node(items, 'backlog/b.md')
  assert.equal(dependent.prerequisites.length, 1)
  assert.equal(dependent.prerequisites[0].slug, 'ghost')
  assert.equal(dependent.prerequisites[0].target, null)
  assert.equal(dependent.prerequisites[0].status, 'unknown')
  assert.equal(dependent.prerequisites[0].resolved, false)
  assert.equal(dependent.isWaiting, true)
})

run('2-node cycle: both members flagged, mutually waiting, order finite (path order)', () => {
  const items = [
    mk('backlog/a.md', { status: 'idea', dependsOn: ['b'] }),
    mk('backlog/b.md', { status: 'idea', dependsOn: ['a'] }),
  ]
  const graph = deriveBacklogDependencies(items)
  assert.equal(graph.hasCycle, true)
  assert.deepEqual([...graph.cycleItemIds].sort(), ['backlog/a.md', 'backlog/b.md'])
  assert.ok(graph.nodes.every((entry) => entry.inCycle && entry.isWaiting))
  // Neither can be ordered, so both are appended in stable path order — finite, no drops.
  assert.deepEqual(paths(graph.order), ['backlog/a.md', 'backlog/b.md'])
})

run('3-node cycle: all three flagged and appended', () => {
  const items = [
    mk('backlog/a.md', { status: 'idea', dependsOn: ['c'] }),
    mk('backlog/b.md', { status: 'idea', dependsOn: ['a'] }),
    mk('backlog/c.md', { status: 'idea', dependsOn: ['b'] }),
  ]
  const graph = deriveBacklogDependencies(items)
  assert.deepEqual([...graph.cycleItemIds].sort(), ['backlog/a.md', 'backlog/b.md', 'backlog/c.md'])
  assert.deepEqual(paths(graph.order), ['backlog/a.md', 'backlog/b.md', 'backlog/c.md'])
})

run('a node downstream of a cycle is waiting but NOT a cycle member', () => {
  // a <-> b cycle; d dependsOn a but nothing depends on d.
  const items = [
    mk('backlog/a.md', { status: 'idea', dependsOn: ['b'] }),
    mk('backlog/b.md', { status: 'idea', dependsOn: ['a'] }),
    mk('backlog/d.md', { status: 'idea', dependsOn: ['a'] }),
  ]
  const graph = deriveBacklogDependencies(items)
  assert.deepEqual([...graph.cycleItemIds].sort(), ['backlog/a.md', 'backlog/b.md'])
  const downstream = graph.nodes.find((entry) => entry.item.relativePath === 'backlog/d.md') as BacklogDependencyNode
  assert.equal(downstream.inCycle, false)
  assert.equal(downstream.isWaiting, true)
  // Still finite and complete: all three present exactly once.
  assert.deepEqual(paths(graph.order).sort(), ['backlog/a.md', 'backlog/b.md', 'backlog/d.md'])
})

run('two cycles bridged by a connector: the connector is NOT a cycle member', () => {
  // a<->b and g<->h are independent 2-cycles. c bridges them: c dependsOn a (so a
  // can reach c) and g dependsOn c (so c can reach g<->h). c is reachable from one
  // cycle and can reach the other but sits on neither — it must not be flagged.
  // Source/sink pruning would wrongly keep c; SCC membership lands it in its own
  // singleton component.
  const items = [
    mk('backlog/a.md', { status: 'idea', dependsOn: ['b'] }),
    mk('backlog/b.md', { status: 'idea', dependsOn: ['a'] }),
    mk('backlog/g.md', { status: 'idea', dependsOn: ['h', 'c'] }),
    mk('backlog/h.md', { status: 'idea', dependsOn: ['g'] }),
    mk('backlog/c.md', { status: 'idea', dependsOn: ['a'] }),
  ]
  const graph = deriveBacklogDependencies(items)
  assert.deepEqual([...graph.cycleItemIds].sort(), ['backlog/a.md', 'backlog/b.md', 'backlog/g.md', 'backlog/h.md'])
  const connector = graph.nodes.find((entry) => entry.item.relativePath === 'backlog/c.md') as BacklogDependencyNode
  assert.equal(connector.inCycle, false)
  // c depends on the active cycle member a, so it is still honestly waiting.
  assert.equal(connector.isWaiting, true)
})

run('duplicate-stem collision: flagged and resolved last-wins', () => {
  // Two items share the stem `dup`; a dependent referencing `dup` resolves to the
  // last one in scan order.
  const items = [
    mk('backlog/dup.md', { status: 'completed' }),
    mk('backlog/nested/dup.md', { status: 'in_progress' }),
    mk('backlog/x.md', { status: 'idea', dependsOn: ['dup'] }),
  ]
  const graph = deriveBacklogDependencies(items)
  assert.deepEqual(graph.duplicateSlugs, ['dup'])
  assert.equal(graph.bySlug.get('dup')?.relativePath, 'backlog/nested/dup.md')
  // x's prerequisite resolves to the last-wins target (in_progress -> unresolved).
  const x = node(items, 'backlog/x.md')
  assert.equal(x.prerequisites[0].target?.relativePath, 'backlog/nested/dup.md')
  assert.equal(x.isWaiting, true)
})

run('a self-reference (dropped upstream) yields no prerequisite and no cycle', () => {
  const items = [mk('backlog/a.md', { status: 'idea', dependsOn: ['a'] })]
  const graph = deriveBacklogDependencies(items)
  assert.deepEqual(graph.nodes[0].prerequisites, [])
  assert.equal(graph.nodes[0].isWaiting, false)
  assert.equal(graph.hasCycle, false)
  assert.deepEqual(paths(graph.order), ['backlog/a.md'])
})

// ---- Derived blocked (effective readiness) ---------------------------------

run('isBlocked: only a stored `ready` with an unresolved prerequisite flips', () => {
  const items = [
    mk('backlog/a.md', { status: 'in_progress' }),
    mk('backlog/done.md', { status: 'completed' }),
    mk('backlog/gated.md', { status: 'ready', dependsOn: ['a'] }),
    mk('backlog/free.md', { status: 'ready', dependsOn: ['done'] }),
    mk('backlog/rough.md', { status: 'idea', dependsOn: ['a'] }),
    mk('backlog/working.md', { status: 'in_progress', dependsOn: ['a'] }),
  ]
  // Ready + unresolved prerequisite: the readiness claim is falsified.
  assert.equal(node(items, 'backlog/gated.md').isBlocked, true)
  // Ready with every prerequisite resolved stays ready.
  assert.equal(node(items, 'backlog/free.md').isBlocked, false)
  // An idea makes no readiness claim — waiting, never blocked.
  assert.equal(node(items, 'backlog/rough.md').isBlocked, false)
  assert.equal(node(items, 'backlog/rough.md').isWaiting, true)
  // Work already underway is not "blocked" either.
  assert.equal(node(items, 'backlog/working.md').isBlocked, false)
})

run('isBlocked: a dangling prerequisite gates a ready item (never silently satisfied)', () => {
  const items = [mk('backlog/gated.md', { status: 'ready', dependsOn: ['missing'] })]
  assert.equal(node(items, 'backlog/gated.md').isBlocked, true)
})

run('backlogDependencyState: blocked beats waiting; resolved items carry no marker', () => {
  const items = [
    mk('backlog/a.md', { status: 'in_progress' }),
    mk('backlog/gated.md', { status: 'ready', dependsOn: ['a'] }),
    mk('backlog/rough.md', { status: 'idea', dependsOn: ['a'] }),
    mk('backlog/free.md', { status: 'ready' }),
  ]
  assert.equal(backlogDependencyState(node(items, 'backlog/gated.md')), 'blocked')
  assert.equal(backlogDependencyState(node(items, 'backlog/rough.md')), 'waiting')
  assert.equal(backlogDependencyState(node(items, 'backlog/free.md')), null)
})

// ---- Epic granular rollup ---------------------------------------------------

run('epic rollup counts blocked among remaining children; terminal children drop out', () => {
  const items = [
    mk('backlog/epics/auth.md', { type: 'epic', status: 'ready' }),
    mk('backlog/other.md', { status: 'in_progress' }),
    // 2 remaining children, 1 blocked; the completed child is out of `remaining`.
    mkChild('backlog/c1.md', 'auth', { status: 'ready', dependsOn: ['other'] }),
    mkChild('backlog/c2.md', 'auth', { status: 'ready' }),
    mkChild('backlog/c3.md', 'auth', { status: 'completed' }),
  ]
  const rollup = epicBlockedRollupBySlug(deriveBacklogDependencies(items)).get('auth')
  assert.deepEqual(rollup, { remaining: 2, blocked: 1 })
  // Partially blocked: the container is NOT fully blocked and carries no marker.
  assert.equal(isEpicFullyBlocked(rollup), false)
  assert.equal(backlogDependencyState(node(items, 'backlog/epics/auth.md'), rollup), null)
})

run('an epic reads blocked only when every remaining child is blocked', () => {
  const items = [
    mk('backlog/epics/auth.md', { type: 'epic', status: 'ready' }),
    mk('backlog/other.md', { status: 'in_progress' }),
    mkChild('backlog/c1.md', 'auth', { status: 'ready', dependsOn: ['other'] }),
    mkChild('backlog/c2.md', 'auth', { status: 'ready', dependsOn: ['other'] }),
    mkChild('backlog/c3.md', 'auth', { status: 'completed' }),
  ]
  const rollup = epicBlockedRollupBySlug(deriveBacklogDependencies(items)).get('auth')
  assert.deepEqual(rollup, { remaining: 2, blocked: 2 })
  assert.equal(isEpicFullyBlocked(rollup), true)
  assert.equal(backlogDependencyState(node(items, 'backlog/epics/auth.md'), rollup), 'blocked')
})

run('a childless or fully-completed epic is never blocked (0/0 rollup)', () => {
  const items = [
    mk('backlog/epics/empty.md', { type: 'epic', status: 'ready' }),
    mk('backlog/epics/shipped.md', { type: 'epic', status: 'ready' }),
    mkChild('backlog/done.md', 'shipped', { status: 'completed' }),
  ]
  const rollups = epicBlockedRollupBySlug(deriveBacklogDependencies(items))
  assert.deepEqual(rollups.get('empty'), { remaining: 0, blocked: 0 })
  assert.deepEqual(rollups.get('shipped'), { remaining: 0, blocked: 0 })
  assert.equal(isEpicFullyBlocked(rollups.get('empty')), false)
  assert.equal(backlogDependencyState(node(items, 'backlog/epics/empty.md'), rollups.get('empty')), null)
})

run('a completed epic never reads blocked, even over a fully gated remainder', () => {
  const items = [
    mk('backlog/epics/auth.md', { type: 'epic', status: 'completed' }),
    mk('backlog/other.md', { status: 'in_progress' }),
    mkChild('backlog/c1.md', 'auth', { status: 'ready', dependsOn: ['other'] }),
  ]
  const rollup = epicBlockedRollupBySlug(deriveBacklogDependencies(items)).get('auth')
  assert.equal(isEpicFullyBlocked(rollup), true)
  // The container's own terminal status wins: no marker on finished work.
  assert.equal(backlogDependencyState(node(items, 'backlog/epics/auth.md'), rollup), null)
})

run('dangling epic slugs roll up too, so an Unknown-epic header stays accurate', () => {
  const items = [
    mk('backlog/other.md', { status: 'in_progress' }),
    mkChild('backlog/c1.md', 'ghost', { status: 'ready', dependsOn: ['other'] }),
  ]
  const rollup = epicBlockedRollupBySlug(deriveBacklogDependencies(items)).get('ghost')
  assert.deepEqual(rollup, { remaining: 1, blocked: 1 })
})

run('orderItemsByDependencies matches the graph order', () => {
  const items = [mk('backlog/c.md', { status: 'idea', dependsOn: ['a'] }), mk('backlog/a.md', { status: 'idea' })]
  assert.deepEqual(paths(orderItemsByDependencies(items)), paths(deriveBacklogDependencies(items).order))
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
  console.log('backlogDependencies.test.ts: ok')
}

main()
