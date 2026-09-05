import assert from 'node:assert/strict'

import type { Workspace, WorkspaceWindowState } from '../types/workspace'
import type { WorkspaceSyncEvent, WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'

// The registry-snapshot half of the rail-to-pane heal (store v74). Main owns
// the registry and never carries a pane record, so a snapshot whose layout
// still docks the Backlog rail must adopt that rail INTO the pane record the
// window already has — the seed `healRetiredRailLayout` builds from the raw
// record is otherwise discarded in favour of the window's own pane, and the
// person's open Backlog would vanish instead of becoming a tab. The stripped
// layout is written back to main once, so the heal converges.


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
const dispatchCalls: Array<{ type: string; payload: Record<string, unknown> }> = []

const railLayout = {
  global: {},
  borders: [],
  layout: {
    type: 'row',
    children: [
      { type: 'tabset', weight: 18, enableTabStrip: false, children: [{ type: 'tab', name: 'Backlog', component: 'backlog' }] },
      { type: 'tabset', weight: 82, children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'a-1' } }] },
    ],
  },
}

function workspace(id: string, layoutModel?: unknown): Workspace {
  return { id, name: id, folderPath: null, agents: {}, ...(layoutModel ? { layoutModel } : {}) } as unknown as Workspace
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

// What main answers when the client asks for its registry: empty at boot, then
// the rail layout once the test swaps it in.
let snapshot: WorkspaceSyncSnapshot = {
  sequence: 0,
  state: { workspaces: [], activeWorkspaceId: null, primaryWorkspaceWindowId: 'A', workspaceWindows: [] },
}

const workspaceSyncApiMock = {
  workspaceSyncDispatch: (command: { type: string; payload: Record<string, unknown> }) => {
    dispatchCalls.push(command)
    return Promise.resolve({ ok: false as const, reason: 'workspace_not_in_window', message: 'unseeded' })
  },
  workspaceSyncGetSnapshot: () => Promise.resolve(snapshot),
  workspaceSyncGetEventsAfter: () => Promise.resolve([]),
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
    location: { href: 'http://localhost/?windowId=A' },
    localStorage: localStorageMock,
    api: workspaceSyncApiMock,
    addEventListener: () => {},
  },
  configurable: true,
})
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })

const { useWorkspaceStore, __workspaceStoreBackupRecoveryPromise } = await import('./workspaceStore')
await __workspaceStoreBackupRecoveryPromise

// This window already renders the workspace with a pane of its own (closed, on
// a Git tab) and a layout that never docked the rail.
useWorkspaceStore.setState({
  workspaces: [{
    ...workspace('ws-heal', { global: {}, borders: [], layout: { type: 'row', children: [] } }),
    paneState: { open: false, activeTabId: 'g', tabs: [{ id: 'g', kind: 'git' }] },
  } as Workspace],
  activeWorkspaceId: 'ws-heal',
  primaryWorkspaceWindowId: 'A',
  workspaceWindows: [windowState('A', ['ws-heal'], 'ws-heal')],
  workspaceRegistryEmptyState: null,
})

// Main's copy still docks the Backlog rail. A broadcast with an unbridgeable
// sequence gap makes the client take main's whole registry as its baseline —
// the production path a stale snapshot arrives through.
snapshot = {
  sequence: 50,
  state: {
    workspaces: [workspace('ws-heal', railLayout)],
    activeWorkspaceId: 'ws-heal',
    primaryWorkspaceWindowId: 'A',
    workspaceWindows: [windowState('A', ['ws-heal'], 'ws-heal')],
  },
}
assert.ok(broadcastListeners.length > 0, 'the sync client subscribed a broadcast listener at store init')
for (const listener of broadcastListeners) {
  listener({
    id: 'workspace-sync-50',
    type: 'workspace_window.active_changed',
    sourceWindowId: 'A',
    sequence: 50,
    createdAt: 1_050,
    payload: { windowId: 'A', workspaceId: 'ws-heal' },
  })
}
await new Promise<void>((resolve) => setTimeout(resolve, 20))

const healed = useWorkspaceStore.getState().workspaces.find((w) => w.id === 'ws-heal')
assert.ok(healed, 'the snapshot was adopted')
assert.equal(
  JSON.stringify(healed.layoutModel).includes('"component":"backlog"'),
  false,
  'the rail tab is stripped from the adopted layout',
)
assert.deepEqual(
  healed.paneState?.tabs.map((tab) => tab.kind),
  ['git', 'backlog'],
  "the rail is adopted into the window's existing pane record, behind the tabs it had",
)
assert.equal(healed.paneState?.open, true, 'the rail was on screen, so the closed pane opens')
assert.equal(healed.paneState?.activeTabId, healed.paneState?.tabs[1].id, 'on the backlog tab')

const layoutWriteBacks = dispatchCalls.filter((command) => command.type === 'workspace.update_layout')
assert.equal(layoutWriteBacks.length, 1, 'the stripped layout is written back to main once so the heal converges')
assert.equal(
  JSON.stringify(layoutWriteBacks[0].payload).includes('"component":"backlog"'),
  false,
  'and what goes back carries no rail tab',
)

console.log('workspaceStore.registrySnapshotHeal.test.ts: ok')
