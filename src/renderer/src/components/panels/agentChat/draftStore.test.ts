import { expect, test, vi } from 'vitest'
import { createComposerDraftStore, MAX_DRAFT_CHARS, MAX_COMPOSER_DRAFTS, MAX_TOTAL_DRAFT_CHARS } from './draftStore'

function storage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}
test('drafts survive a store remount with metadata but never serialize image payloads', () => {
  const memory = storage(),
    store = createComposerDraftStore(memory)
  const draft = {
    text: 'Unfinished',
    skillIds: ['review'],
    mentions: [{ kind: 'file' as const, path: 'src/app.ts', line: 2 }],
    attachments: [{ dataBase64: 'never-persist' }],
  }
  store.getState().put('workspace', 'agent', draft)
  store.flushDrafts()
  const restored = createComposerDraftStore(memory)
  expect(restored.getState().read('workspace', 'agent')).toMatchObject({
    text: 'Unfinished',
    skillIds: ['review'],
    mentions: [{ kind: 'file', path: 'src/app.ts', line: 2 }],
  })
  expect([...memory.data.values()].join('')).not.toContain('never-persist')
  expect(restored.getState().read('other', 'agent').text).toBe('')
  restored.getState().remove('workspace', 'agent')
  restored.flushDrafts()
  expect(createComposerDraftStore(memory).getState().read('workspace', 'agent').text).toBe('')
})

test('the files a draft attached by path survive a remount; a draft of files alone is kept, bad entries are not', () => {
  const memory = storage(),
    store = createComposerDraftStore(memory)
  store.getState().put('workspace', 'agent', {
    text: '',
    skillIds: [],
    mentions: [],
    files: ['/Users/dev/Desktop/Q3 budget.xlsx', 'C:\\Users\\dev\\deck.pptx'],
  })
  store.flushDrafts()
  expect(createComposerDraftStore(memory).getState().read('workspace', 'agent').files).toEqual([
    '/Users/dev/Desktop/Q3 budget.xlsx',
    'C:\\Users\\dev\\deck.pptx',
  ])
  // A seed of words alone (a fork, an opener) has no files to give.
  store.getState().put('workspace', 'other', { text: 'Words', skillIds: [], mentions: [] })
  expect(store.getState().read('workspace', 'other').files).toEqual([])
  store.getState().put('workspace', 'odd', {
    text: 'x',
    skillIds: [],
    mentions: [],
    files: ['/Users/dev/ok.pdf', 'bad\npath', 7 as unknown as string],
  })
  expect(store.getState().read('workspace', 'odd').files).toEqual(['/Users/dev/ok.pdf'])
})

test('draft sizes and least-recently-used retention are bounded', () => {
  const memory = storage()
  let now = 0
  const store = createComposerDraftStore(memory, () => ++now)
  for (let i = 0; i <= MAX_COMPOSER_DRAFTS; i++)
    store.getState().put('workspace', `agent-${i}`, { text: 'draft', skillIds: [], mentions: [] })
  expect(Object.keys(store.getState().drafts)).toHaveLength(MAX_COMPOSER_DRAFTS)
  expect(store.getState().read('workspace', 'agent-0').text).toBe('')
  store.getState().put('workspace', 'agent-1', { text: 'x'.repeat(MAX_DRAFT_CHARS + 10), skillIds: [], mentions: [] })
  expect(store.getState().read('workspace', 'agent-1').text).toHaveLength(MAX_DRAFT_CHARS)
  store.getState().put('workspace', 'new', { text: 'new', skillIds: [], mentions: [] })
  expect(store.getState().read('workspace', 'agent-1').text).toHaveLength(MAX_DRAFT_CHARS)
  expect(store.getState().read('workspace', 'agent-2').text).toBe('')
})

test('opening an old draft protects it from eviction even within the same millisecond', () => {
  const store = createComposerDraftStore(storage(), () => 1)
  for (let i = 0; i < MAX_COMPOSER_DRAFTS; i++)
    store.getState().put('workspace', `agent-${i}`, { text: 'draft', skillIds: [], mentions: [] })
  expect(store.getState().read('workspace', 'agent-0').text).toBe('draft')
  store.getState().put('workspace', 'new', { text: 'new', skillIds: [], mentions: [] })
  expect(store.getState().read('workspace', 'agent-0').text).toBe('draft')
  expect(store.getState().read('workspace', 'agent-1').text).toBe('')
})

