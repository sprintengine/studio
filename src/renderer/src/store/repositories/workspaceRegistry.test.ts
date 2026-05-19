import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import {
  WORKSPACE_REGISTRY_STORAGE_KEY,
  WORKSPACE_REGISTRY_VERSION,
  classifyWorkspaceRegistry,
  isDangerousRegistryClassification,
  isLegacyV44WorkspaceEnvelope,
  readRawWorkspaceRegistry,
  readWorkspaceRegistryEnvelope,
  splitLegacyV44Envelope,
  writeWorkspaceRegistry,
} from './workspaceRegistry'

const stored: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => stored[key] ?? null,
  setItem: (key: string, value: string) => {
    stored[key] = value
  },
  removeItem: (key: string) => {
    delete stored[key]
  },
}
Object.defineProperty(globalThis, 'window', {
  value: { localStorage: localStorageMock },
  configurable: true,
})

// classifyWorkspaceRegistry ----------------------------------------------------

assert.equal(
  classifyWorkspaceRegistry({ rawLocalStorage: null }),
  'dangerous_empty_missing_storage',
)
assert.equal(
  classifyWorkspaceRegistry({ rawLocalStorage: 'not-json{{{' }),
  'dangerous_empty_unreadable',
)
assert.equal(
  classifyWorkspaceRegistry({
    rawLocalStorage: JSON.stringify({ state: 'not-object' }),
  }),
  'dangerous_empty_unreadable',
)
assert.equal(
  classifyWorkspaceRegistry({
    rawLocalStorage: JSON.stringify({ state: { workspaces: [{ id: 'ws-1' }], activeWorkspaceId: 'ws-1' } }),
  }),
  'present',
)
assert.equal(
  classifyWorkspaceRegistry({
    rawLocalStorage: JSON.stringify({ state: { workspaces: [] } }),
  }),
  'dangerous_empty_no_workspaces',
  'empty workspaces without an emptyState record is dangerous',
)
assert.equal(
  classifyWorkspaceRegistry({
    rawLocalStorage: JSON.stringify({
      state: {
        workspaces: [],
        activeWorkspaceId: null,
        workspaceRegistryEmptyState: { reason: 'user_removed_all', updatedAt: '2026-05-19T13:00:00.000Z' },
      },
    }),
  }),
  'intentional_empty',
  'empty workspaces with an explicit workspaceRegistryEmptyState record is intentional',
)
// A legacy / mis-named "emptyState" field is NOT honored — the production
// schema is workspaceRegistryEmptyState. This prevents a silent rename drift
// from creating phantom intentional_empty classifications.
assert.equal(
  classifyWorkspaceRegistry({
    rawLocalStorage: JSON.stringify({
      state: {
        workspaces: [],
        activeWorkspaceId: null,
        emptyState: { reason: 'user_removed_all', updatedAt: '2026-05-19T13:00:00.000Z' },
      },
    }),
  }),
  'dangerous_empty_no_workspaces',
  'classifier ignores the wrong field name; only workspaceRegistryEmptyState counts',
)
assert.equal(
  classifyWorkspaceRegistry({
    rawLocalStorage: JSON.stringify({ state: { activeWorkspaceId: null } }),
  }),
  'dangerous_empty_no_workspaces',
  'missing workspaces array is dangerous, not intentional',
)

// isDangerousRegistryClassification -------------------------------------------

assert.equal(isDangerousRegistryClassification('present'), false)
assert.equal(isDangerousRegistryClassification('intentional_empty'), false)
assert.equal(isDangerousRegistryClassification('dangerous_empty_missing_storage'), true)
assert.equal(isDangerousRegistryClassification('dangerous_empty_unreadable'), true)
assert.equal(isDangerousRegistryClassification('dangerous_empty_no_workspaces'), true)

// readRawWorkspaceRegistry + readWorkspaceRegistryEnvelope + writeWorkspaceRegistry

assert.equal(readRawWorkspaceRegistry(), null)
assert.equal(readWorkspaceRegistryEnvelope(), null)

const sample: Workspace[] = [{ id: 'ws-1', name: 'A', folderPath: null, agents: {} } as unknown as Workspace]
writeWorkspaceRegistry({
  state: { workspaces: sample, activeWorkspaceId: 'ws-1', workspaceRegistryEmptyState: null },
  version: WORKSPACE_REGISTRY_VERSION,
})
const envelope = readWorkspaceRegistryEnvelope()
assert.ok(envelope)
assert.equal(envelope?.state.workspaces.length, 1)
assert.equal(envelope?.version, WORKSPACE_REGISTRY_VERSION)

// Storage key uses the expected name (matches the renderer constant).
assert.ok(
  stored[WORKSPACE_REGISTRY_STORAGE_KEY],
  'write targets the canonical multicode-workspaces key',
)

// Legacy v44 detection + split ------------------------------------------------

// Synthetic v44 envelope (single key carrying workspaces AND appSettings).
const legacyRaw = JSON.stringify({
  state: {
    workspaces: [{ id: 'legacy-1', name: 'Old', agents: {} }],
    activeWorkspaceId: 'legacy-1',
    appSettings: { searchExcludes: [], cliRuntimes: {} },
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
