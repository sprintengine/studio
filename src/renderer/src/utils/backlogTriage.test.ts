import assert from 'node:assert/strict'

import type { BacklogCriticality, BacklogDifficulty, BacklogItemStatus } from './backlog'
import {
  compareBacklogItems,
  TYPE_LABEL,
  isBacklogUnestimated,
  matchesBacklogView,
  type BacklogSort,
  type BacklogView,
} from './backlogTriage'

type Triage = {
  difficulty?: BacklogDifficulty
  criticality?: BacklogCriticality
  status?: BacklogItemStatus
  modifiedAt?: number
}

function mk(triage: Triage): {
  difficulty?: BacklogDifficulty
  criticality?: BacklogCriticality
  status: BacklogItemStatus
  modifiedAt: number
} {
  return {
    difficulty: triage.difficulty,
    criticality: triage.criticality,
    status: triage.status ?? 'idea',
    modifiedAt: triage.modifiedAt ?? 0,
  }
}

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

function ids<T>(items: T[], pick: (item: T) => string): string[] {
  return items.map(pick)
}

run('isBacklogUnestimated is true when either axis is missing', () => {
  assert.equal(isBacklogUnestimated(mk({ difficulty: 'm', criticality: 'high' })), false)
  assert.equal(isBacklogUnestimated(mk({ difficulty: 'm' })), true)
  assert.equal(isBacklogUnestimated(mk({ criticality: 'high' })), true)
  assert.equal(isBacklogUnestimated(mk({})), true)
})

run('type labels use the public backlog vocabulary', () => {
  assert.deepEqual(TYPE_LABEL, {
    feature: 'Feature',
    bug: 'Bug',
    mockup: 'Mockup',
    spike: 'Spike',
  })
})

run('all view shows everything except archived', () => {
  assert.equal(matchesBacklogView(mk({}), 'all'), true)
  assert.equal(matchesBacklogView(mk({ status: 'archived' }), 'all'), false)
})

run('archived view shows only archived', () => {
  assert.equal(matchesBacklogView(mk({ status: 'archived' }), 'archived'), true)
  assert.equal(matchesBacklogView(mk({ status: 'idea' }), 'archived'), false)
})

run('quick wins are XS/S with high or critical priority', () => {
  assert.equal(matchesBacklogView(mk({ difficulty: 'xs', criticality: 'high' }), 'quick_wins'), true)
  assert.equal(matchesBacklogView(mk({ difficulty: 's', criticality: 'critical' }), 'quick_wins'), true)
  assert.equal(matchesBacklogView(mk({ difficulty: 'm', criticality: 'critical' }), 'quick_wins'), false)
  assert.equal(matchesBacklogView(mk({ difficulty: 's', criticality: 'normal' }), 'quick_wins'), false)
  // Archived never leaks into a triage lens even when sizes/priority match.
  assert.equal(matchesBacklogView(mk({ difficulty: 'xs', criticality: 'high', status: 'archived' }), 'quick_wins'), false)
})

run('strategic bets are L/XL with high or critical priority', () => {
  assert.equal(matchesBacklogView(mk({ difficulty: 'l', criticality: 'high' }), 'strategic_bets'), true)
  assert.equal(matchesBacklogView(mk({ difficulty: 'xl', criticality: 'critical' }), 'strategic_bets'), true)
  assert.equal(matchesBacklogView(mk({ difficulty: 's', criticality: 'critical' }), 'strategic_bets'), false)
})

run('defer candidates are L/XL with low priority', () => {
  assert.equal(matchesBacklogView(mk({ difficulty: 'xl', criticality: 'low' }), 'defer'), true)
  assert.equal(matchesBacklogView(mk({ difficulty: 'l', criticality: 'normal' }), 'defer'), false)
})

run('unestimated view collects items missing either axis', () => {
  assert.equal(matchesBacklogView(mk({ difficulty: 'm' }), 'unestimated'), true)
  assert.equal(matchesBacklogView(mk({ difficulty: 'm', criticality: 'low' }), 'unestimated'), false)
})

