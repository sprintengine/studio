import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import { CONVERSATION_CAPABILITY, parseConversationClientFrame } from '../../../../packages/conversation-protocol/src'

test('portable protocol source stays byte-identical to the companion source mirror', () => {
  const hash = createHash('sha256')
  for (const name of ['index.ts', 'presentation.ts', 'tool-types.ts', 'toolKind.ts']) {
    hash.update(name)
    hash.update('\0')
    hash.update(readFileSync(join(process.cwd(), 'packages/conversation-protocol/src', name)))
  }
  // Update this pin and the companion's pin together only after comparing both
  // source trees. A local digest alone cannot detect a stale peer mirror.
  assert.equal(hash.digest('hex'), 'd7e2941dfa126d572b4ee8a3584b9122ec21914d1939a797d92ebbf4f3f27937')
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
