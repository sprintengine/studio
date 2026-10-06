import assert from 'node:assert/strict'

import { beforeEach, test, vi } from 'vitest'

// Continue in terminal from a tab's menu brings a chat's reclaimed worktree
// back first, as the open chat does, and hands nothing over when it cannot.

const restore = vi.hoisted(() => ({ ok: true, asked: [] as string[] }))
vi.mock('../../../utils/chatWorktreeRestore', () => ({
  ensureChatWorktree: async (workspaceId: string) => {
    restore.asked.push(workspaceId)
    return restore.ok
  },
}))

const { resumeChatInTerminal } = await import('./resumeInTerminal')

const handoffs: unknown[] = []
beforeEach(() => {
  restore.asked.length = 0
  handoffs.length = 0
  Object.assign(globalThis, {
    window: {
      api: {
        conversationSessionTerminalHandoff: async (input: unknown) => {
          handoffs.push(input)
          return { ok: true, workspaceId: 'ws-1', agentId: 'agent-claude-code-1' }
        },
      },
    },
  })
})

test('the worktree is brought back before the handoff', async () => {
  restore.ok = true
  assert.deepEqual(await resumeChatInTerminal({ workspaceId: 'ws-1', agentId: 'chat-1' }), { ok: true })
  assert.deepEqual(restore.asked, ['ws-1'])
  assert.deepEqual(handoffs, [{ workspaceId: 'ws-1', agentId: 'chat-1' }])
})

test('a worktree that could not come back hands nothing over', async () => {
  restore.ok = false
  const result = await resumeChatInTerminal({ workspaceId: 'ws-1', agentId: 'chat-1' })
  assert.equal(result.ok, false)
  assert.deepEqual(handoffs, [])
})
