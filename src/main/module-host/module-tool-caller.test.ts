import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import type { ConversationSessionSummary, ConversationStartSessionInput } from '../../shared/conversation-runtime'
import { emptyAgentLaunchSettings } from '../../shared/launch-settings'
import { toolSuccess, type McpConnectionContext } from '../../shared/modules/mcp-tools'
import { launchPermissionCeiling } from '../automation/launch-permission-cap'
import { createStudioGatewayTools } from '../automation/studio-gateway-tools'
import { createConversationLaunchService } from '../conversation-launch-service'
import { createConversationModuleRegistry, type ModuleConversationWorkspace } from './module-conversation-service'
import { clampToModuleToolCaller, moduleToolCallerCeiling, runAsModuleToolCall } from './module-tool-caller'

// A capped agent must not reach a looser chat through a module's MCP tool: the
// gateway runs the handler as its caller, and the module conversation service
// holds a chat it starts to that caller's preset. Everything between the tool
// call and the chat record is the app's own code.
function harness(agentPresets: Record<string, CliPermissionPreset>) {
  const workspaces: ModuleConversationWorkspace[] = [{ id: 'ws-1', folderPath: '/repo/a', agents: {} }]
  const starts: ConversationStartSessionInput[] = []
  let suffix = 0
  const launch = createConversationLaunchService({
    getWorkspace: (id) => workspaces.find((workspace) => workspace.id === id) ?? null,
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: (workspaceId, agentId, agent) => {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId)!
      if (agent) workspace.agents[agentId] = agent
      else delete workspace.agents[agentId]
      return { ok: true }
    },
    listWorkspaces: () => workspaces,
    createWorkspace: () => ({ ok: false, message: 'unused' }),
    removeWorkspace: () => undefined,
    startSession: async (input) => {
      starts.push(input)
      const session: ConversationSessionSummary = {
        sessionId: `conv_${starts.length}`,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        status: 'ready',
        createdAt: 0,
        updatedAt: 0,
      }
      return { ok: true, session }
    },
    send: async () => ({ ok: true }) as never,
    newAgentSuffix: () => `s${++suffix}`,
  })
  const conversations = createConversationModuleRegistry({
    launch: (request) => launch.launch(request),
    runtime: {
      startSession: async () => ({ ok: false, message: 'unused' }),
      sendTurn: async () => ({ ok: false, message: 'unused' }),
      interrupt: async () => ({ ok: false, message: 'unused' }),
      respondToRequest: async () => ({ ok: false, message: 'unused' }),
      stopSession: async () => ({ ok: false, message: 'unused' }),
      listSessions: () => ({ ok: true, sessions: [] }),
      readTranscript: async () => ({ ok: false, message: 'unused' }),
      onEvent: () => () => undefined,
    },
    getWorkspaceAgents: () => workspaces,
    getModulePermissions: () => ['conversation:operate', 'mcp:tools'],
    getCallerPermissionCeiling: moduleToolCallerCeiling,
  })
  const acme = conversations.forModule('acme')
  const tools = createStudioGatewayTools({
    appTools: [],
    resolveModuleTools: () => [
      {
        moduleId: 'acme',
        moduleDisplayName: 'Acme',
        registration: {
          name: 'acme.start_chat',
          description: 'Starts a chat on bypass.',
          inputSchema: { type: 'object' },
          handler: async () => {
            // Work after an await is still the caller's.
            await new Promise((resolve) => setTimeout(resolve, 1))
            const created = await acme.create({ workspaceId: 'ws-1', cli: 'claude-code', permissionPreset: 'bypass' })
            assert.equal(created.ok, true)
            return toolSuccess({ agentId: created.ok ? created.conversation.agentId : null })
          },
        },
      },
    ],
    isModuleEnabled: () => true,
    callerPermissionCeiling: (context) =>
      launchPermissionCeiling(context, ({ agentId }) => agentPresets[agentId] ?? null),
  })()
  const tool = tools.find((candidate) => candidate.name === 'acme.start_chat')!
  async function call(context?: McpConnectionContext) {
    const result = await tool.handler({}, context)
    const agentId = (result.structuredContent as { agentId: string }).agentId
    return { record: workspaces[0].agents[agentId]!, start: starts.at(-1)! }
  }
  return { call, acme, workspaces, starts }
}

const agent = (agentId: string): McpConnectionContext => ({
  metadata: { kind: 'studio-agent', workspaceId: 'ws-0', agentId },
})

test('module-tool-caller', async () => {
  // A `none` agent's call makes a `none` chat, record and session alike.
  {
    const { call } = harness({ careful: 'none' })
    const { record, start } = await call(agent('careful'))
    assert.equal(record.cliPermissionPreset, 'none')
    assert.equal(start.permissionPreset, 'none')
  }

  // An agent that names itself and cannot be found is capped at the strictest
  // preset, `manual`.
  {
    const { call } = harness({})
    const { record } = await call(agent('nobody-holds-this'))
    assert.equal(record.cliPermissionPreset, 'manual')
  }

  // A `bypass` agent, the person's own script, and a paired device are not capped.
  {
    const { call } = harness({ bold: 'bypass' })
    assert.equal((await call(agent('bold'))).record.cliPermissionPreset, 'bypass')
    assert.equal((await call(undefined)).record.cliPermissionPreset, 'bypass')
    assert.equal((await call({ metadata: { kind: 'external-local' } })).record.cliPermissionPreset, 'bypass')
    assert.equal(
      (await call({ metadata: { kind: 'remote-tailnet', deviceId: 'dev-1' } })).record.cliPermissionPreset,
      'bypass',
    )
  }

  // The module's own work, outside any tool call, starts what it asks for.
  {
    const { acme, workspaces } = harness({ careful: 'none' })
    const created = await acme.create({ workspaceId: 'ws-1', cli: 'claude-code', permissionPreset: 'bypass' })
    assert.equal(created.ok, true)
    if (created.ok) assert.equal(workspaces[0].agents[created.conversation.agentId]!.cliPermissionPreset, 'bypass')
  }

  // The clamp: lowered, never raised, and pinned when the module names none.
  assert.equal(clampToModuleToolCaller('bypass', 'none'), 'none')
  assert.equal(clampToModuleToolCaller('none', 'bypass'), 'none')
  assert.equal(clampToModuleToolCaller(undefined, 'none'), 'none')
  assert.equal(clampToModuleToolCaller(undefined, 'bypass'), undefined)
  assert.equal(clampToModuleToolCaller('bypass', null), 'bypass')
  assert.equal(
    runAsModuleToolCall({ permissionCeiling: 'none' }, () => clampToModuleToolCaller('bypass')),
    'none',
  )
  assert.equal(moduleToolCallerCeiling(), null)
})
