import assert from 'node:assert/strict'
import { test } from 'vitest'

import { conversationWorkingRoot, type AgentState } from '../shared/agent-state'
import type {
  ConversationSessionActionResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationSessionSummary,
} from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings, type AgentLaunchSettings } from '../shared/launch-settings'
import { SOLO_CHAT_AGENT_ID } from '../shared/layouts/templates'
import {
  emptyWorkspaceRegistryFile,
  normalizeWorkspaceForRegistry,
  toWorkspaceRegistryRecord,
} from '../shared/workspace-registry'
import { isDefaultWorkspaceName } from '../shared/workspace-title'
import type { Workspace } from '../renderer/src/types/workspace'
import {
  createConversationLaunchService,
  type ConversationLaunchServiceDeps,
  type ConversationLaunchWorkspace,
} from './conversation-launch-service'
import { createWorkspaceRegistryService } from './workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from './workspace-registry-store'
import { createWorkspaceSyncService } from './workspace-sync-service'

type Harness = {
  writes: Array<{ workspaceId: string; agentId: string; agent: AgentState | null }>
  starts: ConversationStartSessionInput[]
  sends: Array<Parameters<ConversationLaunchServiceDeps['send']>[0]>
  installs: Array<{ workingRoot: string; skillId: string }>
  warnings: string[]
}

function harness(
  overrides: Partial<ConversationLaunchServiceDeps> & {
    workspace?: ConversationLaunchWorkspace | null
    settings?: Partial<AgentLaunchSettings>
  } = {},
) {
  const record: Harness = { writes: [], starts: [], sends: [], installs: [], warnings: [] }
  const workspace =
    overrides.workspace === undefined
      ? { id: 'ws-1', folderPath: '/repo/a', agents: { 'agent-1': { name: 'Ada' } } }
      : overrides.workspace
  const service = createConversationLaunchService({
    getWorkspace: (id) => (workspace && workspace.id === id ? workspace : null),
    getLaunchSettings: () => ({ ...emptyAgentLaunchSettings(), ...overrides.settings }),
    writeAgent: (workspaceId, agentId, agent) => {
      record.writes.push({ workspaceId, agentId, agent })
      return { ok: true }
    },
    listWorkspaces: () => (workspace ? [workspace] : []),
    createWorkspace: () => ({ ok: false, message: 'not in this test' }),
    removeWorkspace: () => undefined,
    startSession: async (input) => {
      record.starts.push(input)
      return {
        ok: true,
        session: {
          sessionId: 'conv_1',
          workspaceId: input.workspaceId,
          agentId: input.agentId,
        } as ConversationSessionSummary,
      }
    },
    send: async (input) => {
      record.sends.push(input)
      return { ok: true } as ConversationSessionActionResult
    },
    ensureSkillInstalled: async (workingRoot, skillId) => {
      record.installs.push({ workingRoot, skillId })
      return skillId === 'no-such-skill'
        ? { ok: false, status: 'unknown-skill', message: `Unknown skill: ${skillId}` }
        : { ok: true, status: 'installed' }
    },
    warn: (message) => record.warnings.push(message),
    newAgentSuffix: () => 'abc123',
    newCommandId: () => 'cmd-1',
    ...overrides,
  })
  return { service, record }
}

test('a chat launch writes a conversation agent, starts its session and sends the prompt', async () => {
  const { service, record } = harness()
  const result = await service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    cliModel: 'opus',
    permissionPreset: 'none',
    prompt: '  fix the build  ',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.agentId, 'agent-claude-code-abc123')
  assert.equal(result.sessionId, 'conv_1')
  assert.equal(result.modelId, 'opus')

  assert.equal(record.writes.length, 1)
  const agent = record.writes[0]!.agent!
  assert.equal(agent.runtimeKind, 'conversation')
  assert.deepEqual(agent.conversation, { providerId: result.providerId, modelId: 'opus' })
  assert.equal(agent.cliPermissionPreset, 'none')
  // Main sends the prompt itself; a mounting chat view must not send it again.
  assert.equal(agent.chatStartupPrompt, undefined)
  assert.notEqual(agent.name, 'Ada', 'the name is not one the workspace already uses')

  assert.deepEqual(record.starts[0], {
    workspaceRoot: '/repo/a',
    workspaceId: 'ws-1',
    agentId: 'agent-claude-code-abc123',
    providerId: result.providerId,
    modelId: 'opus',
    permissionPreset: 'none',
  })
  await Promise.resolve()
  assert.deepEqual(record.sends, [{ sessionId: 'conv_1', commandId: 'cmd-1', message: 'fix the build' }])
})

test('an unnamed CLI, model and preset take what the launcher here would', async () => {
  const { service, record } = harness({
    settings: { lastSelectedCli: 'codex', cliPermissionPresets: { codex: 'none' } },
  })
  const result = await service.launch({ workspaceId: 'ws-1' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.cli, 'codex')
  assert.equal(result.modelId, 'default')
  assert.equal(record.starts[0]!.permissionPreset, 'none')
  assert.deepEqual(record.sends, [], 'no prompt, no first message')
})

test('a CLI with no chat provider is refused before anything is written', async () => {
  const { service, record } = harness()
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'not-a-chat-cli' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'cli_not_conversational')
  assert.deepEqual(record.writes, [])
  assert.deepEqual(record.starts, [])
})

