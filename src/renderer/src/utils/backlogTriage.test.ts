import assert from 'node:assert/strict'

import type { BacklogCriticality, BacklogDifficulty, BacklogItemStatus, BacklogRisk } from './backlog'
import {
  compareBacklogItems,
  deriveRiskColor,
  resolveBacklogRowColor,
  resolveBacklogStripeColor,
  TYPE_LABEL,
  isBacklogUnestimated,
  isBacklogUnfiled,
  matchesBacklogView,
  type BacklogSort,
  type BacklogView,
} from './backlogTriage'
import { test } from 'vitest'

test('backlogTriage', async () => {
  type Triage = {
    difficulty?: BacklogDifficulty
    criticality?: BacklogCriticality
    risk?: BacklogRisk
    status?: BacklogItemStatus
    modifiedAt?: number
    createdAtMs?: number
    relativePath?: string
    isEpic?: boolean
    epic?: string
  }

  function mk(triage: Triage): {
    difficulty?: BacklogDifficulty
    criticality?: BacklogCriticality
    risk?: BacklogRisk
    status: BacklogItemStatus
    modifiedAt: number
    createdAtMs: number
    relativePath: string
    isEpic: boolean
    epic?: string
  } {
    return {
      difficulty: triage.difficulty,
      criticality: triage.criticality,
      risk: triage.risk,
      status: triage.status ?? 'idea',
      modifiedAt: triage.modifiedAt ?? 0,
      createdAtMs: triage.createdAtMs ?? triage.modifiedAt ?? 0,
      relativePath: triage.relativePath ?? 'backlog/item.md',
      isEpic: triage.isEpic ?? false,
      epic: triage.epic,
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
      epic: 'Epic',
      feature: 'Feature',
      bug: 'Bug',
      mockup: 'Mockup',
      spike: 'Spike',
    })
  })

  run('all view is the firehose — shows every status, terminal states included', () => {
    assert.equal(matchesBacklogView(mk({}), 'all'), true)
    assert.equal(matchesBacklogView(mk({ status: 'completed' }), 'all'), true)
    assert.equal(matchesBacklogView(mk({ status: 'archived' }), 'all'), true)
  })

  run('active view is the default working set — hides completed and archived', () => {
    assert.equal(matchesBacklogView(mk({ status: 'idea' }), 'active'), true)
    assert.equal(matchesBacklogView(mk({ status: 'in_progress' }), 'active'), true)
    assert.equal(matchesBacklogView(mk({ status: 'completed' }), 'active'), false)
    assert.equal(matchesBacklogView(mk({ status: 'archived' }), 'active'), false)
  })

  run('completed view shows only completed', () => {
    assert.equal(matchesBacklogView(mk({ status: 'completed' }), 'completed'), true)
    assert.equal(matchesBacklogView(mk({ status: 'idea' }), 'completed'), false)
    assert.equal(matchesBacklogView(mk({ status: 'archived' }), 'completed'), false)
  })

  run('archived view shows only archived', () => {
    assert.equal(matchesBacklogView(mk({ status: 'archived' }), 'archived'), true)
    assert.equal(matchesBacklogView(mk({ status: 'idea' }), 'archived'), false)
    assert.equal(matchesBacklogView(mk({ status: 'completed' }), 'archived'), false)
  })

  run('quick wins are XS/S with high or critical priority', () => {
    assert.equal(matchesBacklogView(mk({ difficulty: 'xs', criticality: 'high' }), 'quick_wins'), true)
    assert.equal(matchesBacklogView(mk({ difficulty: 's', criticality: 'critical' }), 'quick_wins'), true)
    assert.equal(matchesBacklogView(mk({ difficulty: 'm', criticality: 'critical' }), 'quick_wins'), false)
    assert.equal(matchesBacklogView(mk({ difficulty: 's', criticality: 'normal' }), 'quick_wins'), false)
    // Neither terminal state leaks into a triage lens even when sizes/priority match.
    assert.equal(
      matchesBacklogView(mk({ difficulty: 'xs', criticality: 'high', status: 'archived' }), 'quick_wins'),
      false,
    )
    assert.equal(
      matchesBacklogView(mk({ difficulty: 'xs', criticality: 'high', status: 'completed' }), 'quick_wins'),
      false,
    )
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
    assert.deepEqual(
      ids(sorted, (item) => String(item.modifiedAt)),
      ['30', '20', '10'],
    )
  })

  run('created sort orders by newest created first, independent of modified time', () => {
    // The freshly-created item leads even though it was modified least recently,
    // proving the sort keys on createdAtMs rather than modifiedAt.
    const items = [
      mk({ createdAtMs: 10, modifiedAt: 99 }),
      mk({ createdAtMs: 30, modifiedAt: 1 }),
      mk({ createdAtMs: 20, modifiedAt: 50 }),
    ]
    const sorted = [...items].sort((a, b) => compareBacklogItems(a, b, 'created'))
    assert.deepEqual(
      ids(sorted, (item) => String(item.createdAtMs)),
      ['30', '20', '10'],
    )
  })

  run('isBacklogUnfiled is true only for a leaf item pointing at no epic', () => {
    assert.equal(isBacklogUnfiled(mk({})), true)
    // A blank `epic:` is the same gap as an absent one, not a slug named "".
    assert.equal(isBacklogUnfiled(mk({ epic: '   ' })), true)
    assert.equal(isBacklogUnfiled(mk({ epic: 'auth' })), false)
    // An epic container is the filing cabinet, never a loose item.
    assert.equal(isBacklogUnfiled(mk({ isEpic: true })), false)
  })

  run('no_epic sort leads with unfiled items, newest first', () => {
    const items = [
      mk({ relativePath: 'filed-old.md', epic: 'auth', modifiedAt: 5 }),
      mk({ relativePath: 'loose-old.md', modifiedAt: 1 }),
      mk({ relativePath: 'loose-new.md', modifiedAt: 9 }),
    ]
    const sorted = [...items].sort((a, b) => compareBacklogItems(a, b, 'no_epic'))
    assert.deepEqual(
      ids(sorted, (item) => item.relativePath),
      ['loose-new.md', 'loose-old.md', 'filed-old.md'],
    )
  })

  run('no_epic sort keeps each epic members adjacent below the unfiled band', () => {
    // Two epics interleaved by recency in the input: the sort must gather each
    // epic's members rather than letting recency shuffle them together.
    const items = [
      mk({ relativePath: 'b1.md', epic: 'billing', modifiedAt: 40 }),
      mk({ relativePath: 'a1.md', epic: 'auth', modifiedAt: 30 }),
      mk({ relativePath: 'b2.md', epic: 'billing', modifiedAt: 20 }),
      mk({ relativePath: 'a2.md', epic: 'auth', modifiedAt: 10 }),
      mk({ relativePath: 'loose.md', modifiedAt: 1 }),
    ]
    const sorted = [...items].sort((a, b) => compareBacklogItems(a, b, 'no_epic'))
    assert.deepEqual(
      ids(sorted, (item) => item.relativePath),
      ['loose.md', 'a1.md', 'a2.md', 'b1.md', 'b2.md'],
    )
  })

  run('no_epic sort does not strand epic containers in the unfiled band', () => {
    // The epic header has no `epic:` of its own, but it is not loose work — only
    // the genuinely unfiled leaf may lead.
    const items = [
      mk({ relativePath: 'epic.md', isEpic: true, modifiedAt: 50 }),
      mk({ relativePath: 'loose.md', modifiedAt: 1 }),
    ]
    const sorted = [...items].sort((a, b) => compareBacklogItems(a, b, 'no_epic'))
    assert.deepEqual(
      ids(sorted, (item) => item.relativePath),
      ['loose.md', 'epic.md'],
    )
  })

  run('epics view shows only epic containers, at any lifecycle stage', () => {
    assert.equal(matchesBacklogView(mk({ isEpic: true }), 'epics'), true)
    assert.equal(matchesBacklogView(mk({ isEpic: false }), 'epics'), false)
    // Structural lens: a completed or archived epic still shows (unlike the
    // working-set lenses, which hide terminal states).
    assert.equal(matchesBacklogView(mk({ isEpic: true, status: 'completed' }), 'epics'), true)
    assert.equal(matchesBacklogView(mk({ isEpic: true, status: 'archived' }), 'epics'), true)
    assert.equal(matchesBacklogView(mk({ isEpic: false, status: 'in_progress' }), 'epics'), false)
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
    assert.deepEqual(
      ids(sorted, (item) => item.status),
      ['needs_input', 'in_progress', 'in_progress', 'ready', 'idea', 'completed'],
    )
    // Within the in_progress band the newer item leads.
    assert.deepEqual(
      ids(
        sorted.filter((item) => item.status === 'in_progress'),
        (item) => String(item.modifiedAt),
      ),
      ['6', '5'],
    )
  })

  run('priority sort puts critical first, small-before-large on ties, unset last', () => {
    const smallCritical = mk({ difficulty: 'xs', criticality: 'critical', modifiedAt: 1 })
    const largeCritical = mk({ difficulty: 'xl', criticality: 'critical', modifiedAt: 2 })
    const high = mk({ difficulty: 'm', criticality: 'high', modifiedAt: 3 })
    const unset = mk({ difficulty: 'm', modifiedAt: 4 })
    const sorted = [unset, high, largeCritical, smallCritical].sort((a, b) => compareBacklogItems(a, b, 'priority'))
    assert.deepEqual(
      ids(sorted, (item) => item.criticality ?? 'none'),
      ['critical', 'critical', 'high', 'none'],
    )
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
      assert.deepEqual(
        ids(sorted, (item) => item.difficulty ?? 'none'),
        expected,
      )
    })
  }

  run('best sort orders impact desc → risk asc → effort asc, unestimated last per tier', () => {
    const a = mk({ criticality: 'critical', risk: 'low', difficulty: 's', relativePath: 'backlog/a.md' })
    const b = mk({ criticality: 'critical', risk: 'low', difficulty: 'l', relativePath: 'backlog/b.md' })
    const c = mk({ criticality: 'critical', risk: 'high', difficulty: 'xs', relativePath: 'backlog/c.md' })
    const e = mk({ criticality: 'critical', difficulty: 'xs', relativePath: 'backlog/e.md' }) // risk unset
    const d = mk({ criticality: 'high', risk: 'low', difficulty: 'xs', relativePath: 'backlog/d.md' })
    const sorted = [e, d, c, b, a].sort((x, y) => compareBacklogItems(x, y, 'best'))
    assert.deepEqual(
      ids(sorted, (item) => item.relativePath),
      [
        'backlog/a.md', // critical, low risk, small effort — the best pick
        'backlog/b.md', // critical, low risk, larger effort
        'backlog/c.md', // critical, higher risk
        'backlog/e.md', // critical, risk unestimated — after risk-estimated peers
        'backlog/d.md', // lower impact sinks regardless of how easy/safe it is
      ],
    )
  })

  run('status sort demotes derived-blocked items below idea, above the terminal states', () => {
    // Two stored-`ready` items, one gated by unresolved prerequisites: the
    // blocked one leaves the ready band and lands after idea but before
    // completed/archived — it is open work that cannot be started.
    const blockedPath = 'backlog/gated.md'
    const isBlocked = (item: { relativePath: string }): boolean => item.relativePath === blockedPath
    const items = [
      mk({ status: 'archived', modifiedAt: 9, relativePath: 'backlog/x.md' }),
      mk({ status: 'completed', modifiedAt: 8, relativePath: 'backlog/y.md' }),
      mk({ status: 'ready', modifiedAt: 7, relativePath: blockedPath }),
      mk({ status: 'idea', modifiedAt: 6, relativePath: 'backlog/i.md' }),
      mk({ status: 'ready', modifiedAt: 1, relativePath: 'backlog/r.md' }),
    ]
    const sorted = [...items].sort((a, b) => compareBacklogItems(a, b, 'status', isBlocked))
    assert.deepEqual(
      ids(sorted, (item) => item.relativePath),
      [
        'backlog/r.md', // genuinely ready
        'backlog/i.md', // idea
        'backlog/gated.md', // blocked: after every actionable band
        'backlog/y.md', // completed
        'backlog/x.md', // archived
      ],
    )
    // Without the accessor the stored-status bands are unchanged (graph-less surfaces).
    const plain = [...items].sort((a, b) => compareBacklogItems(a, b, 'status'))
    assert.deepEqual(ids(plain, (item) => item.relativePath).slice(0, 2), ['backlog/gated.md', 'backlog/r.md'])
  })

  run('best sort sinks derived-blocked items below every unblocked item', () => {
    // The gated item is the best on the composite (critical/low/xs) but cannot be
    // picked up, so it sorts after every actionable item; within the blocked half
    // the composite still orders.
    const isBlocked = (item: { relativePath: string }): boolean => item.relativePath.startsWith('backlog/blocked')
    const bestButBlocked = mk({
      criticality: 'critical',
      risk: 'low',
      difficulty: 'xs',
      status: 'ready',
      relativePath: 'backlog/blocked-a.md',
    })
    const alsoBlocked = mk({
      criticality: 'low',
      risk: 'low',
      difficulty: 'xs',
      status: 'ready',
      relativePath: 'backlog/blocked-b.md',
    })
    const modest = mk({
      criticality: 'normal',
      risk: 'normal',
      difficulty: 'l',
      status: 'ready',
      relativePath: 'backlog/free.md',
    })
    const sorted = [alsoBlocked, bestButBlocked, modest].sort((a, b) => compareBacklogItems(a, b, 'best', isBlocked))
    assert.deepEqual(
      ids(sorted, (item) => item.relativePath),
      ['backlog/free.md', 'backlog/blocked-a.md', 'backlog/blocked-b.md'],
    )
  })

  run('best sort breaks exact ties by stable path order, not recency', () => {
    const later = mk({
      criticality: 'high',
      risk: 'normal',
      difficulty: 'm',
      modifiedAt: 100,
      relativePath: 'backlog/z-late.md',
    })
    const earlier = mk({
      criticality: 'high',
      risk: 'normal',
      difficulty: 'm',
      modifiedAt: 1,
      relativePath: 'backlog/a-early.md',
    })
    const sorted = [later, earlier].sort((x, y) => compareBacklogItems(x, y, 'best'))
    assert.deepEqual(
      ids(sorted, (item) => item.relativePath),
      ['backlog/a-early.md', 'backlog/z-late.md'],
    )
  })

  run('deriveRiskColor pins the grid corners and stays null when an axis is unset', () => {
    assert.equal(deriveRiskColor('low', 'xs'), 'green') // easy + safe → confident pick
    assert.equal(deriveRiskColor('high', 'xl'), 'red') // hard + risky → costly gamble
    assert.equal(deriveRiskColor('low', 'xl'), 'amber') // safe but large
    assert.equal(deriveRiskColor('high', 'xs'), 'amber') // small but risky
    assert.equal(deriveRiskColor('normal', 'm'), null) // calm middle → no stripe
    assert.equal(deriveRiskColor(undefined, 'xs'), null) // unestimated → no derived color
    assert.equal(deriveRiskColor('high', undefined), null)
  })

  run('deriveRiskColor maps the full risk×difficulty grid to the warm heat ramp', () => {
    const grid = (['low', 'normal', 'high'] as const).map((risk) =>
      (['xs', 's', 'm', 'l', 'xl'] as const).map((difficulty) => deriveRiskColor(risk, difficulty)),
    )
    assert.deepEqual(grid, [
      ['green', 'green', null, null, 'amber'],
      ['green', null, null, 'amber', 'orange'],
      ['amber', 'amber', 'orange', 'orange', 'red'],
    ])
  })

  run('resolveBacklogStripeColor lets the manual highlight color override the derived heat', () => {
    // Derived would be red (high + xl); the hand-set blue always wins.
    assert.equal(
      resolveBacklogStripeColor({ highlight: { starred: false, color: 'blue' }, risk: 'high', difficulty: 'xl' }),
      'blue',
    )
    // Starred but no color set → the derived heat still shows through the stripe.
    assert.equal(
      resolveBacklogStripeColor({ highlight: { starred: true, color: null }, risk: 'high', difficulty: 'xl' }),
      'red',
    )
    // No highlight and nothing to derive from → no stripe at all.
    assert.equal(resolveBacklogStripeColor({ risk: 'high' }), null)
  })

  run('resolveBacklogRowColor ranks highlight over epic colour over derived heat', () => {
    // 1. Hand-set highlight wins over both the epic colour and the derived heat,
    //    and earns the full-width lit fill.
    assert.deepEqual(
      resolveBacklogRowColor(
        { highlight: { starred: false, color: 'blue' }, risk: 'high', difficulty: 'xl' },
        'purple',
      ),
      { color: 'blue', litFill: true },
    )
    // 2. No highlight → the epic identity colour fills the whole member row
    //    (option C), overriding what the risk heat would have shown.
    assert.deepEqual(resolveBacklogRowColor({ risk: 'high', difficulty: 'xl' }, 'purple'), {
      color: 'purple',
      litFill: true,
    })
    // 3. No highlight and no epic colour → derived risk heat tints the stripe only
    //    (no fill), exactly as before epics carried a colour.
    assert.deepEqual(resolveBacklogRowColor({ risk: 'high', difficulty: 'xl' }, null), { color: 'red', litFill: false })
    // 4. Nothing anywhere → no colour, no fill.
    assert.deepEqual(resolveBacklogRowColor({}, null), { color: null, litFill: false })
  })

  // Keep the example views from the brief honest: each lens partitions a mixed set
  // the way the product direction describes.
  run('the named lenses partition a mixed backlog as documented', () => {
    const backlog = [
      mk({ difficulty: 'xs', criticality: 'critical' }), // quick win
      mk({ difficulty: 'l', criticality: 'high' }), // strategic bet
      mk({ difficulty: 'xl', criticality: 'low' }), // defer
      mk({ difficulty: 'm' }), // unestimated (no priority)
      mk({ status: 'completed' }), // completed
      mk({ status: 'archived' }), // archived
    ]
    const lenses: BacklogView[] = ['quick_wins', 'strategic_bets', 'defer', 'unestimated', 'completed', 'archived']
    const counts = lenses.map((lens) => backlog.filter((item) => matchesBacklogView(item, lens)).length)
    assert.deepEqual(counts, [1, 1, 1, 1, 1, 1])
    // Active is the working set: the four estimated/unestimated items, neither
    // terminal one. All items is the firehose: every row.
    assert.equal(backlog.filter((item) => matchesBacklogView(item, 'active')).length, 4)
    assert.equal(backlog.filter((item) => matchesBacklogView(item, 'all')).length, 6)
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
})
