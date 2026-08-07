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

// Offline policy of record: a snapshot stays usable for this long past both its
// own expiry and the last successful refresh, whichever runs out first.
//
// Both defaults below are carried over verbatim from the Multiauth adapter so
// this extraction changes no decision. Both are also KNOWN WRONG, and are fixed
// under `backlog/2026-08-07-offline-entitlement-grace-fix.md`, not here: the
// `min` collapses the window to zero for a default-TTL snapshot, and the
// allowlist names a key that stopped gating anything in `e60c241d6`. They are a
// constant and a constructor option rather than inline arithmetic and a
// hardcoded predicate precisely so that fix is local to this file.
export const ENTITLEMENT_GRACE_MS = 72 * 60 * 60 * 1000

// Feature keys that survive the offline grace window. A key is here only when
// the feature it unlocks is entirely local — nothing that spends hosted budget
// may run on a stale snapshot, and `hostedCost` requests are refused regardless.
export const DESKTOP_GRACE_FEATURE_KEYS: readonly string[] = ['multicode.sprintengine']

export type EntitlementServiceOptions = {
  product: EntitlementSnapshot['product']
  graceMs?: number
  graceFeatureKeys?: readonly string[]
}

export class EntitlementService {
  private readonly product: EntitlementSnapshot['product']
  private readonly graceMs: number
  private readonly graceFeatureKeys: readonly string[]

  constructor(
    private readonly provider: EntitlementProvider,
    options: EntitlementServiceOptions
  ) {
    this.product = options.product
    this.graceMs = options.graceMs ?? ENTITLEMENT_GRACE_MS
    this.graceFeatureKeys = options.graceFeatureKeys ?? DESKTOP_GRACE_FEATURE_KEYS
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
    const cacheStatus = entitlementCacheStatus(cache, this.graceMs)
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

    if (cacheStatus === 'offline_grace') {
      if (request.hostedCost || !this.graceFeatureKeys.includes(request.featureKey)) {
        return denied(
          request.featureKey,
          value,
          'offline_grace',
          'This premium action needs online entitlement verification.',
          limit,
          graceExpiresAt
        )
      }
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

export function entitlementGraceExpiresAt(
  cache: CachedEntitlementSnapshot,
  graceMs: number = ENTITLEMENT_GRACE_MS
): string | null {
  const snapshotExpiresAt = Date.parse(cache.snapshot.expiresAt)
  const lastRefreshAt = Date.parse(cache.lastRefreshAt)
  if (!Number.isFinite(snapshotExpiresAt) || !Number.isFinite(lastRefreshAt)) return null

  return new Date(Math.min(snapshotExpiresAt + graceMs, lastRefreshAt + graceMs)).toISOString()
}

export function entitlementCacheStatus(
  cache: CachedEntitlementSnapshot,
  graceMs: number = ENTITLEMENT_GRACE_MS
): EntitlementCacheStatus {
  if (isEntitlementSnapshotFresh(cache.snapshot)) return 'fresh'

  const graceExpiresAt = entitlementGraceExpiresAt(cache, graceMs)
  if (graceExpiresAt && Date.parse(graceExpiresAt) > Date.now()) {
    return 'offline_grace'
  }

  return 'expired'
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
      ? 'Using cached Multicode access while offline.'
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
