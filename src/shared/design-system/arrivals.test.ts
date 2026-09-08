import assert from 'node:assert/strict'

import { designSystemNewEntryCount, type DesignSystemBundleArrivals } from './arrivals'
import { DESIGN_SYSTEM_NEW_FOR_DAYS } from './new-entries'

// The Design row's count. The rule itself is `new-entries.test.ts`'s subject;
// what is tested here is the SUM — the part the row adds and the door never had
// to do. Every case is one where a wrong sum is invisible to the person: a
// second system silently hidden behind the first one's visit, a badge that
// survives opening the door, and a fresh profile lighting up a whole repo.

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

const NOW = new Date('2026-09-08T12:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

function bundle(
  bundleId: string,
  addedAt: Record<string, string>,
): DesignSystemBundleArrivals {
  return { bundleId, path: `/repos/${bundleId}/design-system`, addedAt }
}

run('the count sums every bundle in the library', () => {
  const count = designSystemNewEntryCount({
    bundles: [
      bundle('aaaa1111', { 'components:badge': daysAgo(1), 'components:card': daysAgo(2) }),
      bundle('bbbb2222', { 'patterns:patterns/rail.html': daysAgo(3) }),
    ],
    seen: { aaaa1111: daysAgo(5), bbbb2222: daysAgo(5) },
    now: NOW,
  })
  assert.equal(count, 3)
})

run('each bundle is measured against its OWN visit', () => {
  // The failure this prevents: one seen stamp applied to the whole library, so
  // opening the system you look at every day silences the one you have not
  // opened in a year.
  const bundles = [
    bundle('aaaa1111', { 'components:badge': daysAgo(2) }),
    bundle('bbbb2222', { 'components:tile': daysAgo(2) }),
  ]
  assert.equal(
    designSystemNewEntryCount({ bundles, seen: { aaaa1111: daysAgo(1) }, now: NOW }),
    1,
    'the bundle visited yesterday drops out; the untouched one still counts',
  )
  assert.equal(
    designSystemNewEntryCount({
      bundles,
      seen: { aaaa1111: daysAgo(1), bbbb2222: daysAgo(1) },
      now: NOW,
    }),
    0,
    'and opening both clears the row',
  )
})

run('a bundle nobody has opened counts only its recent arrivals', () => {
  // The never-seen half of the rule, reached through the sum: pointing a fresh
  // profile at a five-year-old repo must not put 200 on the Design row.
  const count = designSystemNewEntryCount({
    bundles: [
      bundle('aaaa1111', {
        'components:ancient': daysAgo(900),
        'components:older': daysAgo(DESIGN_SYSTEM_NEW_FOR_DAYS + 1),
        'components:fresh': daysAgo(2),
      }),
    ],
    seen: {},
    now: NOW,
  })
  assert.equal(count, 1)
})

run('a bundle with no arrival dates contributes nothing', () => {
  // A bundle outside git whose files carry no birthtime draws no markers in the
  // door, so it must not put a number on the row either.
  assert.equal(
    designSystemNewEntryCount({
      bundles: [bundle('aaaa1111', {}), bundle('bbbb2222', { 'components:a': 'not a date' })],
      seen: {},
      now: NOW,
    }),
    0,
  )
})

run('an empty library is zero, not a badge', () => {
  assert.equal(designSystemNewEntryCount({ bundles: [], seen: {}, now: NOW }), 0)
  // A seen stamp for a bundle that is no longer registered is inert rather than
  // an error: forgetting a folder leaves its stamp behind in settings forever.
  assert.equal(
    designSystemNewEntryCount({ bundles: [], seen: { cccc3333: daysAgo(1) }, now: NOW }),
    0,
  )
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
console.log('arrivals.test.ts: ok')
