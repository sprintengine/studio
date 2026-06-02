import assert from 'node:assert/strict'

import type { Workspace, WorkspaceWindowState } from '../types/workspace'
import type { WorkspaceSyncEvent } from '../../../shared/workspace-sync'

// Production-faithful regression test for the active-workspace sync event path
// (T3). It loads the real Zustand workspace store with the real persist +
// storage-event rollback path and proves that applying an imported
// active_changed event does NOT write the registry to localStorage. That write
// is the mechanism by which a broadcast applied in one window could echo
// through another window's `storage` listener and flip its global active
// workspace (AC5/AC6). User-initiated selection must still persist so it
// reaches other windows through the existing rollback path.

const WORKSPACE_STORAGE_KEY = 'multicode-workspaces'

const stored: Record<string, string> = {}
stored['multicode.workspaceStorageLiveSync'] = '1'
let registryWriteCount = 0
const localStorageMock = {
  getItem: (key: string) => stored[key] ?? null,
  setItem: (key: string, value: string) => {
    if (key === WORKSPACE_STORAGE_KEY) registryWriteCount += 1
    stored[key] = value
  },
  removeItem: (key: string) => {
    delete stored[key]
  },
}

type StorageListener = (event: { key: string | null; newValue: string | null }) => void
const storageListeners: StorageListener[] = []

// Captures the broadcast callback the sync client registers at store init so
// the test can deliver a main-broadcast event exactly as the IPC layer would.
const broadcastListeners: Array<(event: WorkspaceSyncEvent) => void> = []
const dispatchCalls: unknown[] = []

const workspaceSyncApiMock = {
  workspaceSyncDispatch: (command: unknown) => {
    dispatchCalls.push(command)
    // Reject like an unseeded main service so the user-action path falls back to
    // local-only without applying an accepted event; the write under test then
    // comes purely from the local store mutation.
    return Promise.resolve({ ok: false as const, reason: 'workspace_not_in_window', message: 'unseeded' })
  },
  workspaceSyncGetSnapshot: () =>
    Promise.resolve({
      sequence: 0,
      state: { workspaces: [], activeWorkspaceId: null, primaryWorkspaceWindowId: 'A', workspaceWindows: [] },
    }),
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
    addEventListener: (type: string, listener: StorageListener) => {
      if (type === 'storage') storageListeners.push(listener)
    },
  },
  configurable: true,
})
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })

const { useWorkspaceStore, __workspaceStoreBackupRecoveryPromise } = await import('./workspaceStore')
await __workspaceStoreBackupRecoveryPromise

assert.equal(storageListeners.length, 1, 'rollback storage listener is registered only when the live-sync flag is enabled')

function workspace(id: string): Workspace {
  return { id, name: id, folderPath: null, agents: {} } as unknown as Workspace
}

function windowState(id: string, workspaceIds: string[], activeWorkspaceId: string | null): WorkspaceWindowState {
  return {
    id,
    kind: id === 'A' ? 'primary' : 'detached',
    workspaceIds,
    activeWorkspaceId,
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: 1,
    lastFocusedAt: 1,
  }
}

function seedTwoWindows(): void {
  useWorkspaceStore.setState({
    workspaces: [workspace('wsA1'), workspace('wsA2'), workspace('wsB1'), workspace('wsB2')],
    activeWorkspaceId: 'wsA1',
    primaryWorkspaceWindowId: 'A',
    workspaceWindows: [
      windowState('A', ['wsA1', 'wsA2'], 'wsA1'),
      windowState('B', ['wsB1', 'wsB2'], 'wsB1'),
    ],
    workspaceRegistryEmptyState: null,
  })
}

function emitBroadcast(event: WorkspaceSyncEvent): void {
  assert.ok(broadcastListeners.length > 0, 'sync client subscribed a broadcast listener at store init')
  for (const listener of broadcastListeners) listener(event)
}

function activeEvent(sequence: number, windowId: string, workspaceId: string): WorkspaceSyncEvent {
  return {
    id: `workspace-sync-${sequence}`,
    type: 'workspace_window.active_changed',
    sourceWindowId: windowId,
    sequence,
    createdAt: 1_000 + sequence,
    payload: { windowId, workspaceId },
  }
}

// ── CASE 1 ────────────────────────────────────────────────────────────────
// A broadcast targeting another window updates that window's record in memory
// but must not persist the registry (no echo) and must not flip this renderer's
// global active workspace.
seedTwoWindows()
await new Promise<void>((resolve) => setTimeout(resolve, 10))
let writesBefore = registryWriteCount

emitBroadcast(activeEvent(1, 'B', 'wsB2'))
await new Promise<void>((resolve) => setTimeout(resolve, 10))

