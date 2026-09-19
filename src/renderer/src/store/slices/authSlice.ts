// SprintEngineAuthState is declared globally via src/renderer/src/env.d.ts
// (re-exported from @sprintengine/shared), so no import is required here.

export const defaultAuthState = (): SprintEngineAuthState => ({
  authenticated: false,
  user: null,
  selectedOrganization: null,
  entitlements: null,
  status: 'checking',
  entitlementStatus: 'missing',
  message: null,
  lastRefreshAt: null,
  graceExpiresAt: null,
})

interface AuthSliceState {
  authState: SprintEngineAuthState
}

interface AuthSliceActions {
  setAuthState: (authState: SprintEngineAuthState) => void
}

export type AuthSlice = AuthSliceState & AuthSliceActions

type AuthSliceSet = (mutator: (state: AuthSliceState) => void) => void

export function createAuthSlice(set: AuthSliceSet): AuthSlice {
  return {
    authState: defaultAuthState(),
    setAuthState: (authState) =>
      set((state) => {
        state.authState = authState
      }),
  }
}
