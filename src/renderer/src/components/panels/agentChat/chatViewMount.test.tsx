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

// Decoding an image needs a real <img> and canvas, which jsdom lacks; what the
// composer does with the decoded attachment is what these tests drive.
vi.mock('./imageAttachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./imageAttachments')>()),
  readImageAttachment: async (file: File, id: string) => ({
    id,
    mediaType: file.type || 'image/png',
    dataBase64: 'iVBORw0KGgo=',
    name: file.name,
    byteLength: 8,
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
    // The elapsed time and the copy glyph stay under the reply.
    expect(chat.host.querySelector('button[aria-label="Copy reply"]')).not.toBeNull()
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

// A running turn the test holds open: its send settles only when released,
// the way a local send does once the whole turn has streamed.
function runningTurnSend() {
  const calls: Array<Record<string, unknown>> = []
  let release = () => undefined as void
  const sendTurn = vi.fn<SendTurn>(async (input) => {
    calls.push(input as Record<string, unknown>)
    if ((input as { steer?: boolean }).steer) return { ok: true }
    await new Promise<void>((resolve) => (release = resolve))
    return { ok: true }
  })
  return { sendTurn, calls, release: () => release() }
}

test('a message queued behind a running turn is handed to it with Send now', async () => {
  const turn = runningTurnSend()
  const chat = await mountChat({ capabilities: { steer: true }, sendTurn: turn.sendTurn })
  try {
    await chat.act(async () => chat.type('Investigate the flaky test'))
    await chat.act(async () => chat.enter())
    const localTurnId = turn.calls[0]?.localTurnId
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('user_message', { turnId: 't1', text: 'x', localTurnId }) })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't1' }) })
    })
    await chat.act(async () => chat.type('Use the staging config'))
    await chat.act(async () => chat.enter())
    expect(turn.sendTurn, 'a message committed mid-turn waits').toHaveBeenCalledOnce()
    expect(chat.host.querySelector('[aria-label="Queued message"]')?.textContent).toContain('Use the staging config')

    await chat.act(async () => chat.button('Send now')!.click())
    expect(turn.calls[1]).toMatchObject({ message: 'Use the staging config', steer: true })
    expect(chat.host.querySelector('[aria-label="Queued message"]')).toBeNull()
    // The steered message is a bubble in the transcript straight away.
    expect(chat.host.textContent).toContain('Use the staging config')
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('⌘↵ mid-turn sends the draft now; a provider without steering stops the turn instead', async () => {
  const turn = runningTurnSend()
  const interrupt = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn: turn.sendTurn })
  // The stand-in API has no Stop; this case needs one.
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.conversationSessionInterrupt = interrupt
  try {
    await chat.act(async () => chat.type('Investigate the flaky test'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't2' }) })
    })
    await chat.act(async () => chat.type('Stop, wrong branch'))
    expect(chat.host.textContent).not.toContain('Stop and send')
    await chat.act(async () => {
      chat.host.querySelector('textarea')!.dispatchEvent(
        new chat.dom.window.KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    expect(interrupt).toHaveBeenCalledOnce()
    expect(turn.sendTurn, 'the draft waits in the queue for the stopped turn').toHaveBeenCalledOnce()
    expect(chat.button('Stop and send')).toBeDefined()
    expect(chat.host.querySelector('textarea')!.value).toBe('')
  } finally {
    turn.release()
    await chat.unmount()
  }
})

// Starts a turn and queues a second message behind it, the way the steer
// cases below all begin.
async function queueBehindRunningTurn(chat: Awaited<ReturnType<typeof mountChat>>, calls: Record<string, unknown>[]) {
  await chat.act(async () => chat.type('Investigate the flaky test'))
  await chat.act(async () => chat.enter())
  await chat.act(async () => {
    chat.emit({
      type: 'event',
      event: event('user_message', { turnId: 't1', text: 'x', localTurnId: calls[0]?.localTurnId }),
    })
    chat.emit({ type: 'event', event: event('turn_started', { turnId: 't1' }) })
  })
  await chat.act(async () => chat.type('Use the staging config'))
  await chat.act(async () => chat.enter())
}

