import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { ConversationThread } from '../../../../shared/conversation-index'
import type { Workspace } from '../../types/workspace'
import type { ConversationEvent } from '../../../../shared/conversation-runtime'

vi.mock('../../utils/conversationHistoryNavigation', () => ({
  openConversationHistory: vi.fn(),
}))

// A layout with a tab open on `open-agent`: its saved conversation is the tab,
// not history.
const layoutWithOpenAgent = {
  layout: {
    type: 'row',
    children: [{ type: 'tabset', children: [{ type: 'tab', component: 'agent', config: { agentId: 'open-agent' } }] }],
  },
}

test('closed history extends the chat stream and deletion requires confirmation', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const thread: ConversationThread = {
    agentId: 'closed-agent',
    title: 'A saved conversation',
    titleSource: 'user',
    model: 'model',
    providerId: 'provider',
    createdAt: 1,
    updatedAt: Date.now(),
    turnCount: 1,
    lastSeq: 2,
    firstUserText: 'Hello',
  }
  let threads = [thread, { ...thread, agentId: 'open-agent', title: 'Already open' }]
  const remove = vi.fn(async () => {
    threads = []
    return { ok: true }
  })
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationThreads: async ({ workspaceId }: { workspaceId: string }) =>
        workspaceId === 'missing' ? { ok: false, message: 'Workspace is unavailable.' } : { ok: true, threads },
      conversationDelete: remove,
      onConversationEvent: () => () => undefined,
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationHistoryRows } = await import('./ConversationHistoryRows')
  const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
  const { composerDraftStore } = await import('../panels/agentChat/draftStore')
  composerDraftStore().getState().put('workspace', 'closed-agent', { text: 'Unsent', skillIds: [], mentions: [] })
  composerDraftStore().getState().put('workspace', 'open-agent', { text: 'Keep me', skillIds: [], mentions: [] })
  composerDraftStore().flushDrafts()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ConfirmDialogProvider>
          <ConversationHistoryRows
            workspaces={[
              { id: 'workspace', name: 'Project', folderPath: '/project', layoutModel: layoutWithOpenAgent } as never,
              { id: 'missing', name: 'Offline project', folderPath: '/missing' } as Workspace,
            ]}
            sessions={[]}
          />
        </ConfirmDialogProvider>,
      ),
    )
    expect(host.textContent).toContain('A saved conversation')
    expect(host.textContent).not.toContain('Already open')
    // One folder that cannot be read is left out, with no banner over the rest.
    expect(host.textContent).not.toContain('could not load')
    const removeButton = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Delete')!
    await act(async () => removeButton.click())
    expect(remove).not.toHaveBeenCalled()
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete conversation',
    )!
    expect(confirm).toBeDefined()
    await act(async () => confirm.click())
    expect(remove).toHaveBeenCalledWith({
      workspaceRoot: '/project',
      workspaceId: 'workspace',
      agentId: 'closed-agent',
    })
    expect(host.textContent).not.toContain('A saved conversation')
    // The deleted conversation's unsent draft goes with it, from storage too.
    const stored = dom.window.localStorage.getItem('sprintengine-conversation-drafts') ?? ''
    expect(stored).not.toContain('Unsent')
    expect(stored).toContain('Keep me')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'Node',
      'Event',
      'CustomEvent',
      'IS_REACT_ACT_ENVIRONMENT',
    ]) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

