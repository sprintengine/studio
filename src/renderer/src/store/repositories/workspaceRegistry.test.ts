import assert from 'node:assert/strict'

import { isLegacyV44WorkspaceEnvelope, splitLegacyV44Envelope } from './workspaceRegistry'

// Legacy v44 detection + split ------------------------------------------------

// Synthetic v44 envelope (single key carrying workspaces AND appSettings).
const legacyRaw = JSON.stringify({
  state: {
    workspaces: [{ id: 'legacy-1', name: 'Old', agents: {} }],
    activeWorkspaceId: 'legacy-1',
    appSettings: { cliRuntimes: {} },
    sidebarCollapsed: true,
  },
  version: 44,
})
assert.equal(isLegacyV44WorkspaceEnvelope(legacyRaw), true, 'v44 envelope with settings fields detected')

// A v45 envelope without settings inside the registry payload must NOT
// trigger the legacy split.
const v45Raw = JSON.stringify({
  state: {
    workspaces: [{ id: 'modern-1', name: 'New', agents: {} }],
    activeWorkspaceId: 'modern-1',
    workspaceRegistryEmptyState: null,
  },
  version: 45,
})
assert.equal(isLegacyV44WorkspaceEnvelope(v45Raw), false, 'v45 registry-only envelope is not legacy')

const split = splitLegacyV44Envelope(legacyRaw)
assert.ok(split)
assert.equal(split?.registry.state.workspaces.length, 1)
assert.equal(split?.registry.state.activeWorkspaceId, 'legacy-1')
assert.equal(split?.registry.state.workspaceRegistryEmptyState, null,
  'split backfills workspaceRegistryEmptyState=null on the registry half')
assert.ok(split?.extractedSettings, 'settings half is returned for migration')
assert.deepEqual(
  (split!.extractedSettings as { sidebarCollapsed: unknown }).sidebarCollapsed,
  true,
)

console.log('workspaceRegistry.test.ts: ok')
