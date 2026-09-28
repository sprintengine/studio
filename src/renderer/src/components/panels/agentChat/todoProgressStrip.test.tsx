import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationTodoStrip } from './todoProgressStrip'
import { setConversationDisclosures } from './conversationViewState'
import type { TranscriptEntry } from './conversationProjection'

const entries: TranscriptEntry[] = [
  { kind: 'user', id: 'u1', text: 'go' },
  { kind: 'assistant', turnId: 't1', text: '', reasoning: '', status: 'streaming' },
  {
    kind: 'tool',
    id: 'todo',
    turnId: 't1',
    name: 'TodoWrite',
    toolKind: 'todo',
    status: 'done',
    input: {
      todos: [
        { content: 'Read the config', status: 'completed' },
        { content: 'Write the test', status: 'in_progress', activeForm: 'Writing the test' },
        { content: 'Run the suite', status: 'pending' },
      ],
    },
  },
]

test('the strip names the step in hand and how far along the list is, closed until asked', () => {
  const html = renderToStaticMarkup(<ConversationTodoStrip entries={entries} activeTurn />)
  expect(html).toContain('Writing the test')
  expect(html).toContain('1 of 3')
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('aria-label="Tasks: 1 of 3 done. Current: Writing the test"')
  expect(html).not.toContain('Run the suite')
})

test('opened, the strip lists every step with its state spelled out', () => {
  setConversationDisclosures(':', ['todo-strip'], true)
  try {
    const html = renderToStaticMarkup(<ConversationTodoStrip entries={entries} activeTurn />)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Done: </span>')
    expect(html).toContain('In progress: </span>')
    expect(html).toContain('Run the suite')
  } finally {
    setConversationDisclosures(':', ['todo-strip'], false)
  }
})

test('no list, no strip', () => {
  expect(renderToStaticMarkup(<ConversationTodoStrip entries={entries.slice(0, 2)} activeTurn />)).toBe('')
})
