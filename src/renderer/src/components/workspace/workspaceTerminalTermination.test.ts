import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { Workspace } from '../../types/workspace'
import { terminateSettledWorkspaceTerminals } from './workspaceTerminalTermination'

// Settle's kill waits on main's answer about what is working; a chat the
// person un-settled during that round trip keeps its agents.

test('a chat un-settled while main is asked is not killed; one still settled is', async () => {
  const killed: string[] = []
  Object.assign(globalThis, {
    window: {
      api: {
        terminalList: async () => [],
        conversationSessionsList: async () => ({ ok: true, sessions: [] }),
        terminalKill: async (sessionId: string) => {
          killed.push(sessionId)
        },
      },
    },
  })
  const workspace = {
    id: 'ws-1',
    agents: { a: { cliSessionId: 'pty-1' } },
    layoutModel: {},
  } as unknown as Workspace
  assert.equal(await terminateSettledWorkspaceTerminals(workspace, () => false), false)
  assert.deepEqual(killed, [], 'un-settled meanwhile: nothing killed')
  assert.equal(await terminateSettledWorkspaceTerminals(workspace, () => true), true)
  assert.deepEqual(killed, ['pty-1'])
})
