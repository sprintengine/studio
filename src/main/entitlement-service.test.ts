/**
 * MC-2169 — the provider-agnostic entitlement seam. These assertions ARE the
 * gating contract the Multiauth adapter used to own inline: they must still
 * hold, unchanged, after a provider swap, because nothing here knows who the
 * provider is. The fake below implements the whole port — two methods.
 */
import assert from 'node:assert/strict'
import type { EntitlementSnapshot, PremiumAccessDecision } from '../shared/electron-api'
import {
  ENTITLEMENT_GRACE_MS,
  ENTITLEMENT_MAX_CACHE_AGE_MS,
  EntitlementService,
  entitlementCacheStatus,
  entitlementGraceExpiresAt,
  isEntitlementCacheTooStale,
  isEntitlementSnapshot,
  isEntitlementSnapshotFresh,
  offlineGraceMessage,
  type CachedEntitlementSnapshot,
  type EntitlementProvider,
  type EntitlementReading,
} from './entitlement-service'
import { test } from 'vitest'

test('entitlement-service', async () => {
  const HOUR_MS = 60 * 60 * 1000
  // A purely local premium feature: nothing server-side happens when it runs, so
  // it is the case offline grace exists to keep working. There is no allowlist —
  // this is an ordinary key, and that is the point.
  const LOCAL_KEY = 'multicode.local_premium'
  // What Multiauth actually issues: `expiresAt = issuedAt + 72h` (SNAPSHOT_TTL_MS
  // in `../multiauth/src/entitlements/resolver.ts`). The grace bug survived the
  // old suite because no fixture used this shape.
  const SNAPSHOT_TTL_MS = 72 * HOUR_MS

  // A default-TTL cache fetched `ageMs` ago: issued then, expiring 72h later, and
  // stamped `lastRefreshAt` at fetch time — the arithmetic the `min` collapsed.
  function defaultTtlCache(
    ageMs: number,
    features: EntitlementSnapshot['features'] = { [LOCAL_KEY]: true },
  ): CachedEntitlementSnapshot {
    const issuedAt = new Date(Date.now() - ageMs)
    const snap = snapshot({
      features,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + SNAPSHOT_TTL_MS).toISOString(),
    })
    return { snapshot: snap, lastRefreshAt: issuedAt.toISOString() }
  }

  function snapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
    return {
      userId: 'user_1',
      organizationId: 'org_1',
      product: 'multicode',
      roles: [],
      features: {},
      limits: {},
      sources: {},
      plan: { code: 'pro', status: 'active' },
      issuedAt: new Date(Date.now() - HOUR_MS).toISOString(),
      expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
      schemaVersion: 1,
      ...overrides,
    }
  }

  // A provider that hands back exactly what the test set, and counts refreshes so
  // "did the seam actually go back to the source" is observable.
  class FakeProvider implements EntitlementProvider {
    refreshCount = 0
    onRefresh: (() => void) | null = null

    constructor(private reading: EntitlementReading) {}

    read(): EntitlementReading {
      return this.reading
    }

    async refresh(): Promise<void> {
      this.refreshCount += 1
      this.onRefresh?.()
    }

    set(reading: EntitlementReading): void {
      this.reading = reading
    }
  }

  function signedIn(snap: EntitlementSnapshot, cache?: CachedEntitlementSnapshot | null): EntitlementReading {
    return {
      authenticated: true,
      snapshot: snap,
      cache: cache ?? null,
      lastRefreshAt: (cache ?? null)?.lastRefreshAt ?? new Date().toISOString(),
    }
  }

  function serviceFor(reading: EntitlementReading): { service: EntitlementService; provider: FakeProvider } {
    const provider = new FakeProvider(reading)
    return { service: new EntitlementService(provider, { product: 'multicode' }), provider }
  }

  function check(reading: EntitlementReading, featureKey: string, extra = {}): Promise<PremiumAccessDecision> {
    return serviceFor(reading).service.checkAccess({ featureKey, ...extra })
  }

  async function main(): Promise<void> {
    // Signed out: refused before any snapshot is consulted, and the refusal says
    // so — a surface must be able to offer sign-in rather than an upgrade.
    {
      const decision = await check(
        { authenticated: false, snapshot: null, cache: null, lastRefreshAt: null },
        'multicode.anything',
      )
      assert.equal(decision.allowed, false)
      assert.equal(decision.status, 'signed_out')
    }

    // Signed in with nothing to check: "could not verify", never a silent allow.
    for (const bad of [
      { authenticated: true, snapshot: null, cache: null, lastRefreshAt: null },
      signedIn(snapshot({ schemaVersion: 2 as unknown as 1 })),
      signedIn(snapshot({ product: 'other' as unknown as 'multicode' })),
    ] satisfies EntitlementReading[]) {
      const decision = await check(bad, LOCAL_KEY)
      assert.equal(decision.allowed, false, 'an unusable snapshot must not grant anything')
      assert.equal(decision.status, 'missing')
    }

    // A fresh boolean feature: allowed, and the value travels with the decision.
    {
      const decision = await check(
        signedIn(snapshot({ features: { 'multicode.mobile_companion': true } })),
        'multicode.mobile_companion',
      )
      assert.equal(decision.allowed, true)
      assert.equal(decision.status, 'fresh')
      assert.equal(decision.value, true)
    }

    // A feature explicitly false, and a key present in neither map, both read as
    // "not entitled" with the upgrade message rather than an error.
    for (const key of ['multicode.off', 'multicode.unknown']) {
      const decision = await check(signedIn(snapshot({ features: { 'multicode.off': false } })), key)
      assert.equal(decision.allowed, false, `${key} must not be granted`)
      assert.equal(decision.status, 'missing')
    }

    // Numeric limits gate on the requested amount and report the ceiling.
    {
      const reading = signedIn(snapshot({ limits: { 'multicode.seats': 3 } }))
      const within = await check(reading, 'multicode.seats', { amount: 3 })
      assert.equal(within.allowed, true)
      assert.equal(within.limit, 3)

      const over = await check(reading, 'multicode.seats', { amount: 4 })
      assert.equal(over.allowed, false)
      assert.equal(over.limit, 3, 'a refusal still tells the caller the ceiling')

      const zero = await check(signedIn(snapshot({ limits: { 'multicode.seats': 0 } })), 'multicode.seats')
      assert.equal(zero.allowed, false)
    }

    // String-valued entitlements (a tier name, a region) allow when non-blank.
    {
      const set = await check(signedIn(snapshot({ features: { 'multicode.tier': 'team' } })), 'multicode.tier')
      assert.equal(set.allowed, true)
      assert.equal(set.value, 'team')

      const blank = await check(signedIn(snapshot({ features: { 'multicode.tier': '  ' } })), 'multicode.tier')
      assert.equal(blank.allowed, false)
    }

    // MC-2187 — the ladder walked on the snapshot the server actually issues: a
    // 72h TTL stamped `lastRefreshAt` at fetch time. This is the case the old
    // `min(expiresAt + grace, lastRefreshAt + grace)` collapsed to a zero-width
    // window, so `offline_grace` was unreachable and premium died at the TTL.
    {
      const ladder: Array<[number, string]> = [
        [71 * HOUR_MS, 'fresh'],
        // Both boundaries: one minute either side of expiry, and of expiry+grace.
        [SNAPSHOT_TTL_MS - 60_000, 'fresh'],
        [SNAPSHOT_TTL_MS + 60_000, 'offline_grace'],
        [SNAPSHOT_TTL_MS + 8 * HOUR_MS, 'offline_grace'],
        [SNAPSHOT_TTL_MS + ENTITLEMENT_GRACE_MS - 60_000, 'offline_grace'],
        [SNAPSHOT_TTL_MS + ENTITLEMENT_GRACE_MS + 60_000, 'expired'],
      ]

      for (const [age, expected] of ladder) {
        const cache = defaultTtlCache(age)
        assert.equal(
          entitlementCacheStatus(cache),
          expected,
          `a default-TTL snapshot ${age / HOUR_MS}h after issue is ${expected}`,
        )

        const decision = await check(signedIn(cache.snapshot, cache), LOCAL_KEY)
        assert.equal(decision.status, expected)
        assert.equal(
          decision.allowed,
          expected !== 'expired',
          `a local premium key is ${expected === 'expired' ? 'refused' : 'granted'} at ${expected}`,
        )
      }

      // The window is the full grace span past expiry, not the fetch latency.
      const graced = defaultTtlCache(SNAPSHOT_TTL_MS + HOUR_MS)
      assert.equal(
        entitlementGraceExpiresAt(graced),
        new Date(Date.parse(graced.snapshot.expiresAt) + ENTITLEMENT_GRACE_MS).toISOString(),
        'grace runs from snapshot expiry alone',
      )
    }

    // The staleness ceiling is an independent hard stop: a cache we have not
    // refreshed in a fortnight expires even while its snapshot claims to be live.
    // (A long-lived admin grant is the shape that gets here — a default TTL
    // cannot outlive the ceiling.)
    {
      const lastRefreshAt = new Date(Date.now() - ENTITLEMENT_MAX_CACHE_AGE_MS - HOUR_MS)
      const longLived = snapshot({
        expiresAt: new Date(Date.now() + 30 * 24 * HOUR_MS).toISOString(),
        features: { [LOCAL_KEY]: true },
      })
      const cache: CachedEntitlementSnapshot = { snapshot: longLived, lastRefreshAt: lastRefreshAt.toISOString() }

      assert.equal(isEntitlementSnapshotFresh(longLived), true, 'the snapshot itself has not expired')
      assert.equal(isEntitlementCacheTooStale(cache), true)
      assert.equal(entitlementCacheStatus(cache), 'expired', 'the ceiling wins over snapshot expiry')

      const decision = await check(signedIn(longLived, cache), LOCAL_KEY)
      assert.equal(decision.allowed, false)
      assert.equal(decision.status, 'expired')

      // An hour the other side of the ceiling, the same cache is still usable.
      const withinCeiling: CachedEntitlementSnapshot = {
        snapshot: longLived,
        lastRefreshAt: new Date(Date.now() - ENTITLEMENT_MAX_CACHE_AGE_MS + HOUR_MS).toISOString(),
      }
      assert.equal(isEntitlementCacheTooStale(withinCeiling), false)
      assert.equal(entitlementCacheStatus(withinCeiling), 'fresh')

      // An undatable cache is not evidence of a recent check.
      assert.equal(isEntitlementCacheTooStale({ snapshot: longLived, lastRefreshAt: 'not-a-date' }), true)
    }

    // Grace permissions are decided on `hostedCost` alone — no feature key is
    // named anywhere in the decision. Anything with a server-side cost is refused
    // while unverified; a purely local premium feature keeps working.
    {
      const cache = defaultTtlCache(SNAPSHOT_TTL_MS + HOUR_MS, {
        [LOCAL_KEY]: true,
        'multicode.other_local': true,
      })
      const reading = signedIn(cache.snapshot, cache)

      for (const key of [LOCAL_KEY, 'multicode.other_local']) {
        const decision = await check(reading, key)
        assert.equal(decision.allowed, true, `${key} is local, so it survives offline with no allowlist`)
        assert.equal(decision.status, 'offline_grace')
        assert.equal(decision.graceExpiresAt, entitlementGraceExpiresAt(cache), 'the decision carries the deadline')
      }

      // Stale entitlements must never authorize spending someone else's budget.
      const hosted = await check(reading, LOCAL_KEY, { hostedCost: true })
      assert.equal(hosted.allowed, false)
      assert.equal(hosted.status, 'offline_grace')
      assert.equal(hosted.graceExpiresAt, entitlementGraceExpiresAt(cache))

      // …but the same hosted request is fine while the snapshot is fresh.
      const fresh = defaultTtlCache(HOUR_MS)
      const online = await check(signedIn(fresh.snapshot, fresh), LOCAL_KEY, { hostedCost: true })
      assert.equal(online.allowed, true)
      assert.equal(online.status, 'fresh')

      // The grace-state message names the deadline, so the user is warned rather
      // than cut off. The adapter publishes this same string as the auth state's
      // message, which is what the account surface renders.
      const graceMessage = (await check(reading, LOCAL_KEY)).message
      const deadline = entitlementGraceExpiresAt(cache)
      assert.ok(deadline)
      assert.equal(graceMessage, offlineGraceMessage(deadline))
      assert.ok(graceMessage.includes(new Date(deadline).toLocaleString()), 'the deadline is in the message')

      // An unreadable deadline drops the clause instead of inventing one.
      assert.equal(offlineGraceMessage(null), 'Using cached Multicode access while offline.')
      assert.equal(offlineGraceMessage('not-a-date'), 'Using cached Multicode access while offline.')
    }

    // Past the grace window nothing is granted.
    {
      const stale = snapshot({
        expiresAt: new Date(Date.now() - 10 * 24 * HOUR_MS).toISOString(),
        features: { [LOCAL_KEY]: true },
      })
      const reading = signedIn(stale, {
        snapshot: stale,
        lastRefreshAt: new Date(Date.now() - 10 * 24 * HOUR_MS).toISOString(),
      })
      const decision = await check(reading, LOCAL_KEY)
      assert.equal(decision.allowed, false)
      assert.equal(decision.status, 'expired')
    }

    // With no persisted cache, the live snapshot is dated by lastRefreshAt — an
    // absent one dates it to the epoch, which is past the staleness ceiling. An
    // adapter that cannot say when it last reached the provider is refused, and
    // deliberately so: this holds for a snapshot that is still unexpired too, so
    // the port's contract (report lastRefreshAt with every snapshot) is enforced
    // rather than assumed. Both cases are pinned, because the second is the one a
    // future provider adapter is most likely to trip.
    {
      for (const expiresAt of [Date.now() - HOUR_MS, Date.now() + HOUR_MS]) {
        const undatable = snapshot({ expiresAt: new Date(expiresAt).toISOString(), features: { [LOCAL_KEY]: true } })
        const decision = await check(
          { authenticated: true, snapshot: undatable, cache: null, lastRefreshAt: null },
          LOCAL_KEY,
        )
        assert.equal(decision.status, 'expired')
        assert.equal(decision.allowed, false)
      }
    }

    // hasFeature is the boolean face of the same decision.
    {
      const { service } = serviceFor(signedIn(snapshot({ features: { 'multicode.x': true } })))
      assert.equal(await service.hasFeature('multicode.x'), true)
      assert.equal(await service.hasFeature('multicode.y'), false)
    }

    // refreshFeature goes back to the provider first, then decides on what came
    // back — the pre-flight check before an expensive action.
    {
      const denyingSnapshot = snapshot({ features: { 'multicode.x': false } })
      const provider = new FakeProvider(signedIn(denyingSnapshot))
      const service = new EntitlementService(provider, { product: 'multicode' })
      provider.onRefresh = () => provider.set(signedIn(snapshot({ features: { 'multicode.x': true } })))

      assert.equal((await service.checkAccess({ featureKey: 'multicode.x' })).allowed, false)
      const decision = await service.refreshFeature('multicode.x')
      assert.equal(provider.refreshCount, 1)
      assert.equal(decision.allowed, true, 'the decision is made on the refreshed snapshot')
    }

    // requireFeature throws the refusal message, and returns the value on success.
    {
      const { service } = serviceFor(signedIn(snapshot({ limits: { 'multicode.seats': 2 } })))
      assert.equal(await service.requireFeature('multicode.seats'), 2)
      assert.equal(await service.requireFeature({ featureKey: 'multicode.seats', amount: 2 }), 2)
      await assert.rejects(() => service.requireFeature('multicode.missing'), /Upgrade this organization/)
    }

    // getSnapshot force-refreshes on demand, and refuses to invent an empty
    // snapshot when there is none — "could not check" is not "you have nothing".
    {
      const provider = new FakeProvider(signedIn(snapshot()))
      const service = new EntitlementService(provider, { product: 'multicode' })
      await service.getSnapshot()
      assert.equal(provider.refreshCount, 0, 'a plain read must not hit the provider')
      await service.getSnapshot({ forceRefresh: true })
      assert.equal(provider.refreshCount, 1)

      provider.set({ authenticated: true, snapshot: null, cache: null, lastRefreshAt: null })
      await assert.rejects(() => service.getSnapshot(), /No Multicode entitlement snapshot/)
    }

    // Grace policy is shared with the adapter, so the auth state it publishes and
    // the decisions above can never disagree: the window closes a grace span past
    // the snapshot's own expiry, and the cache's age is a separate stop.
    {
      const expiresAt = new Date(Date.now() - HOUR_MS)
      const lastRefreshAt = new Date(Date.now() - 5 * HOUR_MS)
      const cache: CachedEntitlementSnapshot = {
        snapshot: snapshot({ expiresAt: expiresAt.toISOString() }),
        lastRefreshAt: lastRefreshAt.toISOString(),
      }
      assert.equal(
        entitlementGraceExpiresAt(cache),
        new Date(expiresAt.getTime() + ENTITLEMENT_GRACE_MS).toISOString(),
        'snapshot expiry is the only anchor; an earlier lastRefreshAt does not shorten it',
      )
      assert.equal(entitlementCacheStatus(cache), 'offline_grace')
      assert.equal(entitlementCacheStatus({ snapshot: snapshot(), lastRefreshAt: new Date().toISOString() }), 'fresh')
      assert.equal(isEntitlementSnapshotFresh(snapshot()), true)

      // Unparseable timestamps yield no grace window rather than an infinite one.
      const broken: CachedEntitlementSnapshot = {
        snapshot: snapshot({ expiresAt: 'not-a-date' }),
        lastRefreshAt: 'also-not',
      }
      assert.equal(entitlementGraceExpiresAt(broken), null)
      assert.equal(entitlementCacheStatus(broken), 'expired')
    }

    // Cache-file validation: anything that fails the shape check is discarded, so
    // a corrupt or hostile file on disk cannot grant access.
    {
      assert.equal(isEntitlementSnapshot(snapshot(), 'multicode'), true)
      for (const bad of [
        null,
        'multicode',
        {},
        { ...snapshot(), product: 'other' },
        { ...snapshot(), schemaVersion: 2 },
        // `typeof null === 'object'` and so is an array: both used to pass the
        // shape check and then throw on the `in` test at gate time.
        { ...snapshot(), features: null },
        { ...snapshot(), limits: [] },
        { ...snapshot(), expiresAt: 42 },
      ]) {
        assert.equal(isEntitlementSnapshot(bad, 'multicode'), false, `${JSON.stringify(bad)} must be rejected`)
      }
    }

    console.log('entitlement service tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
