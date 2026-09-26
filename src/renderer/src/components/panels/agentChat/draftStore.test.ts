import { expect, test } from 'vitest'
import { createComposerDraftStore, MAX_DRAFT_CHARS, MAX_COMPOSER_DRAFTS } from './draftStore'

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
  const restored = createComposerDraftStore(memory)
  expect(restored.getState().read('workspace', 'agent')).toMatchObject({
    text: 'Unfinished',
    skillIds: ['review'],
    mentions: [{ kind: 'file', path: 'src/app.ts', line: 2 }],
  })
  expect([...memory.data.values()].join('')).not.toContain('never-persist')
  expect(restored.getState().read('other', 'agent').text).toBe('')
  restored.getState().remove('workspace', 'agent')
  expect(createComposerDraftStore(memory).getState().read('workspace', 'agent').text).toBe('')
})

test('draft sizes and least-recently-written retention are bounded', () => {
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
