import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createConversationApi } from './conversation'
import type { ConversationEvent } from '../../shared/conversation-runtime'

test('multiple global consumers share one transport and dispose independently', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const calls: string[] = []
  const renderer = {
    async invoke(channel: string) {
      calls.push(channel)
      return { ok: true, subscriptionId: 'subscription' } as any
    },
    on(channel: string, listener: (...args: any[]) => void) {
      listeners.set(channel, listener)
    },
    removeListener(channel: string) {
      listeners.delete(channel)
    },
  }
  const api = createConversationApi(renderer)
  let first = 0
  let second = 0
  const disposeFirst = api.onConversationEvent(() => first++)
  const disposeSecond = api.onConversationEvent(() => second++)
  assert.equal(calls.filter((channel) => channel === 'conversation:events:subscribe').length, 1)
  listeners.get('conversation:event')!(null, {} as ConversationEvent)
  assert.deepEqual([first, second], [1, 1])
  disposeFirst()
  disposeFirst()
  listeners.get('conversation:event')!(null, {} as ConversationEvent)
  assert.deepEqual([first, second], [1, 2])
  disposeSecond()
  await Promise.resolve()
  assert.equal(listeners.size, 0)
  assert.equal(calls.filter((channel) => channel === 'conversation:events:unsubscribe').length, 1)
})
