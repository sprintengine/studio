import type {
  EntitlementSnapshot,
  FeatureValue,
  PremiumAccessDecision,
  PremiumAccessRequest,
} from '../shared/electron-api'

// The desktop's one entitlement seam (MC-2169). Everything above it — the auth
// IPC handlers, capability modules, any future feature gate — asks THIS whether
// a stable feature key is unlocked. Everything below it is an adapter that only
// has to answer "what snapshot do you hold" and "go get a fresh one";
// `src/main/auth-service.ts` is the Multiauth one, and it is the only place in
// main that names an auth provider.
//
// Consequence for the Clerk migration: swapping providers means writing a second
// adapter behind `EntitlementProvider`. No caller changes, because no caller
// knows who answered.

// Feature values live under `features` (booleans/strings) or `limits`
// (numbers); a key absent from both is simply not entitled.
export type CachedEntitlementSnapshot = {
  snapshot: EntitlementSnapshot
  lastRefreshAt: string
}

// What the seam needs to see. `snapshot` is the live one the adapter is holding;
// `cache` is the last one it persisted, which is what the offline grace window is
// measured from. When the adapter has no persisted cache, `lastRefreshAt` dates
// the live snapshot instead.
//
// An adapter MUST report `lastRefreshAt` whenever it reports a snapshot. It is
// the only evidence of when we last reached the provider, and the staleness
// ceiling below is enforced on it: a snapshot the adapter cannot date is treated
// as expired, however live the snapshot itself claims to be. Refusing is the
// deliberate direction — an undatable entitlement is not a verified one.
export type EntitlementReading = {
  authenticated: boolean
  snapshot: EntitlementSnapshot | null
  cache: CachedEntitlementSnapshot | null
  lastRefreshAt: string | null
}

// The port an auth provider implements. Deliberately two methods: anything more
// would leak how a provider works into the seam.
export interface EntitlementProvider {
  read(): EntitlementReading
  refresh(): Promise<void>
}

export type EntitlementCacheStatus = 'fresh' | 'offline_grace' | 'expired'

// Offline policy of record: a snapshot stays usable for this long past its own
// expiry. Measured from `snapshot.expiresAt` and nothing else (MC-2187) — the
// window used to be `min(expiresAt + graceMs, lastRefreshAt + graceMs)`, and
// since the server issues `expiresAt = issuedAt + 72h` while the desktop stamps
// `lastRefreshAt` at fetch time, that `min` always landed back on `expiresAt`:
// grace was the latency of the original fetch, and `offline_grace` was
// unreachable for any default-TTL snapshot.
export const ENTITLEMENT_GRACE_MS = 72 * 60 * 60 * 1000

// The staleness ceiling that `min` was reaching for, kept as an INDEPENDENT hard
// stop: a cache this old expires whatever the snapshot arithmetic says. Folding
// it back into a `min` with the grace window above is exactly how MC-2187
// happened, so the two are combined by the status ladder, never by arithmetic.
export const ENTITLEMENT_MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000

export type EntitlementServiceOptions = {
  product: EntitlementSnapshot['product']
  graceMs?: number
  maxCacheAgeMs?: number
}

export class EntitlementService {
  private readonly product: EntitlementSnapshot['product']
  private readonly graceMs: number
  private readonly maxCacheAgeMs: number

  constructor(
    private readonly provider: EntitlementProvider,
    options: EntitlementServiceOptions
  ) {
    this.product = options.product
    this.graceMs = options.graceMs ?? ENTITLEMENT_GRACE_MS
    this.maxCacheAgeMs = options.maxCacheAgeMs ?? ENTITLEMENT_MAX_CACHE_AGE_MS
  }

  // The plain gate: is this key unlocked right now, on whatever snapshot we
  // hold. Never throws — a caller asking "may I" gets an answer, not an error.
  async hasFeature(featureKey: string): Promise<boolean> {
    const decision = await this.checkAccess({ featureKey })
    return decision.allowed
  }

  // Gate on a freshly fetched snapshot. For the moment before an expensive or
  // irreversible action, where a stale allow is worse than a slow one.
  async refreshFeature(featureKey: string): Promise<PremiumAccessDecision> {
    await this.provider.refresh()
    return this.checkAccess({ featureKey })
  }

