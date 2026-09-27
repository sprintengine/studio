import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { ConversationThread } from '../../../../shared/conversation-index'
import type { Workspace } from '../../types/workspace'

vi.mock('../../utils/conversationHistoryNavigation', () => ({
  layoutHasConversation: (_layout: unknown, id: string) => id === 'open-agent',
  openConversationHistory: vi.fn(),
}))

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
              { id: 'workspace', name: 'Project', folderPath: '/project' } as Workspace,
              { id: 'missing', name: 'Offline project', folderPath: '/missing' } as Workspace,
            ]}
            sessions={[]}
          />
        </ConfirmDialogProvider>,
      ),
    )
    expect(host.textContent).toContain('A saved conversation')
    expect(host.textContent).not.toContain('Already open')
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
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
