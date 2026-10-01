import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  CONVERSATION_VIEW_STORAGE_KEY,
  MAX_DISCLOSURES_PER_CONVERSATION,
  MAX_REMEMBERED_CONVERSATIONS,
  VIEW_WRITE_DELAY_MS,
} from './conversationViewStorage'

type ViewState = typeof import('./conversationViewState')

function memoryStorage(limit = Infinity) {
  const data = new Map<string, string>()
  return {
    data,
    writes: 0,
    getItem(key: string) {
      return data.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (value.length > limit) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      this.writes += 1
      data.set(key, value)
    },
  }
}

let page: EventTarget & { localStorage: ReturnType<typeof memoryStorage> }

// A fresh module over the same storage is what a restart looks like: the
// in-memory maps are gone and only what was written comes back.
async function launch(storage: ReturnType<typeof memoryStorage>): Promise<ViewState> {
  vi.resetModules()
  page = Object.assign(new EventTarget(), { localStorage: storage })
  vi.stubGlobal('window', page)
  return import('./conversationViewState')
}

function disclosure(state: ViewState, key: string, id: string, defaultOpen = false): boolean {
  let open = defaultOpen
  function Probe() {
    open = state.useConversationDisclosure(key, id, defaultOpen)[0]
    return null
  }
  renderToString(createElement(Probe))
  return open
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('scroll anchor and disclosures come back after a restart', async () => {
  const storage = memoryStorage()
  const before = await launch(storage)
  before.rememberConversationScroll('ws:agent', { rowId: 'assistant:t4', offset: 36.4, atEnd: false })
  before.setConversationDisclosures('ws:agent', ['tool:1', 'fold:t2'], true)
  before.setConversationDisclosures('ws:agent', ['fold:t2'], false)
  vi.advanceTimersByTime(VIEW_WRITE_DELAY_MS)

  const after = await launch(storage)
  expect(after.recalledConversationScroll('ws:agent')).toEqual({ rowId: 'assistant:t4', offset: 36, atEnd: false })
  expect(disclosure(after, 'ws:agent', 'tool:1')).toBe(true)
  expect(disclosure(after, 'ws:agent', 'fold:t2', true)).toBe(false)
  expect(disclosure(after, 'ws:agent', 'tool:unset', true)).toBe(true)
  expect(after.recalledConversationScroll('ws:other')).toBeUndefined()
})

test('a burst of scroll events is written once, after it settles', async () => {
  const storage = memoryStorage()
  const state = await launch(storage)
  for (let offset = 0; offset < 10; offset += 1) {
    state.rememberConversationScroll('ws:agent', { rowId: 'user:u1', offset, atEnd: false })
    vi.advanceTimersByTime(VIEW_WRITE_DELAY_MS / 5)
  }
  expect(storage.writes).toBe(0)
  vi.advanceTimersByTime(VIEW_WRITE_DELAY_MS)
  expect(storage.writes).toBe(1)
  expect(storage.data.get(CONVERSATION_VIEW_STORAGE_KEY)).toContain('"offset":9')
})

test('an unbroken scroll is still written within the wait ceiling', async () => {
  const storage = memoryStorage()
  const state = await launch(storage)
  for (let offset = 0; offset < 50; offset += 1) {
    state.rememberConversationScroll('ws:agent', { rowId: 'user:u1', offset, atEnd: false })
    vi.advanceTimersByTime(50)
  }
  expect(storage.writes).toBeGreaterThan(0)
})

test('an unchanged position schedules no write', async () => {
  const storage = memoryStorage()
  const state = await launch(storage)
  state.rememberConversationScroll('ws:agent', { rowId: 'user:u1', offset: 4, atEnd: false })
  vi.advanceTimersByTime(VIEW_WRITE_DELAY_MS)
  state.rememberConversationScroll('ws:agent', { rowId: 'user:u1', offset: 4.2, atEnd: false })
  vi.advanceTimersByTime(VIEW_WRITE_DELAY_MS)
  expect(storage.writes).toBe(1)
})

test('closing the window writes what the delay is still holding', async () => {
  const storage = memoryStorage()
  const state = await launch(storage)
  state.rememberConversationScroll('ws:agent', { rowId: 'user:u1', offset: 12, atEnd: false })
  expect(storage.writes).toBe(0)
  page.dispatchEvent(new Event('pagehide'))
  expect(storage.writes).toBe(1)
  expect((await launch(storage)).recalledConversationScroll('ws:agent')?.offset).toBe(12)
})

test('only the most recently used conversations are kept', async () => {
  const storage = memoryStorage()
  const state = await launch(storage)
  for (let index = 0; index <= MAX_REMEMBERED_CONVERSATIONS; index += 1)
    state.rememberConversationScroll(`ws:agent-${index}`, { offset: index, atEnd: true })
  // Reading the first survivor makes it the newest, so the next one goes instead.
  state.recalledConversationScroll('ws:agent-1')
  state.rememberConversationScroll('ws:agent-new', { offset: 0, atEnd: true })
  page.dispatchEvent(new Event('pagehide'))

  const after = await launch(storage)
  expect(after.recalledConversationScroll('ws:agent-0')).toBeUndefined()
  expect(after.recalledConversationScroll('ws:agent-2')).toBeUndefined()
  expect(after.recalledConversationScroll('ws:agent-1')).toEqual({ offset: 1, atEnd: true })
  expect(after.recalledConversationScroll('ws:agent-new')).toEqual({ offset: 0, atEnd: true })
})

test('a conversation keeps only its most recently toggled disclosures', async () => {
  const storage = memoryStorage()
  const state = await launch(storage)
  const ids = Array.from({ length: MAX_DISCLOSURES_PER_CONVERSATION + 1 }, (_, index) => `tool:${index}`)
  state.setConversationDisclosures('ws:agent', ids, true)
  state.setConversationDisclosures('ws:agent', ['tool:0'], true)
  page.dispatchEvent(new Event('pagehide'))

  const after = await launch(storage)
  expect(disclosure(after, 'ws:agent', 'tool:0')).toBe(true)
  expect(disclosure(after, 'ws:agent', 'tool:1')).toBe(false)
  expect(disclosure(after, 'ws:agent', `tool:${MAX_DISCLOSURES_PER_CONVERSATION}`)).toBe(true)
})

test('a full quota keeps the newest conversations that fit and never throws', async () => {
  const roomy = memoryStorage()
  const seed = await launch(roomy)
  for (let index = 0; index < 20; index += 1)
    seed.rememberConversationScroll(`ws:agent-${index}`, {
      rowId: `assistant:${'t'.repeat(40)}`,
      offset: 1,
      atEnd: false,
    })
  page.dispatchEvent(new Event('pagehide'))
  const full = roomy.data.get(CONVERSATION_VIEW_STORAGE_KEY)!

  const tight = memoryStorage(Math.floor(full.length / 2))
  const state = await launch(tight)
  for (let index = 0; index < 20; index += 1)
    state.rememberConversationScroll(`ws:agent-${index}`, {
      rowId: `assistant:${'t'.repeat(40)}`,
      offset: 1,
      atEnd: false,
    })
  expect(() => page.dispatchEvent(new Event('pagehide'))).not.toThrow()

  const after = await launch(tight)
  expect(after.recalledConversationScroll('ws:agent-19')).toBeDefined()
  expect(after.recalledConversationScroll('ws:agent-0')).toBeUndefined()
  // What did not fit is forgotten in memory too, so the next write does not
  // go looking for room for it again.
  expect(state.recalledConversationScroll('ws:agent-0')).toBeUndefined()
})

test('a storage that refuses everything leaves the view state working in memory', async () => {
  const state = await launch(memoryStorage(0))
  state.rememberConversationScroll('ws:agent', { rowId: 'user:u1', offset: 3, atEnd: false })
  expect(() => vi.advanceTimersByTime(VIEW_WRITE_DELAY_MS)).not.toThrow()
  expect(state.recalledConversationScroll('ws:agent')).toEqual({ rowId: 'user:u1', offset: 3, atEnd: false })
})

test('a corrupt blob is ignored and then replaced', async () => {
  const storage = memoryStorage()
  storage.data.set(CONVERSATION_VIEW_STORAGE_KEY, '{"version":1,"conversations":[')
  const state = await launch(storage)
  expect(state.recalledConversationScroll('ws:agent')).toBeUndefined()
  state.rememberConversationScroll('ws:agent', { offset: 0, atEnd: true })
  page.dispatchEvent(new Event('pagehide'))
  expect((await launch(storage)).recalledConversationScroll('ws:agent')).toEqual({ offset: 0, atEnd: true })
})

test('with no window the view state is memory only', async () => {
  vi.resetModules()
  const state = await import('./conversationViewState')
  state.rememberConversationScroll('ws:agent', { offset: 5, atEnd: false })
  expect(state.recalledConversationScroll('ws:agent')).toEqual({ offset: 5, atEnd: false })
})
