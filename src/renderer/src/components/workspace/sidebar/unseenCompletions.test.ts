import assert from 'node:assert/strict'
import { test } from 'vitest'

import { keepUnvisitedCompletions } from './rowTerminals'

// The "finished while you were away" mark, as a visit made on another device
// clears it.

const marks = new Set(['read-on-phone', 'unread', 'never-visited'])
const markedAt = new Map([
  ['read-on-phone', 1_000],
  ['unread', 1_000],
  ['never-visited', 1_000],
])

test('a mark a visit landed after comes down; one visited before it went up stays', () => {
  const visits: Record<string, number> = { 'read-on-phone': 1_500, unread: 900 }
  const kept = keepUnvisitedCompletions({ marks, markedAt, visitedAt: (id) => visits[id] })
  assert.deepEqual([...kept].sort(), ['never-visited', 'unread'])
})

test('a visit at the very moment the mark went up counts as seeing it', () => {
  const kept = keepUnvisitedCompletions({ marks, markedAt, visitedAt: (id) => (id === 'unread' ? 1_000 : null) })
  assert.equal(kept.has('unread'), false)
})

test('nothing visited answers the same set, so a caller keeps its identity', () => {
  assert.equal(keepUnvisitedCompletions({ marks, markedAt, visitedAt: () => undefined }), marks)
})

test('a mark with no record of when it went up is left alone', () => {
  const kept = keepUnvisitedCompletions({ marks, markedAt: new Map(), visitedAt: () => 5_000 })
  assert.equal(kept, marks)
})
