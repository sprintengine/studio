import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { createWorkspaceRegistryService } from '../../../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../../../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../../../main/workspace-sync-service'
import { defaultAgent } from '../../../shared/agent-state'
import type { TerminalSessionSnapshot } from '../../../shared/electron-api'
import type { WorkspaceSyncCommand, WorkspaceSyncEvent } from '../../../shared/workspace-sync'
import type { Workspace } from '../types/workspace'
import { defaultWorkspaceMemoryConfig } from './slices/memorySlice'
import { defaultWorkspaceWorktreeState } from './slices/worktreesSlice'

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

function session(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    sessionId: 'session-1',
    kind: 'agent',
    workspaceId: 'ws',
    agentId: 'agent-codex-abc123',
    processAlive: true,
    suspended: false,
    visible: true,
    reapExempt: false,
    startedAt: 1,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'idle', since: 1 },
    exitedAt: null,
    outputBufferLength: 0,
    retainedOutputBytes: 0,
    fileChanges: [],
    activeSubagents: 0,
    contextUsage: null,
    ...overrides,
  }
}

async function harness(
  agents: Workspace['agents'] = {},
  terminalList = async (): Promise<TerminalSessionSnapshot[]> => [],
) {
  const disk = createInMemoryWorkspaceRegistryStore()
  const registry = createWorkspaceRegistryService({ store: disk })
  const bus = createWorkspaceSyncService({ registry, maxReplayEvents: 1 })
  bus.adoptWorkspace(
    {
      id: 'ws',
      name: 'Workspace',
      mode: 'standard',
      folderPath: '/repo',
      templateId: 'test',
      agents,
      layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
      memory: defaultWorkspaceMemoryConfig(),
      worktreeState: defaultWorkspaceWorktreeState(),
      editorState: { openFiles: [], activeFilePath: null },
      createdAt: 1,
    },
    'primary',
    '/repo',
    'system',
  )
  const commands: WorkspaceSyncCommand[] = []
  const listeners: Array<(event: WorkspaceSyncEvent) => void> = []
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
      terminalList,
      workspaceSyncGetSnapshot: async () => bus.getSnapshot(),
      workspaceSyncGetEventsAfter: async (sequence: number) => bus.getEventsAfter(sequence),
      workspaceSyncDispatch: async (command: WorkspaceSyncCommand) => {
        // IPC structured cloning also proves no revoked Immer draft escaped.
        commands.push(structuredClone(command))
        return bus.dispatch({ command, sourceWindowId: 'primary' })
      },
      onWorkspaceSyncEvent: (listener: (event: WorkspaceSyncEvent) => void) => {
        listeners.push(listener)
        return () => {}
      },
    },
  })
  const { useWorkspaceStore: store, __workspaceStoreBackupRecoveryPromise } = await import('./workspaceStore')
  await __workspaceStoreBackupRecoveryPromise
  await vi.waitFor(() => assert.equal(store.getState().workspaces[0]?.id, 'ws'))
  const resync = async () => {
    const before = bus.getSnapshot().sequence
    let last: WorkspaceSyncEvent | undefined
    for (let i = 0; i < 3; i++) {
      const result = bus.updateWorkspaceFields('ws', { settledAt: i }, 'system')
      if (result.ok) last = result.event
    }
    assert.ok(last && last.sequence > before)
    for (const listener of listeners) listener(last!)
    await vi.waitFor(() => assert.equal(store.getState().workspaces[0]?.settledAt, 2))
  }
  return { store, disk, registry, bus, commands, resync }
}

test('agent creation and rename survive terminal assignment, registry resync, and restart without echoes', async () => {
  const app = await harness()
  app.store.getState().updateAgent('ws', 'agent-codex-abc123', { name: 'Scout', cli: 'codex' })
  await vi.waitFor(() => assert.equal(app.registry.getRecord('ws')?.agents['agent-codex-abc123'].name, 'Scout'))
  const result = app.bus.dispatch({
    sourceWindowId: 'primary',
    command: {
      type: 'agent_terminal.assign_session',
      payload: { workspaceId: 'ws', agentId: 'agent-codex-abc123', sessionId: 'session-1', cli: 'codex' },
    },
  })
  assert.equal(result.ok, true)
  await app.resync()
  assert.equal(app.store.getState().workspaces[0].agents['agent-codex-abc123'].name, 'Scout')
  app.store.getState().updateAgent('ws', 'agent-codex-abc123', { name: 'Reviewer' })
  app.store.getState().updateAgent('ws', 'agent-codex-abc123', { cliHasLaunched: true })
  await vi.waitFor(() => assert.equal(app.registry.getRecord('ws')?.agents['agent-codex-abc123'].name, 'Reviewer'))
  assert.deepEqual(
    app.commands
      .filter((command) => command.type === 'workspace.update_agent')
      .map((command) => command.payload.patch && Object.keys(command.payload.patch).includes('name')),
    [true, true, false],
  )
  const restarted = createWorkspaceRegistryService({ store: app.disk })
  assert.equal(restarted.getRecord('ws')?.agents['agent-codex-abc123'].name, 'Reviewer')
})

