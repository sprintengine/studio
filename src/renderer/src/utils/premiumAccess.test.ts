import assert from 'node:assert/strict'

import {
  getSprintEngineAccessState,
  requireFreshSprintEngineAccess,
  SPRINT_ENGINE_FEATURE_KEY,
} from './premiumAccess'
import type { MulticodeAuthState, PremiumAccessDecision } from '../../../shared/electron-api'

function authState(overrides: Partial<MulticodeAuthState> = {}): MulticodeAuthState {
  return {
    authenticated: false,
    user: null,
    selectedOrganization: null,
    entitlements: null,
    status: 'signed_out',
    entitlementStatus: 'missing',
    message: null,
    lastRefreshAt: null,
    graceExpiresAt: null,
    ...overrides,
  }
}

function entitlementState(features: Record<string, boolean | number | string>): MulticodeAuthState {
  return authState({
    authenticated: true,
    user: { id: 'user-1', email: 'user@example.com', displayName: 'User One' },
    selectedOrganization: { id: 'org-1', name: 'Example Org', slug: 'example-org', type: 'team' },
    entitlements: {
      userId: 'user-1',
      organizationId: 'org-1',
      product: 'multicode',
      roles: ['owner'],
      plan: { code: 'pro', status: 'active' },
      features,
      limits: {},
      sources: {},
      issuedAt: '2026-06-08T00:00:00.000Z',
      expiresAt: '2026-06-09T00:00:00.000Z',
      schemaVersion: 1,
    },
    status: 'signed_in',
    entitlementStatus: 'fresh',
  })
}

assert.equal(getSprintEngineAccessState(authState()).allowed, false)
assert.equal(getSprintEngineAccessState(entitlementState({ [SPRINT_ENGINE_FEATURE_KEY]: true })).allowed, true)
assert.equal(getSprintEngineAccessState(entitlementState({ sprintEngine: true })).allowed, false)

const refreshedState = entitlementState({ [SPRINT_ENGINE_FEATURE_KEY]: true })
const decision: PremiumAccessDecision = {
  allowed: true,
  featureKey: SPRINT_ENGINE_FEATURE_KEY,
  value: true,
  status: 'fresh',
  message: 'Allowed.',
}
let appliedState: MulticodeAuthState | null = null
const returned = await requireFreshSprintEngineAccess(
  {
    authRefreshEntitlements: async () => refreshedState,
    authCheckPremiumAccess: async () => decision,
  },
  (state) => {
    appliedState = state
  },
)

assert.equal(returned, decision)
assert.equal(appliedState, refreshedState)

await assert.rejects(
  () => requireFreshSprintEngineAccess(
    {
      authRefreshEntitlements: async () => authState(),
      authCheckPremiumAccess: async () => ({
        allowed: false,
        featureKey: SPRINT_ENGINE_FEATURE_KEY,
        value: undefined,
        status: 'signed_out',
        message: 'Sign in to unlock this Multicode feature.',
      }),
    },
    () => {},
  ),
  /Sign in to unlock this Multicode feature/,
)

console.log('premiumAccess.test.ts: ok')
