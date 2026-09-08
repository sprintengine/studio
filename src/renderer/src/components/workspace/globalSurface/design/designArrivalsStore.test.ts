import assert from 'node:assert/strict'

import type { DesignSystemBundleArrivals } from '../../../../../../shared/design-system/arrivals'
import {
  getDesignArrivalsSnapshot,
  reloadDesignArrivals,
  reportDesignArrivals,
  resetDesignArrivalsForTests,
  subscribeDesignArrivals,
} from './designArrivalsStore'

// The Design row's arrival dates, held outside the door. What matters here is
// that the row and the door cannot disagree, and that the store is honest about
// what it knows:
//
//   - one listing however many consumers are watching;
//   - a door read merges into the same snapshot rather than starting a second
//     source of truth;
//   - a repeated report publishes nothing, because the door calls it on every
//     read and every publish re-renders the drawer;
//   - a window with no `listDesignSystemArrivals` (a detached window, a test)
//     settles empty and READY rather than sitting in 'loading' forever.

type Harness = {
  calls: number
  setBundles: (bundles: DesignSystemBundleArrivals[]) => void
  failNext: (message: string) => void
}

function bundle(bundleId: string, addedAt: Record<string, string>): DesignSystemBundleArrivals {
  return { bundleId, path: `/repos/${bundleId}/design-system`, addedAt }
}

function install(): Harness {
  let bundles: DesignSystemBundleArrivals[] = []
  let failure: string | null = null
  const state: Harness = {
    calls: 0,
    setBundles: (next) => {
      bundles = next
    },
    failNext: (message) => {
      failure = message
    },
  }
  const api = {
    listDesignSystemArrivals: async () => {
      state.calls += 1
      if (failure) {
        const message = failure
        failure = null
        throw new Error(message)
      }
      return { bundles }
    },
  }
  ;(globalThis as unknown as { window: unknown }).window = { api }
  return state
}

/** A window that has no arrivals method at all — a detached window, or a test. */
function installBareWindow(): void {
  ;(globalThis as unknown as { window: unknown }).window = { api: {} }
}