test('a steer that fails after its message landed reports the failure and is not sent a second time', async () => {
  const calls: Array<Record<string, unknown>> = []
  let failSteer = () => undefined as void
  const sendTurn = vi.fn<SendTurn>(async (input) => {
    calls.push(input as Record<string, unknown>)
    if ((input as { steer?: boolean }).steer) {
      await new Promise<void>((resolve) => (failSteer = resolve))
      return { ok: false, message: 'The agent stopped unexpectedly.' }
    }
    return { ok: true }
  })
  const chat = await mountChat({ capabilities: { steer: true }, sendTurn })
  try {
    await queueBehindRunningTurn(chat, calls)
    await chat.act(async () => chat.button('Send now')!.click())
    expect(calls[1]).toMatchObject({ message: 'Use the staging config', steer: true })
    await chat.act(async () => {
      chat.emit({
        type: 'event',
        event: event('user_message', {
          turnId: 't2',
          text: 'Use the staging config',
          localTurnId: calls[1].localTurnId,
        }),
      })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't2' }) })
    })
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_failed', { turnId: 't2', reason: 'runtime' }) })
      failSteer()
    })
    expect(sendTurn, 'the message is already in the conversation').toHaveBeenCalledTimes(2)
    expect(chat.host.querySelector('[aria-label="Queued message"]')).toBeNull()
    expect(chat.host.textContent).toContain('The agent stopped unexpectedly.')
  } finally {
    await chat.unmount()
  }
})

test('a steer refused before its message landed goes back to the queue', async () => {
  const turn = runningTurnSend()
  const sendTurn = vi.fn<SendTurn>(async (input) =>
    (input as { steer?: boolean }).steer
      ? { ok: false, message: 'This agent cannot take a message while it is working.' }
      : turn.sendTurn(input),
  )
  const chat = await mountChat({ capabilities: { steer: true }, sendTurn })
  try {
    await queueBehindRunningTurn(chat, turn.calls)
    await chat.act(async () => chat.button('Send now')!.click())
    expect(chat.host.querySelector('[aria-label="Queued message"]')?.textContent).toContain('Use the staging config')
    expect(chat.host.textContent).toContain('This agent cannot take a message while it is working.')
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('Stop and send keeps the queued message until the stopped send settles, then sends it', async () => {
  const turn = runningTurnSend()
  const interrupt = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn: turn.sendTurn })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.conversationSessionInterrupt = interrupt
  try {
    await queueBehindRunningTurn(chat, turn.calls)
    await chat.act(async () => chat.button('Stop and send')!.click())
    expect(interrupt).toHaveBeenCalledOnce()
    // The turn ends on screen before the send that started it has settled.
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_failed', { turnId: 't1', reason: 'interrupted' }) })
    })
    expect(turn.sendTurn).toHaveBeenCalledOnce()
    expect(chat.host.querySelector('[aria-label="Queued message"]')?.textContent).toContain('Use the staging config')
    await chat.act(async () => turn.release())
    expect(turn.sendTurn).toHaveBeenCalledTimes(2)
    expect(turn.calls[1]).toMatchObject({ message: 'Use the staging config' })
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('the drop overlay leaves with the drag, however many rows it crossed or lost on the way', async () => {
  const chat = await mountChat({ capabilities: { images: true } })
  const doc = chat.dom.window.document
  const drag = (type: string, target: EventTarget, relatedTarget: EventTarget | null = null) => {
    const dragEvent = new chat.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget })
    Object.defineProperty(dragEvent, 'dataTransfer', { value: { types: ['Files'], items: [], files: [] } })
    target.dispatchEvent(dragEvent)
  }
  const overlay = () => chat.host.textContent?.includes('Drop to attach')
  try {
    const composer = chat.host.querySelector('textarea')!
    const inside = chat.host.querySelector('button')!
    // Two enters, as crossing a row and then the composer reports them, and
    // only one leave: the row was removed before it could report its own.
    await chat.act(async () => {
      drag('dragenter', inside)
      drag('dragenter', composer)
    })
    expect(overlay()).toBe(true)
    await chat.act(async () => drag('dragleave', composer, inside))
    expect(overlay(), 'moving within the panel keeps it').toBe(true)
    await chat.act(async () => drag('dragleave', composer, doc.body))
    expect(overlay(), 'leaving the panel clears it').toBe(false)

    await chat.act(async () => drag('dragenter', composer))
    expect(overlay()).toBe(true)
    await chat.act(async () => {
      chat.dom.window.dispatchEvent(new chat.dom.window.Event('dragend'))
    })
    expect(overlay(), 'a drag that ends anywhere clears it').toBe(false)
  } finally {
    await chat.unmount()
  }
})

