import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  CONVERSATION_CAPABILITY,
  CONVERSATION_MAX_CLIENT_FRAME_BYTES,
  CONVERSATION_MAX_MESSAGE_CHARS,
  CONVERSATION_MAX_IMAGES,
  conversationCloseReason,
  explainRejectedConversationFrame,
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
  assert.equal(hash.digest('hex'), 'ac6b94800c943f2576702c4abaabe3cf8df778f2a320f8b2d038931761d0e278')
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

test('every frame the validator accepts fits the client frame cap', () => {
  // The worst case: every unit of the longest message escaped, the longest ids,
  // every image reference.
  const frame = {
    type: 'command',
    commandId: 'c'.repeat(200),
    command: {
      kind: 'send',
      message: '\u0001'.repeat(CONVERSATION_MAX_MESSAGE_CHARS),
      uploadIds: Array.from({ length: CONVERSATION_MAX_IMAGES }, () => 'u'.repeat(200)),
    },
  }
  assert.ok(parseConversationClientFrame(frame))
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= CONVERSATION_MAX_CLIENT_FRAME_BYTES)
  const answers = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [`q${index}`.padEnd(200, '?'), '\u0001'.repeat(2_900)]),
  )
  const answer = {
    type: 'command',
    commandId: 'c'.repeat(200),
    command: { kind: 'answerQuestion', requestId: 'r', answers },
  }
  assert.ok(parseConversationClientFrame(answer))
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= CONVERSATION_MAX_CLIENT_FRAME_BYTES)
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`q${index}`, 'a']))
  assert.equal(parseConversationClientFrame({ ...answer, command: { ...answer.command, answers: tooMany } }), null)
})

test('a refused frame is explained under the id it carries', () => {
  const send = (message: string) => ({ type: 'command', commandId: 'c', command: { kind: 'send', message } })
  assert.deepEqual(explainRejectedConversationFrame(send('x'.repeat(CONVERSATION_MAX_MESSAGE_CHARS + 1))), {
    code: 'too_large',
    message: `A message may hold at most ${CONVERSATION_MAX_MESSAGE_CHARS} characters.`,
    commandId: 'c',
    commandKind: 'send',
  })
  assert.equal(
    explainRejectedConversationFrame({
      type: 'command',
      commandId: 'c',
      command: { kind: 'resolveApproval', requestId: 'r', decision: 'always' },
    }).code,
    'unsafe_remote_decision',
  )
  assert.equal(
    explainRejectedConversationFrame({ type: 'command', commandId: 'c', command: { kind: 'format_disk' } }).code,
    'unsupported_command',
  )
  assert.deepEqual(explainRejectedConversationFrame({ type: 'loadEarlier', requestId: 'r', beforeCursor: -1 }), {
    code: 'invalid_frame',
    message: 'Unsupported conversation frame.',
    requestId: 'r',
  })
  assert.deepEqual(explainRejectedConversationFrame('nonsense'), {
    code: 'invalid_frame',
    message: 'Unsupported conversation frame.',
  })
})