  // The full decision, including why a refusal happened and when offline access
  // runs out — what a surface needs to explain itself to the user.
  async checkAccess(request: PremiumAccessRequest): Promise<PremiumAccessDecision> {
    const reading = this.provider.read()

    if (!reading.authenticated) {
      return denied(request.featureKey, undefined, 'signed_out', 'Sign in to unlock this Multicode feature.')
    }

    const snapshot = reading.snapshot
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.product !== this.product) {
      return denied(request.featureKey, undefined, 'missing', 'Multicode access could not be verified.')
    }

    const cache = reading.cache ?? {
      snapshot,
      lastRefreshAt: reading.lastRefreshAt ?? new Date(0).toISOString(),
    }
    const cacheStatus = entitlementCacheStatus(cache, this.graceMs, this.maxCacheAgeMs)
    const graceExpiresAt = entitlementGraceExpiresAt(cache, this.graceMs)
    const value = entitlementValue(snapshot, request.featureKey)
    const limit = typeof value === 'number' ? value : undefined

    if (cacheStatus === 'expired') {
      return denied(
        request.featureKey,
        value,
        'expired',
        'Multicode premium access needs a fresh entitlement check.',
        limit
      )
    }

    // Grace permissions are decided on the `hostedCost` axis alone: a stale
    // snapshot must never authorize spending someone else's budget, but a
    // purely local premium feature keeps working offline. No feature-key
    // allowlist — the old one named a key that stopped gating anything.
    if (cacheStatus === 'offline_grace' && request.hostedCost) {
      return denied(
        request.featureKey,
        value,
        'offline_grace',
        'This premium action needs online entitlement verification.',
        limit,
        graceExpiresAt
      )
    }

    if (typeof value === 'boolean' && value) {
      return allowed(request.featureKey, value, cacheStatus, graceExpiresAt)
    }

    if (typeof value === 'number' && value > 0 && (request.amount === undefined || request.amount <= value)) {
      return allowed(request.featureKey, value, cacheStatus, graceExpiresAt, value)
    }

    if (typeof value === 'string' && value.trim()) {
      return allowed(request.featureKey, value, cacheStatus, graceExpiresAt)
    }

    return denied(
      request.featureKey,
      value,
      'missing',
      'Upgrade this organization or switch to one with Multicode premium access.',
      limit
    )
  }

  // Gate that refuses by throwing, for call sites where continuing without the
  // entitlement is not a state the code can represent.
  async requireFeature(input: PremiumAccessRequest | string): Promise<FeatureValue> {
    const decision = await this.checkAccess(typeof input === 'string' ? { featureKey: input } : input)

    if (!decision.allowed) {
      throw new Error(decision.message)
    }

    return decision.value ?? true
  }

  // The raw snapshot, for surfaces that render entitlement state rather than
  // gate on it. Absence is an error, not an empty snapshot: a caller must not
  // mistake "we could not check" for "you have nothing".
  async getSnapshot(options: { forceRefresh?: boolean } = {}): Promise<EntitlementSnapshot> {
    if (options.forceRefresh) {
      await this.provider.refresh()
    }

    const { snapshot } = this.provider.read()
    if (!snapshot) {
      throw new Error('No Multicode entitlement snapshot is available.')
    }

    return snapshot
  }
}

// Snapshot policy, shared with the adapter so the auth state it publishes and
// the decisions this service makes can never disagree about freshness.

