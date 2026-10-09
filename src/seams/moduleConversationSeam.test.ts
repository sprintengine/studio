import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, vi } from 'vitest'

import { getConversationService, type ModuleConversationService } from '../../packages/module-sdk/src/conversation'
import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import type { CapabilityManifest } from '../shared/modules/manifest'
import type { ModuleConversationEvent } from '../shared/modules/conversation-service'
import { toolSuccess, type McpConnectionContext } from '../shared/modules/mcp-tools'
import { emptyWorkspaceRegistryFile, toWorkspaceRegistryRecord } from '../shared/workspace-registry'
import type { Workspace } from '../renderer/src/types/workspace'
import { launchPermissionCeiling } from '../main/automation/launch-permission-cap'
import { createStudioGatewayTools } from '../main/automation/studio-gateway-tools'
import { createConversationLaunchService } from '../main/conversation-launch-service'
import { ConversationRuntime } from '../main/conversation-runtime'
import { createFakeIpcMain } from '../main/module-host/ipc-main-fake.test-helper'
import { loadMainModules } from '../main/module-host/load-modules'
import { createAgentRuntimeModule } from '../main/modules/agent-runtime-module'
import { createWorkspaceRegistryService } from '../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../main/workspace-sync-service'
import { createNodeStudioPaths } from '../server/platform/studio-paths'
import { createSecretCipherStandIn } from '../../tests/stubs/secret-cipher'

vi.mock('electron', () => import('../../tests/stubs/electron'))

// ── Seam: a third-party module and the chats it reaches ─────────────────────
//
// Each side is tested on its own: the SDK's getConversationService against a
// fake registry, the module conversation service against a fake runtime, the
// ACL against a bare kernel. What none of them shows is that a module loaded
// the way the app loads one — third-party, through the kernel, reaching the
// service the agent runtime provides through the SDK's own helper — ends up on
// the real launch service, the real conversation runtime and the real
// workspace bus, and still sees only its own chats. This suite wires exactly
// that, with a stand-in provider as the only fake:
//
//   fixture module ─ getConversationService(host) ─ kernel ACL ─ agent-runtime-module
//     ─ module conversation service ─ ConversationLaunchService ─ ConversationRuntime
//     ─ workspace sync (the chat record, its owner) ─ runtime events back to the module
//
// It also runs a module MCP tool through the gateway's own tool list, so a
// capped agent's call starts a chat no looser than that agent.

