import assert from 'node:assert/strict'
import { test } from 'vitest'
import { CONVERSATION_CAPABILITY, parseConversationClientFrame } from '../../../../packages/conversation-protocol/src'

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