test('an unknown workspace, or one with no folder, is refused', async () => {
  const unknown = await harness().service.launch({ workspaceId: 'nope', cli: 'claude' })
  assert.equal(!unknown.ok && unknown.code, 'unknown_workspace')
  const folderless = await harness({ workspace: { id: 'ws-1', folderPath: null } }).service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
  })
  assert.equal(!folderless.ok && folderless.code, 'workspace_folder_missing')
})

test('a session that cannot start takes its agent record back out', async () => {
  const { service, record } = harness({
    startSession: async (): Promise<ConversationStartSessionResult> => ({ ok: false, message: 'CLI not installed' }),
  })
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', prompt: 'hi' })
  assert.deepEqual(result, { ok: false, code: 'conversation_start_failed', message: 'CLI not installed' })
  assert.deepEqual(
    record.writes.map((write) => [write.agentId, write.agent === null]),
    [
      ['agent-claude-code-abc123', false],
      ['agent-claude-code-abc123', true],
    ],
  )
  assert.deepEqual(record.sends, [])
})

test('a refused first message is reported, and the launch still stands', async () => {
  const { service, record } = harness({
    send: async () => ({ ok: false, message: 'busy' }) as ConversationSessionActionResult,
  })
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', prompt: 'hi' })
  assert.equal(result.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(record.warnings.length, 1)
  assert.match(record.warnings[0]!, /busy/)
})

/** The launch wired to a real registry and bus, as app-services wires it, around one chat in a worktree. */
function registryHarness(startSession?: ConversationLaunchServiceDeps['startSession']) {
  const existing: Workspace = {
    id: 'ws-old',
    name: 'Fix the flaky login test',
    titleLocked: true,
    mode: 'standard',
    folderPath: '/Users/dev/.worktrees/app/login-fix',
    hostId: 'wsl:Ubuntu',
    worktree: { branch: 'agent/login-fix', repoRoot: '/Users/dev/app' },
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  }
  let ids = 0
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore({
      ...emptyWorkspaceRegistryFile(1),
      revision: 1,
      workspaces: [
        toWorkspaceRegistryRecord(existing, 1),
        toWorkspaceRegistryRecord({ ...existing, id: 'ws-two', name: 'Chat' }, 1),
      ],
    }),
    now: () => 1000,
    newWorkspaceId: () => `ws-new-${++ids}`,
  })
  const sync = createWorkspaceSyncService({ registry, now: () => 1000 })
  const writes: string[] = []
  const service = createConversationLaunchService({
    getWorkspace: (id) => registry.getRecord(id),
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: (workspaceId, agentId, agent) => {
      writes.push(agentId)
      return sync.updateWorkspaceAgent(workspaceId, agentId, agent, 'system')
    },
    listWorkspaces: () => registry.getRecords(),
    createWorkspace: (request) => {
      const created = sync.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => {
      sync.removeWorkspace(workspaceId, 'system')
    },
    startSession:
      startSession ??
      (async (input) => ({
        ok: true,
        session: {
          sessionId: 'conv_1',
          workspaceId: input.workspaceId,
          agentId: input.agentId,
        } as ConversationSessionSummary,
      })),
    send: async () => ({ ok: true }) as ConversationSessionActionResult,
    newCommandId: () => 'cmd-1',
  })
  return { service, registry, writes }
}

