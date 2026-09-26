import { afterEach, expect, test, vi } from 'vitest'
import type { ConversationEvent } from '../../../shared/conversation-runtime'

const hooks = vi.hoisted(() => ({ dispose: undefined as (() => void) | undefined, publish: vi.fn() }))
vi.mock('react', () => ({
  useState: () => [[], hooks.publish],
  useEffect: (effect: () => (() => void) | undefined) => {
    hooks.dispose = effect()
  },
}))
import { useConversationSessions } from './useConversationSessions'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  hooks.dispose?.()
  hooks.dispose = undefined
  vi.useRealTimers()
  vi.clearAllMocks()
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('tool title changes refresh summaries while token deltas stay silent and bursts coalesce', async () => {
  vi.useFakeTimers()
  const list = vi.fn().mockResolvedValue({ ok: true, sessions: [] })
  const unsubscribe = vi.fn()
  let receive!: (event: ConversationEvent) => void
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        conversationSessionsList: list,
        onConversationEvent: (listener: typeof receive) => {
          receive = listener
          return unsubscribe
        },
      },
    },
  })
  useConversationSessions()
  expect(list).toHaveBeenCalledTimes(1)
  const emit = (type: ConversationEvent['type']) => receive({ type } as ConversationEvent)
  emit('content_delta')
  emit('reasoning_delta')
  await vi.advanceTimersByTimeAsync(250)
  expect(list).toHaveBeenCalledTimes(1)
  emit('tool_started')
  emit('tool_started')
  await vi.advanceTimersByTimeAsync(200)
  expect(list).toHaveBeenCalledTimes(2)
  emit('tool_output')
  await vi.advanceTimersByTimeAsync(200)
  expect(list).toHaveBeenCalledTimes(3)
  emit('tool_started')
  hooks.dispose?.()
  hooks.dispose = undefined
  await vi.advanceTimersByTimeAsync(250)
  expect(list).toHaveBeenCalledTimes(3)
  expect(unsubscribe).toHaveBeenCalledOnce()
})
