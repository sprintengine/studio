import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { createWorkspaceRegistryService } from '../../../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../../../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../../../main/workspace-sync-service'
import type { WorkspaceSyncCommand, WorkspaceSyncEvent } from '../../../shared/workspace-sync'
import type { LayoutTemplate, Workspace } from '../types/workspace'
import { defaultWorkspaceMemoryConfig } from './slices/memorySlice'
import { defaultWorkspaceWorktreeState } from './slices/worktreesSlice'

// A chat started with ⌘⏎ from New chat joins the window without coming to the
// front: the window keeps the chat it had, in this window's store, in main's
// registry, and in the event main broadcasts back, which every window applies.

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

function workspace(id: string): Workspace {
  return {
    id,
    name: id,
    mode: 'standard',
    folderPath: '/repo',
    templateId: 'test',
    agents: {},
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    memory: defaultWorkspaceMemoryConfig(),
    worktreeState: defaultWorkspaceWorktreeState(),
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  }
}

const template: LayoutTemplate = {
  id: 'solo-test',
  name: 'Chat',
  description: '',
  previewSlots: [],
  layout: { global: {}, borders: [], layout: { type: 'row', children: [] } },
}

async function harness(seed: string[]) {
  const registry = createWorkspaceRegistryService({ store: createInMemoryWorkspaceRegistryStore() })
  const bus = createWorkspaceSyncService({ registry })
  for (const id of seed) bus.adoptWorkspace(workspace(id), 'primary', '/repo', 'system')
  const commands: WorkspaceSyncCommand[] = []
  const broadcast: Array<(event: WorkspaceSyncEvent) => void> = []
  const stored = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', {
    location: { href: 'http://localhost/?windowId=primary' },
    localStorage,
    addEventListener: () => {},
    api: {
      terminalList: async () => [],
      workspaceSyncGetSnapshot: async () => bus.getSnapshot(),
      workspaceSyncGetEventsAfter: async (sequence: number) => bus.getEventsAfter(sequence),
      workspaceSyncDispatch: async (command: WorkspaceSyncCommand) => {
        commands.push(structuredClone(command))
        const answer = bus.dispatch({ command, sourceWindowId: 'primary' })
        // Main's broadcast reaches this window too, as it does every window.
        if (answer.ok) for (const listener of broadcast) listener(answer.event)
        return answer
      },
      onWorkspaceSyncEvent: (listener: (event: WorkspaceSyncEvent) => void) => {
        broadcast.push(listener)
        return () => undefined
      },
    },
  })
  const { useWorkspaceStore: store, __workspaceStoreBackupRecoveryPromise } = await import('./workspaceStore')
  await __workspaceStoreBackupRecoveryPromise
  await vi.waitFor(() => assert.equal(store.getState().workspaces.length, seed.length))
  return { store, bus, commands }
}

const windowActive = (state: { workspaceWindows: Array<{ id: string; activeWorkspaceId: string | null }> }) =>
  state.workspaceWindows.find((candidate) => candidate.id === 'primary')?.activeWorkspaceId ?? null

test('a chat created without activating joins the window and leaves its chat in front, everywhere', async () => {
  const app = await harness(['open'])
  app.store.getState().setActiveWorkspaceForWindow('primary', 'open')
  await vi.waitFor(() => assert.equal(windowActive(app.bus.getSnapshot().state), 'open'))

  const id = app.store.getState().addWorkspace(template, { windowId: 'primary', activate: false })
  const local = app.store.getState()
  assert.equal(windowActive(local), 'open', 'the window still shows the chat it had')
  assert.equal(local.activeWorkspaceId, 'open')
  assert.ok(local.workspaceWindows.find((candidate) => candidate.id === 'primary')?.workspaceIds.includes(id))

  await vi.waitFor(() => assert.ok(app.bus.getSnapshot().state.workspaces.some((candidate) => candidate.id === id)))
  const create = app.commands.find((command) => command.type === 'workspace.created')
  assert.ok(create?.type === 'workspace.created')
  assert.equal(create.payload.activate, false, 'main is told, or its echo would bring it front')
  assert.equal(windowActive(app.bus.getSnapshot().state), 'open', "main's record keeps the window as it was")
  assert.equal(windowActive(app.store.getState()), 'open', 'and so does the echo applied here')
})

test('a plain create still brings the new chat to the front', async () => {
  const app = await harness(['open'])
  app.store.getState().setActiveWorkspaceForWindow('primary', 'open')
  const id = app.store.getState().addWorkspace(template, { windowId: 'primary' })
  assert.equal(windowActive(app.store.getState()), id)
  await vi.waitFor(() => assert.equal(windowActive(app.bus.getSnapshot().state), id))
  const create = app.commands.find((command) => command.type === 'workspace.created')
  assert.ok(create?.type === 'workspace.created')
  assert.equal(create.payload.activate, undefined)
})
