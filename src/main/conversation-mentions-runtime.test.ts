import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider, type MockAdapterTurnInput } from './providers/mock-conversation-provider'

test.each([false, true])('mentions reach the provider without persisting file contents (tools=%s)', async (tools) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-mention-runtime-'))
  const turns: MockAdapterTurnInput[] = []
  const mock = createMockConversationProvider({ tools })
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        sendTurn(input) {
          turns.push(input)
          return mock.sendTurn({ ...input, message: '/tools' })
        },
      },
    ],
    getProviderById: () => undefined,
  })
  try {
    await writeFile(join(workspaceRoot, 'notes.txt'), 'transient file context marker')
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const mentions = [{ path: 'notes.txt', kind: 'file' as const }]
    assert.equal((await runtime.sendTurn({ sessionId: started.session.sessionId, message: '', mentions })).ok, true)
    assert.match(turns[0].message, /notes\.txt/)
    assert.equal(turns[0].message.includes('transient file context marker'), !tools)
    assert.equal(turns[0].messages?.at(-1)?.content.includes('transient file context marker'), !tools)
    const transcript = await runtime.readTranscript(key)
    assert.ok(transcript.ok)
    assert.deepEqual(transcript.events.find((event) => event.type === 'user_message')?.payload?.mentions, mentions)
    assert.equal(JSON.stringify(transcript.events).includes('transient file context marker'), false)
    const count = turns.length
    const rejected = await runtime.sendTurn({
      sessionId: started.session.sessionId,
      message: 'read',
      mentions: [{ path: '../outside.txt', kind: 'file' }],
    })
    assert.equal(rejected.ok, false)
    assert.equal(turns.length, count)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
