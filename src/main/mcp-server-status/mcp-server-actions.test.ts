import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { ConversationRuntime } from '../conversation-runtime'
import { createMockConversationProvider } from '../providers/mock-conversation-provider'

// A live chat's MCP server is reconnected, switched or signed in to through
// its provider, and only as far as the provider says it can.

async function fixture(actions: Array<'reconnect' | 'enable' | 'disable' | 'sign-in'> | undefined) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'mcp-actions-'))
  const asked: Array<[string, string]> = []
  const mock = createMockConversationProvider(actions ? { mcpServerActions: actions } : {})
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        async mcpServerAction(input) {
          asked.push([input.serverId, input.action])
          return input.action === 'sign-in' ? { ok: true, authUrl: 'https://mcp.example.com/authorize' } : { ok: true }
        },
      },
    ],
    getProviderById: () => undefined,
  })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
  })
  assert.ok(started.ok)
  return {
    runtime,
    sessionId: started.session.sessionId,
    asked,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('an action the provider offers reaches it, and a sign-in answers where to finish it', async () => {
  const f = await fixture(['reconnect', 'sign-in'])
  try {
    assert.deepEqual(
      await f.runtime.mcpServerAction({ sessionId: f.sessionId, serverId: 'figma', action: 'reconnect' }),
      {
        ok: true,
      },
    )
    assert.deepEqual(
      await f.runtime.mcpServerAction({ sessionId: f.sessionId, serverId: 'linear', action: 'sign-in' }),
      {
        ok: true,
        authUrl: 'https://mcp.example.com/authorize',
      },
    )
    assert.deepEqual(f.asked, [
      ['figma', 'reconnect'],
      ['linear', 'sign-in'],
    ])
  } finally {
    await f.cleanup()
  }
})

test('an action the provider does not offer is refused without asking it', async () => {
  const f = await fixture(['reconnect'])
  try {
    const result = await f.runtime.mcpServerAction({ sessionId: f.sessionId, serverId: 'sentry', action: 'enable' })
    assert.equal(result.ok, false)
    assert.deepEqual(f.asked, [])
    const unknown = await f.runtime.mcpServerAction({ sessionId: 'nope', serverId: 'sentry', action: 'reconnect' })
    assert.equal(unknown.ok, false)
  } finally {
    await f.cleanup()
  }
})
