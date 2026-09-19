import assert from 'node:assert/strict'

import { useWorkspaceStore } from '../workspaceStore'
import { defaultAuthState } from './authSlice'
import { test } from 'vitest'

test('authSlice', async () => {
  function createAuthenticatedState(): MulticodeAuthState {
    return {
      authenticated: true,
      user: {
        id: 'user-1',
        email: 'user@example.com',
        displayName: 'User One',
        photoUrl: null,
      },
      selectedOrganization: {
        id: 'org-1',
        name: 'Example Org',
        slug: 'example-org',
        type: 'team',
      },
      entitlements: {
        userId: 'user-1',
        organizationId: 'org-1',
        product: 'multicode',
        roles: ['owner'],
        plan: {
          code: 'pro',
          status: 'active',
        },
        features: {
          sprintEngine: true,
        },
        limits: {},
        sources: {},
        issuedAt: '2026-05-19T09:00:00.000Z',
        expiresAt: '2026-06-19T09:00:00.000Z',
        schemaVersion: 1,
      },
      status: 'signed_in',
      entitlementStatus: 'fresh',
      message: 'Signed in',
      lastRefreshAt: '2026-05-19T10:00:00.000Z',
      graceExpiresAt: null,
    }
  }

  const expectedDefaultAuthState = {
    authenticated: false,
    user: null,
    selectedOrganization: null,
    entitlements: null,
    status: 'checking',
    entitlementStatus: 'missing',
    message: null,
    lastRefreshAt: null,
    graceExpiresAt: null,
  }

  assert.deepEqual(defaultAuthState(), expectedDefaultAuthState)
  assert.deepEqual(useWorkspaceStore.getState().authState, expectedDefaultAuthState)

  const authenticatedState = createAuthenticatedState()
  useWorkspaceStore.getState().setAuthState(authenticatedState)
  assert.deepEqual(useWorkspaceStore.getState().authState, authenticatedState)

  console.log('authSlice.test.ts: ok')
})
