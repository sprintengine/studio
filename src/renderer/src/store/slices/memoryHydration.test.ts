import { hydrationStorage, hydrationWorkspaceId } from './memoryHydration.test-helper'
import { useWorkspaceStore } from '../workspaceStore'
import { defaultAuthState } from './authSlice'
import assert from 'node:assert/strict'

function readPersistedWorkspaces(): unknown[] {
  const raw = hydrationStorage.get('multicode-workspaces')
  assert.ok(raw, 'persisted entry should still exist in localStorage')
  const envelope = JSON.parse(raw) as { state?: { workspaces?: unknown[] } }
  const workspaces = envelope.state?.workspaces
  assert.ok(Array.isArray(workspaces), 'persisted workspaces should be an array')
  return workspaces
}

const initialState = useWorkspaceStore.getState()
assert.ok(initialState.workspaces.length > 0, 'seeded workspaces should hydrate into the store')
assert.equal(
  initialState.workspaces[0].id,
  hydrationWorkspaceId,
  'hydrated workspace id should match the seeded fixture',
)

initialState.setLastSelectedCli('codex')
assert.ok(
  useWorkspaceStore.getState().workspaces.length > 0,
  'workspaces survive setLastSelectedCli',
)
assert.equal(
  readPersistedWorkspaces().length,
  initialState.workspaces.length,
  'persisted workspaces survive setLastSelectedCli',
)

useWorkspaceStore.getState().setSidebarCollapsed(true)
assert.ok(
  useWorkspaceStore.getState().workspaces.length > 0,
  'workspaces survive setSidebarCollapsed',
)
assert.equal(
  readPersistedWorkspaces().length,
  initialState.workspaces.length,
  'persisted workspaces survive setSidebarCollapsed',
)

useWorkspaceStore.getState().setAuthState({
  ...defaultAuthState(),
  status: 'signed_in',
  authenticated: true,
  message: 'hydration regression',
})
assert.ok(
  useWorkspaceStore.getState().workspaces.length > 0,
  'workspaces survive setAuthState',
)

useWorkspaceStore.getState().setAppearanceTheme('dark')
assert.ok(
  useWorkspaceStore.getState().workspaces.length > 0,
  'workspaces survive app-settings writes',
)
const persistedAfterSettings = readPersistedWorkspaces()
assert.ok(
  persistedAfterSettings.length > 0,
  'persisted workspaces still non-empty after app-settings writes',
)
assert.equal(
  (persistedAfterSettings[0] as { id?: string }).id,
  hydrationWorkspaceId,
  'persisted workspace id is still the seeded fixture',
)

console.log('memoryHydration.test.ts: ok')
