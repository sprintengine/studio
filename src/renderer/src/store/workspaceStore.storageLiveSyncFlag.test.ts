import assert from 'node:assert/strict'

import type { WorkspaceSyncEvent } from '../../../shared/workspace-sync'
import { test } from 'vitest'

test('workspaceStore.storageLiveSyncFlag', async () => {
  // The retired rollback flag, set on: proving the deleted path cannot be
  // switched back on is the point of this file.
  const stored: Record<string, string> = { 'multicode.workspaceStorageLiveSync': '1' }
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
    workspaceSyncGetEventsAfter: () => Promise.resolve([]),
    workspaceRegistryNeedsHydration: () => Promise.resolve(false),
    workspaceRegistryHydrate: () => Promise.resolve({ changed: false, reason: 'already_present' as const }),
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

  // The `multicode.workspaceStorageLiveSync` flag and the storage-event path it
  // gated are deleted (MC-2158): they were the rollback for a localStorage
  // registry that no longer exists. What survives is the assertion that mattered
  // — this window subscribes to main's bus and mirrors it — now with the flag set
  // to '1' to prove the retired path cannot be switched back on.
  assert.equal(storageListeners.length, 0, 'no storage listener is registered even with the retired live-sync flag set')
  assert.equal(broadcastListeners.length, 1, 'the window subscribes to main-mediated workspace sync')

  console.log('workspaceStore.storageLiveSyncFlag.test.ts: ok')
})
