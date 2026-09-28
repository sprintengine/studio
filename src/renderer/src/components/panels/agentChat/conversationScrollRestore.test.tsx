import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ConversationScrollMemory } from './conversationViewState'

let dom: JSDOM
let previous: PropertyDescriptorMap

beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  })
})

afterEach(() => {
  dom.window.close()
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'KeyboardEvent', 'IS_REACT_ACT_ENVIRONMENT']) {
    if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
    else Reflect.deleteProperty(globalThis, key)
  }
  for (const key of ['requestAnimationFrame', 'cancelAnimationFrame']) {
    if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
    else Reflect.deleteProperty(globalThis, key)
  }
})

/**
 * Mounts the restore over a transcript whose history arrives one page per
 * `loadEarlier`. `anchorPage` is the page the remembered row is on, or
 * undefined when it is in none of them.
 */
async function mountRestore(options: {
  memory: ConversationScrollMemory
  pages?: number
  anchorPage?: number
  loadDelayMs?: number
}) {
  const { act, createElement, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useConversationScrollRestore } = await import('./conversationScrollRestore')
  const scroller = document.createElement('div')
  const editor = document.createElement('textarea')
  scroller.append(editor)
  document.body.append(scroller)
  const root = createRoot(document.createElement('div'))
  const restore = vi.fn()
  const fallbackToEnd = vi.fn()
  const loadEarlier = vi.fn()
  let isRestoring = () => false
  function Harness() {
    const [page, setPage] = useState(0)
    const rows = Array.from({ length: page + 1 }, (_, index) => ({
      id: index === options.anchorPage ? options.memory.rowId! : `page-${index}`,
    })).reverse()
    ;({ isRestoring } = useConversationScrollRestore({
      memory: options.memory,
      hydrated: true,
      searching: false,
      hasMore: page < (options.pages ?? 5),
      loadingEarlier: false,
      rows,
      loadEarlier: async () => {
        loadEarlier()
        await new Promise((resolve) => dom.window.setTimeout(resolve, options.loadDelayMs ?? 0))
        setPage((value) => value + 1)
      },
      restore,
      fallbackToEnd,
      scrollRoot: () => scroller,
    }))
    return null
  }
  await act(async () => root.render(createElement(Harness)))
  // One act per few milliseconds: an async act flushes the renders it queued
  // only as it exits, and each page of history is a render away from the next.
  const settle = async (ms = 60) => {
    for (let waited = 0; waited < ms; waited += 5)
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5))
      })
  }
  return {
    scroller,
    editor,
    restore,
    fallbackToEnd,
    loadEarlier,
    isRestoring: () => isRestoring(),
    settle,
    unmount: () => act(async () => root.unmount()),
  }
}

test('a remembered row older than the first page is paged in and then restored', async () => {
  const view = await mountRestore({ memory: { rowId: 'user:u3', offset: 24, atEnd: false }, anchorPage: 2 })
  expect(view.isRestoring()).toBe(true)
  await view.settle()
  expect(view.loadEarlier).toHaveBeenCalledTimes(2)
  expect(view.restore).toHaveBeenCalledExactlyOnceWith(0, 24)
  expect(view.fallbackToEnd).not.toHaveBeenCalled()
  expect(view.isRestoring()).toBe(false)
  await view.unmount()
})

test('a row that is no longer in the transcript falls back to the end', async () => {
  const view = await mountRestore({ memory: { rowId: 'user:rewound', offset: 8, atEnd: false }, pages: 3 })
  await view.settle()
  expect(view.loadEarlier).toHaveBeenCalledTimes(3)
  expect(view.restore).not.toHaveBeenCalled()
  expect(view.fallbackToEnd).toHaveBeenCalledOnce()
  expect(view.isRestoring()).toBe(false)
  await view.unmount()
})

test('the search for a lost row stops after a bounded number of pages', async () => {
  const { MAX_RESTORE_PAGES } = await import('./conversationScrollRestore')
  const view = await mountRestore({ memory: { rowId: 'user:gone', offset: 0, atEnd: false }, pages: 1_000 })
  await view.settle(400)
  expect(view.loadEarlier).toHaveBeenCalledTimes(MAX_RESTORE_PAGES)
  expect(view.fallbackToEnd).toHaveBeenCalledOnce()
  await view.unmount()
})

test('a wheel during the restore hands the scroll to the reader', async () => {
  const view = await mountRestore({
    memory: { rowId: 'user:u3', offset: 24, atEnd: false },
    anchorPage: 3,
    loadDelayMs: 20,
  })
  view.scroller.dispatchEvent(new dom.window.WheelEvent('wheel', { bubbles: true }))
  expect(view.isRestoring()).toBe(false)
  await view.settle(120)
  expect(view.restore).not.toHaveBeenCalled()
  expect(view.fallbackToEnd).not.toHaveBeenCalled()
  expect(view.loadEarlier.mock.calls.length).toBeLessThanOrEqual(1)
  await view.unmount()
})

test('a scrolling key cancels the restore, typing in the composer does not', async () => {
  const view = await mountRestore({
    memory: { rowId: 'user:u2', offset: 4, atEnd: false },
    anchorPage: 2,
    loadDelayMs: 10,
  })
  view.editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  view.scroller.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  expect(view.isRestoring()).toBe(true)
  view.scroller.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
  expect(view.isRestoring()).toBe(false)
  await view.settle()
  expect(view.restore).not.toHaveBeenCalled()
  await view.unmount()
})

test('a conversation left at its end has nothing to restore', async () => {
  const view = await mountRestore({ memory: { rowId: 'user:u1', offset: 0, atEnd: true }, anchorPage: 2 })
  expect(view.isRestoring()).toBe(false)
  await view.settle()
  expect(view.loadEarlier).not.toHaveBeenCalled()
  expect(view.restore).not.toHaveBeenCalled()
  expect(view.fallbackToEnd).not.toHaveBeenCalled()
  await view.unmount()
})