test('a pasted path to an image in the workspace is typed, not attached', async () => {
  const chat = await mountChat({ capabilities: { images: true } })
  const readImageDataUrl = vi.fn(async () => 'data:image/png;base64,iVBORw0K')
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.readImageDataUrl = readImageDataUrl
  try {
    const paste = new chat.dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], files: [], types: ['text/plain'], getData: () => '/Users/dev/project/public/logo.png' },
    })
    await chat.act(async () => {
      chat.host.querySelector('textarea')!.dispatchEvent(paste)
    })
    expect(paste.defaultPrevented, 'the agent can open it itself').toBe(false)
    expect(readImageDataUrl).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('a pasted image path that can no longer be read goes in as text, with the reason', async () => {
  const chat = await mountChat({ capabilities: { images: true } })
  const readImageDataUrl = vi.fn(async () => {
    throw new Error("Error invoking remote method 'fs:read-image-data-url': Error: ENOENT: no such file")
  })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.readImageDataUrl = readImageDataUrl
  try {
    const pasted = "'/var/folders/x1/T/TemporaryItems/Screenshot 2026-09-27 at 22.41.31.png'"
    const paste = new chat.dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], files: [], types: ['text/plain'], getData: () => pasted },
    })
    await chat.act(async () => {
      chat.host.querySelector('textarea')!.dispatchEvent(paste)
    })
    expect(paste.defaultPrevented, 'the path is read rather than typed').toBe(true)
    expect(readImageDataUrl).toHaveBeenCalledWith(
      '/var/folders/x1/T/TemporaryItems/Screenshot 2026-09-27 at 22.41.31.png',
    )
    expect(chat.host.querySelector('textarea')!.value).toBe(pasted)
    expect(chat.host.textContent).toContain(
      'Could not attach Screenshot 2026-09-27 at 22.41.31.png: the file no longer exists.',
    )
  } finally {
    await chat.unmount()
  }
})

test('a send that fails offers Retry, which sends that message again and empties the composer', async () => {
  const sendTurn = vi
    .fn<SendTurn>()
    .mockResolvedValueOnce({ ok: false, message: 'The provider is restarting.' })
    .mockResolvedValueOnce({ ok: true })
  const chat = await mountChat({ sendTurn })
  try {
    await chat.act(async () => chat.type('Rerun the migration'))
    await chat.act(async () => chat.enter())
    expect(chat.host.textContent).toContain('The provider is restarting.')
    expect(chat.host.querySelector('textarea')!.value, 'the message is handed back').toBe('Rerun the migration')
    await chat.act(async () => chat.button('Retry')!.click())
    expect(sendTurn).toHaveBeenCalledTimes(2)
    expect(sendTurn.mock.calls[1][0]).toMatchObject({ message: 'Rerun the migration' })
    expect(chat.host.querySelector('textarea')!.value).toBe('')
    expect(chat.button('Retry')).toBeUndefined()
  } finally {
    await chat.unmount()
  }
})

