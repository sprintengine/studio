import assert from 'node:assert/strict'
import { test } from 'vitest'

import { chatIdsOnRecord } from './agent-worktree-keep-checks'

test('a settled chat is not on record: its history keeps no worktree', () => {
  assert.deepEqual(
    chatIdsOnRecord([
      { id: 'open', settledAt: null },
      { id: 'settled', settledAt: 1_790_000_000_000 },
      { id: 'never-settled' },
    ]),
    ['open', 'never-settled'],
  )
})

test('every chat settled is an empty list; an empty registry is unknown', () => {
  assert.deepEqual(chatIdsOnRecord([{ id: 'settled', settledAt: 1 }]), [])
  assert.equal(chatIdsOnRecord([]), null, 'a registry with nothing in it may be one that could not be read')
})
