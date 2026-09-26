import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type {
  ConversationEvent,
  ConversationPageResult,
  ConversationSessionFrame,
  ConversationSubscribeInput,
} from '../../../../../shared/conversation-runtime'

test('scoped catch-up hydrates at the fence and pages without losing live events or hiding errors', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const subscriptions: {
    input: ConversationSubscribeInput
    receive: (frame: ConversationSessionFrame) => void
    dispose: ReturnType<typeof vi.fn>
  }[] = []
  let finishPage!: (result: ConversationPageResult) => void
  const earlier = vi.fn(
    () =>
      new Promise<ConversationPageResult>((resolve) => {
        finishPage = resolve
      }),
  )
  Object.assign(dom.window, {
    api: {
      onConversationSession: (
        input: ConversationSubscribeInput,
        receive: (frame: ConversationSessionFrame) => void,
      ) => {
        const dispose = vi.fn()
        subscriptions.push({ input, receive, dispose })
        return dispose
      },
      conversationLoadEarlier: earlier,
    },
  })
  const { act, createElement, StrictMode } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useConversationSession } = await import('./useConversationSession')
  const event = (seq: number): ConversationEvent => ({
    seq,
    id: `event-${seq}`,
    workspaceId: 'workspace',
    agentId: 'agent',
    sessionId: 'session',
    providerId: 'mock',
    modelId: 'mock',
    createdAt: seq,
    type: 'user_message',
    payload: { text: `message ${seq}` },
  })
  let hook!: ReturnType<typeof useConversationSession>
  function Harness({ agentId }: { agentId: string }) {
    hook = useConversationSession('/Users/dev/project', 'workspace', agentId)
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Harness, { agentId: 'agent' }))))
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[0].dispose).toHaveBeenCalledOnce()
    expect(subscriptions[1].input).toEqual({
      key: { workspaceRoot: '/Users/dev/project', workspaceId: 'workspace', agentId: 'agent' },
      turnLimit: 10,
    })
    const receive = subscriptions[1].receive
    const stableLoadEarlier = hook.loadEarlier
    await act(async () => {
      subscriptions[0].receive({ type: 'event', event: event(999) })
      receive({
        type: 'snapshot',
        page: { events: [event(12), event(11), event(11)], hasMore: true, beforeCursor: 11 },
      })
      receive({ type: 'event', event: event(13) })
    })
    expect(hook.hydrated).toBe(false)
    expect(hook.events).toEqual([])
    await act(async () => receive({ type: 'synchronized', seq: 13 }))
    expect(hook.hydrated).toBe(true)
    expect(hook.events.map((entry) => entry.seq)).toEqual([11, 12, 13])
    const originalTail = hook.events[2]
    let pending!: Promise<void>
    await act(async () => {
      pending = hook.loadEarlier()
      expect(hook.loadEarlier()).toBe(pending)
    })
    expect(hook.loadingEarlier).toBe(true)
    expect(earlier).toHaveBeenCalledExactlyOnceWith({
      key: subscriptions[1].input.key,
      beforeCursor: 11,
      turnLimit: 10,
    })
    await act(async () => {
      receive({ type: 'event', event: event(14) })
      receive({ type: 'event', event: event(13) })
      finishPage({ ok: true, page: { events: [event(1), event(10), event(11)], hasMore: true, beforeCursor: 1 } })
      await pending
    })
    expect(hook.events.map((entry) => entry.seq)).toEqual([1, 10, 11, 12, 13, 14])
    expect(hook.events[4]).toBe(originalTail)
    expect(hook.loadingEarlier).toBe(false)
    expect(hook.loadEarlier).toBe(stableLoadEarlier)
    await act(async () => {
      pending = hook.loadEarlier()
    })
    await act(async () => {
      finishPage({ ok: false, message: 'Page unavailable' })
      await expect(pending).rejects.toThrow('Page unavailable')
    })
    expect(hook.error).toBe('Page unavailable')
    expect(hook.loadingEarlier).toBe(false)
    expect(hook.hasMore).toBe(true)
    await act(async () => {
      pending = hook.loadEarlier()
    })
    await act(async () => root.render(createElement(StrictMode, null, createElement(Harness, { agentId: 'other' }))))
    expect(subscriptions[1].dispose).toHaveBeenCalledOnce()
    await act(async () => {
      finishPage({ ok: true, page: { events: [event(1000)], hasMore: false, beforeCursor: null } })
      receive({ type: 'event', event: event(1001) })
      await pending
    })
    expect(hook.events).toEqual([])
    expect(hook.hydrated).toBe(false)
    expect(hook.loadEarlier).toBe(stableLoadEarlier)
    await act(async () => {
      subscriptions[2].receive({ type: 'snapshot', page: { events: [], hasMore: false, beforeCursor: null } })
      subscriptions[2].receive({ type: 'synchronized', seq: 0 })
      await hook.loadEarlier()
    })
    expect(hook.hydrated).toBe(true)
    expect(earlier).toHaveBeenCalledTimes(3)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
