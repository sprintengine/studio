import { JSDOM } from 'jsdom'
import { forwardRef, Fragment, useImperativeHandle, useRef, type ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionFrame,
  ConversationSubscribeInput,
} from '../../../../../shared/conversation-runtime'

// The virtual list measures a real viewport, which jsdom does not have; this
// stand-in renders every row so the rows themselves can be driven.
vi.mock('@legendapp/list/react', () => ({
  LegendList: forwardRef(function LegendList(
    {
      data,
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      className,
    }: {
      data: unknown[]
      renderItem: (props: { item: unknown; index: number }) => ReactNode
      keyExtractor: (item: unknown) => string
      ListHeaderComponent?: ReactNode
      className?: string
    },
    ref,
  ) {
    const scroller = useRef<HTMLDivElement>(null)
    useImperativeHandle(ref, () => ({
      scrollToEnd: async () => undefined,
      scrollToIndex: async () => undefined,
      scrollToOffset: async () => undefined,
      getScrollableNode: () => scroller.current,
      getState: () => ({ positionAtIndex: () => 0, positionByKey: () => 0 }),
    }))
    return (
      <div ref={scroller} className={className}>
        {ListHeaderComponent}
        {data.map((item, index) => (
          <Fragment key={keyExtractor(item)}>{renderItem({ item, index })}</Fragment>
        ))}
      </div>
    )
  }),
}))

type SendTurn = (input: { mode?: string; message?: string }) => Promise<{ ok: false; message: string }>

// Mounts the whole chat view against a scripted conversation API, the way a
// person meets it: a transcript arrives over the session subscription and the
// composer and rows are driven through the DOM.
async function mountChat({
  events = [],
  capabilities = {},
  conversationMode,
  sendTurn = async () => ({ ok: false, message: 'Not scripted.' }),
}: {
  events?: ConversationEvent[]
  capabilities?: Record<string, unknown>
  conversationMode?: 'plan'
  sendTurn?: SendTurn
}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const frames: ((frame: ConversationSessionFrame) => void)[] = []
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    api: {
      platform: 'darwin',
      onConversationSession: (
        _input: ConversationSubscribeInput,
        receive: (frame: ConversationSessionFrame) => void,
      ) => {
        frames.push(receive)
        return () => undefined
      },
      conversationProvidersList: async () => ({
        ok: true,
        providers: [{ id: 'mock', displayName: 'Mock', models: [{ id: 'mock-model' }], capabilities }],
      }),
      conversationSecretStatus: async () => ({ ok: false, message: 'No secret' }),
      conversationSessionStart: async () => ({
        ok: true,
        session: {
          sessionId: 'session',
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: 'mock',
          modelId: 'mock-model',
          status: 'ready',
          createdAt: 1,
          updatedAt: 1,
          capabilities,
        },
      }),
      conversationSessionSendTurn: sendTurn,
      conversationThreads: async () => ({ ok: true, threads: [] }),
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  const { default: AgentChatView } = await import('../AgentChatView')
  const { composerDraftStore } = await import('./draftStore')
  composerDraftStore().getState().remove('workspace', 'agent')
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'workspace',
        name: 'Project',
        folderPath: '/Users/dev/project',
        agents: {
          agent: {
            id: 'agent',
            name: 'Chat',
            runtimeKind: 'conversation',
            conversation: { providerId: 'mock', modelId: 'mock-model' },
            ...(conversationMode ? { conversationMode } : {}),
          },
        },
      },
    ] as never,
  })
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(AgentChatView, { workspaceId: 'workspace', agentId: 'agent' })))
  await act(async () => {
    frames.at(-1)?.({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null } })
    frames.at(-1)?.({ type: 'synchronized', seq: events.at(-1)?.seq ?? 0 })
  })
  const composer = () => host.querySelector('textarea')!
  return {
    dom,
    host,
    act,
    agent: () => useWorkspaceStore.getState().workspaces[0].agents.agent,
    button: (label: string) =>
      Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes(label)),
    type: (value: string) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), value)
      composer().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    },
    enter: () =>
      composer().dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const key of Object.keys(globals)) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

let seq = 0
function event(type: ConversationEventType, payload: Record<string, unknown>): ConversationEvent {
  seq++
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock',
    modelId: 'mock-model',
    type,
    createdAt: seq * 1000,
    payload,
  }
}

test('a failed send keeps the plan mode the user chose', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: false, message: 'The provider is restarting.' }))
  const chat = await mountChat({ capabilities: { planMode: true }, conversationMode: 'plan', sendTurn })
  try {
    await chat.act(async () => chat.type('Plan the migration'))
    await chat.act(async () => chat.enter())
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ mode: 'plan' })
    expect(chat.host.textContent).toContain('The provider is restarting.')
    // The retry must still be a plan-mode turn, not one with write access.
    expect(chat.agent().conversationMode).toBe('plan')
    await chat.act(async () => chat.enter())
    expect(sendTurn).toHaveBeenCalledTimes(2)
    expect(sendTurn.mock.calls[1][0]).toMatchObject({ mode: 'plan', message: 'Plan the migration' })
  } finally {
    await chat.unmount()
  }
})

test('opening a folded turn does not flash the jump-to-latest pill', async () => {
  const chat = await mountChat({
    events: [
      event('user_message', { turnId: 'a', text: 'Check the build' }),
      event('turn_started', { turnId: 'a' }),
      event('tool_started', { turnId: 'a', toolUseId: 'one', name: 'Read', input: { path: 'a.ts' } }),
      event('tool_output', { turnId: 'a', toolUseId: 'one', output: 'a', status: 'ok' }),
      event('tool_started', { turnId: 'a', toolUseId: 'two', name: 'Read', input: { path: 'b.ts' } }),
      event('tool_output', { turnId: 'a', toolUseId: 'two', output: 'b', status: 'ok' }),
      event('content_delta', { turnId: 'a', text: 'It builds.' }),
      event('turn_completed', { turnId: 'a' }),
    ],
  })
  try {
    const fold = chat.button('Worked for')
    expect(fold).toBeDefined()
    expect(chat.host.textContent).not.toContain('Jump to latest')
    await chat.act(async () => fold!.click())
    expect(chat.host.textContent).not.toContain('Jump to latest')
  } finally {
    await chat.unmount()
  }
})

test('a turn shows its cost only when the provider reports cost', async () => {
  const events = [
    event('user_message', { turnId: 'priced', text: 'Summarize' }),
    event('turn_started', { turnId: 'priced' }),
    event('content_delta', { turnId: 'priced', text: 'Done.' }),
    event('turn_completed', { turnId: 'priced', costUsd: 0.0123 }),
  ]
  for (const cost of [false, true]) {
    const chat = await mountChat({ events, capabilities: { cost } })
    try {
      expect(chat.host.textContent?.includes('$0.0123')).toBe(cost)
    } finally {
      await chat.unmount()
    }
  }
})
