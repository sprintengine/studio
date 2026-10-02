import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createControlRpc, type ControlRpc } from '../../server/bootstrap/control-rpc'
import { SERVER_EVENTS, SERVER_METHODS, type ServerMirrorState } from '../../server/desktop/server-methods'
import { emptyAgentLaunchSettings } from '../../shared/launch-settings'
import { installHostRegistry } from '../hosts/host-registry'
import { createRemoteCore, createRemoteCredentialStore, createRemoteGitHubTokenStore } from './remote-core'
import { createServerStateMirror } from './server-mirror'

// What the shell reads of the server out of process: the mirror, fed by the
// server's snapshot and its pushes, and the core proxy over it.

function pair(): { shell: ControlRpc; server: ControlRpc } {
  const shell: ControlRpc = createControlRpc((frame) => setImmediate(() => server.receive(frame)))
  const server: ControlRpc = createControlRpc((frame) => setImmediate(() => shell.receive(frame)))
  return { shell, server }
}

const workspace = (id: string) => ({ id, name: id, folderPath: `/Users/dev/${id}`, agents: {} }) as never

function snapshotWith(ids: string[], cli = 'claude-code'): ServerMirrorState {
  const state = {
    workspaces: ids.map(workspace),
    activeWorkspaceId: null,
    workspaceWindows: [],
    primaryWorkspaceWindowId: 'primary',
    lastAppliedWorkspaceSyncSequence: ids.length,
  }
  const { lastAppliedWorkspaceSyncSequence: _sequence, ...snapshotState } = state
  return {
    state,
    snapshot: { sequence: ids.length, state: snapshotState },
    needsHydration: false,
    launchSettings: {
      settings: { ...emptyAgentLaunchSettings(), lastSelectedCli: cli },
      record: { schemaVersion: 1, revision: 1, settings: emptyAgentLaunchSettings() } as never,
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve)).then(() => new Promise((r) => setImmediate(r)))

test('the mirror is empty until the server answers, then reads its snapshot synchronously', async () => {
  const { shell, server } = pair()
  server.handle(SERVER_METHODS.mirrorSnapshot, () => snapshotWith(['acme']))
  const mirror = createServerStateMirror({ rpc: shell })
  assert.deepEqual(mirror.registry.getRecords(), [])
  await mirror.load()
  await mirror.whenLoaded()
  assert.equal(mirror.registry.getRecord('acme')?.folderPath, '/Users/dev/acme')
  assert.equal(mirror.workspaceSync.getSnapshot().state.workspaces.length, 1)
  assert.equal(mirror.launchSettings.get().lastSelectedCli, 'claude-code')
})

test('pushes keep it current and reach its subscribers', async () => {
  const { shell, server } = pair()
  server.handle(SERVER_METHODS.mirrorSnapshot, () => snapshotWith([]))
  const mirror = createServerStateMirror({ rpc: shell })
  await mirror.load()
  const seen: string[] = []
  mirror.registry.subscribe((state) => seen.push(state.workspaces.map((w) => w.id).join(',')))
  mirror.workspaceSync.subscribeEvents((event) => seen.push(`event:${(event as { type: string }).type}`))
  const records: number[] = []
  mirror.launchSettings.subscribe((record) => records.push(record.revision))
  const next = snapshotWith(['acme', 'build-box'], 'codex')
  server.emit(SERVER_EVENTS.mirrorRegistry, { state: next.state, snapshot: next.snapshot, needsHydration: false })
  server.emit(SERVER_EVENTS.mirrorWorkspaceEvent, { type: 'workspace.created' })
  server.emit(SERVER_EVENTS.mirrorLaunchSettings, {
    settings: next.launchSettings.settings,
    record: { schemaVersion: 1, revision: 2, settings: next.launchSettings.settings },
  })
  await settle()
  assert.deepEqual(seen, ['acme,build-box', 'event:workspace.created'])
  assert.deepEqual(records, [2])
  assert.equal(mirror.launchSettings.get().lastSelectedCli, 'codex')
})

test('an agent record the shell writes goes to the server, answered at once', async () => {
  const { shell, server } = pair()
  const written: unknown[] = []
  server.handle(SERVER_METHODS.updateWorkspaceAgent, (params) => {
    written.push(params)
    return { ok: true }
  })
  const mirror = createServerStateMirror({ rpc: shell })
  assert.deepEqual(mirror.workspaceSync.updateWorkspaceAgent('acme', 'agent-1', { name: 'Fix' }, 'system', 0), {
    ok: true,
  })
  await settle()
  assert.deepEqual(written, [
    { workspaceId: 'acme', agentId: 'agent-1', patch: { name: 'Fix' }, actor: 'system', stamp: 0 },
  ])
})

test("the core proxy answers the shell's members and refuses the server's by name", () => {
  const { shell } = pair()
  const mirror = createServerStateMirror({ rpc: shell })
  const core = createRemoteCore({ rpc: shell, mirror, whenServing: async () => true, isServing: () => true })
  assert.equal(core.workspaceRegistry.getRecords().length, 0)
  assert.equal(core.conversations.listSessions().ok, true)
  assert.equal(core.dataDirLock, null)
  assert.throws(() => core.createConversationHost, /server's/)
  assert.throws(() => core.conversationLaunchService.launch({} as never), /server's/)
  installHostRegistry(null)
})

test('a credential and the GitHub token are asked of the server', async () => {
  const { shell, server } = pair()
  server.handle(SERVER_METHODS.resolveSecretForLaunch, (params) => ({
    ok: true,
    providerId: (params as { cli: string }).cli,
    value: 'sk-test',
    source: 'settings',
  }))
  server.handle(SERVER_METHODS.githubToken, (params) => ((params as { op: string }).op === 'resolve' ? 'ghp_x' : null))
  assert.equal(
    ((await createRemoteCredentialStore(shell).resolveSecret('codex')) as { value: string }).value,
    'sk-test',
  )
  assert.equal(await createRemoteGitHubTokenStore(shell).resolveToken(), 'ghp_x')
  // No server: a resolve is not an error, it is no token.
  shell.close('gone')
  assert.equal(await createRemoteGitHubTokenStore(shell).resolveToken('explicit'), 'explicit')
  assert.equal((await createRemoteCredentialStore(shell).resolveSecret('codex')).ok, false)
})
