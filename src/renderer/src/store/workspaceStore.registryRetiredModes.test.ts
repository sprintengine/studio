import assert from 'node:assert/strict'

import type { Workspace, WorkspaceWindowState } from '../types/workspace'
import type { WorkspaceSyncEvent, WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'

// Retired-mode rows (`RETIRED_WORKSPACE_MODES`) never enter a window through
// main's registry. The localStorage path has dropped them for a long time; the
// registry path adopted them verbatim, so a profile with old `sprintengine`
// rows showed each one in the sidebar as an uninstalled type whose old roster
// could still start. Both registry entry points are covered: a whole-snapshot
// adoption and a broadcast `workspace.created`.

const stored: Record<string, string> = {}
stored['multicode.workspaceStorageLiveSync'] = '1'
const localStorageMock = {
  getItem: (key: string) => stored[key] ?? null,
  setItem: (key: string, value: string) => {
    stored[key] = value
  },
  removeItem: (key: string) => {
    delete stored[key]
  },
}

const broadcastListeners: Array<(event: WorkspaceSyncEvent) => void> = []

function workspace(id: string, mode: string): Workspace {
  return {
    id,
    name: id,
    mode,
    folderPath: null,
    agents: {},
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
  } as unknown as Workspace
}

function windowState(id: string, workspaceIds: string[], activeWorkspaceId: string | null): WorkspaceWindowState {
  return {
    id,
    kind: 'primary',
    workspaceIds,
    activeWorkspaceId,
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: 1,
    lastFocusedAt: 1,
  }
}

let snapshot: WorkspaceSyncSnapshot = {
  sequence: 0,
  state: { workspaces: [], activeWorkspaceId: null, primaryWorkspaceWindowId: 'A', workspaceWindows: [] },
}

Object.defineProperty(globalThis, 'window', {
  value: {
    location: { href: 'http://localhost/?windowId=A' },
    localStorage: localStorageMock,
    api: {
      workspaceSyncDispatch: () =>
        Promise.resolve({ ok: false as const, reason: 'workspace_not_in_window', message: 'unseeded' }),
      workspaceSyncGetSnapshot: () => Promise.resolve(snapshot),
      workspaceSyncGetEventsAfter: () => Promise.resolve([]),
      onWorkspaceSyncEvent: (cb: (event: WorkspaceSyncEvent) => void) => {
        broadcastListeners.push(cb)
        return () => {
          const index = broadcastListeners.indexOf(cb)
          if (index >= 0) broadcastListeners.splice(index, 1)
        }
      },
    },
    addEventListener: () => {},
  },
  configurable: true,
})
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })

// Bundled as CommonJS (this directory's profile), so no top-level await.
async function main(): Promise<void> {
  const { useWorkspaceStore, __workspaceStoreBackupRecoveryPromise } = await import('./workspaceStore')
  await __workspaceStoreBackupRecoveryPromise

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }

  function broadcast(event: WorkspaceSyncEvent): void {
    for (const listener of broadcastListeners) listener(event)
  }

  useWorkspaceStore.setState({
    workspaces: [workspace('ws-local', 'standard')],
    activeWorkspaceId: 'ws-local',
    primaryWorkspaceWindowId: 'A',
    workspaceWindows: [windowState('A', ['ws-local'], 'ws-local')],
    workspaceRegistryEmptyState: null,
  })

  // Main's registry still carries a retired sprint-engine row, and it is the
  // window's active workspace. A sequence gap makes the client adopt it whole.
  snapshot = {
    sequence: 50,
    state: {
      workspaces: [
        workspace('ws-keep', 'standard'),
        workspace('ws-sprint', 'sprintengine'),
        workspace('ws-roadmap', 'roadmap'),
      ],
      activeWorkspaceId: 'ws-sprint',
      primaryWorkspaceWindowId: 'A',
      workspaceWindows: [windowState('A', ['ws-sprint', 'ws-keep', 'ws-roadmap'], 'ws-sprint')],
    },
  }
  assert.ok(broadcastListeners.length > 0, 'the sync client subscribed a broadcast listener at store init')
  broadcast({
    id: 'workspace-sync-50',
    type: 'workspace_window.active_changed',
    sourceWindowId: 'A',
    sequence: 50,
    createdAt: 1_050,
    payload: { windowId: 'A', workspaceId: 'ws-keep' },
  })
  await waitFor(
    () => useWorkspaceStore.getState().workspaces.some((candidate) => candidate.id === 'ws-keep'),
    'the snapshot adoption',
  )

  let state = useWorkspaceStore.getState()
  assert.deepEqual(
    state.workspaces.map((candidate) => candidate.id),
    ['ws-keep'],
    'a snapshot adoption drops every retired-mode row',
  )
  assert.deepEqual(
    state.workspaceWindows.find((candidate) => candidate.id === 'A')?.workspaceIds,
    ['ws-keep'],
    'and removes them from window membership',
  )
  assert.notEqual(state.activeWorkspaceId, 'ws-sprint', 'a dropped row is never the active workspace')
  assert.notEqual(
    state.workspaceWindows.find((candidate) => candidate.id === 'A')?.activeWorkspaceId,
    'ws-sprint',
    'nor a window active workspace',
  )

  // A broadcast create of a retired-mode record (an older main, or a window that
  // still held the row) is ignored; an ordinary one next to it still lands.
  broadcast({
    id: 'workspace-sync-51',
    type: 'workspace.created',
    sourceWindowId: 'B',
    sequence: 51,
    createdAt: 1_051,
    payload: {
      workspace: workspace('ws-sprint-again', 'sprintengine'),
      windowId: 'A',
      insert: { kind: 'folder_head', folderPath: null },
    },
  })
  broadcast({
    id: 'workspace-sync-52',
    type: 'workspace.created',
    sourceWindowId: 'B',
    sequence: 52,
    createdAt: 1_052,
    payload: {
      workspace: workspace('ws-new', 'standard'),
      windowId: 'A',
      insert: { kind: 'folder_head', folderPath: null },
    },
  })
  await waitFor(
    () => useWorkspaceStore.getState().workspaces.some((candidate) => candidate.id === 'ws-new'),
    'the ordinary create',
  )
  state = useWorkspaceStore.getState()
  assert.equal(
    state.workspaces.some((candidate) => candidate.id === 'ws-sprint-again'),
    false,
    'a broadcast create of a retired-mode record is not adopted',
  )
  assert.equal(
    state.workspaceWindows.some((candidate) => candidate.workspaceIds.includes('ws-sprint-again')),
    false,
    'and is not assigned to any window',
  )

  console.log('workspaceStore.registryRetiredModes.test.ts: ok')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