test('Retry sends the failed message as it was, even after the composer was edited', async () => {
  const sendTurn = vi
    .fn<SendTurn>()
    .mockResolvedValueOnce({ ok: false, message: 'The provider is restarting.' })
    .mockResolvedValueOnce({ ok: true })
  const chat = await mountChat({ sendTurn })
  try {
    await chat.act(async () => chat.type('Rerun the migration'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => chat.type('Something else entirely'))
    await chat.act(async () => chat.button('Retry')!.click())
    expect(sendTurn.mock.calls[1][0]).toMatchObject({ message: 'Rerun the migration' })
    expect(chat.host.querySelector('textarea')!.value).toBe('Something else entirely')
  } finally {
    await chat.unmount()
  }
})

test('Retry after an edit takes the failed send’s images with it, so the next send does not upload them again', async () => {
  const sendTurn = vi
    .fn<SendTurn>()
    .mockResolvedValueOnce({ ok: false, message: 'The provider is restarting.' })
    .mockResolvedValue({ ok: true })
  const chat = await mountChat({ capabilities: { images: true }, sendTurn })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.readImageDataUrl = async () =>
    'data:image/png;base64,iVBORw0KGgo='
  const attached = () => chat.host.querySelector('[aria-label="Remove shot.png"]')
  try {
    const paste = new chat.dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], files: [], types: ['text/plain'], getData: () => '/Users/dev/Desktop/shot.png' },
    })
    await chat.act(async () => {
      chat.host.querySelector('textarea')!.dispatchEvent(paste)
    })
    expect(attached(), 'the pasted image is on the composer').not.toBeNull()
    await chat.act(async () => chat.type('What is wrong in this screenshot?'))
    await chat.act(async () => chat.enter())
    expect(attached(), 'a failed send hands its image back').not.toBeNull()
    await chat.act(async () => chat.type('Something else entirely'))
    await chat.act(async () => chat.button('Retry')!.click())
    expect(sendTurn.mock.calls[1][0]).toMatchObject({ message: 'What is wrong in this screenshot?' })
    expect(chat.host.querySelector('textarea')!.value).toBe('Something else entirely')
    expect(attached(), 'the retry took the image').toBeNull()
  } finally {
    await chat.unmount()
  }
})

test('an error that is not a failed send has no Retry', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({
    capabilities: { images: true },
    sendTurn,
    events: [event('user_message', { turnId: 'a', text: 'Earlier message' })],
  })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.readImageDataUrl = async () => {
    throw new Error('ENOENT: no such file')
  }
  try {
    const paste = new chat.dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], files: [], types: ['text/plain'], getData: () => '/tmp/gone/Screenshot.png' },
    })
    await chat.act(async () => {
      chat.host.querySelector('textarea')!.dispatchEvent(paste)
    })
    expect(chat.host.textContent).toContain('Could not attach Screenshot.png')
    expect(chat.button('Retry'), 'nothing to send again').toBeUndefined()
    expect(sendTurn).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('Esc in the composer stops a running turn, and does nothing while the chat is idle', async () => {
  const turn = runningTurnSend()
  const interrupt = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn: turn.sendTurn })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.conversationSessionInterrupt = interrupt
  const escape = () =>
    chat.host
      .querySelector('textarea')!
      .dispatchEvent(new chat.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  try {
    await chat.act(async () => escape())
    expect(interrupt, 'no turn to stop').not.toHaveBeenCalled()
    await chat.act(async () => chat.type('Investigate the flaky test'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't1' }) })
    })
    await chat.act(async () => escape())
    expect(interrupt).toHaveBeenCalledOnce()
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('Esc in the composer leaves a turn that is waiting on a request alone', async () => {
  const turn = runningTurnSend()
  const interrupt = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn: turn.sendTurn, capabilities: { approvals: true } })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.conversationSessionInterrupt = interrupt
  try {
    await chat.act(async () => chat.type('Run the tests'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't1' }) })
      chat.emit({
        type: 'event',
        event: event('approval_requested', {
          turnId: 't1',
          requestId: 'approval-1',
          action: 'Bash',
          summary: 'npm test',
          input: { command: 'npm test' },
        }),
      })
    })
    await chat.act(async () =>
      chat.host
        .querySelector('textarea')!
        .dispatchEvent(
          new chat.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
    )
    expect(interrupt, 'the turn is paused on the request, not stopped').not.toHaveBeenCalled()
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('copying a selection of the conversation puts its markdown on the clipboard', async () => {
  const chat = await mountChat({
    events: [
      event('user_message', { turnId: 'a', text: 'Summarise the change' }),
      event('turn_started', { turnId: 'a' }),
      event('content_delta', { turnId: 'a', text: '## Result\n\nThe **cache** is fixed.' }),
      event('turn_completed', { turnId: 'a' }),
    ],
  })
  try {
    const log = chat.host.querySelector('[role="log"]')!
    const heading = Array.from(log.querySelectorAll('h2')).find((node) => node.textContent === 'Result')!
    const paragraph = Array.from(log.querySelectorAll('p')).find((node) => node.textContent === 'The cache is fixed.')!
    const range = chat.dom.window.document.createRange()
    range.setStartBefore(heading)
    range.setEndAfter(paragraph)
    const selection = chat.dom.window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const written: Record<string, string> = {}
    const copy = new chat.dom.window.Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(copy, 'clipboardData', {
      value: { setData: (type: string, value: string) => void (written[type] = value) },
    })
    await chat.act(async () => {
      paragraph.dispatchEvent(copy)
    })
    expect(copy.defaultPrevented).toBe(true)
    expect(written['text/plain']).toBe('## Result\n\nThe **cache** is fixed.')
    expect(written['text/html']).toContain('<h2>Result</h2>')
  } finally {
    await chat.unmount()
  }
})

// The `/` menu over a Claude Code chat whose CLI reported two commands.
async function mountCommandChat(sendTurn: SendTurn = async () => ({ ok: true })) {
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'opus',
    capabilities: { reasoningEfforts: ['low', 'high'] },
    sendTurn,
  })
  const { resetConversationCommandsCache } = await import('./useConversationCommands')
  resetConversationCommandsCache()
  Object.assign(chat.dom.window.api, {
    conversationCommands: async ({ cli, cwd }: { cli: string; cwd: string }) => ({
      cli,
      cwd,
      fetchedAt: Date.now(),
      commands: [
        { name: 'compact', description: 'Summarize the conversation', source: 'cli' },
        { name: 'review', description: 'Review a pull request', argumentHint: '[pr-number]', source: 'custom' },
      ],
    }),
  })
  const field = () => chat.host.querySelector('textarea')!
  const key = (name: string) =>
    chat.act(async () => {
      field().dispatchEvent(
        new chat.dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      )
    })
  const options = () => Array.from(chat.dom.window.document.querySelectorAll('[role="option"]'))
  return { ...chat, field, key, options }
}

