import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { TerminalSessionSnapshot } from '../../shared/ipc/terminal'
import { findEditorAgentSession } from './editor-tool-backends'

function session(partial: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot {
  return {
    sessionId: 's1',
    processAlive: true,
    kind: 'agent',
    agentId: 'agent-1',
    activity: { kind: 'idle', since: 0 },
    ...partial,
  } as TerminalSessionSnapshot
}

test("an agent connection speaks for its own chat's session, not another chat's agent of the same id", () => {
  const sessions = [
    session({ sessionId: 's-other', workspaceId: 'ws-2', cwd: '/Users/dev/other' }),
    session({ sessionId: 's-mine', workspaceId: 'ws-1', cwd: '/Users/dev/app' }),
  ]
  assert.equal(findEditorAgentSession(sessions, 'ws-1', 'agent-1')?.cwd, '/Users/dev/app')
  assert.equal(findEditorAgentSession(sessions, 'ws-3', 'agent-1'), null)
})

test('a session naming no workspace is used only when the workspace has none of its own', () => {
  const unscoped = session({ sessionId: 's-unscoped', cwd: '/Users/dev/somewhere' })
  const own = session({ sessionId: 's-own', workspaceId: 'ws-1', cwd: '/Users/dev/app', processAlive: false })
  assert.equal(findEditorAgentSession([unscoped, own], 'ws-1', 'agent-1')?.cwd, '/Users/dev/app')
  assert.equal(findEditorAgentSession([unscoped], 'ws-1', 'agent-1')?.cwd, '/Users/dev/somewhere')
})
