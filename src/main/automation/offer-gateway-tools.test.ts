import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { McpConnectionContext, McpToolRegistration } from '../../shared/modules/mcp-tools'
import { RECORDING_LIMITS } from '../browser/browser-recorder'
import { connectionContextOf, gatewayToolDefinitions, gatewayToolTimeoutMs } from './offer-gateway-tools'

const registration = (name: string, seen: McpConnectionContext[] = []): McpToolRegistration => ({
  name,
  description: `${name} does a thing.`,
  inputSchema: { type: 'object' },
  handler: async (_args, context) => {
    if (context) seen.push(context)
    return { content: [{ type: 'text', text: name }] }
  },
})

test('today’s registrations become a toolset with the gateway’s own classification and deadlines', () => {
  const definitions = gatewayToolDefinitions('browser', [
    registration('browser.status'),
    registration('browser.open'),
    registration('browser.wait_for'),
  ])
  assert.deepEqual(
    definitions.map((definition) => [definition.name, definition.mutates, definition.timeoutMs]),
    [
      ['status', false, 20_000],
      ['open', true, 30_000],
      ['wait_for', false, 40_000],
    ],
  )
  const canvas = gatewayToolDefinitions('canvas', [registration('canvas.list'), registration('canvas.import')])
  assert.deepEqual(
    canvas.map((definition) => [definition.name, definition.mutates, definition.timeoutMs]),
    [
      ['list', false, 15_000],
      ['import', true, 90_000],
    ],
  )
  assert.throws(() => gatewayToolDefinitions('browser', [registration('canvas.list')]), /not a browser tool/)
})

test('a recording start is given longer than its own start and stop deadlines', () => {
  const [start] = gatewayToolDefinitions('browser', [registration('browser.record_start')])
  assert.ok(start.timeoutMs !== undefined)
  assert.ok(start.timeoutMs > RECORDING_LIMITS.startTimeoutMs + RECORDING_LIMITS.stopTimeoutMs)
  assert.equal(gatewayToolTimeoutMs('browser.record_start'), start.timeoutMs)
})

test('a handler reads the connection its call came on, as the gateway gave it', async () => {
  const seen: McpConnectionContext[] = []
  const [definition] = gatewayToolDefinitions('browser', [registration('browser.status', seen)])
  const context = {
    connection: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'codex' },
    conversation: { workspaceId: 'ws-1', agentId: 'agent-1' },
  }
  await definition.handler({}, { context } as never)
  assert.deepEqual(seen, [
    { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'codex' } },
  ])
  assert.deepEqual(connectionContextOf({ context: { connection: { kind: 'external-local' } } }), {
    metadata: { kind: 'external-local' },
  })
})
