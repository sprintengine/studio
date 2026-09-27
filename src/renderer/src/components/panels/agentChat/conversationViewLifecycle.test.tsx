import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import { ConversationRowFrame } from './conversationRowFrame'
import { useConversationScrollRestore } from './conversationScrollRestore'

test('row arrival animates only once and remembered scroll walks older pages exactly once', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  }
  Object.assign(globalThis, globals)
  const { act, createElement, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = document.createElement('div')
  const root = createRoot(container)
  const seen = new Set<string>(),
    restored = vi.fn(),
    loaded = vi.fn()
  const row = (live: boolean) =>
    createElement(ConversationRowFrame, {
      id: 'row',
      live,
      seen,
      flash: false,
      onFlashEnd: () => {},
      children: 'Message',
    })
  function Harness({ searching = false, fail = false }: { searching?: boolean; fail?: boolean }) {
    const [page, setPage] = useState(0)
    useConversationScrollRestore({
      memory: { rowId: 'remembered', offset: 17, atEnd: false },
      hydrated: true,
      searching,
      hasMore: page < 3,
      loadingEarlier: false,
      rows: [{ id: page === 2 ? 'remembered' : `page-${page}` }],
      loadEarlier: async () => {
        loaded()
        if (fail) throw new Error('History is unavailable.')
        await Promise.resolve()
        setPage((value) => value + 1)
      },
      restore: restored,
    })
    return null
  }
  try {
    await act(async () => root.render(row(false)))
    expect(container.firstElementChild?.className).toBe('')
    await act(async () => root.render(null))
    await act(async () => root.render(row(true)))
    expect(container.firstElementChild?.className).toBe('conversation-row-enter')
    await act(async () => root.render(null))
    await act(async () => root.render(row(true)))
    expect(container.firstElementChild?.className).toBe('')
    await act(async () => root.render(createElement(Harness)))
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 40))
    })
    expect(loaded).toHaveBeenCalledTimes(2)
    expect(restored).toHaveBeenCalledExactlyOnceWith(0, 17)
    await act(async () => root.render(createElement(Harness)))
    expect(loaded).toHaveBeenCalledTimes(2)
    expect(restored).toHaveBeenCalledTimes(1)
    for (const props of [{ searching: true }, { fail: true }]) {
      await act(async () => root.render(null))
      loaded.mockClear()
      restored.mockClear()
      await act(async () => root.render(createElement(Harness, props)))
      expect(loaded).toHaveBeenCalledTimes(props.fail ? 1 : 0)
      expect(restored).not.toHaveBeenCalled()
    }
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
