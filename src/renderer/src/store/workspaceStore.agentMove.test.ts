import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { createWorkspaceRegistryService } from '../../../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../../../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../../../main/workspace-sync-service'
import { defaultAgent } from '../../../shared/agent-state'
import type { WorkspaceSyncCommand, WorkspaceSyncEvent } from '../../../shared/workspace-sync'
import type { LayoutTemplate, Workspace } from '../types/workspace'
import { defaultWorkspaceMemoryConfig } from './slices/memorySlice'
import { defaultWorkspaceWorktreeState } from './slices/worktreesSlice'

// Main owns the registry. A move that only changed the window's store left
// main, every other window and the next start with the agent in the chat it
// was dragged out of.

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

const AGENT = 'agent-0123456789abcdef'

function workspace(id: string, agents: Workspace['agents']): Workspace {
  return {
    id,
    name: id,
    mode: 'standard',
    folderPath: '/repo',
    templateId: 'test',
    agents,
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    memory: defaultWorkspaceMemoryConfig(),
    worktreeState: defaultWorkspaceWorktreeState(),
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  }
}

async function harness() {
  const disk = createInMemoryWorkspaceRegistryStore()
  const registry = createWorkspaceRegistryService({ store: disk })
  const bus = createWorkspaceSyncService({ registry })
  bus.adoptWorkspace(
    workspace('a', { [AGENT]: { ...defaultAgent(AGENT, 'Scout'), cli: 'codex', cliSessionId: 'cli-1' } }),
    'primary',
    '/repo',
    'system',
  )
  bus.adoptWorkspace(workspace('b', {}), 'primary', '/repo', 'system')
  const commands: WorkspaceSyncCommand[] = []
  const stored = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value)
    },
    removeItem: (key: string) => {
      stored.delete(key)
    },
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
        // IPC structured cloning also proves no revoked Immer draft escaped.
        commands.push(structuredClone(command))
        return bus.dispatch({ command, sourceWindowId: 'primary' })
      },
      onWorkspaceSyncEvent: (_listener: (event: WorkspaceSyncEvent) => void) => () => {},
    },
  })
  const { useWorkspaceStore: store, __workspaceStoreBackupRecoveryPromise } = await import('./workspaceStore')
  await __workspaceStoreBackupRecoveryPromise
  await vi.waitFor(() =>
    assert.equal(store.getState().workspaces.find((ws) => ws.id === 'a')?.agents[AGENT]?.name, 'Scout'),
  )
  return { store, disk, registry, bus, commands }
}

test('an agent dragged into another chat moves there in main, for other windows and the next start', async () => {
  const app = await harness()
  const before = app.bus.getSnapshot().sequence
  assert.equal(app.store.getState().moveAgentToWorkspace('a', 'b', AGENT), true)

  await vi.waitFor(() => assert.equal(app.registry.getRecord('a')?.agents[AGENT], undefined))
  const moved = app.registry.getRecord('b')?.agents[AGENT]
  assert.equal(moved?.name, 'Scout')
  assert.equal(moved?.cli, 'codex', 'the whole record moves, not a skeleton')
  assert.equal(moved?.cliSessionId, 'cli-1')

  // Other windows learn it from the bus: the agent arrives in the destination
  // before it leaves the source, so no reader sees it in neither chat.
  const events = app.bus.getEventsAfter(before)
  assert.deepEqual(
    events.map((event) =>
      event.type === 'workspace.agents_updated'
        ? [event.payload.workspaceId, event.payload.patch === null ? 'removed' : 'added']
        : [event.type],
    ),
    [
      ['b', 'added'],
      ['a', 'removed'],
    ],
  )

  const restarted = createWorkspaceRegistryService({ store: app.disk })
  assert.equal(restarted.getRecord('a')?.agents[AGENT], undefined)
  assert.equal(restarted.getRecord('b')?.agents[AGENT]?.name, 'Scout')
})

test('a refused move sends nothing to main', async () => {
  const app = await harness()
  app.store.getState().updateAgent('b', AGENT, { name: 'Other' })
  await vi.waitFor(() => assert.equal(app.registry.getRecord('b')?.agents[AGENT]?.name, 'Other'))
  const sent = app.commands.length
  assert.equal(app.store.getState().moveAgentToWorkspace('a', 'b', AGENT), false)
  assert.equal(app.commands.length, sent)
  assert.equal(app.registry.getRecord('a')?.agents[AGENT]?.name, 'Scout')
  assert.equal(app.registry.getRecord('b')?.agents[AGENT]?.name, 'Other')
})

test('an agent dragged out into a new chat is in that chat’s create, so main never holds its tab alone', async () => {
  const app = await harness()
  const template: LayoutTemplate = {
    id: 'extracted-tab-test',
    name: 'Scout',
    description: '',
    previewSlots: [],
    layout: {
      global: {},
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            children: [{ type: 'tab', name: 'Scout', component: 'agent', config: { agentId: AGENT } }],
          },
        ],
      },
    },
  }
  const id = app.store.getState().addWorkspace(template, {
    folderPath: '/repo',
    windowId: 'primary',
    moveLayoutAgentsFrom: 'a',
  })

  const local = app.store.getState().workspaces
  assert.equal(local.find((ws) => ws.id === id)?.agents[AGENT]?.name, 'Scout')
  assert.equal(local.find((ws) => ws.id === 'a')?.agents[AGENT], undefined)

  await vi.waitFor(() => assert.equal(app.registry.getRecord('a')?.agents[AGENT], undefined))
  const create = app.commands.find((command) => command.type === 'workspace.created')
  assert.ok(create?.type === 'workspace.created')
  assert.equal(create.payload.workspace.agents[AGENT]?.name, 'Scout', 'the create itself carries the agent')
  assert.equal(app.registry.getRecord(id)?.agents[AGENT]?.cliSessionId, 'cli-1')
  assert.match(JSON.stringify(app.registry.getRecord(id)?.layoutModel), new RegExp(`"agentId":"${AGENT}"`))
  assert.deepEqual(
    app.commands.map((command) => command.type),
    ['workspace.created', 'workspace.update_agent'],
    'the create goes first, and the source lets go of the agent only after it',
  )
})
