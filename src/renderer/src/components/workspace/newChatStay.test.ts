import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createNewChatStay, NEW_CHAT_STAY_WATCH_MS } from './newChatStay'

const offScreen = () => false

test('a chat ⌘⏎ started is held as starting until its agent is seen under way', () => {
  const stay = createNewChatStay(() => 1_000)
  stay.started('chat-1')
  stay.started('chat-2')
  assert.deepEqual(stay.starting(), ['chat-1', 'chat-2'])
  // Not in the activity yet (the render that lists it has not happened), or
  // idle while its view comes up: still starting.
  assert.deepEqual(stay.review({ 'chat-1': 'idle' }, offScreen).starting, ['chat-1', 'chat-2'])
  assert.deepEqual(stay.review({ 'chat-1': 'working' }, offScreen).starting, ['chat-2'])
  // A turn that ends quickly does not make it starting again.
  assert.deepEqual(stay.review({ 'chat-1': 'idle', 'chat-2': 'working' }, offScreen).starting, [])
})

test('only a chat ⌘⏎ started is held or watched', () => {
  const stay = createNewChatStay()
  assert.deepEqual(stay.review({ 'opened-with-enter': 'failed' }, offScreen), { failed: [], starting: [] })
})

test('a started chat failing in its first minute is reported once, unless it is on screen', () => {
  let now = 1_000
  const stay = createNewChatStay(() => now)
  for (const id of ['quiet', 'watched', 'seen', 'asks']) stay.started(id)
  assert.deepEqual(stay.review({ quiet: 'working', watched: 'working', seen: 'idle' }, offScreen).failed, [])
  // Stopping to ask is a chat that started: no longer watched or held.
  const asked = stay.review({ asks: 'needs-input' }, offScreen)
  assert.equal(asked.starting.includes('asks'), false)
  assert.deepEqual(stay.review({ asks: 'failed' }, offScreen).failed, [])
  const failing = stay.review({ watched: 'failed', seen: 'failed' }, (id) => id === 'seen')
  assert.deepEqual(failing.failed, ['watched'], 'the one on screen shows its own failure')
  assert.equal(failing.starting.includes('seen'), false, 'a failed start is not held')
  assert.deepEqual(stay.review({ watched: 'failed' }, offScreen).failed, [], 'reported once')
  // Past its first minute a failure is an ordinary failed turn, the badge's.
  now += NEW_CHAT_STAY_WATCH_MS + 1
  assert.deepEqual(stay.review({ quiet: 'working' }, offScreen).failed, [])
  assert.deepEqual(stay.review({ quiet: 'failed' }, offScreen).failed, [])
})

test('a chat that never gets under way is let go after its first minute', () => {
  let now = 1_000
  const stay = createNewChatStay(() => now)
  stay.started('stuck')
  assert.deepEqual(stay.review({ stuck: 'idle' }, offScreen).starting, ['stuck'])
  now += NEW_CHAT_STAY_WATCH_MS + 1
  assert.deepEqual(stay.review({ stuck: 'idle' }, offScreen).starting, [])
  assert.deepEqual(stay.starting(), [])
})

test('a chat waiting on its worktree is held past a minute, and its minute starts when the folder lands', () => {
  let now = 1_000
  const stay = createNewChatStay(() => now)
  stay.started('slow-worktree')
  let waiting = true
  const isWaiting = () => waiting
  now += NEW_CHAT_STAY_WATCH_MS + 1
  assert.deepEqual(stay.review({ 'slow-worktree': 'idle' }, offScreen, isWaiting).starting, ['slow-worktree'])
  now += NEW_CHAT_STAY_WATCH_MS + 1
  assert.deepEqual(stay.review({ 'slow-worktree': 'idle' }, offScreen, isWaiting).starting, ['slow-worktree'])
  // The worktree lands: the agent now has its minute to get under way.
  waiting = false
  now += NEW_CHAT_STAY_WATCH_MS - 1
  assert.deepEqual(stay.review({ 'slow-worktree': 'idle' }, offScreen, isWaiting).starting, ['slow-worktree'])
  now += 2
  assert.deepEqual(stay.review({ 'slow-worktree': 'idle' }, offScreen, isWaiting).starting, [])
})
