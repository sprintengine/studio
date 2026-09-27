import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'

test('debounces persistence, flushes on unmount, restores failed sends and clears acknowledged sends', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  vi.useFakeTimers()
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useComposerDraft } = await import('./useComposerDraft')
  const { composerDraftStore } = await import('./draftStore')
  let hook!: ReturnType<typeof useComposerDraft>
  function Harness() {
    hook = useComposerDraft('workspace', 'agent')
    return null
  }
  let root = createRoot(document.createElement('div'))
  try {
    await act(async () => {
      root.render(createElement(Harness))
    })
    await act(async () => {
      hook.setDraft('unfinished')
      await vi.advanceTimersByTimeAsync(399)
    })
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('unfinished')
    await act(async () => {
      hook.setDraft('new unsaved text')
    })
    await act(async () => root.unmount())
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('new unsaved text')
    root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(createElement(Harness))
    })
    expect(hook.draft).toBe('new unsaved text')
    let token: symbol | null = null
    await act(async () => {
      token = hook.beginDraftSend(hook.draft)
    })
    expect(hook.draft).toBe('')
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('new unsaved text')
    await act(async () => {
      hook.finishDraftSend(token, false)
    })
    expect(hook.draft).toBe('new unsaved text')
    await act(async () => {
      token = hook.beginDraftSend(hook.draft)
    })
    await act(async () => {
      hook.finishDraftSend(token, true)
    })
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('')
    await act(async () => {
      hook.setDraft('queued')
      hook.clearDraft()
    })
    expect(hook.draft).toBe('')
    await act(async () => {
      hook.setDraft('sending')
      token = hook.beginDraftSend('sending')
      hook.setDraft('newer draft')
      hook.finishDraftSend(token, true)
    })
    expect(hook.draft).toBe('newer draft')
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('newer draft')
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