test('edits and reads coalesce into one storage write after a pause', () => {
  vi.useFakeTimers()
  try {
    const memory = storage()
    const setItem = vi.spyOn(memory, 'setItem')
    const store = createComposerDraftStore(memory)
    for (const text of ['d', 'dr', 'dra', 'draft'])
      store.getState().put('workspace', 'agent', { text, skillIds: [], mentions: [] })
    store.getState().read('workspace', 'agent')
    expect(setItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(setItem).toHaveBeenCalledOnce()
    expect(createComposerDraftStore(memory).getState().read('workspace', 'agent').text).toBe('draft')
  } finally {
    vi.useRealTimers()
  }
})

test('all drafts together stay within a character budget, newest first', () => {
  let now = 0
  const store = createComposerDraftStore(storage(), () => ++now)
  const count = Math.ceil(MAX_TOTAL_DRAFT_CHARS / MAX_DRAFT_CHARS) + 2
  for (let i = 0; i < count; i++)
    store.getState().put('workspace', `agent-${i}`, { text: 'x'.repeat(MAX_DRAFT_CHARS), skillIds: [], mentions: [] })
  const kept = Object.values(store.getState().drafts)
  expect(kept.reduce((sum, draft) => sum + draft.text.length, 0)).toBeLessThanOrEqual(MAX_TOTAL_DRAFT_CHARS)
  expect(store.getState().read('workspace', `agent-${count - 1}`).text).toHaveLength(MAX_DRAFT_CHARS)
  expect(store.getState().read('workspace', 'agent-0').text).toBe('')
})

test('a write the quota refuses gives up the oldest drafts and reports only if nothing fits', () => {
  const memory = storage()
  let limit = Infinity
  memory.setItem = (key: string, value: string) => {
    if (value.length > limit) throw new DOMException('Quota exceeded', 'QuotaExceededError')
    memory.data.set(key, value)
  }
  let now = 0
  const store = createComposerDraftStore(memory, () => ++now)
  store.getState().put('workspace', 'old', { text: 'o'.repeat(1000), skillIds: [], mentions: [] })
  store.getState().put('workspace', 'new', { text: 'n'.repeat(1000), skillIds: [], mentions: [] })
  limit = 1500
  store.flushDrafts()
  expect(store.draftWriteFailed()).toBe(false)
  const restored = createComposerDraftStore(memory)
  expect(restored.getState().read('workspace', 'new').text).toHaveLength(1000)
  expect(restored.getState().read('workspace', 'old').text).toBe('')
  limit = 10
  const failures = vi.fn()
  store.subscribeDraftWrites(failures)
  store.getState().put('workspace', 'new', { text: 'still here', skillIds: [], mentions: [] })
  store.flushDrafts()
  expect(store.draftWriteFailed()).toBe(true)
  expect(failures).toHaveBeenCalledOnce()
  // The in-memory draft is untouched by a failed write.
  expect(store.getState().read('workspace', 'new').text).toBe('still here')
})

test('after the quota evicts drafts the store forgets them, so the next write is a single attempt', () => {
  const memory = storage()
  let limit = Infinity
  let attempts = 0
  memory.setItem = (key: string, value: string) => {
    attempts++
    if (value.length > limit) throw new DOMException('Quota exceeded', 'QuotaExceededError')
    memory.data.set(key, value)
  }
  let now = 0
  const store = createComposerDraftStore(memory, () => ++now)
  const count = 150
  for (let index = 0; index < count; index++)
    store.getState().put('workspace', `agent-${index}`, { text: 'x'.repeat(5000), skillIds: [], mentions: [] })
  store.flushDrafts()
  limit = 20_000
  attempts = 0
  store.getState().put('workspace', 'agent-0', { text: 'edited', skillIds: [], mentions: [] })
  store.flushDrafts()
  expect(store.draftWriteFailed()).toBe(false)
  // A binary search over the cut, not one attempt per evicted draft.
  expect(attempts).toBeLessThanOrEqual(1 + Math.ceil(Math.log2(count)))
  const kept = Object.keys(store.getState().drafts)
  expect(kept.length).toBeGreaterThan(1)
  expect(kept.length).toBeLessThan(count)
  expect(store.getState().drafts[JSON.stringify(['workspace', 'agent-0'])]?.text).toBe('edited')
  expect(Object.keys(JSON.parse(memory.data.get('sprintengine-conversation-drafts')!).state.drafts).sort()).toEqual(
    kept.sort(),
  )
  for (let edit = 0; edit < 3; edit++) {
    attempts = 0
    store.getState().put('workspace', 'agent-0', { text: `edited ${edit}`, skillIds: [], mentions: [] })
    store.flushDrafts()
    expect(attempts).toBe(1)
  }
})
