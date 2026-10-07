import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createNewChatStay, NEW_CHAT_STAY_WATCH_MS } from './newChatStay'

test('a ⌘⏎ launch keeps New chat up over each chat it creates, once', async () => {
  const stay = createNewChatStay(() => 1_000)
  let runningDuringLaunch = false
  const started = await stay.run(() => {
    runningDuringLaunch = stay.isRunning()
    stay.noteCreated('chat-1')
  })
  assert.equal(started, true)
  assert.equal(runningDuringLaunch, true, 'the launch paths see it and leave the door up')
  assert.equal(stay.isRunning(), false)
  // Its activation under the door does not park New chat; a later one does.
  assert.equal(stay.keepsNewChatOver('chat-1'), true)
  assert.equal(stay.keepsNewChatOver('chat-1'), false)
  assert.equal(stay.keepsNewChatOver(null), false)
})

test('a chat ⏎ creates is not one to keep New chat over', () => {
  const stay = createNewChatStay()
  stay.noteCreated('chat-2')
  assert.equal(stay.keepsNewChatOver('chat-2'), false)
})

test('a ⌘⏎ launch that created nothing says so, and a throwing one still ends', async () => {
  const stay = createNewChatStay()
  assert.equal(await stay.run(async () => undefined), false)
  await assert.rejects(
    stay.run(() => {
      throw new Error('worktree')
    }),
  )
  assert.equal(stay.isRunning(), false)
})

test('a started chat failing in its first minute is reported once, unless it is on screen', async () => {
  let now = 1_000
  const stay = createNewChatStay(() => now)
  await stay.run(() => {
    stay.noteCreated('quiet')
    stay.noteCreated('watched')
    stay.noteCreated('seen')
    stay.noteCreated('asks')
  })
  const offScreen = () => false
  assert.deepEqual(stay.takeFailures({ quiet: 'working', watched: 'working', seen: 'idle' }, offScreen), [])
  // Stopping to ask is a chat that started: no longer watched.
  assert.deepEqual(stay.takeFailures({ asks: 'needs-input' }, offScreen), [])
  assert.deepEqual(stay.takeFailures({ asks: 'failed' }, offScreen), [])
  assert.deepEqual(
    stay.takeFailures({ watched: 'failed', seen: 'failed' }, (id) => id === 'seen'),
    ['watched'],
    'the one on screen shows its own failure',
  )
  assert.deepEqual(stay.takeFailures({ watched: 'failed' }, offScreen), [], 'reported once')
  // Past its first minute a failure is an ordinary failed turn, the badge's.
  now += NEW_CHAT_STAY_WATCH_MS + 1
  assert.deepEqual(stay.takeFailures({ quiet: 'working' }, offScreen), [])
  assert.deepEqual(stay.takeFailures({ quiet: 'failed' }, offScreen), [])
})
