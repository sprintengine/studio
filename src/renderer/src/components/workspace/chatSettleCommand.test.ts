import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace } from '../../types/workspace'
import { chatSettleStep } from './chatSettleCommand'

const remoteOrigin = { connectionId: 'conn-1', workspaceId: 'ws-remote' } as Workspace['remoteOrigin']

test('a chat at rest settles here', () => {
  assert.equal(chatSettleStep({}, false), 'settle')
})

test('a settled chat comes back, working or not', () => {
  assert.equal(chatSettleStep({ settledAt: 1 }, false), 'restore')
  assert.equal(chatSettleStep({ settledAt: 1 }, true), 'restore')
})

test('a chat whose agents are working is left alone', () => {
  assert.equal(chatSettleStep({}, true), 'busy')
  assert.equal(chatSettleStep({ remoteOrigin }, true), 'busy')
})

test('a chat opened from a paired machine asks that machine first', () => {
  assert.equal(chatSettleStep({ remoteOrigin }, false), 'settle-remote')
})
