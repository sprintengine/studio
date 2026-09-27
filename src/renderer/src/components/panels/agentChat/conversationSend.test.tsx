import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { ConversationSessionFrame, ConversationSubscribeInput } from '../../../../../shared/conversation-runtime'

test('a failed send keeps the plan mode the user chose', async () => {
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
  const capabilities = { planMode: true }
  const frames: ((frame: ConversationSessionFrame) => void)[] = []
  const sendTurn = vi.fn(async (_input: { mode?: string; message?: string }) => ({
    ok: false as const,
    message: 'The provider is restarting.',
  }))
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
            conversationMode: 'plan',
          },
        },
      },
    ] as never,
  })
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AgentChatView, { workspaceId: 'workspace', agentId: 'agent' })))
    await act(async () => {
      frames.at(-1)?.({ type: 'snapshot', page: { events: [], hasMore: false, beforeCursor: null } })
      frames.at(-1)?.({ type: 'synchronized', seq: 0 })
    })
    const composer = host.querySelector('textarea')!
    const type = (value: string) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, value)
      composer.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }
    const enter = () =>
      composer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await act(async () => type('Plan the migration'))
    await act(async () => enter())
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ mode: 'plan' })
    expect(host.textContent).toContain('The provider is restarting.')
    // The retry must still be a plan-mode turn, not one with write access.
    expect(useWorkspaceStore.getState().workspaces[0].agents.agent.conversationMode).toBe('plan')
    await act(async () => enter())
    expect(sendTurn).toHaveBeenCalledTimes(2)
    expect(sendTurn.mock.calls[1][0]).toMatchObject({ mode: 'plan', message: 'Plan the migration' })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
