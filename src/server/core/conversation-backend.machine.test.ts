import assert from 'node:assert/strict'
import { test } from 'vitest'

import { refuseMachinePaths, type ConversationBackend } from './conversation-backend'

// This process's runtime never runs a chat whose folder is on an SSH machine
// (`ssh://…`): with the SSH machines preview off, such a chat is refused in
// words instead of being read as a folder of this computer.

test('a chat on an SSH machine is refused in words; anything else reaches the runtime unchanged', async () => {
  const calls: string[] = []
  const runtime = {
    sendTurn: async (input: { workspaceRoot?: string }) => (calls.push(`send ${input.workspaceRoot}`), { ok: true }),
    recoverTranscript: async () => (calls.push('recover'), { ok: true }),
    onEvent: () => () => undefined,
  } as unknown as ConversationBackend
  const guarded = refuseMachinePaths(runtime) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>

  const refused = (await guarded.sendTurn!({ workspaceRoot: 'ssh://e1/home/dev/repo' })) as {
    ok: boolean
    message: string
  }
  assert.equal(refused.ok, false)
  assert.match(refused.message, /on an SSH machine/u)
  await assert.rejects(guarded.recoverTranscript!({ key: { workspaceRoot: 'ssh://e1/home/dev/repo' } }), /SSH machine/u)
  assert.deepEqual(calls, [], 'the runtime was never asked')

  assert.deepEqual(await guarded.sendTurn!({ workspaceRoot: '/Users/dev/repo' }), { ok: true })
  assert.deepEqual(calls, ['send /Users/dev/repo'])
  assert.equal(guarded.onEvent, guarded.onEvent, 'a member read twice is the same function')
})