test('main-launched projections persist their name and config exactly once', async () => {
  const app = await harness()
  const sessions = [
    session({
      agentRecord: { agentId: 'agent-codex-abc123', name: 'Scout', cli: 'codex', cliPermissionPreset: 'manual' },
    }),
  ]
  assert.equal(app.store.getState().projectLaunchedAgentSessions(sessions).length, 1)
  assert.equal(app.store.getState().projectLaunchedAgentSessions(sessions).length, 0)
  await vi.waitFor(() => assert.equal(app.registry.getRecord('ws')?.agents['agent-codex-abc123'].name, 'Scout'))
  await app.resync()
  assert.equal(app.store.getState().workspaces[0].agents['agent-codex-abc123'].name, 'Scout')
  assert.equal(app.commands.filter((command) => command.type === 'workspace.update_agent').length, 1)
  app.store.getState().removeAgent('ws', 'agent-codex-abc123')
  await vi.waitFor(() => assert.equal(app.registry.getRecord('ws')?.agents['agent-codex-abc123'], undefined))
  assert.equal(
    createWorkspaceRegistryService({ store: app.disk }).getRecord('ws')?.agents['agent-codex-abc123'],
    undefined,
  )
})

test('damaged saved names recover from retained sessions or receive stable unique replacements', async () => {
  const app = await harness(
    {
      'agent-codex-abc123': { ...defaultAgent('agent-codex-abc123'), cliSessionId: 'session-1' },
      'short-id': defaultAgent('short-id'),
      custom: defaultAgent('custom', 'Reviewer'),
    },
    async () => [session({ processAlive: false, suspended: true, agentName: 'Scout' })],
  )
  await vi.waitFor(() => assert.equal(app.registry.getRecord('ws')?.agents['agent-codex-abc123'].name, 'Scout'))
  const repaired = app.registry.getRecord('ws')!.agents
  assert.match(repaired['short-id'].name, /^[A-Z][a-z]+ [A-Z][a-z]+$/)
  assert.equal(repaired.custom.name, 'Reviewer')
  assert.equal(new Set(Object.values(repaired).map((agent) => agent.name)).size, 3)
  const count = app.commands.length
  await app.resync()
  assert.equal(app.commands.length, count, 'accepted repairs do not echo or reroll at resync')
  assert.equal(
    createWorkspaceRegistryService({ store: app.disk }).getRecord('ws')!.agents['short-id'].name,
    repaired['short-id'].name,
  )
})

test('a custom rename during terminal recovery wins over the old session name', async () => {
  let resolve!: (sessions: TerminalSessionSnapshot[]) => void
  const app = await harness(
    { 'agent-codex-abc123': defaultAgent('agent-codex-abc123') },
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  app.store.getState().updateAgent('ws', 'agent-codex-abc123', { name: 'Reviewer' })
  resolve([session({ agentName: 'Scout' })])
  await vi.waitFor(() => assert.equal(app.registry.getRecord('ws')?.agents['agent-codex-abc123'].name, 'Reviewer'))
  assert.equal(app.store.getState().workspaces[0].agents['agent-codex-abc123'].name, 'Reviewer')
})

test('a surviving local agent keeps its name and config when a registry snapshot omits it', async () => {
  const app = await harness()
  app.store.setState((state) => ({
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      agents: {
        local: {
          ...defaultAgent('local', 'Reviewer'),
          cliSessionId: 'session-local',
          cli: 'codex',
          cliModel: 'test-model',
        },
      },
    })),
  }))
  await app.resync()
  await vi.waitFor(() => assert.equal(app.registry.getRecord('ws')?.agents.local?.name, 'Reviewer'))
  assert.equal(app.registry.getRecord('ws')?.agents.local.cliModel, 'test-model')
})

test('a surviving local name repairs an id-named registry record', async () => {
  let resolve!: (sessions: TerminalSessionSnapshot[]) => void
  const app = await harness(
    { local: defaultAgent('local') },
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  app.store.setState((state) => ({
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      agents: { local: defaultAgent('local', 'Reviewer') },
    })),
  }))
  await app.resync()
  resolve([])
  await vi.waitFor(() => assert.equal(app.registry.getRecord('ws')?.agents.local.name, 'Reviewer'))
})

test('recovery checks workspace and session identity and can use the original launch record', async () => {
  const app = await harness(
    {
      'agent-codex-abc123': { ...defaultAgent('agent-codex-abc123'), cliSessionId: 'session-1' },
    },
    async () => [
      session({ workspaceId: 'other-workspace', agentName: 'Wrong workspace' }),
      session({ sessionId: 'old-session', agentName: 'Old session' }),
      session({
        agentName: 'agent-codex-abc123',
        agentRecord: {
          agentId: 'agent-codex-abc123',
          name: 'Scout',
          cli: 'codex',
          cliPermissionPreset: 'manual',
        },
      }),
    ],
  )
  await vi.waitFor(() => assert.equal(app.registry.getRecord('ws')?.agents['agent-codex-abc123'].name, 'Scout'))
})

test('terminal metadata failure still repairs an id-named agent once', async () => {
  const app = await harness({ local: defaultAgent('local') }, async () => {
    throw new Error('unavailable')
  })
  await vi.waitFor(() => assert.notEqual(app.registry.getRecord('ws')?.agents.local.name, 'local'))
  assert.match(app.registry.getRecord('ws')!.agents.local.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/)
})

test('removal during terminal recovery does not recreate the agent', async () => {
  let resolve!: (sessions: TerminalSessionSnapshot[]) => void
  const app = await harness(
    { 'agent-codex-abc123': defaultAgent('agent-codex-abc123') },
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  app.store.getState().removeAgent('ws', 'agent-codex-abc123')
  resolve([session({ agentName: 'Scout' })])
  await vi.waitFor(() => assert.deepEqual(app.registry.getRecord('ws')?.agents, {}))
  assert.deepEqual(app.store.getState().workspaces[0].agents, {})
})
