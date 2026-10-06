import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { WorkspaceBackupPayload } from '../../../shared/electron-api'
import type { Workspace } from '../types/workspace'

// A pane pop-out window (`?aux=pane`) mounts the pane's own tab bodies, so the
// store's setters run in it — against settings that are a snapshot of when it
// opened. It writes neither the settings key nor the backup: either would put
// that snapshot back over what the workspace window has changed since.

test('a pane pop-out window persists nothing', async () => {
  const stored: Record<string, string> = {
    'sprintengine-app-settings': JSON.stringify({ state: { sidebarCollapsed: true }, version: 1 }),
  }
  const localStorageMock = {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value
    },
    removeItem: (key: string) => {
      delete stored[key]
    },
  }
  const backupWrites: WorkspaceBackupPayload[] = []
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: { href: 'http://localhost/?aux=pane&popOutId=pop-1&workspaceId=ws-1' },
      localStorage: localStorageMock,
      api: {
        workspaceBackupRead: async () => ({ ok: false, reason: 'missing' }),
        workspaceBackupWrite: async (payload: WorkspaceBackupPayload) => {
          backupWrites.push(payload)
          return { ok: true }
        },
      },
      addEventListener: () => undefined,
    },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })

  // After the doubles above: a static import would be hoisted over them.
  const { useWorkspaceStore, flushWorkspaceSettingsWrite, __workspaceStoreBackupRecoveryPromise } =
    await import('./workspaceStore')
  await __workspaceStoreBackupRecoveryPromise

  const settingsBefore = stored['sprintengine-app-settings']
  useWorkspaceStore.getState().setSidebarCollapsed(false)
  flushWorkspaceSettingsWrite()
  assert.equal(stored['sprintengine-app-settings'], settingsBefore, 'the settings key is not written')
  assert.equal(useWorkspaceStore.getState().sidebarCollapsed, false, 'the change still lands in this window')

  // The owner's pushes, and the registry's broadcasts, move the workspace list.
  useWorkspaceStore.setState({
    workspaces: [{ id: 'ws-1', name: 'Owner', folderPath: '/Users/dev/app', agents: {} } as unknown as Workspace],
  })
  useWorkspaceStore.setState((state) => ({
    workspaces: state.workspaces.map((workspace) => ({ ...workspace, name: 'Renamed' })),
  }))
  await new Promise<void>((resolve) => setTimeout(resolve, 1_200))
  assert.deepEqual(backupWrites, [], 'no backup carries its settings')
})