test('a new chat is born in a workspace of its own, in the named workspace’s folder, titled by its first message', async () => {
  const { service, registry, writes } = registryHarness()
  const result = await service.launch({ workspaceId: 'ws-old', newChat: true, cli: 'claude-code', prompt: 'hi' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.notEqual(result.workspaceId, 'ws-old')
  assert.equal(result.agentId, SOLO_CHAT_AGENT_ID)
  assert.deepEqual(writes, [], 'nothing is added to the chat the workspace already was')
  assert.deepEqual(Object.keys(registry.getRecord('ws-old')?.agents ?? {}), [])

  const created = registry.getRecord(result.workspaceId)!
  assert.equal(created.folderPath, '/Users/dev/.worktrees/app/login-fix')
  assert.equal(created.hostId, 'wsl:Ubuntu')
  assert.deepEqual(created.worktree, { branch: 'agent/login-fix', repoRoot: '/Users/dev/app' })
  // Named as New chat names one beside the folder's others, and left open for
  // the first message to title.
  assert.equal(created.name, 'Chat 2')
  assert.equal(isDefaultWorkspaceName(created.name), true)
  assert.equal(created.titleLocked, undefined)
  // The layout's one agent tab is the chat's agent, from the first event.
  assert.match(JSON.stringify(created.layoutModel), new RegExp(`"agentId":"${SOLO_CHAT_AGENT_ID}"`))
  assert.deepEqual(Object.keys(created.agents), [SOLO_CHAT_AGENT_ID])
  assert.equal(created.agents[SOLO_CHAT_AGENT_ID]?.runtimeKind, 'conversation')
  assert.equal(created.agents[SOLO_CHAT_AGENT_ID]?.name, result.name)
})

test('a new chat whose session cannot start takes its whole workspace back out', async () => {
  const { service, registry } = registryHarness(async () => ({ ok: false, message: 'CLI not installed' }))
  const before = registry.getRecords().map((record) => record.id)
  const result = await service.launch({ workspaceId: 'ws-old', newChat: true, cli: 'claude-code' })
  assert.deepEqual(result, { ok: false, code: 'conversation_start_failed', message: 'CLI not installed' })
  assert.deepEqual(
    registry.getRecords().map((record) => record.id),
    before,
  )
})

test('skills are installed in the working root, attached to the first message and kept as the chat\'s chips', async () => {
  const { service, record } = harness()
  const result = await service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    prompt: 'triage',
    skills: ['backlog', ' backlog ', 'review'],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(record.installs, [
    { workingRoot: '/repo/a', skillId: 'backlog' },
    { workingRoot: '/repo/a', skillId: 'review' },
  ])
  assert.deepEqual(record.writes[0]!.agent!.conversationSkills, ['backlog', 'review'])
  await Promise.resolve()
  assert.deepEqual(record.sends[0]!.skills, [{ id: 'backlog' }, { id: 'review' }])
})

test('an unknown skill refuses the launch before anything is written', async () => {
  const { service, record } = harness()
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', skills: ['no-such-skill'] })
  assert.equal(!result.ok && result.code, 'unknown_skill')
  assert.deepEqual(record.writes, [])
  assert.deepEqual(record.starts, [])
})

test('a skill copy that could not be written is reported, and the launch goes on', async () => {
  const { service, record } = harness({
    ensureSkillInstalled: async () => ({ ok: false, status: 'install-failed', message: 'disk full' }),
  })
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', skills: ['backlog'] })
  assert.equal(result.ok, true)
  assert.match(record.warnings[0]!, /disk full/)
})

test('the owning module is stamped on the chat record', async () => {
  const { service, record } = harness()
  await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', ownerModuleId: 'acme.reviews' })
  assert.equal(record.writes[0]!.agent!.ownerModuleId, 'acme.reviews')
  const { service: own, record: ownRecord } = harness()
  await own.launch({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.equal(ownRecord.writes[0]!.agent!.ownerModuleId, undefined, "a chat nobody's module started has no owner")
})

test('a worktree launch starts the session in the worktree and records where it runs', async () => {
  const { service, record } = harness()
  const result = await service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    worktreePath: '/repo/a/.sprintengine/automations/worktrees/run-1',
    skills: ['backlog'],
  })
  assert.equal(result.ok, true)
  assert.equal(record.starts[0]!.workspaceRoot, '/repo/a/.sprintengine/automations/worktrees/run-1')
  assert.equal(record.installs[0]!.workingRoot, '/repo/a/.sprintengine/automations/worktrees/run-1')
  assert.deepEqual(record.writes[0]!.agent!.execution, {
    mode: 'worktree',
    worktreeId: null,
    cwd: '/repo/a/.sprintengine/automations/worktrees/run-1',
  })
  assert.equal(conversationWorkingRoot(record.writes[0]!.agent, '/repo/a'), record.starts[0]!.workspaceRoot)
})

test('sendFirst false starts the session and sends nothing', async () => {
  const { service, record } = harness()
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', prompt: 'hi', sendFirst: false })
  assert.equal(result.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(record.sends, [])
})

test('pictures ride the first message, and a failed first message reaches the caller', async () => {
  const failures: string[] = []
  const { service, record } = harness({
    send: async (input) => {
      record.sends.push(input)
      throw new Error('provider went away')
    },
  })
  const attachment = { id: 'img-1', mediaType: 'image/png', dataBase64: 'AA==', byteLength: 1 }
  await service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    prompt: 'what is this',
    attachments: [attachment],
    onFirstSendFailed: (message) => failures.push(message),
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(record.sends[0]!.attachments, [attachment])
  assert.equal(failures.length, 1)
  assert.match(failures[0]!, /provider went away/)
})

test('the owner survives the registry normalisation every window and restart goes through', async () => {
  const { service, record } = harness()
  await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', ownerModuleId: 'acme.reviews' })
  const agent = record.writes[0]!.agent!
  const workspace = normalizeWorkspaceForRegistry({
    id: 'ws-1',
    agents: { [agent.id]: agent },
  } as unknown as Workspace)
  assert.equal(workspace.agents[agent.id]!.ownerModuleId, 'acme.reviews')
  assert.equal(JSON.parse(JSON.stringify(workspace)).agents[agent.id].ownerModuleId, 'acme.reviews')
})
