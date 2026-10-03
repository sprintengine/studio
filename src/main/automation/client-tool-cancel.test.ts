import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { McpConnectionContext, McpToolRegistration } from '../../shared/modules/mcp-tools'
import { bindGatewayConversation } from '../../server/tools/client-tool-gateway'
import { cancelClientCallsAtTurnEnd } from '../../server/tools/client-tool-turns'
import { createClientToolLoop, type ClientToolLoop } from './client-tool-loop.test-helper'

// Parity test 7 of the client-tools spec (11.2): interrupting a turn while a
// client tool runs answers the agent `cancelled` and sends the client its
// cancel, through the whole loop and without the agent's CLI cancelling.

const loops: ClientToolLoop[] = []
afterEach(async () => {
  for (const loop of loops.splice(0)) await loop.close()
})

test('an interrupted turn cancels the client tool it was waiting on, in the client too', async () => {
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const waits: McpToolRegistration = {
    name: 'browser.wait_for',
    description: 'Waits.',
    inputSchema: { type: 'object' },
    handler: () => new Promise(() => started()),
  }
  const loop = await createClientToolLoop({ toolsets: [{ name: 'browser', registrations: [waits] }] })
  loops.push(loop)
  const context: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'chat-1' } }
  bindGatewayConversation(context, { workspaceId: 'ws-1', agentId: 'chat-1' })
  const answer = loop.call('browser.wait_for', {}, context)
  await running
  // A turn that completed is no reason to cancel; one that ended early is.
  assert.equal(
    cancelClientCallsAtTurnEnd(loop.registry, { type: 'turn_completed', workspaceId: 'ws-1', agentId: 'chat-1' }),
    0,
  )
  assert.equal(
    cancelClientCallsAtTurnEnd(loop.registry, { type: 'turn_failed', workspaceId: 'ws-1', agentId: 'chat-2' }),
    0,
  )
  assert.equal(
    cancelClientCallsAtTurnEnd(loop.registry, { type: 'turn_failed', workspaceId: 'ws-1', agentId: 'chat-1' }),
    1,
  )
  const result = await answer
  assert.equal(result.isError, true)
  assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /^cancelled/)
  // The handler's own signal is the SDK's to abort (packages/agent-sdk/test/tools.test.ts);
  // a built-in's handler takes none, so here the agent's answer is what is proved.
})
