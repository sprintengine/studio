import { expect, test } from 'vitest'
import { CONVERSATION_VIEW_STORAGE_KEY, readConversationViews } from './conversationViewStorage'

const stored = (value: unknown) => ({
  getItem: (key: string) => (key === CONVERSATION_VIEW_STORAGE_KEY ? JSON.stringify(value) : null),
  setItem: () => {},
})

test('a malformed record costs only itself', () => {
  const views = readConversationViews(
    stored({
      version: 1,
      conversations: [
        ['ws:good', { scroll: { rowId: 'user:u1', offset: 8, atEnd: false }, disclosures: [['tool:1', true]] }],
        ['ws:bad-scroll', { scroll: { offset: 'far', atEnd: false } }],
        [
          'ws:bad-pairs',
          {
            disclosures: [
              ['tool:2', 'yes'],
              [3, true],
              ['tool:4', false],
            ],
          },
        ],
        ['', { scroll: { offset: 0, atEnd: true } }],
        'not a record',
      ],
    }),
  )
  expect(views.map(([key]) => key)).toEqual(['ws:good', 'ws:bad-pairs'])
  expect(views[0]![1].scroll).toEqual({ rowId: 'user:u1', offset: 8, atEnd: false })
  expect([...views[1]![1].disclosures]).toEqual([['tool:4', false]])
})

test('a blob from another version, or none at all, restores nothing', () => {
  expect(readConversationViews(stored({ version: 2, conversations: [] }))).toEqual([])
  expect(readConversationViews(stored(null))).toEqual([])
  expect(readConversationViews(undefined)).toEqual([])
  const throwing = {
    getItem: () => {
      throw new Error('Storage is disabled.')
    },
    setItem: () => {},
  }
  expect(readConversationViews(throwing)).toEqual([])
})