const tick = async (times = 4): Promise<void> => {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

async function main(): Promise<void> {
  // ── One listing, however many consumers ───────────────────────────────────
  {
    resetDesignArrivalsForTests()
    const harness = install()
    harness.setBundles([bundle('aaaa1111', { 'components:badge': '2026-09-07T10:00:00.000Z' })])

    let notifications = 0
    const stopA = subscribeDesignArrivals(() => {
      notifications += 1
    })
    const stopB = subscribeDesignArrivals(() => {})
    await tick()
    assert.equal(harness.calls, 1, 'two consumers cost ONE listing, not one each')
    const snapshot = getDesignArrivalsSnapshot()
    assert.equal(snapshot.loadState, 'ready')
    assert.deepEqual(snapshot.bundles.map((entry) => entry.bundleId), ['aaaa1111'])
    assert.ok(notifications > 0, 'and the consumers are told when it lands')
    assert.equal(
      getDesignArrivalsSnapshot(),
      snapshot,
      'the snapshot is stable by identity between publishes',
    )
    stopA()
    stopB()
  }
  console.log('ok - the first subscriber reads the library once for everybody')

  // ── A door read merges into the same snapshot ─────────────────────────────
  {
    resetDesignArrivalsForTests()
    const harness = install()
    harness.setBundles([bundle('aaaa1111', { 'components:badge': '2026-09-01T10:00:00.000Z' })])
    const stop = subscribeDesignArrivals(() => {})
    await tick()

    // The door read the bundle the listing already knows, and found one more
    // entry than the listing did.
    reportDesignArrivals('aaaa1111', '/repos/aaaa1111/design-system', {
      'components:card': '2026-09-08T09:00:00.000Z',
    })
    let entry = getDesignArrivalsSnapshot().bundles.find((row) => row.bundleId === 'aaaa1111')
    assert.deepEqual(
      Object.keys(entry?.addedAt ?? {}).sort(),
      ['components:badge', 'components:card'],
      'a report MERGES: a read that saw fewer entries cannot delete dates the row had',
    )

    // A bundle the listing has never returned — the project's attached copy,
    // which is not in the library at all.
    reportDesignArrivals('bbbb2222', '/work/app/design-system', {
      'glyphs:glyphs/check.svg': '2026-09-08T09:30:00.000Z',
    })
    assert.deepEqual(
      getDesignArrivalsSnapshot().bundles.map((row) => row.bundleId),
      ['aaaa1111', 'bbbb2222'],
      'an unlisted bundle the door read is added rather than dropped',
    )

    // The same report again: the door runs this on every read, and an identical
    // publish would re-render the drawer for no news.
    let notifications = 0
    const watch = subscribeDesignArrivals(() => {
      notifications += 1
    })
    const before = getDesignArrivalsSnapshot()
    reportDesignArrivals('bbbb2222', '/work/app/design-system', {
      'glyphs:glyphs/check.svg': '2026-09-08T09:30:00.000Z',
    })
    assert.equal(notifications, 0, 'a report that changes nothing publishes nothing')
    assert.equal(getDesignArrivalsSnapshot(), before, 'and the snapshot keeps its identity')

    // A date that MOVED is news: the entry was re-committed, so the door and the
    // row must land on the same value.
    reportDesignArrivals('bbbb2222', '/work/app/design-system', {
      'glyphs:glyphs/check.svg': '2026-09-08T11:00:00.000Z',
    })
    assert.equal(notifications, 1)
    entry = getDesignArrivalsSnapshot().bundles.find((row) => row.bundleId === 'bbbb2222')
    assert.equal(entry?.addedAt['glyphs:glyphs/check.svg'], '2026-09-08T11:00:00.000Z')
    watch()
    stop()
    void harness
  }
  console.log('ok - a door read merges into the row`s own snapshot')

  // ── Reload re-reads the library ───────────────────────────────────────────
  {
    resetDesignArrivalsForTests()
    const harness = install()
    harness.setBundles([bundle('aaaa1111', { 'components:badge': '2026-09-01T10:00:00.000Z' })])
    const stop = subscribeDesignArrivals(() => {})
    await tick()
    assert.equal(harness.calls, 1)

    // The user registered a second folder: the count describes a library nobody
    // has any more until this lands.
    harness.setBundles([
      bundle('aaaa1111', { 'components:badge': '2026-09-01T10:00:00.000Z' }),
      bundle('cccc3333', { 'components:tile': '2026-09-08T08:00:00.000Z' }),
    ])
    reloadDesignArrivals()
    await tick()
    assert.equal(harness.calls, 2)
    assert.deepEqual(
      getDesignArrivalsSnapshot().bundles.map((row) => row.bundleId),
      ['aaaa1111', 'cccc3333'],
    )

    // A failed listing keeps the rows already counted rather than blanking the
    // badge on a timer.
    harness.failNext('the library could not be read')
    reloadDesignArrivals()
    await tick(8)
    assert.equal(getDesignArrivalsSnapshot().loadState, 'error')
    assert.deepEqual(
      getDesignArrivalsSnapshot().bundles.map((row) => row.bundleId),
      ['aaaa1111', 'cccc3333'],
      'an unreadable library is a stale count, never a vanished one',
    )
    stop()
  }
  console.log('ok - reload re-reads the library, and a failure keeps the rows')

  // ── A window without the method settles empty and ready ───────────────────
  {
    resetDesignArrivalsForTests()
    installBareWindow()
    const stop = subscribeDesignArrivals(() => {})
    await tick()
    const snapshot = getDesignArrivalsSnapshot()
    assert.deepEqual(snapshot.bundles, [])
    assert.equal(
      snapshot.loadState,
      'ready',
      'a detached window counts nothing — it does not sit in `loading` forever',
    )
    stop()
  }
  console.log('ok - a window with no arrivals API counts nothing, without throwing')

  resetDesignArrivalsForTests()
  console.log('designArrivalsStore.test.ts: ok')
}

void main()
