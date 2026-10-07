import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { ConversationEvent } from '../shared/conversation-runtime'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// `onSessionIdle` is the moment a chat takes a message again. Its turn's end
// event comes first, while the turn still holds the session: a send made on
// that event is refused as busy, and one made on the idle news is taken.
test('a chat says it is idle once its turn lets go, after the turn’s end, once per rest', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-idle-runtime-'))
  const mock = createMockConversationProvider()
  const runtime = new ConversationRuntime({
    adapters: [{ ...mock, sendTurn: (input) => mock.sendTurn({ ...input, message: '/tools' }) }],
    getProviderById: () => undefined,
  })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    const order: string[] = []
    const sendsOnTurnEnd: Array<Promise<{ ok: boolean; code?: string }>> = []
    const sendsOnIdle: Array<Promise<{ ok: boolean }>> = []
    runtime.onEvent((event: ConversationEvent) => {
      if (event.type !== 'turn_completed') return
      order.push('turn_completed')
      if (sendsOnTurnEnd.length === 0) sendsOnTurnEnd.push(runtime.sendTurn({ sessionId, message: 'too soon' }))
    })
    runtime.onSessionIdle((summary) => {
      order.push(`idle:${summary.status}`)
      if (sendsOnIdle.length === 0) sendsOnIdle.push(runtime.sendTurn({ sessionId, message: 'now' }))
    })

    assert.equal((await runtime.sendTurn({ sessionId, message: 'first' })).ok, true)
    const refused = await sendsOnTurnEnd[0]
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'busy', 'the turn still holds the chat when its end is published')
    assert.equal((await sendsOnIdle[0]).ok, true, 'the idle news is when a send is taken')
    // One per rest: the second turn's rest is told once more, and no more.
    assert.deepEqual(order, ['turn_completed', 'idle:ready', 'turn_completed', 'idle:ready'])
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
