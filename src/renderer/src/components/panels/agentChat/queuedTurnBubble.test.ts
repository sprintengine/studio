import assert from 'node:assert/strict'
import { test } from 'vitest'

import { queuedTurnSendNow } from './queuedTurnBubble'

const running = { activeTurn: true, awaitingApproval: false, stopping: false, steering: false }

test('a provider that takes a message mid-turn is steered; any other is stopped, and says so', () => {
  assert.deepEqual(queuedTurnSendNow({ ...running, canSteer: true }), {
    kind: 'steer',
    label: 'Send now',
    disabled: false,
  })
  assert.deepEqual(queuedTurnSendNow({ ...running, canSteer: false }), {
    kind: 'interrupt',
    label: 'Stop and send',
    disabled: false,
  })
})

test('a card the agent is blocked on holds the queued message, with the reason on the action', () => {
  const held = queuedTurnSendNow({ ...running, canSteer: true, awaitingApproval: true })
  assert.equal(held.disabled, true)
  assert.match(held.reason ?? '', /open request/)
  assert.equal(queuedTurnSendNow({ ...running, canSteer: false, awaitingApproval: true }).disabled, true)
})

test('one steer is delivered at a time, and nothing is sent into a turn that is stopping or not yet started', () => {
  assert.equal(queuedTurnSendNow({ ...running, canSteer: true, steering: true }).disabled, true)
  assert.equal(queuedTurnSendNow({ ...running, canSteer: false, stopping: true }).disabled, true)
  assert.equal(queuedTurnSendNow({ ...running, canSteer: true, activeTurn: false }).disabled, true)
})
