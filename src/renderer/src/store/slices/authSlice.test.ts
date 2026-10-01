import assert from 'node:assert/strict'

import { useWorkspaceStore } from '../workspaceStore'
import { defaultAuthState } from './authSlice'
import { test } from 'vitest'

test('authSlice', async () => {
  function createAuthenticatedState(): SprintEngineAuthState {
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
      status: 'signed_in',
      message: 'Signed in',
    }
  }

  const expectedDefaultAuthState = {
    authenticated: false,
    user: null,
    selectedOrganization: null,
    status: 'checking',
    message: null,
  }

  assert.deepEqual(defaultAuthState(), expectedDefaultAuthState)
  assert.deepEqual(useWorkspaceStore.getState().authState, expectedDefaultAuthState)

  const authenticatedState = createAuthenticatedState()
  useWorkspaceStore.getState().setAuthState(authenticatedState)
  assert.deepEqual(useWorkspaceStore.getState().authState, authenticatedState)

  console.log('authSlice.test.ts: ok')
})
