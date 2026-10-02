import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// A quit has a budget (a standalone server's is ten seconds), and each chat's
// stop waits on its own child process to go. One after another, a few slow
// children were enough to outrun it, so the runtime stops them all at once.

test('shutdown stops every open chat at once, not one after another', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-runtime-shutdown-'))
  const mock = createMockConversationProvider()
  const STOP_MS = 200
  const stopping: string[] = []
  const runtime = new ConversationRuntime({
    getProviderById: () => undefined,
    adapters: [
      {
        ...mock,
        async stopSession(input) {
          stopping.push(input.sessionId)
          await new Promise((resolve) => setTimeout(resolve, STOP_MS))
          return mock.stopSession(input)
        },
      },
    ],
  })
  try {
    for (const agentId of ['a', 'b', 'c', 'd', 'e']) {
      const started = await runtime.startSession({
        workspaceRoot: root,
        workspaceId: 'workspace',
        agentId,
        providerId: mock.id,
        modelId: 'mock-model',
      })
      assert.ok(started.ok)
    }
    const began = Date.now()
    await runtime.shutdown()
    assert.equal(stopping.length, 5)
    assert.ok(Date.now() - began < STOP_MS * 3, `took ${Date.now() - began}ms for five stops of ${STOP_MS}ms`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
