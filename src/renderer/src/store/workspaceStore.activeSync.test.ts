import assert from 'node:assert/strict'

import type { Workspace, WorkspaceWindowState } from '../types/workspace'
import type { WorkspaceSyncEvent } from '../../../shared/workspace-sync'
import { test } from 'vitest'

test('workspaceStore.activeSync', async () => {
  // Production-faithful regression test for the active-workspace sync event path.
  // It loads the real Zustand workspace store and proves the no-echo contract now
  // that main owns the registry: applying an imported active_changed
  // event updates the mirror without writing localStorage, and a user-initiated
  // selection reaches other windows by DISPATCHING to main rather than by
  // persisting a registry another window's `storage` listener would import. That
  // listener is gone, and with it the echo hazard it created.

  const WORKSPACE_STORAGE_KEY = 'sprintengine-workspaces'

  const stored: Record<string, string> = {}
  stored['sprintengine.workspaceStorageLiveSync'] = '1'
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

  assert.equal(
    storageListeners.length,
    0,
    'the storage-event cross-window path is deleted: it was the rollback for a localStorage registry that no longer exists',
  )

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
      workspaceWindows: [windowState('A', ['wsA1', 'wsA2'], 'wsA1'), windowState('B', ['wsB1', 'wsB2'], 'wsB1')],
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
  assert.equal(
    afterForeign.activeWorkspaceId,
    'wsA1',
    "current window's global active workspace is not flipped by a foreign event",
  )
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
  // A genuine user selection dispatches through the sync bus — that dispatch IS
  // how the selection reaches other windows now. It writes no registry: the
  // source renderer's localStorage write used to be the transport, and main's
  // broadcast replaced it.
  seedTwoWindows()
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  writesBefore = registryWriteCount
  const dispatchesBefore = dispatchCalls.length

  useWorkspaceStore.getState().setActiveWorkspaceForWindow('A', 'wsA2')
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  assert.equal(
    registryWriteCount,
    writesBefore,
    'a user-initiated active selection writes no registry: the dispatch below is the transport',
  )
  assert.equal(
    dispatchCalls.length,
    dispatchesBefore + 1,
    'a user-initiated active selection dispatches set_active once',
  )
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
  // The deferred-echo hazard, closed structurally. This used to be a live risk: a
  // suppressed apply left the registry dedup baseline stale, so a LATER unrelated
  // settings write serialized the imported window-active snapshot into
  // `sprintengine-workspaces`, where another window's storage listener imported it
  // and flipped that window's active workspace. Neither half exists now — the
  // registry key is frozen and the listener is deleted — so the assertion is that
  // NOTHING reaches the key, whatever order the mutations arrive in.
  seedTwoWindows()
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  const frozenRegistryRaw = stored[WORKSPACE_STORAGE_KEY]
  emitBroadcast(activeEvent(3, 'B', 'wsB2'))
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  writesBefore = registryWriteCount
  useWorkspaceStore.getState().setSidebarCollapsed(true)
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  assert.equal(registryWriteCount, writesBefore, 'a settings-only mutation after an imported event writes no registry')
  assert.equal(
    stored[WORKSPACE_STORAGE_KEY],
    frozenRegistryRaw,
    'the frozen registry key is byte-identical after an import followed by a settings write',
  )
  assert.equal(
    useWorkspaceStore.getState().workspaceWindows.find((w) => w.id === 'B')?.activeWorkspaceId,
    'wsB2',
    'the imported event still applied to the in-memory mirror',
  )
  console.log('workspaceStore.activeSync.test.ts: no registry write can carry an imported event — ok')

  // ── CASE 6 ────────────────────────────────────────────────────────────────
  // Registry-domain user edits are asked of main. Each carries an
  // `editedAt` stamped HERE, at the gesture, because main's per-field
  // last-write-wins ordering must not depend on IPC latency.
  seedTwoWindows()
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  const beforeEdits = dispatchCalls.length
  const stampedAfter = Date.now()

  useWorkspaceStore.getState().renameWorkspace('wsA1', 'Typed by hand')
  useWorkspaceStore.getState().updateLayout('wsA1', { global: {}, borders: [], layout: { type: 'row', children: [] } })
  useWorkspaceStore.getState().removeWorkspace('wsA2')
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  const registryCommands = dispatchCalls.slice(beforeEdits) as Array<{ type: string; payload: Record<string, unknown> }>
  assert.deepEqual(
    registryCommands.map((command) => command.type),
    ['workspace.rename', 'workspace.update_layout', 'workspace.remove'],
    'each user-editable fact is its own command, so two windows editing different fields never contend',
  )

  const rename = registryCommands[0]!
  assert.equal(rename.payload.name, 'Typed by hand')
  assert.equal(rename.payload.titleLocked, true, 'the lock travels with the name or auto-titling overwrites the winner')
  assert.ok(
    typeof rename.payload.editedAt === 'number' && (rename.payload.editedAt as number) >= stampedAfter,
    'the rename is stamped at the gesture, not on arrival in main',
  )
  assert.ok(
    typeof registryCommands[1]!.payload.editedAt === 'number',
    'the layout command is stamped too — layout is renderer-authored, main-persisted',
  )
  assert.equal(registryCommands[2]!.payload.workspaceId, 'wsA2')

  // The optimistic apply still happened locally; main's answer reconciles it.
  assert.equal(useWorkspaceStore.getState().workspaces.find((w) => w.id === 'wsA1')?.name, 'Typed by hand')
  assert.equal(
    useWorkspaceStore.getState().workspaces.some((w) => w.id === 'wsA2'),
    false,
  )
  console.log('workspaceStore.activeSync.test.ts: registry edits dispatch stamped commands — ok')

  console.log('workspaceStore.activeSync.test.ts: ok')
})
