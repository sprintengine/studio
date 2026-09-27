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

type SendTurn = (input: {
  mode?: string
  message?: string
  sessionId?: string
}) => Promise<{ ok: boolean; message?: string }>

// Mounts the whole chat view against a scripted conversation API, the way a
// person meets it: a transcript arrives over the session subscription and the
// composer and rows are driven through the DOM.
async function mountChat({
  events = [],
  capabilities = {},
  providerId = 'mock',
  modelId = 'mock-model',
  providerModels = [{ id: modelId }],
  agent: agentPatch = {},
  sendTurn = async () => ({ ok: false, message: 'Not scripted.' }),
  setModel,
  plugins,
}: {
  events?: ConversationEvent[]
  capabilities?: Record<string, unknown>
  providerId?: string
  modelId?: string
  providerModels?: { id: string; displayName?: string }[]
  agent?: Record<string, unknown>
  sendTurn?: SendTurn
  setModel?: (input: { sessionId: string; modelId: string }) => Promise<unknown>
  plugins?: unknown[]
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
        providers: [
          {
            id: providerId,
            displayName: providerId === 'mock' ? 'Mock' : 'Claude Code',
            providerType: providerId === 'mock' ? 'model-provider' : 'agent-harness',
            models: providerModels,
            capabilities,
          },
        ],
      }),
      conversationSecretStatus: async () => ({ ok: false, message: 'No secret' }),
      conversationSessionStart: async () => ({
        ok: true,
        session: {
          sessionId: 'session',
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId,
          modelId,
          status: 'ready',
          createdAt: 1,
          updatedAt: 1,
          capabilities,
        },
      }),
      conversationSessionSendTurn: sendTurn,
      conversationThreads: async () => ({ ok: true, threads: [] }),
      ...(setModel ? { conversationSessionSetModel: setModel } : {}),
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  const { default: AgentChatView } = await import('../AgentChatView')
  const { composerDraftStore } = await import('./draftStore')
  composerDraftStore().getState().remove('workspace', 'agent')
  if (plugins)
    useWorkspaceStore.setState({ pluginCatalogEntries: plugins as never, pluginCatalogStatus: 'ready' as never })
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
            conversation: { providerId, modelId },
            ...agentPatch,
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
    emit: (frame: ConversationSessionFrame) => frames.at(-1)?.(frame),
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

test('a turn goes out in the default mode: the chat has no plan toggle', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: false, message: 'The provider is restarting.' }))
  // Even an agent record left on plan mode by an older build sends a default
  // turn: plan mode has no control here any more, so it cannot be a state.
  const chat = await mountChat({ capabilities: { planMode: true }, agent: { conversationMode: 'plan' }, sendTurn })
  try {
    expect(chat.button('Plan')).toBeUndefined()
    await chat.act(async () => chat.type('Plan the migration'))
    await chat.act(async () => chat.enter())
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ mode: 'default', message: 'Plan the migration' })
    expect(chat.host.textContent).toContain('The provider is restarting.')
  } finally {
    await chat.unmount()
  }
})

test('the launcher’s prompt is sent as the first message the moment the chat is ready', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({ agent: { chatStartupPrompt: 'hi' }, sendTurn })
  try {
    await chat.act(async () => undefined)
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ message: 'hi' })
    expect(chat.agent().chatStartupPrompt, 'one-shot: a remount never sends it twice').toBeUndefined()
    expect(chat.host.querySelector('textarea')!.value, 'nothing is left in the composer for a second Enter').toBe('')
  } finally {
    await chat.unmount()
  }
})

test('the composer offers one engine chip — no plan toggle, no separate permission or effort pill, no dollars', async () => {
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'opus',
    capabilities: { approvals: true, permissionPresets: ['bypass', 'none'], reasoningEfforts: ['low', 'high'] },
  })
  try {
    const buttons = () => Array.from(chat.dom.window.document.querySelectorAll('button'))
    const chips = buttons().filter((item) => item.getAttribute('aria-label')?.startsWith('Engine:'))
    expect(chips).toHaveLength(1)
    for (const retired of ['Plan', 'Bypass permissions', 'CLI default', 'Auto']) {
      expect(
        buttons().some((item) => item.textContent?.trim() === retired),
        `no standalone “${retired}” control`,
      ).toBe(false)
    }
    expect(chat.host.textContent).not.toMatch(/\$\d/)
    // The chip opens the terminal agent's picker, locked to this chat's CLI.
    await chat.act(async () => chips[0].click())
    const rail = chat.dom.window.document.querySelector('[role="radiogroup"][aria-label="Provider"]')
    expect(rail?.querySelectorAll('[role="radio"]')).toHaveLength(1)
    expect(chat.dom.window.document.querySelector('[role="listbox"][aria-label="Agent runtime"]')).not.toBeNull()
  } finally {
    await chat.unmount()
  }
})

test('a chat named after its model is renamed from the agent-name pool', async () => {
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'claude-opus-5-5',
    providerModels: [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }],
    agent: { name: 'Opus 5.5 2' },
  })
  try {
    await chat.act(async () => undefined)
    const name = chat.agent().name
    expect(name).not.toMatch(/Opus/)
    expect(name?.trim()).toBeTruthy()
  } finally {
    await chat.unmount()
  }
})

