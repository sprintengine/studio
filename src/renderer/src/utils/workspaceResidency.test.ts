import assert from 'node:assert/strict'
import { residentAgentWorkspaceIds } from './workspaceResidency'

function session(input: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot {
  return {
    sessionId: 'session-1',
    processAlive: true,
    kind: 'agent',
    startedAt: 1,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'idle', since: 1 },
    exitedAt: null,
    outputBufferLength: 0,
    retainedOutputBytes: 0,
    visible: true,
    suspended: false,
    fileChanges: [],
    activeSubagents: 0,
    contextUsage: null,
    reapExempt: false,
    ...input,
  }
}

// A live agent PTY marks its workspace resident.
assert.deepEqual(
  [...residentAgentWorkspaceIds([session({ workspaceId: 'ws-1', processAlive: true })])],
  ['ws-1'],
)

// A suspended/exited agent (processAlive false) does NOT count — this is the
// reaper's suspend path, where the row should un-bold.
assert.deepEqual(
  [...residentAgentWorkspaceIds([session({ workspaceId: 'ws-1', processAlive: false })])],
  [],
)

// Plain terminals are never agents, so they never make a workspace "hot".
assert.deepEqual(
  [...residentAgentWorkspaceIds([session({ workspaceId: 'ws-1', kind: 'terminal', processAlive: true })])],
  [],
)

// A session with no workspaceId is ignored (cannot be attributed).
assert.deepEqual(
  [...residentAgentWorkspaceIds([session({ workspaceId: undefined, processAlive: true })])],
  [],
)

// Multiple live agents in the same workspace collapse to one entry; distinct
// workspaces each appear once.
assert.deepEqual(
  new Set(
    residentAgentWorkspaceIds([
      session({ sessionId: 's1', workspaceId: 'ws-1', processAlive: true }),
      session({ sessionId: 's2', workspaceId: 'ws-1', processAlive: true }),
      session({ sessionId: 's3', workspaceId: 'ws-2', processAlive: true }),
      session({ sessionId: 's4', workspaceId: 'ws-3', processAlive: false }),
    ]),
  ),
  new Set(['ws-1', 'ws-2']),
)

console.log('workspaceResidency.test.ts passed')