run('recent sort orders by newest modified first', () => {
  const items = [mk({ modifiedAt: 10 }), mk({ modifiedAt: 30 }), mk({ modifiedAt: 20 })]
  const sorted = [...items].sort((a, b) => compareBacklogItems(a, b, 'recent'))
  assert.deepEqual(ids(sorted, (item) => String(item.modifiedAt)), ['30', '20', '10'])
})

run('status sort bands needs_input → in_progress → ready → idea → completed, newest within a band', () => {
  const items = [
    mk({ status: 'completed', modifiedAt: 9 }),
    mk({ status: 'idea', modifiedAt: 8 }),
    mk({ status: 'ready', modifiedAt: 7 }),
    mk({ status: 'in_progress', modifiedAt: 5 }),
    mk({ status: 'in_progress', modifiedAt: 6 }),
    mk({ status: 'needs_input', modifiedAt: 1 }),
  ]
  const sorted = [...items].sort((a, b) => compareBacklogItems(a, b, 'status'))
  assert.deepEqual(ids(sorted, (item) => item.status), [
    'needs_input',
    'in_progress',
    'in_progress',
    'ready',
    'idea',
    'completed',
  ])
  // Within the in_progress band the newer item leads.
  assert.deepEqual(
    ids(sorted.filter((item) => item.status === 'in_progress'), (item) => String(item.modifiedAt)),
    ['6', '5'],
  )
})

run('priority sort puts critical first, small-before-large on ties, unset last', () => {
  const smallCritical = mk({ difficulty: 'xs', criticality: 'critical', modifiedAt: 1 })
  const largeCritical = mk({ difficulty: 'xl', criticality: 'critical', modifiedAt: 2 })
  const high = mk({ difficulty: 'm', criticality: 'high', modifiedAt: 3 })
  const unset = mk({ difficulty: 'm', modifiedAt: 4 })
  const sorted = [unset, high, largeCritical, smallCritical].sort((a, b) =>
    compareBacklogItems(a, b, 'priority'),
  )
  assert.deepEqual(ids(sorted, (item) => item.criticality ?? 'none'), [
    'critical',
    'critical',
    'high',
    'none',
  ])
  // Among the two criticals, the smaller difficulty (the quick win) wins.
  assert.equal(sorted[0]?.difficulty, 'xs')
})

const sizeCases: Array<{ sort: BacklogSort; expected: Array<BacklogDifficulty | 'none'> }> = [
  { sort: 'largest', expected: ['xl', 'm', 'xs', 'none'] },
  { sort: 'smallest', expected: ['xs', 'm', 'xl', 'none'] },
]
for (const { sort, expected } of sizeCases) {
  run(`${sort} sort orders by size and sinks unestimated`, () => {
    const items = [
      mk({ difficulty: 'm', modifiedAt: 1 }),
      mk({ modifiedAt: 2 }),
      mk({ difficulty: 'xl', modifiedAt: 3 }),
      mk({ difficulty: 'xs', modifiedAt: 4 }),
    ]
    const sorted = [...items].sort((a, b) => compareBacklogItems(a, b, sort))
    assert.deepEqual(ids(sorted, (item) => item.difficulty ?? 'none'), expected)
  })
}

// Keep the example views from the brief honest: each lens partitions a mixed set
// the way the product direction describes.
run('the named lenses partition a mixed backlog as documented', () => {
  const backlog = [
    mk({ difficulty: 'xs', criticality: 'critical' }), // quick win
    mk({ difficulty: 'l', criticality: 'high' }), // strategic bet
    mk({ difficulty: 'xl', criticality: 'low' }), // defer
    mk({ difficulty: 'm' }), // unestimated (no priority)
    mk({ status: 'archived' }), // archived
  ]
  const lenses: BacklogView[] = ['quick_wins', 'strategic_bets', 'defer', 'unestimated', 'archived']
  const counts = lenses.map((lens) => backlog.filter((item) => matchesBacklogView(item, lens)).length)
  assert.deepEqual(counts, [1, 1, 1, 1, 1])
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
  console.error(`backlogTriage.test.ts: ${failures} failing`)
  process.exit(1)
}
console.log('backlogTriage.test.ts: ok')