export function isEntitlementSnapshotFresh(snapshot: EntitlementSnapshot): boolean {
  const expiresAt = Date.parse(snapshot.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

// When offline access runs out: the snapshot's own expiry plus the grace span.
// The cache's age does not enter this — it is a separate stop, below.
export function entitlementGraceExpiresAt(
  cache: CachedEntitlementSnapshot,
  graceMs: number = ENTITLEMENT_GRACE_MS
): string | null {
  const snapshotExpiresAt = Date.parse(cache.snapshot.expiresAt)
  if (!Number.isFinite(snapshotExpiresAt)) return null

  return new Date(snapshotExpiresAt + graceMs).toISOString()
}

// The independent hard stop. A cache we have not managed to refresh in this
// long is not trustworthy however long-lived the snapshot inside it claims to
// be. An unreadable `lastRefreshAt` counts as stale: an undatable cache is not
// evidence of a recent check.
export function isEntitlementCacheTooStale(
  cache: CachedEntitlementSnapshot,
  maxCacheAgeMs: number = ENTITLEMENT_MAX_CACHE_AGE_MS
): boolean {
  const lastRefreshAt = Date.parse(cache.lastRefreshAt)
  if (!Number.isFinite(lastRefreshAt)) return true

  return lastRefreshAt + maxCacheAgeMs <= Date.now()
}

export function entitlementCacheStatus(
  cache: CachedEntitlementSnapshot,
  graceMs: number = ENTITLEMENT_GRACE_MS,
  maxCacheAgeMs: number = ENTITLEMENT_MAX_CACHE_AGE_MS
): EntitlementCacheStatus {
  // The ceiling is checked first so it holds regardless of snapshot expiry —
  // a long-lived grant cannot coast forever on one successful fetch.
  if (isEntitlementCacheTooStale(cache, maxCacheAgeMs)) return 'expired'

  if (isEntitlementSnapshotFresh(cache.snapshot)) return 'fresh'

  const graceExpiresAt = entitlementGraceExpiresAt(cache, graceMs)
  if (graceExpiresAt && Date.parse(graceExpiresAt) > Date.now()) {
    return 'offline_grace'
  }

  return 'expired'
}

// The one grace-state message, shared by the decisions this service returns and
// the auth state the adapter publishes. It carries the deadline so a user
// running offline sees when access runs out rather than being cut off without
// warning; an unreadable deadline is omitted rather than invented.
export function offlineGraceMessage(graceExpiresAt: string | null | undefined): string {
  const expiresAt = graceExpiresAt ? new Date(graceExpiresAt) : null
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    return 'Using cached Multicode access while offline.'
  }

  return `Using cached Multicode access while offline. Access expires ${expiresAt.toLocaleString()}.`
}

// Shape check for a snapshot read back off disk. A cache file that fails this is
// discarded rather than trusted — a malformed snapshot must not grant anything.
export function isEntitlementSnapshot(
  input: unknown,
  product: EntitlementSnapshot['product']
): input is EntitlementSnapshot {
  if (!input || typeof input !== 'object') return false
  const snapshot = input as Partial<EntitlementSnapshot>
  return snapshot.product === product
    && snapshot.schemaVersion === 1
    && typeof snapshot.userId === 'string'
    && typeof snapshot.organizationId === 'string'
    // `typeof null === 'object'`, so these need the null guard: a snapshot with
    // a null map passed the old check and then threw on the `in` test inside
    // entitlementValue — a crash on the gate path instead of a discard.
    && isRecord(snapshot.features)
    && isRecord(snapshot.limits)
    && typeof snapshot.issuedAt === 'string'
    && typeof snapshot.expiresAt === 'string'
}

function isRecord(input: unknown): boolean {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

// Not exported: reading a value out of a snapshot is the seam's own job. An
// adapter that needed this would be making a decision, which is the thing this
// file exists to stop.
function entitlementValue(
  snapshot: EntitlementSnapshot,
  featureKey: string
): FeatureValue | undefined {
  if (featureKey in snapshot.features) return snapshot.features[featureKey]
  if (featureKey in snapshot.limits) return snapshot.limits[featureKey]
  return undefined
}

function allowed(
  featureKey: string,
  value: FeatureValue,
  status: 'fresh' | 'offline_grace',
  graceExpiresAt: string | null,
  limit?: number
): PremiumAccessDecision {
  return {
    allowed: true,
    featureKey,
    value,
    status,
    message: status === 'offline_grace'
      ? offlineGraceMessage(graceExpiresAt)
      : 'Access granted.',
    ...(limit !== undefined ? { limit } : {}),
    ...(graceExpiresAt ? { graceExpiresAt } : {}),
  }
}

function denied(
  featureKey: string,
  value: FeatureValue | undefined,
  status: PremiumAccessDecision['status'],
  message: string,
  limit?: number,
  graceExpiresAt?: string | null
): PremiumAccessDecision {
  return {
    allowed: false,
    featureKey,
    value,
    status,
    message,
    ...(limit !== undefined ? { limit } : {}),
    ...(graceExpiresAt ? { graceExpiresAt } : {}),
  }
}
