// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'

import type { ConversationTimelineRow } from './conversationTimeline'
import {
  CHAT_FIND_ACTIVE_HIGHLIGHT,
  CHAT_FIND_HIGHLIGHT,
  chatFindHits,
  clearChatFindHighlights,
  paintChatFindHighlights,
  stepChatFindIndex,
} from './conversationFind'

const user = (id: string, text: string): ConversationTimelineRow =>
  ({ kind: 'user', id: `user:${id}`, entry: { kind: 'user', id, text, createdAt: 1 } }) as never

function reply(turnId: string, text: string, tools: { id: string; summary: string; lane?: boolean }[] = []) {
  return {
    kind: 'assistant',
    id: `assistant:${turnId}`,
    entry: { kind: 'assistant', id: turnId, turnId, text, reasoning: '', createdAt: 1 },
    tools: tools.map((tool) => ({
      kind: 'tool',
      id: tool.id,
      turnId,
      name: tool.lane ? 'Agent' : 'Read',
      status: 'done',
      summary: tool.summary,
      ...(tool.lane ? { subagentLane: true } : {}),
    })),
    decisions: [],
  } as unknown as ConversationTimelineRow
}

test('every match in the loaded rows is found, whatever its case, in row order', () => {
  const rows = [user('a', 'Fix the Login page'), reply('a', 'The login form now checks LOGIN twice.')]
  expect(chatFindHits(rows, 'login')).toEqual([
    { rowIndex: 0, rowId: 'user:a', occurrence: 0, opens: [] },
    { rowIndex: 1, rowId: 'assistant:a', occurrence: 0, opens: [] },
    { rowIndex: 1, rowId: 'assistant:a', occurrence: 1, opens: [] },
  ])
})

test('a query of only spaces finds nothing, and the spaces in a real one count', () => {
  const rows = [user('a', 'run the tests then run them again')]
  expect(chatFindHits(rows, '   ')).toEqual([])
  expect(chatFindHits(rows, 'run t')).toHaveLength(2)
})

test("a match in a step's summary is behind the turn's fold and its group of steps; one in the reply or an agent card is not", () => {
  const rows = [
    reply('b', 'Read the config.', [
      { id: 't1', summary: 'Read: config.ts' },
      { id: 't2', summary: 'Read: package.json' },
      { id: 'lane', summary: 'Agent: audit the config', lane: true },
    ]),
  ]
  const hits = chatFindHits(rows, 'config')
  // Drawn order: the fold's steps, then the agent card, then the reply.
  expect(hits.map((hit) => hit.opens)).toEqual([['fold:b', 'group:t1'], [], []])
  expect(hits.map((hit) => hit.occurrence)).toEqual([0, 1, 2])
})

test('the steps go round the end in both directions, and start at the first or last', () => {
  expect(stepChatFindIndex(-1, 3, 1)).toBe(0)
  expect(stepChatFindIndex(-1, 3, -1)).toBe(2)
  expect(stepChatFindIndex(2, 3, 1)).toBe(0)
  expect(stepChatFindIndex(0, 3, -1)).toBe(2)
  expect(stepChatFindIndex(0, 0, 1)).toBe(-1)
})

// The document's highlight registry, as Chromium has it and jsdom does not.
const registry = new Map<string, { ranges: Range[] }>()
class FakeHighlight {
  ranges: Range[]
  constructor(...ranges: Range[]) {
    this.ranges = ranges
  }
}
Object.assign(globalThis, {
  Highlight: FakeHighlight,
  CSS: {
    highlights: {
      set: (name: string, value: FakeHighlight) => registry.set(name, value),
      delete: (name: string) => registry.delete(name),
    },
  },
})

afterEach(() => {
  clearChatFindHighlights('one')
  clearChatFindHighlights('two')
  document.body.innerHTML = ''
})

function transcript(rows: Record<string, string>): HTMLElement {
  const root = document.createElement('div')
  for (const [id, text] of Object.entries(rows)) {
    const row = document.createElement('div')
    row.setAttribute('data-conversation-row', id)
    row.innerHTML = text
    root.appendChild(row)
  }
  document.body.appendChild(root)
  return root
}

test('the words on screen are marked, and the current match more strongly, in the row it is in', () => {
  const root = transcript({ 'user:a': 'Fix <b>login</b>', 'assistant:a': 'The login form, the login page.' })
  const current = paintChatFindHighlights('one', root, 'LOGIN', { rowId: 'assistant:a', occurrence: 1 })
  expect(registry.get(CHAT_FIND_HIGHLIGHT)?.ranges.map(String)).toEqual(['login', 'login', 'login'])
  expect(registry.get(CHAT_FIND_ACTIVE_HIGHLIGHT)?.ranges).toEqual([current])
  // The second in its row: the one after "the login form".
  expect(current?.startOffset).toBe('The login form, the '.length)
})

test("the find bar's own words are never marked", () => {
  const root = transcript({ 'user:a': 'one of two' })
  const bar = document.createElement('div')
  bar.setAttribute('data-conversation-find', '')
  bar.textContent = '1 of 2'
  root.prepend(bar)
  paintChatFindHighlights('one', root, 'of', null)
  expect(registry.get(CHAT_FIND_HIGHLIGHT)?.ranges).toHaveLength(1)
})

test('two chats in one window keep their own marks, and closing one leaves the other', () => {
  const first = transcript({ 'user:a': 'alpha' })
  const second = transcript({ 'user:b': 'alpha alpha' })
  paintChatFindHighlights('one', first, 'alpha', null)
  paintChatFindHighlights('two', second, 'alpha', null)
  expect(registry.get(CHAT_FIND_HIGHLIGHT)?.ranges).toHaveLength(3)
  clearChatFindHighlights('two')
  expect(registry.get(CHAT_FIND_HIGHLIGHT)?.ranges).toHaveLength(1)
  clearChatFindHighlights('one')
  expect(registry.has(CHAT_FIND_HIGHLIGHT)).toBe(false)
})