async function mountHistory(options: {
  threadsFor: (workspaceId: string) => ConversationThread[] | null
  workspaces: Workspace[]
}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Node',
    'Event',
    'CustomEvent',
    'IS_REACT_ACT_ENVIRONMENT',
  ]
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const listeners = new Set<(event: ConversationEvent) => void>()
  const threads = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
    const list = options.threadsFor(workspaceId)
    return list ? { ok: true, threads: list } : { ok: false, message: 'Workspace is unavailable.' }
  })
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationThreads: threads,
      onConversationEvent: (listener: (event: ConversationEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationHistoryRows } = await import('./ConversationHistoryRows')
  const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = (workspaces: Workspace[]) =>
    act(async () =>
      root.render(
        <ConfirmDialogProvider>
          <ConversationHistoryRows workspaces={workspaces} sessions={[]} />
        </ConfirmDialogProvider>,
      ),
    )
  await render(options.workspaces)
  return {
    host,
    threads,
    act,
    render,
    emit(event: Partial<ConversationEvent>) {
      for (const listener of listeners) listener(event as ConversationEvent)
    },
    async cleanup() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const key of keys) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

const threadFixture = (agentId: string, updatedAt: number): ConversationThread => ({
  agentId,
  title: `Chat ${agentId}`,
  titleSource: 'user',
  model: 'model',
  providerId: 'provider',
  createdAt: 1,
  updatedAt,
  turnCount: 1,
  lastSeq: 2,
  firstUserText: 'Hello',
})

test('a turn ending reads only its own workspace again, and focus reads nothing', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const history = await mountHistory({
    threadsFor: (id) => [threadFixture(`${id}-agent`, Date.now())],
    workspaces: [
      { id: 'a', name: 'A', folderPath: '/a' } as Workspace,
      { id: 'b', name: 'B', folderPath: '/b' } as Workspace,
    ],
  })
  try {
    expect(history.threads).toHaveBeenCalledTimes(2)
    await history.act(async () => {
      window.dispatchEvent(new window.Event('focus'))
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(history.threads).toHaveBeenCalledTimes(2)
    await history.act(async () => {
      history.emit({ type: 'turn_completed', workspaceId: 'b' })
      history.emit({ type: 'session_updated', workspaceId: 'b' })
      history.emit({ type: 'content_delta', workspaceId: 'a' })
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(history.threads).toHaveBeenCalledTimes(3)
    expect(history.threads).toHaveBeenLastCalledWith({ workspaceId: 'b', workspaceRoot: '/b' })
    // A rename changes no key: nothing is read again.
    await history.render([
      { id: 'a', name: 'A renamed', folderPath: '/a' } as Workspace,
      { id: 'b', name: 'B', folderPath: '/b' } as Workspace,
    ])
    expect(history.threads).toHaveBeenCalledTimes(3)
    expect(history.host.textContent).toContain('A renamed')
    // A workspace that joins is read alone.
    await history.render([
      { id: 'a', name: 'A renamed', folderPath: '/a' } as Workspace,
      { id: 'b', name: 'B', folderPath: '/b' } as Workspace,
      { id: 'c', name: 'C', folderPath: '/c' } as Workspace,
    ])
    expect(history.threads).toHaveBeenCalledTimes(4)
    expect(history.threads).toHaveBeenLastCalledWith({ workspaceId: 'c', workspaceRoot: '/c' })
  } finally {
    await history.cleanup()
    vi.useRealTimers()
  }
})

test('the list shows the most recent chats first and folds the rest', async () => {
  const now = Date.now()
  const many = Array.from({ length: 25 }, (_, index) => threadFixture(`agent-${index}`, now - index * 60_000))
  const history = await mountHistory({
    threadsFor: () => many,
    workspaces: [{ id: 'a', name: 'A', folderPath: '/a' } as Workspace],
  })
  try {
    const titles = () => Array.from(history.host.querySelectorAll('.text-body')).map((node) => node.textContent)
    expect(titles()).toHaveLength(20)
    expect(titles()[0]).toBe('Chat agent-0')
    const more = Array.from(history.host.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('Show'),
    )!
    expect(more.textContent).toBe('Show 5 more')
    await history.act(async () => more.click())
    expect(titles()).toHaveLength(25)
  } finally {
    await history.cleanup()
  }
})

test('the banner is kept for when no history could be read at all', async () => {
  const history = await mountHistory({
    threadsFor: () => null,
    workspaces: [{ id: 'a', name: 'A', folderPath: '/a' } as Workspace],
  })
  try {
    expect(history.host.textContent).toContain('Conversation history could not load')
  } finally {
    await history.cleanup()
  }
})