test('picking a command from the / menu inserts it as text with the caret after it, and shows what it takes', async () => {
  const chat = await mountCommandChat()
  try {
    await chat.act(async () => chat.type('/rev'))
    expect(chat.field().getAttribute('aria-expanded')).toBe('true')
    expect(chat.options().map((row) => row.textContent)).toEqual([expect.stringContaining('/review')])
    await chat.key('Enter')
    expect(chat.field().value).toBe('/review ')
    expect(chat.field().selectionStart).toBe('/review '.length)
    expect(chat.field().getAttribute('aria-expanded')).toBe('false')
    expect(chat.host.textContent).toContain('/review [pr-number]')
    await chat.act(async () => chat.type('/review 12'))
    expect(chat.host.textContent, 'the hint goes once the person types').not.toContain('[pr-number]')
  } finally {
    await chat.unmount()
  }
})

test('/model from the menu opens the model picker and leaves nothing to send', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountCommandChat(sendTurn)
  try {
    await chat.act(async () => chat.type('/mod'))
    expect(chat.options()[0]?.textContent).toContain('/model')
    await chat.key('Enter')
    expect(chat.field().value).toBe('')
    expect(chat.dom.window.document.querySelector('[role="listbox"][aria-label="Agent runtime"]')).not.toBeNull()
    expect(sendTurn).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('/effort from the menu steps the chat to its next effort', async () => {
  const chat = await mountCommandChat()
  try {
    await chat.act(async () => chat.type('/eff'))
    await chat.key('Tab')
    expect(chat.field().value).toBe('')
    expect(chat.agent().conversationReasoningEffort).toBe('low')
  } finally {
    await chat.unmount()
  }
})

test('a / command the menu does not know is sent as typed', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountCommandChat(sendTurn)
  try {
    await chat.act(async () => chat.type('/zzz'))
    expect(chat.options()).toHaveLength(0)
    await chat.key('Enter')
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ message: '/zzz' })
  } finally {
    await chat.unmount()
  }
})
