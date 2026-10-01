import { afterEach, expect, test, vi } from 'vitest'
import type { ConversationThread } from '../../../../shared/conversation-index'
import { createConversationHistoryProvider } from './conversationHistoryProvider'
import { openConversationHistory } from '../../utils/conversationHistoryNavigation'

vi.mock('../../utils/conversationHistoryNavigation', () => ({ openConversationHistory: vi.fn() }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
const thread: ConversationThread = {
  agentId: 'agent',
  title: 'Find matches',
  titleSource: 'user',
  createdAt: 1,
  updatedAt: 2,
  turnCount: 3,
  model: 'model',
  providerId: 'provider',
  lastSeq: 50,
  firstUserText: 'Hello',
}
const context = { workspaceRoot: '/project', workspaceId: 'workspace', scope: 'conversations' as const, close: vi.fn() }

test('title rows precede content hits and hits reopen the original agent at its sequence', async () => {
  vi.stubGlobal('window', {
    api: {
      conversationThreads: async () => ({ ok: true, threads: [thread] }),
      conversationSearch: async () => ({ ok: true, hits: [{ agentId: 'agent', seq: 20, snippet: 'the match here' }] }),
      conversationCancelSearch: vi.fn(async () => undefined),
    },
  })
  const rows = await createConversationHistoryProvider().load('match', context)
  expect(rows.map((row) => row.badge)).toEqual(['Saved chat', 'Message'])
  rows[1].run()
  expect(openConversationHistory).toHaveBeenCalledWith('workspace', thread, 20)
  expect(context.close).toHaveBeenCalledOnce()
})

test('superseding a search cancels main work and discards late results', async () => {
  let resolve!: (value: unknown) => void
  const cancel = vi.fn(async () => undefined)
  vi.stubGlobal('window', {
    api: {
      conversationThreads: async () => ({ ok: true, threads: [thread] }),
      conversationSearch: () =>
        new Promise((done) => {
          resolve = done
        }),
      conversationCancelSearch: cancel,
    },
  })
  const provider = createConversationHistoryProvider()
  const pending = provider.load('match', context)
  await vi.waitFor(() => expect(resolve).toBeDefined())
  provider.cancel?.()
  expect(cancel).toHaveBeenCalledWith({ requestId: expect.any(String) })
  resolve({ ok: true, hits: [{ agentId: 'agent', seq: 20, snippet: 'match' }] })
  expect(await pending).toEqual([])
})

test('empty queries list saved threads without scanning transcripts', async () => {
  const search = vi.fn()
  vi.stubGlobal('window', {
    api: { conversationThreads: async () => ({ ok: true, threads: [thread] }), conversationSearch: search },
  })
  const rows = await createConversationHistoryProvider().load('', context)
  expect(rows).toHaveLength(1)
  expect(search).not.toHaveBeenCalled()
})

test('publishes title and streamed content batches before the final scan resolves', async () => {
  let receive!: (batch: { requestId: string; hits: { agentId: string; seq: number; snippet: string }[] }) => void
  const stop = vi.fn()
  const publish = vi.fn()
  vi.stubGlobal('window', {
    api: {
      conversationThreads: async () => ({ ok: true, threads: [thread] }),
      onConversationSearchBatch: (callback: typeof receive) => {
        receive = callback
        return stop
      },
      conversationSearch: async ({ requestId }: { requestId: string }) => {
        const hits = [{ agentId: 'agent', seq: 20, snippet: 'match' }]
        receive({ requestId: 'other-window-request', hits })
        receive({ requestId, hits })
        expect(publish).toHaveBeenCalledTimes(2)
        expect(publish.mock.calls[1][0]).toHaveLength(2)
        return { ok: true, hits }
      },
    },
  })
  const rows = await createConversationHistoryProvider().load('match', context, publish)
  expect(rows).toHaveLength(2)
  expect(stop).toHaveBeenCalledOnce()
})
