import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { TerminalSessionSnapshot } from '../../shared/ipc/terminal'
import { agentCheckoutOf } from './tour-app'

function session(partial: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot {
  return {
    sessionId: 's1',
    processAlive: true,
    kind: 'agent',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    activity: { kind: 'idle', since: 0 },
    ...partial,
  } as TerminalSessionSnapshot
}

test("an agent's checkout is its own chat's, not another chat's agent of the same id", () => {
  const sessions = [
    session({ sessionId: 's-other', workspaceId: 'ws-2', cwd: '/Users/dev/other' }),
    session({ sessionId: 's-mine', cwd: '/Users/dev/app', worktreePath: '/Users/dev/app-wt' }),
  ]
  assert.equal(agentCheckoutOf(sessions, 'ws-1', 'agent-1'), '/Users/dev/app-wt')
  assert.equal(agentCheckoutOf(sessions, 'ws-2', 'agent-1'), '/Users/dev/other')
  assert.equal(agentCheckoutOf(sessions, 'ws-3', 'agent-1'), null)
})

test('an agent moved to another chat is still found under the chat its tour names', () => {
  // The tour was written through the process's MCP binding, which names the
  // chat the agent was launched in; its session now sits in the other one.
  const moved = session({ workspaceId: 'ws-2', launchWorkspaceId: 'ws-1', cwd: '/Users/dev/app' })
  assert.equal(agentCheckoutOf([moved], 'ws-1', 'agent-1'), '/Users/dev/app')
  assert.equal(agentCheckoutOf([moved], 'ws-2', 'agent-1'), '/Users/dev/app')
})
