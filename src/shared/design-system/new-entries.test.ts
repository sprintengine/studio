import assert from 'node:assert/strict'

import { DESIGN_SYSTEM_NEW_FOR_DAYS, designSystemEntryKey, newDesignSystemEntryKeys } from './new-entries'
import { test } from 'vitest'

test('new-entries', async () => {
  // The Design door's "arrived since you last looked" rule. Every case here is one
  // the marker gets wrong in a way the person cannot see: a fresh profile that
  // lights up every component it has ever had, a repeat visit that keeps showing
  // the same four, a bundle with no dates that marks everything, and a clock that
  // ran ahead.

  const tests: Array<{ name: string; body: () => void }> = []
  function run(name: string, body: () => void): void {
    tests.push({ name, body })
  }

  const NOW = new Date('2026-09-08T12:00:00.000Z')

  function daysAgo(days: number): string {
    return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  }

  run('the entry key is the manifest group and the manifest string, verbatim', () => {
    // Components are declared as bare names, patterns as bundle-relative paths.
    // Both survive intact, and neither collides with the other.
    assert.equal(designSystemEntryKey('components', 'badge'), 'components:badge')
    assert.equal(designSystemEntryKey('patterns', 'patterns/context-rail.html'), 'patterns:patterns/context-rail.html')
    assert.notEqual(designSystemEntryKey('components', 'badge'), designSystemEntryKey('glyphs', 'badge'))
  })

  run('a bundle never opened before marks only the recent arrivals', () => {
    // The whole reason the never-seen case is not "everything is new": pointing a
    // fresh profile at a five-year-old repo must not paint 200 markers, which is
    // indistinguishable from no markers at all.
    const marked = newDesignSystemEntryKeys({
      addedAt: {
        'components:ancient': daysAgo(900),
        'components:old': daysAgo(DESIGN_SYSTEM_NEW_FOR_DAYS + 1),
        'components:fresh': daysAgo(2),
        'patterns:patterns/new-thing.html': daysAgo(DESIGN_SYSTEM_NEW_FOR_DAYS - 1),
      },
      seenAt: null,
      now: NOW,
    })
    assert.deepEqual([...marked].sort(), ['components:fresh', 'patterns:patterns/new-thing.html'])
  })

  run('a bundle seen before marks exactly what arrived after that visit', () => {
    const marked = newDesignSystemEntryKeys({
      addedAt: {
        // Long before the visit, and far outside the never-seen window: proof the
        // window stops applying the moment there is a real last-visit date.
        'components:ancient': daysAgo(900),
        // The moment of the visit itself: it was on screen, so it is not new.
        'components:on-screen-then': daysAgo(10),
        'components:after': daysAgo(9),
        // Older than the never-seen window, but newer than the visit: still new.
        'glyphs:glyphs/late.svg': daysAgo(9.5),
      },
      seenAt: daysAgo(10),
      now: NOW,
    })
    assert.deepEqual([...marked].sort(), ['components:after', 'glyphs:glyphs/late.svg'])
  })

  run('a very old visit still marks only what came after it, not the window', () => {
    // A person who last opened this bundle two years ago sees everything since,
    // however long ago "since" started. The 30-day window is the never-seen
    // fallback and must not leak into the seen case.
    const marked = newDesignSystemEntryKeys({
      addedAt: { 'components:a': daysAgo(400), 'components:b': daysAgo(900) },
      seenAt: daysAgo(800),
      now: NOW,
    })
    assert.deepEqual([...marked], ['components:a'])
  })

  run('no addedAt data means no markers at all', () => {
    // A bundle outside git whose files carry no usable birthtime. An unknown date
    // is never a marker: "New" on everything is "New" on nothing.
    assert.equal(newDesignSystemEntryKeys({ addedAt: undefined, seenAt: null, now: NOW }).size, 0)
    assert.equal(newDesignSystemEntryKeys({ addedAt: null, seenAt: daysAgo(3), now: NOW }).size, 0)
    assert.equal(newDesignSystemEntryKeys({ addedAt: {}, seenAt: null, now: NOW }).size, 0)
    // An entry whose date could not be parsed drops out rather than defaulting to
    // new or to seen.
    assert.equal(
      newDesignSystemEntryKeys({
        addedAt: { 'components:a': 'not a date', 'components:b': '' },
        seenAt: null,
        now: NOW,
      }).size,
      0,
    )
  })

  run('an unparseable last-visit date falls back to the never-seen rule', () => {
    // Never silently "everything is seen": a corrupted settings value must not be
    // able to delete a marker the person has not looked at yet.
    const marked = newDesignSystemEntryKeys({
      addedAt: { 'components:fresh': daysAgo(1), 'components:old': daysAgo(400) },
      seenAt: 'yesterday-ish',
      now: NOW,
    })
    assert.deepEqual([...marked], ['components:fresh'])
  })

  run('clock skew counts as new, in both halves of the rule', () => {
    // A date ahead of the machine's clock — a commit dated in the future, or a
    // clock that moved. "Arrived after you last looked" is honestly yes, and the
    // never-seen half agrees rather than quietly dropping it.
    const seen = newDesignSystemEntryKeys({
      addedAt: { 'components:future': '2027-01-01T00:00:00.000Z' },
      seenAt: daysAgo(1),
      now: NOW,
    })
    assert.deepEqual([...seen], ['components:future'])
    const unseen = newDesignSystemEntryKeys({
      addedAt: { 'components:future': '2027-01-01T00:00:00.000Z' },
      seenAt: null,
      now: NOW,
    })
    assert.deepEqual([...unseen], ['components:future'])
  })

  run('the window is overridable, and it is the model picker`s own length', () => {
    assert.equal(DESIGN_SYSTEM_NEW_FOR_DAYS, 30)
    const marked = newDesignSystemEntryKeys({
      addedAt: { 'components:a': daysAgo(3) },
      seenAt: null,
      now: NOW,
      days: 2,
    })
    assert.equal(marked.size, 0)
  })

  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('new-entries.test.ts: ok')
})
