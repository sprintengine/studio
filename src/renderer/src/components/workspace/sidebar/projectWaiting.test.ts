import assert from 'node:assert/strict'
import { test } from 'vitest'

import { waitingChatCount, waitingLabel } from './projectWaiting'

test('blocked and failed chats are waiting; working and idle ones are not', () => {
  assert.equal(waitingChatCount(['needs-input', 'failed', 'working', 'idle', undefined, 'needs-input']), 3)
})

test('no waiting chat says nothing', () => {
  assert.equal(waitingChatCount([]), 0)
  assert.equal(waitingLabel(0), null)
})

test('the count is said in words', () => {
  assert.equal(waitingLabel(1), '1 waiting')
  assert.equal(waitingLabel(4), '4 waiting')
})
