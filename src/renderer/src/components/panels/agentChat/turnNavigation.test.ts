import { expect, test } from 'vitest'
import type { ConversationTimelineRow } from './conversationTimeline'
import {
  adjacentTurn,
  deriveTurnMarks,
  turnAtRow,
  turnMarksKey,
  turnPreviewText,
  turnReply,
  useTurnNavigation,
} from './turnNavigation'

const user = (id: string, text: string): ConversationTimelineRow => ({
  kind: 'user',
  id,
  entry: { kind: 'user', id, text },
})
const reply = (id: string, text: string): ConversationTimelineRow => ({
  kind: 'assistant',
  id,
  entry: { kind: 'assistant', turnId: id, text, reasoning: '', status: 'complete' },
  tools: [],
  decisions: [],
})

// rows: 0 u1 · 1 a1 · 2 a1' · 3 u2 · 4 u3 · 5 a3
const rows: ConversationTimelineRow[] = [
  user('u1', 'Rename the config loader'),
  reply('a1', 'Looking at the loader first.'),
  reply('a1b', 'Renamed it and updated the imports.'),
  user('u2', 'Now the tests'),
  user('u3', 'And the docs'),
  reply('a3', ''),
]

test('a mark per prompt, previewed with the last reply before the next prompt', () => {
  const marks = deriveTurnMarks(rows)
  expect(marks).toEqual([
    { id: 'u1', rowIndex: 0, prompt: 'Rename the config loader' },
    { id: 'u2', rowIndex: 3, prompt: 'Now the tests' },
    { id: 'u3', rowIndex: 4, prompt: 'And the docs' },
  ])
  expect(turnReply(rows, marks, 0)).toBe('Renamed it and updated the imports.')
  expect(turnReply(rows, marks, 1)).toBeNull()
  // A reply with no prose yet (tools only, or still streaming) is no preview.
  expect(turnReply(rows, marks, 2)).toBeNull()
  expect(turnReply(rows, marks, 3)).toBeNull()
  expect(deriveTurnMarks([reply('orphan', 'No prompt above me')])).toEqual([])
})

test('a streamed token leaves the marks key alone; a new prompt changes it', () => {
  const streamed = [...rows.slice(0, 5), reply('a3', 'Updating the docs')]
  expect(turnMarksKey(streamed)).toBe(turnMarksKey(rows))
  expect(turnMarksKey([...rows, user('u4', 'Ship it')])).not.toBe(turnMarksKey(rows))
})

test('a preview collapses whitespace and cuts at a word', () => {
  expect(turnPreviewText('  one\n\n two  ', 40)).toBe('one two')
  expect(turnPreviewText('alpha beta gamma delta', 13)).toBe('alpha beta…')
  expect(turnPreviewText('   ', 10)).toBeNull()
  expect(turnPreviewText(null, 10)).toBeNull()
})

test('the current turn is the last prompt at or above the first visible row', () => {
  const marks = deriveTurnMarks(rows)
  expect(turnAtRow(marks, 0)).toBe(0)
  expect(turnAtRow(marks, 2)).toBe(0)
  expect(turnAtRow(marks, 3)).toBe(1)
  expect(turnAtRow(marks, 5)).toBe(2)
  expect(turnAtRow(deriveTurnMarks([reply('lead', 'x'), ...rows]), 0)).toBe(-1)
})

test('stepping back from mid-turn lands on that turn, from its prompt on the one before', () => {
  const marks = deriveTurnMarks(rows)
  expect(adjacentTurn(marks, 2, -1)).toBe(0)
  expect(adjacentTurn(marks, 3, -1)).toBe(0)
  expect(adjacentTurn(marks, 0, -1)).toBe(-1)
  expect(adjacentTurn(marks, 2, 1)).toBe(1)
  expect(adjacentTurn(marks, 5, 1)).toBe(-1)
  expect(adjacentTurn([], 0, 1)).toBe(-1)
})

test('a jump anchor wins over a first visible row that is a pixel behind it', () => {
  const marks = deriveTurnMarks(rows)
  // Jumped to u2 (row 3), but the list still reports row 2 as first visible.
  expect(adjacentTurn(marks, 2, 1, 1)).toBe(2)
  expect(adjacentTurn(marks, 2, -1, 1)).toBe(0)
  expect(adjacentTurn(marks, 2, 1, 2)).toBe(-1)
  // An anchor left over from before a page was prepended is ignored.
  expect(adjacentTurn(marks, 2, 1, 9)).toBe(1)
})

test('steps walk from the landed turn and hand the row to the shared jump', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const jumps: [number, string][] = []
  let navigation: ReturnType<typeof useTurnNavigation> | null = null
  function Harness() {
    navigation = useTurnNavigation({
      rows,
      listRef: { current: null },
      jumpToRow: (index, id) => jumps.push([index, id]),
    })
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(createElement(Harness)))
    expect(navigation!.current).toBe(0)
    expect(navigation!.hasPrevious).toBe(false)
    await act(async () => navigation!.step(1))
    await act(async () => navigation!.step(1))
    expect(jumps).toEqual([
      [3, 'u2'],
      [4, 'u3'],
    ])
    expect(navigation!.current).toBe(2)
    expect(navigation!.hasNext).toBe(false)
    await act(async () => navigation!.step(1))
    expect(jumps).toHaveLength(2)
    await act(async () => navigation!.jump(0))
    expect(jumps.at(-1)).toEqual([0, 'u1'])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
