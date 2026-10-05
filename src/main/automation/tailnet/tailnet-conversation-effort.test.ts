import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import type { ConversationProviderAdapter } from '../../providers/conversation-provider-adapter'
import { createConversationGatewayHost } from './tailnet-conversation-host'

// A paired device's send runs at the effort the chat's agent record keeps, as
// a window's chat view sends every turn with it, so a chat started at an effort
// from the phone keeps it past its first message.

async function fixture(effort: string | null, reasoningEfforts: string[] | null) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-effort-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const sentAt: Array<string | undefined> = []
  const mock = createMockConversationProvider({ reasoningEfforts })
  const adapter: ConversationProviderAdapter = {
    ...mock,
    sendTurn(input) {
      sentAt.push(input.reasoningEffort)
      return mock.sendTurn(input)
    },
  }
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    (asked) => (asked.workspaceId === key.workspaceId && asked.agentId === key.agentId ? effort : null),
  )
  const started = await runtime.startSession({
    ...key,
    providerId: adapter.id,
    modelId: adapter.listModels()[0]!,
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  return {
    send: (commandId: string) => host.command(key, 'phone', commandId, { kind: 'send', message: 'hello' }),
    sentAt,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test("a remote send runs at the chat's recorded effort when its provider runs that level", async () => {
  const f = await fixture('high', ['low', 'high'])
  try {
    const result = await f.send('send-1')
    assert.equal(result.ok, true, result.message ?? '')
    assert.deepEqual(f.sentAt, ['high'])
  } finally {
    await f.cleanup()
  }
})

test("a remote send to a chat whose provider does not run the recorded level runs at the provider's default", async () => {
  const f = await fixture('max', ['low', 'high'])
  try {
    await f.send('send-1')
    assert.deepEqual(f.sentAt, [undefined])
  } finally {
    await f.cleanup()
  }
})

test('a remote send to a chat with no recorded effort names none', async () => {
  const f = await fixture(null, ['low', 'high'])
  try {
    await f.send('send-1')
    assert.deepEqual(f.sentAt, [undefined])
  } finally {
    await f.cleanup()
  }
})
