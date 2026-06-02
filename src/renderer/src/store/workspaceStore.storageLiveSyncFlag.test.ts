import assert from 'node:assert/strict'

import type { WorkspaceSyncEvent } from '../../../shared/workspace-sync'

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

type StorageListener = (event: { key: string | null; newValue: string | null }) => void
const storageListeners: StorageListener[] = []
const broadcastListeners: Array<(event: WorkspaceSyncEvent) => void> = []

const workspaceSyncApiMock = {
  workspaceSyncDispatch: () =>
    Promise.resolve({ ok: false as const, reason: 'workspace_not_in_window', message: 'unseeded' }),
  workspaceSyncGetSnapshot: () =>
    Promise.resolve({
      sequence: 0,
      state: { workspaces: [], activeWorkspaceId: null, primaryWorkspaceWindowId: 'primary', workspaceWindows: [] },
    }),
  onWorkspaceSyncEvent: (cb: (event: WorkspaceSyncEvent) => void) => {
    broadcastListeners.push(cb)
    return () => {
      const index = broadcastListeners.indexOf(cb)
      if (index >= 0) broadcastListeners.splice(index, 1)
    }
  },
}

Object.defineProperty(globalThis, 'window', {
  value: {
    location: { href: 'http://localhost/?windowId=primary' },
    localStorage: localStorageMock,
    api: workspaceSyncApiMock,
    addEventListener: (type: string, listener: StorageListener) => {
      if (type === 'storage') storageListeners.push(listener)
    },
  },
  configurable: true,
})
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })

const { __workspaceStoreBackupRecoveryPromise } = await import('./workspaceStore')
await __workspaceStoreBackupRecoveryPromise

assert.equal(storageListeners.length, 0, 'storage-event workspace live sync is disabled by default')
assert.equal(broadcastListeners.length, 1, 'main-mediated workspace sync remains subscribed')

console.log('workspaceStore.storageLiveSyncFlag.test.ts: ok')
