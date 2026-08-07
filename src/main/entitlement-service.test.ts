/**
 * MC-2169 — the provider-agnostic entitlement seam. These assertions ARE the
 * gating contract the Multiauth adapter used to own inline: they must still
 * hold, unchanged, after a provider swap, because nothing here knows who the
 * provider is. The fake below implements the whole port — two methods.
 */
import assert from 'node:assert/strict'
import type { EntitlementSnapshot, PremiumAccessDecision } from '../shared/electron-api'
import {
  DESKTOP_GRACE_FEATURE_KEYS,
  ENTITLEMENT_GRACE_MS,
  EntitlementService,
  entitlementCacheStatus,
  entitlementGraceExpiresAt,
  isEntitlementSnapshot,
  isEntitlementSnapshotFresh,
  type CachedEntitlementSnapshot,
  type EntitlementProvider,
  type EntitlementReading,
} from './entitlement-service'

const HOUR_MS = 60 * 60 * 1000
const GRACE_KEY = DESKTOP_GRACE_FEATURE_KEYS[0]

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

function signedIn(
  snap: EntitlementSnapshot,
  cache?: CachedEntitlementSnapshot | null
): EntitlementReading {
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
      'multicode.anything'
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
    const decision = await check(bad, GRACE_KEY)
    assert.equal(decision.allowed, false, 'an unusable snapshot must not grant anything')
    assert.equal(decision.status, 'missing')
  }

  // A fresh boolean feature: allowed, and the value travels with the decision.
  {
    const decision = await check(signedIn(snapshot({ features: { 'multicode.mobile_companion': true } })), 'multicode.mobile_companion')
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

  // Offline grace. The snapshot has expired but the grace window is open.
  {
    const expired = snapshot({
      expiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
      features: { [GRACE_KEY]: true, 'multicode.other': true },
    })
    const cache: CachedEntitlementSnapshot = {
      snapshot: expired,
      lastRefreshAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    }
    const reading = signedIn(expired, cache)

    const allowlisted = await check(reading, GRACE_KEY)
    assert.equal(allowlisted.allowed, true, `${GRACE_KEY} is local-only, so it survives offline`)
    assert.equal(allowlisted.status, 'offline_grace')
    assert.equal(allowlisted.graceExpiresAt, entitlementGraceExpiresAt(cache))

    // Everything not on the allowlist needs a live check, even though the very
    // same snapshot grants it.
    const other = await check(reading, 'multicode.other')
    assert.equal(other.allowed, false)
    assert.equal(other.status, 'offline_grace')

    // A hosted-cost request is refused even for an allowlisted key: stale
    // entitlements must never authorize spending someone else's budget.
    const hosted = await check(reading, GRACE_KEY, { hostedCost: true })
    assert.equal(hosted.allowed, false)
    assert.equal(hosted.status, 'offline_grace')
  }

  // Past the grace window nothing is granted, allowlisted or not.
  {
    const stale = snapshot({ expiresAt: new Date(Date.now() - 10 * 24 * HOUR_MS).toISOString(), features: { [GRACE_KEY]: true } })
    const reading = signedIn(stale, {
      snapshot: stale,
      lastRefreshAt: new Date(Date.now() - 10 * 24 * HOUR_MS).toISOString(),
    })
    const decision = await check(reading, GRACE_KEY)
    assert.equal(decision.allowed, false)
    assert.equal(decision.status, 'expired')
  }

  // With no persisted cache, the live snapshot is dated by lastRefreshAt — an
  // absent lastRefreshAt dates it to the epoch, which is outside any grace
  // window, so an expired snapshot cannot coast on a missing timestamp.
  {
    const expired = snapshot({ expiresAt: new Date(Date.now() - HOUR_MS).toISOString(), features: { [GRACE_KEY]: true } })
    const decision = await check(
      { authenticated: true, snapshot: expired, cache: null, lastRefreshAt: null },
      GRACE_KEY
    )
    assert.equal(decision.status, 'expired')
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
    await assert.rejects(
      () => service.requireFeature('multicode.missing'),
      /Upgrade this organization/
    )
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
  // the decisions above can never disagree: the window closes at whichever of
  // (snapshot expiry, last refresh) runs out first, plus the grace span.
  {
    const expiresAt = new Date(Date.now() - HOUR_MS)
    const lastRefreshAt = new Date(Date.now() - 5 * HOUR_MS)
    const cache: CachedEntitlementSnapshot = {
      snapshot: snapshot({ expiresAt: expiresAt.toISOString() }),
      lastRefreshAt: lastRefreshAt.toISOString(),
    }
    assert.equal(
      entitlementGraceExpiresAt(cache),
      new Date(lastRefreshAt.getTime() + ENTITLEMENT_GRACE_MS).toISOString(),
      'the earlier of the two anchors wins'
    )
    assert.equal(entitlementCacheStatus(cache), 'offline_grace')
    assert.equal(entitlementCacheStatus({ snapshot: snapshot(), lastRefreshAt: new Date().toISOString() }), 'fresh')
    assert.equal(isEntitlementSnapshotFresh(snapshot()), true)

    // Unparseable timestamps yield no grace window rather than an infinite one.
    const broken: CachedEntitlementSnapshot = { snapshot: snapshot({ expiresAt: 'not-a-date' }), lastRefreshAt: 'also-not' }
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

void main()
