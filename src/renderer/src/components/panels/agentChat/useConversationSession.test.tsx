import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import { frameUrgency, mergeConversationEvents } from './useConversationSession'
import type {
  ConversationEvent,
  ConversationPageResult,
  ConversationSessionFrame,
  ConversationSubscribeInput,
} from '../../../../../shared/conversation-runtime'
import { chatOverStudioUnderTest, installStudioLoopback } from '../../../../../../tests/studio-chat-loopback'

test('live appends use the sequence index without rescanning or sorting hydrated history', () => {
  const seen = new Set<number>()
  const event = (seq: number) => ({ seq, id: `event-${seq}` }) as ConversationEvent
  const history = Array.from({ length: 20_000 }, (_, index) => event(index + 1))
  let current = mergeConversationEvents([], history, seen)
  const original = current[0]
  const sort = vi.spyOn(Array.prototype, 'sort')
  try {
    for (let seq = 20_001; seq <= 20_100; seq++) current = mergeConversationEvents(current, [event(seq)], seen)
    expect(sort).not.toHaveBeenCalled()
    expect(current[0]).toBe(original)
    expect(current).toHaveLength(20_100)
    expect(mergeConversationEvents(current, [event(20_050)], seen)).toBe(current)
    expect(mergeConversationEvents(current, [event(0)], seen)[0].seq).toBe(0)
  } finally {
    sort.mockRestore()
  }
})

// Run both ways. A StrictMode double mount opens and closes a subscription
// first; over IPC the stub sees both, over the protocol the first is closed
// before it reaches Studio, so the test follows whichever is live. Frames and
// pages over the protocol arrive a turn later, so it waits for each.
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
  installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> })
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
  const overStudio = chatOverStudioUnderTest()
  // Each look is its own `act`, so what arrived is drawn before the next.
  const until = async (check: () => boolean, what: string) => {
    for (let tries = 0; !check() && tries < 400; tries++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 2)))
    if (!check()) throw new Error(`Timed out waiting for ${what}`)
  }
  const settle = async () => {
    for (let turn = 0; turn < 10; turn++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  }
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Harness, { agentId: 'agent' }))))
    await until(() => subscriptions.length >= (overStudio ? 1 : 2), 'the subscription')
    await settle()
    if (overStudio) expect(subscriptions).toHaveLength(1)
    else {
      expect(subscriptions).toHaveLength(2)
      expect(subscriptions[0].dispose).toHaveBeenCalledOnce()
    }
    const live = subscriptions[subscriptions.length - 1]
    expect(live.input).toEqual({
      key: { workspaceRoot: '/Users/dev/project', workspaceId: 'workspace', agentId: 'agent' },
      turnLimit: 10,
    })
    const receive = live.receive
    const stableLoadEarlier = hook.loadEarlier
    await act(async () => {
      if (!overStudio) subscriptions[0].receive({ type: 'event', event: event(999) })
      receive({
        type: 'snapshot',
        page: { events: [event(12), event(11), event(11)], hasMore: true, beforeCursor: 11 },
      })
      receive({ type: 'event', event: event(13) })
    })
    await settle()
    expect(hook.hydrated).toBe(false)
    expect(hook.announcement).toBe('')
    expect(hook.events).toEqual([])
    await act(async () => receive({ type: 'synchronized', seq: 13 }))
    await until(() => hook.hydrated, 'hydration at the fence')
    expect(hook.events.map((entry) => entry.seq)).toEqual([11, 12, 13])
    const originalTail = hook.events[2]
    let pending!: Promise<void>
    await act(async () => {
      pending = hook.loadEarlier()
      expect(hook.loadEarlier()).toBe(pending)
    })
    expect(hook.loadingEarlier).toBe(true)
    await until(() => earlier.mock.calls.length === 1, 'the first page asked for')
    expect(earlier).toHaveBeenCalledExactlyOnceWith({
      key: live.input.key,
      beforeCursor: 11,
      turnLimit: 10,
    })
    await act(async () => {
      receive({ type: 'event', event: event(14) })
      receive({ type: 'event', event: event(13) })
      finishPage({ ok: true, page: { events: [event(1), event(10), event(11)], hasMore: true, beforeCursor: 1 } })
      await pending
    })
    await until(() => hook.events.length === 6, 'the page and the live events')
    expect(hook.events.map((entry) => entry.seq)).toEqual([1, 10, 11, 12, 13, 14])
    expect(hook.events[4]).toBe(originalTail)
    expect(hook.loadingEarlier).toBe(false)
    expect(hook.loadEarlier).toBe(stableLoadEarlier)
    await act(async () => {
      pending = hook.loadEarlier()
    })
    await until(() => earlier.mock.calls.length === 2, 'the second page asked for')
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
    await until(() => earlier.mock.calls.length === 3, 'the third page asked for')
    const before = subscriptions.length
    await act(async () => root.render(createElement(StrictMode, null, createElement(Harness, { agentId: 'other' }))))
    await until(() => live.dispose.mock.calls.length === 1, 'the first chat’s subscription closed')
    await until(() => subscriptions.length === before + 1, 'the next chat’s subscription')
    await act(async () => {
      finishPage({ ok: true, page: { events: [event(1000)], hasMore: false, beforeCursor: null } })
      receive({ type: 'event', event: event(1001) })
      await pending.catch(() => undefined)
    })
    await settle()
    expect(live.dispose).toHaveBeenCalledOnce()
    expect(hook.events).toEqual([])
    expect(hook.hydrated).toBe(false)
    expect(hook.loadEarlier).toBe(stableLoadEarlier)
    const next = subscriptions[subscriptions.length - 1]
    await act(async () => {
      next.receive({ type: 'snapshot', page: { events: [], hasMore: false, beforeCursor: null } })
      next.receive({ type: 'synchronized', seq: 0 })
    })
    await until(() => hook.hydrated, 'the next chat hydrated')
    await act(async () => hook.loadEarlier())
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

