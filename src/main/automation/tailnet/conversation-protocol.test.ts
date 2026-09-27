import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  CONVERSATION_CAPABILITY,
  conversationCloseReason,
  conversationCloseRetryAfterMs,
  parseConversationClientFrame,
} from '../../../../packages/conversation-protocol/src'

test('portable protocol source stays byte-identical to the companion source mirror', () => {
  const hash = createHash('sha256')
  for (const name of ['index.ts', 'presentation.ts', 'tool-types.ts', 'toolKind.ts', 'commandLabel.ts']) {
    hash.update(name)
    hash.update('\0')
    hash.update(readFileSync(join(process.cwd(), 'packages/conversation-protocol/src', name)))
  }
  // Update this pin and the companion's pin together only after comparing both
  // source trees. A local digest alone cannot detect a stale peer mirror.
  assert.equal(hash.digest('hex'), '49b206bf7c464f0c429e330eb3a66d1d138388b701cefe8668564622a05342bd')
})

test('conversation protocol accepts bounded frames and refuses remote escalation', () => {
  assert.equal(CONVERSATION_CAPABILITY, 'conversations')
  assert.deepEqual(
    parseConversationClientFrame({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, afterSeq: 8 }),
    { type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, afterSeq: 8 },
  )
  assert.equal(
    parseConversationClientFrame({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, afterSeq: -1 }),
    null,
  )
  // A resume cursor is a sequence plus the log generation it was read from.
  assert.deepEqual(
    parseConversationClientFrame({
      type: 'subscribe',
      key: { workspaceId: 'w', agentId: 'a' },
      afterSeq: 8,
      generation: 'log-1',
      unknown: true,
    }),
    { type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, afterSeq: 8, generation: 'log-1' },
  )
  for (const generation of ['', 7, 'g'.repeat(201)])
    assert.equal(
      parseConversationClientFrame({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, generation }),
      null,
    )
  assert.equal(
    parseConversationClientFrame({
      type: 'command',
      commandId: 'c',
      command: {
        kind: 'resolveApproval',
        requestId: 'r',
        decision: 'always',
      },
    }),
    null,
  )
  assert.equal(
    parseConversationClientFrame({
      type: 'command',
      commandId: 'c',
      command: {
        kind: 'setPermissionPreset',
        preset: 'bypass',
      },
    }),
    null,
  )
  // A CLI-managed preset can inherit a local bypass flag, so it is not a
  // remote-safe way to lower approval friction.
  assert.equal(
    parseConversationClientFrame({
      type: 'command',
      commandId: 'c',
      command: {
        kind: 'setPermissionPreset',
        preset: 'none',
      },
    }),
    null,
  )
  assert.equal(parseConversationClientFrame({ type: 'command', command: { kind: 'send', message: 'hello' } }), null)
})

test('a resync close reason carries the retry delay any client can read', () => {
  const reason = conversationCloseReason('resync_required', 2_000.4)
  assert.equal(reason, 'resync_required;retryAfterMs=2000')
  assert.ok(Buffer.byteLength(reason) <= 123, 'fits a WebSocket close frame')
  assert.equal(conversationCloseRetryAfterMs(reason), 2_000)
  assert.equal(conversationCloseRetryAfterMs('resync_required'), null)
  assert.equal(conversationCloseRetryAfterMs('This device has been revoked.'), null)
})
