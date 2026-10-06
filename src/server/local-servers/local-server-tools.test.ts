import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { localOnlyGatewayToolReason } from '../../main/automation/tailnet/tailnet-scopes'
import type { LocalServerLinkOutcome } from './local-server-domain'
import type { LocalServerConversationKey, LocalServerLinkInput } from './local-server-record'
import { createLocalServerTools, LOCAL_SERVER_LINK_TOOL } from './local-server-tools'

const AGENT: McpConnectionContext = {
  metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'claude-code' },
}

function toolOver(state: 'running' | 'stopped' = 'running') {
  const calls: Array<{ key: LocalServerConversationKey; input: LocalServerLinkInput }> = []
  const [tool] = createLocalServerTools({
    link: async (key, input): Promise<LocalServerLinkOutcome> => {
      calls.push({ key, input })
      return {
        ok: true,
        created: true,
        server: {
          id: 'srv-1',
          agentId: key.agentId,
          url: input.url,
          title: input.title ?? 'localhost:5173',
          port: 5173,
          state,
          linkedAt: 1,
          stateAt: 2,
        },
      }
    },
  })
  return { tool: tool!, calls }
}

const errorCode = (result: { structuredContent?: Record<string, unknown> }) =>
  (result.structuredContent?.error as { code: string } | undefined)?.code

test('local_server.link records under the calling agent and answers with the checked state', async () => {
  const { tool, calls } = toolOver('stopped')
  assert.equal(tool.name, LOCAL_SERVER_LINK_TOOL)
  assert.equal(tool.mutates, true, 'it writes the record, so it is audited')
  const result = await tool.handler(
    { url: ' http://localhost:5173/ ', title: ' Web ', command: ' npm run dev ', cwd: '/Users/dev/app' },
    AGENT,
  )
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls, [
    {
      key: { workspaceId: 'ws-1', agentId: 'agent-1' },
      input: { url: 'http://localhost:5173/', title: 'Web', command: 'npm run dev', cwd: '/Users/dev/app' },
    },
  ])
  assert.deepEqual(result.structuredContent, {
    linked: true,
    server: { id: 'srv-1', url: 'http://localhost:5173/', title: 'Web', state: 'stopped' },
  })
  // The schema takes no conversation: there is nothing to claim another's with.
  assert.deepEqual(Object.keys((tool.inputSchema as { properties: object }).properties).sort(), [
    'command',
    'cwd',
    'title',
    'url',
  ])
})

test('local_server.link refuses whatever is not an agent Studio started', async () => {
  const { tool, calls } = toolOver()
  for (const context of [
    undefined,
    { metadata: { kind: 'external-local' as const } },
    { metadata: { kind: 'remote-tailnet' as const, deviceId: 'dev-1', deviceName: 'android-phone' } },
    { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1' } },
  ]) {
    const refused = await tool.handler({ url: 'http://localhost:5173/' }, context)
    assert.equal(refused.isError, true)
    assert.equal(errorCode(refused), 'not_a_conversation')
  }
  assert.equal(calls.length, 0)
  // A paired device is not an agent: the tool is never served over the tailnet.
  assert.notEqual(localOnlyGatewayToolReason(LOCAL_SERVER_LINK_TOOL), null)
})

test('local_server.link refuses arguments it cannot record', async () => {
  const { tool, calls } = toolOver()
  for (const args of [
    {},
    { url: 42 },
    { url: 'ftp://localhost/' },
    { url: 'localhost:5173' },
    { url: `http://localhost/${'x'.repeat(2048)}` },
    { url: 'http://localhost:5173/', title: 'x'.repeat(201) },
    { url: 'http://localhost:5173/', title: 7 },
    { url: 'http://localhost:5173/', command: 'x'.repeat(4097) },
    { url: 'http://localhost:5173/', cwd: 'relative/folder' },
  ]) {
    const refused = await tool.handler(args, AGENT)
    assert.deepEqual([args, errorCode(refused)], [args, 'invalid_arguments'])
  }
  assert.equal(calls.length, 0)
})

test('local_server.link records the unspecified address as localhost, which a browser can open', async () => {
  const { tool, calls } = toolOver()
  await tool.handler({ url: 'http://0.0.0.0:5173/' }, AGENT)
  await tool.handler({ url: 'http://[::]:8000/docs' }, AGENT)
  assert.deepEqual(
    calls.map((call) => call.input.url),
    ['http://localhost:5173/', 'http://localhost:8000/docs'],
  )
})