assert.equal(
  registryWriteCount,
  writesBefore,
  'applying a broadcast for another window must not write the registry to localStorage (no storage echo)',
)
const afterForeign = useWorkspaceStore.getState()
assert.equal(afterForeign.activeWorkspaceId, 'wsA1', "current window's global active workspace is not flipped by a foreign event")
assert.equal(
  afterForeign.workspaceWindows.find((w) => w.id === 'B')?.activeWorkspaceId,
  'wsB2',
  "the targeted window's active workspace record is updated in memory",
)
assert.equal(
  afterForeign.workspaceWindows.find((w) => w.id === 'A')?.activeWorkspaceId,
  'wsA1',
  "this renderer's own window active workspace is untouched",
)
console.log('workspaceStore.activeSync.test.ts: foreign broadcast does not echo or flip — ok')

// ── CASE 2 ────────────────────────────────────────────────────────────────
// A broadcast targeting THIS window updates its active workspace and global id,
// but still must not persist (so it cannot echo to other windows either).
writesBefore = registryWriteCount
emitBroadcast(activeEvent(2, 'A', 'wsA2'))
await new Promise<void>((resolve) => setTimeout(resolve, 10))

assert.equal(
  registryWriteCount,
  writesBefore,
  'applying an imported event for the current window is also suppressed from persistence',
)
const afterCurrent = useWorkspaceStore.getState()
assert.equal(afterCurrent.activeWorkspaceId, 'wsA2', 'current-window imported event updates global active in memory')
assert.equal(
  afterCurrent.workspaceWindows.find((w) => w.id === 'A')?.activeWorkspaceId,
  'wsA2',
  'current-window imported event updates its window record',
)
console.log('workspaceStore.activeSync.test.ts: current-window broadcast applies without persist echo — ok')

// ── CASE 3 ────────────────────────────────────────────────────────────────
// A genuine user selection still persists (the source renderer's write is how
// the selection reaches other windows through the storage rollback path) and
// still dispatches through the sync bus.
seedTwoWindows()
await new Promise<void>((resolve) => setTimeout(resolve, 10))
writesBefore = registryWriteCount
const dispatchesBefore = dispatchCalls.length

useWorkspaceStore.getState().setActiveWorkspaceForWindow('A', 'wsA2')
await new Promise<void>((resolve) => setTimeout(resolve, 10))

assert.ok(registryWriteCount > writesBefore, 'a user-initiated active selection persists the registry')
assert.equal(dispatchCalls.length, dispatchesBefore + 1, 'a user-initiated active selection dispatches set_active once')
assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'wsA2')
console.log('workspaceStore.activeSync.test.ts: user selection persists and dispatches — ok')

// ── CASE 4 ────────────────────────────────────────────────────────────────
// Re-selecting the already-active workspace bumps focus locally but emits no
// new cross-window dispatch.
const dispatchesBeforeNoop = dispatchCalls.length
useWorkspaceStore.getState().setActiveWorkspaceForWindow('A', 'wsA2')
await new Promise<void>((resolve) => setTimeout(resolve, 10))
assert.equal(
  dispatchCalls.length,
  dispatchesBeforeNoop,
  're-selecting the already-active workspace emits no cross-window event',
)
console.log('workspaceStore.activeSync.test.ts: re-select emits no dispatch — ok')

// ── CASE 5 ────────────────────────────────────────────────────────────────
// Full no-echo contract: after an imported foreign-window broadcast applies
// under suppression, a LATER unrelated persisted mutation (settings-only, e.g.
// setSidebarCollapsed) must not serialize the imported window-active snapshot
// to the registry key. Without advancing the registry dedup baseline after the
// suppressed apply, the next setItem detects a registry diff and writes the
// imported state to `multicode-workspaces`, where another window's storage
// listener would import it and flip its global active workspace.
seedTwoWindows()
await new Promise<void>((resolve) => setTimeout(resolve, 10))

emitBroadcast(activeEvent(3, 'B', 'wsB2'))
await new Promise<void>((resolve) => setTimeout(resolve, 10))

// Baseline must reflect the pre-import persisted registry: window B active wsB1.
function persistedWindowActive(windowId: string): string | null | undefined {
  const raw = stored[WORKSPACE_STORAGE_KEY]
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as {
    state?: { workspaceWindows?: Array<{ id: string; activeWorkspaceId: string | null }> }
  }
  return parsed.state?.workspaceWindows?.find((w) => w.id === windowId)?.activeWorkspaceId
}
assert.equal(
  persistedWindowActive('B'),
  'wsB1',
  'before the settings mutation, the persisted registry still has window B active wsB1 (the imported event was suppressed)',
)

writesBefore = registryWriteCount
useWorkspaceStore.getState().setSidebarCollapsed(true)
await new Promise<void>((resolve) => setTimeout(resolve, 10))

assert.equal(
  registryWriteCount,
  writesBefore,
  'a settings-only mutation after an imported event must not write the registry (no deferred storage echo)',
)
assert.equal(
  persistedWindowActive('B'),
  'wsB1',
  'the persisted registry never serializes the imported window-active snapshot through the later settings write',
)
console.log('workspaceStore.activeSync.test.ts: settings write after import does not echo imported state — ok')

console.log('workspaceStore.activeSync.test.ts: ok')
