import { expect, test, vi } from 'vitest'
import { conversationJumpIndex } from './conversationSearchJump'
import type { ConversationTimelineRow } from './conversationTimeline'
import { clearConversationJump, usePendingConversationJump } from '../../../utils/conversationHistoryNavigation'
import { useConversationSearchJump } from './conversationSearchJump'

vi.mock('../../../utils/conversationHistoryNavigation', () => ({
  clearConversationJump: vi.fn(),
  usePendingConversationJump: vi.fn(),
}))

test('search locates the exact user sequence after earlier pages are prepended', () => {
  const row = (seq: number): ConversationTimelineRow => ({
    kind: 'user',
    id: `user-${seq}`,
    entry: { kind: 'user', id: `turn-${seq}`, seq, text: 'Hello' },
  })
  const rows = [row(20), row(40)]
  expect(conversationJumpIndex(rows, 5)).toBe(-1)
  expect(conversationJumpIndex([row(5), ...rows], 5)).toBe(0)
  expect(conversationJumpIndex([row(5), ...rows], 40)).toBe(2)
})

test('a checkpoint assistant is a fallback only when its user row is absent', () => {
  const assistant: ConversationTimelineRow = {
    kind: 'assistant',
    id: 'reply',
    entry: {
      kind: 'assistant',
      turnId: 'turn',
      text: 'Hello',
      reasoning: '',
      status: 'complete',
      checkpointTurnSeq: 4,
    },
    tools: [],
    decisions: [],
  }
  expect(conversationJumpIndex([assistant], 4)).toBe(0)
  expect(
    conversationJumpIndex(
      [assistant, { kind: 'user', id: 'user', entry: { kind: 'user', id: 'user', seq: 4, text: 'Hi' } }],
      4,
    ),
  ).toBe(1)
})

test('a jump walks multiple earlier pages before scrolling and stops after the match', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  })
  Object.assign(dom.window, { matchMedia: () => ({ matches: true }) })
  const { act, createElement, useState, useCallback } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const scroll = vi.fn(),
    reportError = vi.fn(),
    pause = vi.fn(),
    loaded = vi.fn()
  vi.mocked(usePendingConversationJump).mockReturnValue(5)
  vi.mocked(clearConversationJump).mockImplementation(() => {
    vi.mocked(usePendingConversationJump).mockReturnValue(null)
  })
  function Harness() {
    const [page, setPage] = useState(0)
    const rows: ConversationTimelineRow[] = [
      { kind: 'user', id: `user-${page}`, entry: { kind: 'user', id: 'turn', seq: [30, 10, 5][page], text: 'Hello' } },
    ]
    const loadEarlier = useCallback(async () => {
      loaded()
      await Promise.resolve()
      setPage((value) => value + 1)
    }, [])
    useConversationSearchJump({
      workspaceId: 'workspace',
      agentId: 'agent',
      rows,
      hydrated: true,
      hasMore: page < 2,
      loadingEarlier: false,
      loadEarlier,
      scrollToRow: scroll,
      pauseFollowing: pause,
      reportError,
    })
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => {
      root.render(createElement(Harness))
    })
    await act(async () => {
      await new Promise((done) => dom.window.setTimeout(done, 40))
    })
    expect(loaded).toHaveBeenCalledTimes(2)
    expect(scroll).toHaveBeenCalledWith(0, 'user-2')
    expect(reportError).not.toHaveBeenCalled()
    expect(clearConversationJump).toHaveBeenCalledWith('workspace', 'agent')
  } finally {
    await act(async () => root.unmount())
    vi.clearAllMocks()
    dom.window.close()
    for (const key of [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'Node',
      'IS_REACT_ACT_ENVIRONMENT',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ]) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