test('a chat the person named keeps its name', async () => {
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'claude-opus-5-5',
    providerModels: [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }],
    agent: { name: 'Release checklist' },
  })
  try {
    await chat.act(async () => undefined)
    expect(chat.agent().name).toBe('Release checklist')
  } finally {
    await chat.unmount()
  }
})

test('the first message renders once, as its bubble, with no title row repeating it', async () => {
  const chat = await mountChat({
    events: [
      event('user_message', { turnId: 'hello', text: 'Check the build' }),
      event('turn_started', { turnId: 'hello' }),
      event('content_delta', { turnId: 'hello', text: 'It builds.' }),
      event('turn_completed', { turnId: 'hello' }),
    ],
  })
  try {
    expect(chat.host.textContent?.split('Check the build').length).toBe(2)
  } finally {
    await chat.unmount()
  }
})

test('the transcript takes the kit’s focus ring on keyboard focus only', async () => {
  const chat = await mountChat({ events: [event('user_message', { turnId: 'a', text: 'hello' })] })
  try {
    const scroller = chat.host.querySelector('[role="log"] > div')!
    expect(scroller.className).toContain('focus-visible:focus-ring-inset')
    expect(scroller.className).toContain('focus:outline-none')
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

test('a turn never shows a dollar figure, even when the provider reports one', async () => {
  const events = [
    event('user_message', { turnId: 'priced', text: 'Summarize' }),
    event('turn_started', { turnId: 'priced' }),
    event('content_delta', { turnId: 'priced', text: 'Done.' }),
    event('turn_completed', { turnId: 'priced', costUsd: 0.0123, durationMs: 1200 }),
  ]
  const chat = await mountChat({ events, capabilities: { cost: true } })
  try {
    expect(chat.host.textContent).not.toContain('$')
    // The elapsed time and Copy stay under the reply.
    expect(chat.button('Copy')).toBeDefined()
  } finally {
    await chat.unmount()
  }
})

test('a started chat switches models within its CLI from the full catalog, applied through the live session', async () => {
  const setModel = vi.fn(async (input: { sessionId: string; modelId: string }) => ({
    ok: true,
    session: {
      sessionId: input.sessionId,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'claude-agent',
      modelId: input.modelId,
      status: 'ready',
      createdAt: 1,
      updatedAt: 2,
      capabilities: { liveModelSwitch: true },
    },
    notice: 'The new model starts with your next message.',
  }))
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'claude-opus-5-5',
    capabilities: { liveModelSwitch: true },
    sendTurn: async () => ({ ok: true }),
    setModel,
    plugins: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        source: 'bundled',
        version: 1,
        binary: 'claude',
        modelSelection: {
          args: ['--model', '{{model}}'],
          options: [
            { id: 'claude-opus-5-5', label: 'Opus 5.5' },
            { id: 'claude-fable-5-1', label: 'Fable 5.1' },
          ],
        },
      },
    ],
  })
  try {
    // A first turn starts the live session.
    await chat.act(async () => chat.type('hello'))
    await chat.act(async () => chat.enter())
    const doc = chat.dom.window.document
    const chip = () =>
      Array.from(doc.querySelectorAll('button')).find((item) => item.getAttribute('aria-label')?.startsWith('Engine:'))!
    expect(chip().getAttribute('aria-label')).toBe('Engine: Opus 5.5')
    await chat.act(async () => chip().click())
    const rows = Array.from(doc.querySelectorAll('[role="listbox"][aria-label="Agent runtime"] [role="option"]'))
    const names = rows.map((row) => row.textContent ?? '')
    expect(
      names.some((name) => name.includes('Fable 5.1')),
      'the full catalog, not only the current model',
    ).toBe(true)
    expect(doc.body.textContent).not.toContain('model is set once the chat starts')
    const fable = rows.find((row) => row.textContent?.includes('Fable 5.1')) as HTMLElement
    await chat.act(async () => fable.click())
    expect(setModel).toHaveBeenCalledWith({ sessionId: 'session', modelId: 'claude-fable-5-1' })
    expect(chat.agent().conversation?.modelId).toBe('claude-fable-5-1')
    expect(chip().getAttribute('aria-label')).toBe('Engine: Fable 5.1')
    expect(chat.host.textContent).toContain('The new model starts with your next message.')
  } finally {
    await chat.unmount()
  }
})

test("a switch made from a paired device moves this chat's record, while one replayed from history does not", async () => {
  const replayed = event('session_updated', { modelId: 'replayed-model' })
  const chat = await mountChat({
    events: [event('user_message', { turnId: 't', text: 'hello' }), replayed],
    capabilities: { liveModelSwitch: true },
  })
  try {
    // History is history: the record may have moved since that switch.
    expect(chat.agent().conversation?.modelId).toBe('mock-model')
    await chat.act(async () =>
      chat.emit({ type: 'event', event: event('session_updated', { modelId: 'remote-model' }) }),
    )
    expect(chat.agent().conversation).toEqual({ providerId: 'mock', modelId: 'remote-model' })
    // An event that names no model (a notice, a native session id) leaves it.
    await chat.act(async () => chat.emit({ type: 'event', event: event('session_updated', { notice: 'Resumed.' }) }))
    expect(chat.agent().conversation?.modelId).toBe('remote-model')
  } finally {
    await chat.unmount()
  }
})
