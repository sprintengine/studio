import { expect, test } from 'vitest'
import { EMPTY_RECALL, recallPrompt } from './composerRecall'

test('recall respects visual edges and never replaces a newly typed draft', () => {
  const base = {
    state: EMPTY_RECALL,
    history: ['first', 'second'],
    draft: '',
    key: 'ArrowUp',
    firstLine: false,
    lastLine: true,
  }
  expect(recallPrompt(base).handled).toBe(false)
  expect(recallPrompt({ ...base, firstLine: true, draft: 'new text' }).handled).toBe(false)
  const newest = recallPrompt({ ...base, firstLine: true })
  expect(newest).toEqual({ state: { index: 1, stashed: '' }, text: 'second', handled: true })
  expect(recallPrompt({ ...base, state: newest.state, draft: newest.text, firstLine: true }).text).toBe('first')
})

test('down past newest and Escape restore the stashed draft; middle lines keep normal navigation', () => {
  const base = {
    state: { index: 1, stashed: 'unfinished' },
    history: ['first', 'second'],
    draft: 'second',
    key: 'ArrowDown',
    firstLine: false,
    lastLine: true,
  }
  expect(recallPrompt(base)).toEqual({ state: EMPTY_RECALL, text: 'unfinished', handled: true })
  expect(recallPrompt({ ...base, lastLine: false }).handled).toBe(false)
  expect(recallPrompt({ ...base, key: 'Escape', lastLine: false }).text).toBe('unfinished')
  expect(
    recallPrompt({ ...base, state: EMPTY_RECALL, draft: 'edited second', key: 'ArrowUp', firstLine: true }).handled,
  ).toBe(false)
})
