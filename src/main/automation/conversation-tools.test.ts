import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import { CONVERSATION_MUTATION_TOOL_NAMES, createConversationTools } from './conversation-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { requiredScopeForTool } from './tailnet/tailnet-scopes'

function tool(launch: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>) {
  const [registration] = createConversationTools({ launch })
  assert.equal(registration?.name, 'conversation.create')
  return registration!
}

test('starting a chat is an audited mutation needing conversation:operate', () => {
  assert.deepEqual([...CONVERSATION_MUTATION_TOOL_NAMES], ['conversation.create'])
  assert.equal(isStudioGatewayMutation('conversation.create'), true)
  assert.equal(requiredScopeForTool('conversation.create', true), 'conversation:operate')
})

test('conversation.create forwards the launch and answers with the ids a pane follows', async () => {
  const requests: ConversationLaunchRequest[] = []
  const handler = tool(async (request) => {
    requests.push(request)
    return {
      ok: true,
      workspaceId: 'ws-1',
      agentId: 'agent-codex-1',
      name: 'Ada',
      cli: 'codex',
      providerId: 'codex-agent',
      modelId: 'default',
      sessionId: 'conv_1',
    }
  }).handler
  const result = await handler({ workspaceId: ' ws-1 ', cli: 'codex', prompt: 'hi', permissionPreset: 'bypass_all' })
  assert.deepEqual(requests, [{ workspaceId: 'ws-1', cli: 'codex', prompt: 'hi', permissionPreset: 'bypass' }])
  assert.equal(result.isError, undefined)
  assert.deepEqual((result.structuredContent as { conversation: unknown }).conversation, {
    workspaceId: 'ws-1',
    agentId: 'agent-codex-1',
    name: 'Ada',
    cli: 'codex',
    providerId: 'codex-agent',
    modelId: 'default',
    sessionId: 'conv_1',
  })
})

test('conversation.create refuses bad arguments and passes a launch refusal through', async () => {
  let launched = 0
  const handler = tool(async () => {
    launched += 1
    return { ok: false, code: 'cli_not_conversational', message: 'no chat' }
  }).handler
  const missing = await handler({})
  assert.equal((missing.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  const badPreset = await handler({ workspaceId: 'ws-1', permissionPreset: 'yolo' })
  assert.equal((badPreset.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  assert.equal(launched, 0)
  const refused = await handler({ workspaceId: 'ws-1', cli: 'kimi-code' })
  assert.equal(refused.isError, true)
  assert.deepEqual((refused.structuredContent as { error: unknown }).error, {
    code: 'cli_not_conversational',
    message: 'no chat',
  })
})