test('a failed subscription resubscribes with backoff and catches up from its cursor without a reset', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  vi.useFakeTimers()
  const subscriptions: {
    input: ConversationSubscribeInput
    receive: (frame: ConversationSessionFrame) => void
    dispose: ReturnType<typeof vi.fn>
  }[] = []
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
    },
  })
  installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> })
  const { act, createElement } = await import('react')
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
    type: 'content_delta',
    // A turn each, so no two are a run the session would merge.
    payload: { turnId: `turn-${seq}`, text: `${seq}` },
  })
  let hook!: ReturnType<typeof useConversationSession>
  function Harness() {
    hook = useConversationSession('/Users/dev/project', 'workspace', 'agent')
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => {
      subscriptions[0].receive({
        type: 'snapshot',
        page: { events: [event(3), event(5)], hasMore: false, beforeCursor: 3 },
        generation: 'log-1',
      })
      subscriptions[0].receive({ type: 'synchronized', seq: 5, generation: 'log-1' })
      subscriptions[0].receive({ type: 'event', event: event(6) })
    })
    // A streamed token renders with the next frame, not on arrival.
    expect(hook.events.map((entry) => entry.seq)).toEqual([3, 5])
    await act(async () => vi.advanceTimersByTime(48))
    const held = hook.events
    expect(held.map((entry) => entry.seq)).toEqual([3, 5, 6])
    // Opening a chat mid-stream can fail its subscription; the panel must not stay frozen.
    await act(async () => subscriptions[0].receive({ type: 'error', message: 'Transcript is busy' }))
    expect(hook.error).toBe('Transcript is busy')
    expect(subscriptions[0].dispose).toHaveBeenCalledOnce()
    expect(subscriptions).toHaveLength(1)
    await act(async () => vi.advanceTimersByTime(500))
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[1].input).toMatchObject({ afterSeq: 6, generation: 'log-1' })
    await act(async () => subscriptions[1].receive({ type: 'error', message: 'Transcript is busy' }))
    await act(async () => vi.advanceTimersByTime(999))
    expect(subscriptions).toHaveLength(2)
    await act(async () => vi.advanceTimersByTime(1))
    expect(subscriptions).toHaveLength(3)
    await act(async () => {
      // A merged delta run arrives as one event numbered with its last seq.
      subscriptions[2].receive({ type: 'event', event: event(9) })
      subscriptions[2].receive({ type: 'synchronized', seq: 9, generation: 'log-1' })
    })
    expect(hook.error).toBeNull()
    expect(hook.events.map((entry) => entry.seq)).toEqual([3, 5, 6, 9])
    // Events caught up incrementally were live to this panel's user; only the first join was replay.
    expect(hook.replayThroughSeq).toBe(5)
    expect(hook.events[2]).toBe(held[2])
    // A successful join resets the backoff.
    await act(async () => subscriptions[2].receive({ type: 'error', message: 'Transcript is busy' }))
    await act(async () => vi.advanceTimersByTime(500))
    expect(subscriptions).toHaveLength(4)
    expect(subscriptions[3].input).toMatchObject({ afterSeq: 9, generation: 'log-1' })
    // A cursor the log cannot vouch for gets a reset snapshot, which replaces the transcript.
    await act(async () => {
      subscriptions[3].receive({
        type: 'snapshot',
        page: { events: [event(1)], hasMore: false, beforeCursor: 1 },
        reset: true,
        generation: 'log-2',
      })
      subscriptions[3].receive({ type: 'synchronized', seq: 1, generation: 'log-2' })
    })
    expect(hook.events.map((entry) => entry.seq)).toEqual([1])
    // The reset's own history is replay, even though it is numbered below the old boundary.
    expect(hook.replayThroughSeq).toBe(1)
    await act(async () => root.unmount())
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(subscriptions).toHaveLength(4)
  } finally {
    vi.useRealTimers()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('two readers of one conversation share its subscription, its events and its earlier pages', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const subscriptions: { receive: (frame: ConversationSessionFrame) => void; dispose: ReturnType<typeof vi.fn> }[] = []
  const earlier = vi.fn(async (): Promise<ConversationPageResult> => ({
    ok: true,
    page: { events: [event(1)], hasMore: false, beforeCursor: null },
  }))
  Object.assign(dom.window, {
    api: {
      onConversationSession: (
        _input: ConversationSubscribeInput,
        receive: (frame: ConversationSessionFrame) => void,
      ) => {
        const dispose = vi.fn()
        subscriptions.push({ receive, dispose })
        return dispose
      },
      conversationLoadEarlier: earlier,
    },
  })
  installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> })
  function event(seq: number): ConversationEvent {
    return {
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
    }
  }
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useConversationSession } = await import('./useConversationSession')
  const hooks: Record<string, ReturnType<typeof useConversationSession>> = {}
  function Reader({ name }: { name: string }) {
    hooks[name] = useConversationSession('/Users/dev/shared', 'workspace', 'agent')
    return null
  }
  const chat = createRoot(document.createElement('div'))
  const pane = createRoot(document.createElement('div'))
  try {
    await act(async () => chat.render(createElement(Reader, { name: 'chat' })))
    await act(async () => {
      subscriptions[0].receive({ type: 'snapshot', page: { events: [event(2)], hasMore: true, beforeCursor: 2 } })
      subscriptions[0].receive({ type: 'synchronized', seq: 2 })
    })
    // The pane opens on a conversation the chat already holds: no second
    // subscription, and the events are there at once.
    await act(async () => pane.render(createElement(Reader, { name: 'pane' })))
    expect(subscriptions).toHaveLength(1)
    expect(hooks.pane.hydrated).toBe(true)
    expect(hooks.pane.events.map((entry) => entry.seq)).toEqual([2])
    await act(async () => subscriptions[0].receive({ type: 'event', event: event(3) }))
    expect(hooks.chat.events.map((entry) => entry.seq)).toEqual([2, 3])
    expect(hooks.pane.events.map((entry) => entry.seq)).toEqual([2, 3])
    // Either reader pages earlier turns in, for both.
    await act(async () => hooks.pane.loadEarlier())
    expect(earlier).toHaveBeenCalledOnce()
    expect(hooks.chat.events.map((entry) => entry.seq)).toEqual([1, 2, 3])
    // The subscription outlives the first reader to go, and not the last.
    await act(async () => pane.unmount())
    expect(subscriptions[0].dispose).not.toHaveBeenCalled()
    await act(async () => chat.unmount())
    expect(subscriptions[0].dispose).toHaveBeenCalledOnce()
  } finally {
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('frames are sorted by how soon a reader needs them', () => {
  const frame = (type: ConversationEvent['type'], payload: Record<string, unknown> = {}) =>
    frameUrgency({ type: 'event', event: { type, payload } as ConversationEvent })
  expect(frame('content_delta')).toBe('token')
  expect(frame('reasoning_delta')).toBe('token')
  expect(frame('tool_output', { partial: true })).toBe('token')
  expect(frame('tool_output')).toBe('step')
  expect(frame('tool_started')).toBe('step')
  expect(frame('usage_updated')).toBe('step')
  expect(frame('subagent_status' as ConversationEvent['type'])).toBe('step')
  for (const type of ['turn_started', 'turn_completed', 'turn_failed', 'approval_requested', 'user_message'] as const)
    expect(frame(type)).toBe('turn')
  expect(frameUrgency({ type: 'synchronized', seq: 1 })).toBe('turn')
})

test('a reader renders tokens once a frame, and one nobody can see rests until it is seen', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  vi.useFakeTimers()
  const receivers: ((frame: ConversationSessionFrame) => void)[] = []
  Object.assign(dom.window, {
    api: {
      onConversationSession: (
        _input: ConversationSubscribeInput,
        receive: (frame: ConversationSessionFrame) => void,
      ) => {
        receivers.push(receive)
        return () => undefined
      },
    },
  })
  installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> })
  let seq = 0
  const event = (type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent => ({
    seq: ++seq,
    id: `event-${seq}`,
    workspaceId: 'workspace',
    agentId: 'agent',
    sessionId: 'session',
    providerId: 'mock',
    modelId: 'mock',
    createdAt: seq,
    type,
    payload,
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useConversationSession } = await import('./useConversationSession')
  let renders = 0
  let hook!: ReturnType<typeof useConversationSession>
  function Reader({ active }: { active: boolean }) {
    hook = useConversationSession('/Users/dev/rest', 'workspace', 'agent', { active })
    renders++
    return null
  }
  const root = createRoot(document.createElement('div'))
  const receive = (frame: ConversationSessionFrame) => receivers.at(-1)!(frame)
  const token = (text: string) => receive({ type: 'event', event: event('content_delta', { turnId: 't', text }) })
  try {
    await act(async () => root.render(createElement(Reader, { active: true })))
    await act(async () => {
      receive({ type: 'snapshot', page: { events: [], hasMore: false, beforeCursor: null } })
      receive({ type: 'synchronized', seq: 0 })
      receive({ type: 'event', event: event('turn_started', { turnId: 't' }) })
    })
    expect(hook.events).toHaveLength(1)
    // Ten tokens in one frame are one render.
    const before = renders
    await act(async () => {
      for (let index = 0; index < 10; index++) token(`w${index} `)
    })
    expect(hook.events).toHaveLength(1)
    await act(async () => vi.advanceTimersByTime(48))
    expect(hook.events).toHaveLength(11)
    expect(renders - before).toBe(1)

    // Unseen: tokens and steps wait, a turn's end does not.
    await act(async () => root.render(createElement(Reader, { active: false })))
    const hidden = renders
    await act(async () => {
      for (let index = 0; index < 5; index++) token('x')
      receive({ type: 'event', event: event('tool_started', { turnId: 't', toolUseId: 'a', name: 'Read' }) })
      vi.advanceTimersByTime(1000)
    })
    expect(renders).toBe(hidden)
    expect(hook.events).toHaveLength(11)
    await act(async () => receive({ type: 'event', event: event('turn_completed', { turnId: 't' }) }))
    // The turn's fifteen tokens are one event once it ends.
    expect(hook.events.map((entry) => entry.type)).toEqual([
      'turn_started',
      'content_delta',
      'tool_started',
      'turn_completed',
    ])
    expect(hook.announcement).toBe('Assistant reply complete.')

    // Seen again, it catches up in one render.
    await act(async () => token('late'))
    await act(async () => vi.advanceTimersByTime(1000))
    expect(hook.events).toHaveLength(4)
    await act(async () => root.render(createElement(Reader, { active: true })))
    expect(hook.events).toHaveLength(5)
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('the session keeps a settled turn’s tokens as one event, and appends live tokens without copying the log', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  vi.useFakeTimers()
  const receivers: ((frame: ConversationSessionFrame) => void)[] = []
  Object.assign(dom.window, {
    api: {
      onConversationSession: (
        _input: ConversationSubscribeInput,
        receive: (frame: ConversationSessionFrame) => void,
      ) => {
        receivers.push(receive)
        return () => undefined
      },
    },
  })
  installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> })
  let seq = 0
  const event = (type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent => ({
    seq: ++seq,
    id: `event-${seq}`,
    workspaceId: 'workspace',
    agentId: 'agent',
    sessionId: 'session',
    providerId: 'mock',
    modelId: 'mock',
    createdAt: seq,
    type,
    payload,
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useConversationSession } = await import('./useConversationSession')
  const { projectConversation } = await import('./conversationProjection')
  let hook!: ReturnType<typeof useConversationSession>
  function Reader() {
    hook = useConversationSession('/Users/dev/compact', 'workspace', 'agent')
    return null
  }
  const root = createRoot(document.createElement('div'))
  const receive = (frame: ConversationSessionFrame) => receivers.at(-1)!(frame)
  try {
    await act(async () => root.render(createElement(Reader)))
    // A page arrives with its runs already merged.
    const page = [
      event('user_message', { turnId: 'a', text: 'Go' }),
      event('turn_started', { turnId: 'a' }),
      event('reasoning_delta', { turnId: 'a', text: 'Let me ' }),
      event('reasoning_delta', { turnId: 'a', text: 'think.' }),
      event('content_delta', { turnId: 'a', text: 'Hello ' }),
      event('content_delta', { turnId: 'a', text: 'there.' }),
      event('turn_completed', { turnId: 'a' }),
    ]
    await act(async () => {
      receive({ type: 'snapshot', page: { events: page, hasMore: false, beforeCursor: null } })
      receive({ type: 'synchronized', seq })
    })
    expect(hook.events.map((entry) => entry.type)).toEqual([
      'user_message',
      'turn_started',
      'reasoning_delta',
      'content_delta',
      'turn_completed',
    ])
    expect(projectConversation(hook.events)).toEqual(projectConversation(page))
    // Live tokens render once a frame; the log they go into is the same array
    // until a reader has been handed it.
    const live = [event('user_message', { turnId: 'b', text: 'Again' }), event('turn_started', { turnId: 'b' })]
    await act(async () => live.forEach((item) => receive({ type: 'event', event: item })))
    const handed = hook.events
    const tokens = Array.from({ length: 20 }, (_, index) => event('content_delta', { turnId: 'b', text: `w${index} ` }))
    await act(async () => tokens.forEach((item) => receive({ type: 'event', event: item })))
    expect(handed).toHaveLength(7)
    await act(async () => vi.advanceTimersByTime(48))
    expect(hook.events).toHaveLength(27)
    // A duplicate of a merged token is still recognised as seen.
    await act(async () => receive({ type: 'event', event: { ...page[3]! } }))
    const end = event('turn_completed', { turnId: 'b' })
    await act(async () => receive({ type: 'event', event: end }))
    // The page's five, the new turn's message and start, its tokens as one, its end.
    expect(hook.events).toHaveLength(9)
    expect(projectConversation(hook.events)).toEqual(projectConversation([...page, ...live, ...tokens, end]))
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a chat opened again draws what it held at once and asks only for what was written since', async () => {
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
    },
  })
  const event = (
    agentId: string,
    seq: number,
    type: ConversationEvent['type'] = 'user_message',
  ): ConversationEvent => ({
    seq,
    id: `${agentId}-${seq}`,
    workspaceId: 'workspace',
    agentId,
    sessionId: 'session',
    providerId: 'mock',
    modelId: 'mock',
    createdAt: seq,
    type,
    payload: { turnId: `turn-${seq}`, text: `message ${seq}` },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useConversationSession, RETAINED_SESSION_LIMIT } = await import('./useConversationSession')
  let hook!: ReturnType<typeof useConversationSession>
  function Harness({ agentId }: { agentId: string }) {
    hook = useConversationSession('/Users/dev/retained', 'workspace', agentId)
    return null
  }
  const root = createRoot(document.createElement('div'))
  const subscriptionOf = (agentId: string) => subscriptions.filter((entry) => entry.input.key.agentId === agentId)
  const open = async (agentId: string) => act(async () => root.render(createElement(Harness, { agentId })))
  const join = async (agentId: string, events: ConversationEvent[], head: number) => {
    const { receive } = subscriptionOf(agentId).at(-1)!
    await act(async () => {
      receive({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null }, generation: `log-${agentId}` })
      receive({ type: 'synchronized', seq: head, generation: `log-${agentId}` })
    })
  }
  try {
    await open('first')
    await join('first', [event('first', 1), event('first', 2, 'turn_completed')], 2)
    expect(hook.events.map((entry) => entry.seq)).toEqual([1, 2])
    // Away to another chat: the first one's subscription closes, like any other.
    await open('second')
    expect(subscriptionOf('first')[0].dispose).toHaveBeenCalledOnce()
    await join('second', [event('second', 1)], 1)

    // Back: what it held is drawn before anything arrives, and the runtime is
    // asked only for what follows it.
    await open('first')
    expect(hook.hydrated).toBe(true)
    expect(hook.events.map((entry) => entry.seq)).toEqual([1, 2])
    expect(subscriptionOf('first')).toHaveLength(2)
    expect(subscriptionOf('first')[1].input).toMatchObject({ afterSeq: 2, generation: 'log-first' })
    const { receive } = subscriptionOf('first')[1]
    await act(async () => {
      receive({ type: 'event', event: event('first', 3) })
      receive({ type: 'event', event: event('first', 4, 'turn_completed') })
    })
    // The catch-up is drawn whole at its fence, and is history, as a cold read's would be.
    expect(hook.events.map((entry) => entry.seq)).toEqual([1, 2])
    await act(async () => receive({ type: 'synchronized', seq: 4, generation: 'log-first' }))
    expect(hook.events.map((entry) => entry.seq)).toEqual([1, 2, 3, 4])
    expect(hook.replayThroughSeq).toBe(4)
    expect(hook.announcement).toBe('')

    // Only the newest few are kept: the oldest is read cold again.
    for (let index = 0; index <= RETAINED_SESSION_LIMIT; index++) {
      await open(`other-${index}`)
      await join(`other-${index}`, [event(`other-${index}`, 1)], 1)
    }
    await open('first')
    expect(subscriptionOf('first').at(-1)!.input).not.toHaveProperty('afterSeq')
    expect(hook.hydrated).toBe(false)
    // A chat left before it was read is not kept either.
    await open('unread')
    await open('first')
    await open('unread')
    expect(subscriptionOf('unread')).toHaveLength(2)
    expect(subscriptionOf('unread')[1].input).not.toHaveProperty('afterSeq')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
