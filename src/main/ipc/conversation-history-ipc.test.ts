import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import { registerConversationIpc, type ConversationIpcHandlers } from './conversation-ipc'

test('history search batches, cancellation and cleanup are scoped to the requesting renderer', async () => {
  const routes = new Map<string, (event: { sender: Sender }, input: unknown) => unknown>()
  class Sender extends EventEmitter {
    sent: unknown[] = []
    constructor(readonly id: number) {
      super()
    }
    send(_channel: string, batch: unknown) {
      this.sent.push(batch)
    }
    isDestroyed() {
      return false
    }
  }
  let signal: AbortSignal | undefined
  let emitBatch: (() => void) | undefined
  const handlers = {
    searchThreads: async (_input, options) => {
      signal = options.signal
      emitBatch = () => options.onBatch?.([{ agentId: 'agent', seq: 1, snippet: 'found' }])
      emitBatch()
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      emitBatch()
      return { ok: false, message: 'cancelled' }
    },
  } satisfies Partial<ConversationIpcHandlers>
  registerConversationIpc(
    {
      handle: (channel: string, handler: (event: { sender: Sender }, input: unknown) => unknown) =>
        routes.set(channel, handler),
    } as never,
    handlers as ConversationIpcHandlers,
  )
  const owner = new Sender(1),
    other = new Sender(2)
  const pending = routes.get('conversation:search')!(
    { sender: owner },
    { workspaceRoot: '/workspace', workspaceId: 'workspace', query: 'found', requestId: 'search' },
  )
  expect(owner.sent).toEqual([{ requestId: 'search', hits: [{ agentId: 'agent', seq: 1, snippet: 'found' }] }])
  routes.get('conversation:search:cancel')!({ sender: other }, { requestId: 'search' })
  expect(signal?.aborted).toBe(false)
  routes.get('conversation:search:cancel')!({ sender: owner }, { requestId: 'search' })
  expect(signal?.aborted).toBe(true)
  await pending
  expect(owner.sent).toHaveLength(1)
  expect(owner.listenerCount('destroyed')).toBe(0)
  const next = routes.get('conversation:search')!(
    { sender: owner },
    { workspaceRoot: '/workspace', workspaceId: 'workspace', query: 'found', requestId: 'second' },
  )
  owner.emit('destroyed')
  await next
  expect(signal?.aborted).toBe(true)
})