test('moduleConversationSeam', async () => {
  const root = await mkdtemp(join(tmpdir(), 'module-conversation-seam-'))
  const folders = { a: join(root, 'a'), b: join(root, 'b') }
  await mkdir(folders.a, { recursive: true })
  await mkdir(folders.b, { recursive: true })

  // ── The app half ──────────────────────────────────────────────────────────

  const workspace = (id: string, folderPath: string): Workspace => ({
    id,
    name: id,
    mode: 'standard',
    folderPath,
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  })
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore({
      ...emptyWorkspaceRegistryFile(1),
      revision: 1,
      workspaces: [
        toWorkspaceRegistryRecord(workspace('ws-a', folders.a), 1),
        toWorkspaceRegistryRecord(workspace('ws-b', folders.b), 1),
      ],
    }),
    now: () => 1000,
  })
  const sync = createWorkspaceSyncService({ registry, now: () => 1000 })

  // The one stand-in: a stateful provider on Claude Code's id, answering each
  // turn with an echo, so the runtime's own events are what the module hears.
  const event = (
    base: { sessionId: string; workspaceId: string; agentId: string; providerId: string; modelId: string },
    type: ConversationEventType,
    payload: Record<string, unknown> = {},
  ): ConversationEvent => ({ id: '', ...base, type, createdAt: 0, payload })
  const runtime = new ConversationRuntime({
    getProviderById: () => undefined,
    secretStore: {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    },
    adapters: [
      {
        id: 'claude-agent',
        displayName: 'Claude Code',
        sessions: 'stateful',
        listModels: () => ['default', 'sonnet'],
        startSession: (input) => [event(input, 'session_started'), event(input, 'session_ready')],
        async *sendTurn(input) {
          yield event(input, 'turn_started', { turnId: input.turnId })
          yield event(input, 'content_delta', { turnId: input.turnId, text: `re: ${input.message}` })
          yield event(input, 'turn_completed', { turnId: input.turnId })
        },
        resolveApproval: () => [],
        setPermissionPreset: async () => ({ ok: true }),
        interrupt: () => [],
        stopSession: (input) => [event(input, 'session_closed')],
      },
    ],
  })
  // As app-services wires it.
  const launchService = createConversationLaunchService({
    getWorkspace: (id) => registry.getRecord(id),
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: (workspaceId, agentId, agent) => sync.updateWorkspaceAgent(workspaceId, agentId, agent, 'system'),
    listWorkspaces: () => registry.getRecords(),
    createWorkspace: (request) => {
      const created = sync.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => sync.removeWorkspace(workspaceId, 'system'),
    startSession: (input) => runtime.startSession(input),
    send: (input) => runtime.sendTurn(input),
  })
  const services = {
    conversationLaunchService: launchService,
    conversationRuntime: runtime,
    conversations: runtime,
    workspaceSyncService: sync,
    agentLaunchSettings: { get: () => emptyAgentLaunchSettings() },
    githubTokenStore: { resolveToken: async () => '' },
  }

  // ── The module half: two third-party modules, loaded as the app loads one ──

  const thirdParty = (id: string, permissions: string[]): CapabilityManifest => ({
    id,
    displayName: id,
    version: 1,
    defaultEnabled: true,
    source: 'third-party',
    engines: { hostApi: 1 },
    // As the SDK's docs tell a module that uses a chat service: the agent
    // runtime provides it, so it loads first.
    dependsOn: ['agent-runtime'],
    permissions,
  })
  // acme may run its chats on bypass; the other module goes no looser than auto.
  const acmeManifest = thirdParty('acme-chat', ['conversation:operate', 'conversation:bypass', 'mcp:tools'])
  const otherManifest = thirdParty('other-chat', ['conversation:operate'])
  const modules: Record<string, ModuleConversationService> = {}
  const manifests = new Map([acmeManifest, otherManifest].map((manifest) => [manifest.id, manifest]))
  const agentRuntime = createAgentRuntimeModule(services as never, {
    getModulePermissions: (id) => manifests.get(id)?.permissions,
    // Module storage in the suite's own directory, and a cipher that, honestly,
    // cannot encrypt here.
    platform: {
      paths: createNodeStudioPaths({ dataDir: join(root, 'user-data'), packaged: false }),
      secrets: createSecretCipherStandIn({ value: false }),
    },
  })
  const load = loadMainModules({
    ipcMain: createFakeIpcMain().ipcMain,
    modules: [
      agentRuntime,
      {
        manifest: acmeManifest,
        registerMain(host) {
          modules.acme = getConversationService(host as never)
          // A tool that starts a bypass chat for whoever calls it.
          host.registerMcpTools([
            {
              name: 'acme.start_chat',
              description: 'Starts a chat.',
              inputSchema: { type: 'object' },
              handler: async () => {
                const created = await modules.acme!.create({
                  workspaceId: 'ws-a',
                  cli: 'claude-code',
                  permissionPreset: 'bypass',
                })
                return toolSuccess(created.ok ? { agentId: created.conversation.agentId } : { error: created.code })
              },
            },
          ])
        },
      },
      {
        manifest: otherManifest,
        registerMain(host) {
          modules.other = getConversationService(host as never)
        },
      },
    ],
  })
  await load.ready
  assert.deepEqual(load.report.errors, [])
  const acme = modules.acme!
  const other = modules.other!
  const agentRecord = (workspaceId: string, agentId: string) =>
    sync.getSnapshot().state.workspaces.find((candidate) => candidate.id === workspaceId)?.agents[agentId]

  try {
    // A module creates a chat: a real record on the bus, stamped with its owner.
    const created = await acme.create({ workspaceId: 'ws-a', cli: 'claude-code', name: 'Acme helper' })
    assert.equal(created.ok, true, JSON.stringify(created))
    if (!created.ok) return
    const mine = { workspaceId: created.conversation.workspaceId, agentId: created.conversation.agentId }
    assert.equal(agentRecord(mine.workspaceId, mine.agentId)?.ownerModuleId, 'acme-chat')
    assert.equal(created.conversation.cli, 'claude-code')

    // It subscribes and hears its own turn, as the runtime emitted it.
    const heard: ModuleConversationEvent[] = []
    const unsubscribe = acme.subscribe(mine, (received) => heard.push(received))
    const sent = await acme.send(mine, { message: 'hello' })
    assert.deepEqual(sent, { ok: true })
    assert.ok(
      heard.some((received) => received.type === 'content_delta' && received.payload?.text === 're: hello'),
      `the module hears its turn: ${heard.map((received) => received.type).join(', ')}`,
    )
    assert.ok(heard.every((received) => received.agentId === mine.agentId))
    assert.deepEqual(
      acme.list().map((summary) => summary.agentId),
      [mine.agentId],
    )
    const transcript = await acme.transcript(mine)
    assert.equal(transcript.ok, true)

    // The person's own chat (no owner), started through the same launch service.
    const users = await launchService.launch({ workspaceId: 'ws-b', cli: 'claude-code', prompt: 'mine alone' })
    assert.equal(users.ok, true)
    if (!users.ok) return
    const userChat = { workspaceId: users.workspaceId, agentId: users.agentId }
    assert.equal(agentRecord(userChat.workspaceId, userChat.agentId)?.ownerModuleId, undefined)

    // Another module's chat.
    const others = await other.create({ workspaceId: 'ws-b', cli: 'claude-code' })
    assert.equal(others.ok, true)
    if (!others.ok) return
    const otherChat = { workspaceId: others.conversation.workspaceId, agentId: others.conversation.agentId }

    // Neither is reachable: not listed, not sendable, not readable, and
    // answered exactly as a chat that does not exist. A subscription to one
    // is accepted, as one to a saved chat not loaded yet is, and hears
    // nothing, ever.
    const leaked: unknown[] = []
    const foreignSubscriptions: Array<() => void> = []
    for (const foreign of [userChat, otherChat]) {
      assert.ok(!acme.list().some((summary) => summary.agentId === foreign.agentId))
      foreignSubscriptions.push(acme.subscribe(foreign, (event) => leaked.push(event)))
      const refused = await acme.send(foreign, { message: 'let me in' })
      assert.equal(refused.ok, false)
      if (!refused.ok) assert.equal(refused.code, 'not_owned')
      const read = await acme.transcript(foreign)
      assert.equal(read.ok, false)
      if (!read.ok) assert.equal(read.code, 'not_owned')
      for (const call of [acme.stop(foreign), acme.interrupt(foreign)]) {
        const answer = await call
        assert.equal(answer.ok, false)
      }
    }
    const nowhere = await acme.send({ workspaceId: 'ws-b', agentId: 'no-such-chat' }, { message: 'x' })
    assert.equal(
      nowhere.ok ? '' : nowhere.message.replace('no-such-chat', '<id>'),
      'No conversation "<id>" in workspace "ws-b" was started by this module.',
    )

    // And the other module's traffic never reaches this module's subscription.
    const before = heard.length
    await other.send(otherChat, { message: 'private' })
    assert.equal(heard.length, before)
    assert.ok(!heard.some((received) => received.payload?.text === 're: private'))
    assert.deepEqual(leaked, [], 'a subscription to a chat the module does not own hears none of it')
    unsubscribe()
    for (const stop of foreignSubscriptions) stop()

    // A module without conversation:bypass asking for it gets auto, on the live
    // session and on the record the bus carries, and cannot switch a chat it
    // does not own.
    assert.deepEqual(await other.setPermissionPreset(otherChat, 'bypass'), { ok: true, permissionPreset: 'auto' })
    assert.equal(agentRecord(otherChat.workspaceId, otherChat.agentId)?.cliPermissionPreset, 'auto')
    const otherSessions = runtime.listSessions({ agentId: otherChat.agentId })
    assert.equal(otherSessions.ok && otherSessions.sessions[0]?.permissionPreset, 'auto')
    const foreignSwitch = await other.setPermissionPreset(mine, 'manual')
    assert.equal(!foreignSwitch.ok && foreignSwitch.code, 'not_owned')

    // A third-party host reaches the chat launch only through the module service.
    assert.throws(
      () => load.kernel.hostFor('acme-chat').getService({ key: 'core.conversation-launch' } as never),
      /not available to third-party modules/,
    )

    // A capped agent calling the module's tool gets a chat no looser than itself.
    const tools = createStudioGatewayTools({
      appTools: [],
      resolveModuleTools: () => load.kernel.mcpToolRegistrations(),
      isModuleEnabled: () => true,
      callerPermissionCeiling: (context) =>
        launchPermissionCeiling(context, ({ agentId }) => (agentId === 'careful-agent' ? 'none' : null)),
    })()
    const tool = tools.find((candidate) => candidate.name === 'acme.start_chat')!
    const capped: McpConnectionContext = {
      metadata: { kind: 'studio-agent', workspaceId: 'ws-a', agentId: 'careful-agent' },
    }
    const called = await tool.handler({}, capped)
    const cappedChat = (called.structuredContent as { agentId: string }).agentId
    assert.equal(agentRecord('ws-a', cappedChat)?.cliPermissionPreset, 'none')
    assert.equal(
      runtime.listSessions({ agentId: cappedChat }).ok &&
        (runtime.listSessions({ agentId: cappedChat }) as { sessions: Array<{ permissionPreset?: string }> })
          .sessions[0]?.permissionPreset,
      'none',
    )
    const uncalled = await tool.handler({}, undefined)
    assert.equal(
      agentRecord('ws-a', (uncalled.structuredContent as { agentId: string }).agentId)?.cliPermissionPreset,
      'bypass',
    )
  } finally {
    await load.kernel.runShutdown()
    await runtime.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
