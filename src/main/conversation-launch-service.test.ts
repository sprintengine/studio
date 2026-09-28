import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentState } from '../shared/agent-state'
import type {
  ConversationSessionActionResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationSessionSummary,
} from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings, type AgentLaunchSettings } from '../shared/launch-settings'
import {
  createConversationLaunchService,
  type ConversationLaunchServiceDeps,
  type ConversationLaunchWorkspace,
} from './conversation-launch-service'

type Harness = {
  writes: Array<{ workspaceId: string; agentId: string; agent: AgentState | null }>
  starts: ConversationStartSessionInput[]
  sends: Array<{ sessionId: string; commandId: string; message: string }>
  warnings: string[]
}

function harness(
  overrides: Partial<ConversationLaunchServiceDeps> & {
    workspace?: ConversationLaunchWorkspace | null
    settings?: Partial<AgentLaunchSettings>
  } = {},
) {
  const record: Harness = { writes: [], starts: [], sends: [], warnings: [] }
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
