import assert from 'node:assert/strict'
import type { PsProcessRow } from './child-process-metrics'
import {
  rollupWorkspaceMemory,
  sumSubtreeRssBytes,
  type TerminalRootInfo,
} from './workspace-memory'

function row(pid: number, ppid: number, rssKb: number): PsProcessRow {
  return { pid, ppid, rssKb, cpuPercent: 0, command: 'node', args: '' }
}

function root(overrides: Partial<TerminalRootInfo> & { sessionId: string; rootPid: number }): TerminalRootInfo {
  return {
    workspaceId: 'ws-1',
    agentId: null,
    terminalId: null,
    kind: 'agent',
    cli: 'claude',
    activityKind: 'idle',
    processAlive: true,
    startedAt: 1_000,
    ...overrides,
  }
}

// --- sumSubtreeRssBytes ---

// Root + its descendants are summed; a sibling tree is excluded.
{
  const rows = [
    row(100, 1, 10), // root pty
    row(101, 100, 20), // claude under pty
    row(102, 101, 30), // mcp under claude
    row(200, 1, 999), // unrelated tree
  ]
  assert.equal(sumSubtreeRssBytes(100, rows), (10 + 20 + 30) * 1024)
  assert.equal(sumSubtreeRssBytes(200, rows), 999 * 1024)
}

// A root pid absent from the snapshot contributes nothing (process already gone).
assert.equal(sumSubtreeRssBytes(404, [row(1, 0, 5)]), 0)

// Cycles / repeated pids don't double-count or loop forever.
assert.equal(sumSubtreeRssBytes(1, [row(1, 1, 7)]), 7 * 1024)

// --- rollupWorkspaceMemory ---

{
  const rows = [
    row(100, 1, 10),
    row(101, 100, 90), // ws-1 / session a subtree = 100 KB
    row(200, 1, 50), // ws-1 / session b subtree = 50 KB
    row(300, 1, 300), // ws-2 / session c subtree = 300 KB
  ]
  const roots: TerminalRootInfo[] = [
    root({ sessionId: 'a', rootPid: 100, workspaceId: 'ws-1', startedAt: 5_000, processAlive: true }),
    root({ sessionId: 'b', rootPid: 200, workspaceId: 'ws-1', startedAt: 2_000, kind: 'terminal', cli: null, processAlive: true }),
    root({ sessionId: 'c', rootPid: 300, workspaceId: 'ws-2', startedAt: 9_000, processAlive: true }),
    root({ sessionId: 'd', rootPid: 999, workspaceId: null }), // no workspace → skipped
  ]
  const result = rollupWorkspaceMemory(roots, rows)

  // Heaviest workspace first: ws-2 (300 KB) before ws-1 (150 KB).
  assert.deepEqual(result.map((w) => w.workspaceId), ['ws-2', 'ws-1'])

  const ws1 = result.find((w) => w.workspaceId === 'ws-1')!
  assert.equal(ws1.totalMemoryBytes, (100 + 50) * 1024)
  // resident = has a live AGENT; the plain terminal alone would not qualify.
  assert.equal(ws1.resident, true)
  // becameLiveAt = earliest live terminal start (the plain terminal at 2_000).
  assert.equal(ws1.becameLiveAt, 2_000)
  // Terminals sorted heaviest first within the workspace.
  assert.deepEqual(ws1.terminals.map((t) => t.sessionId), ['a', 'b'])
  assert.equal(ws1.terminals[0].memoryBytes, 100 * 1024)

  // Session with no workspace is dropped entirely.
  assert.equal(result.some((w) => w.terminals.some((t) => t.sessionId === 'd')), false)
}

// A workspace whose only live terminal is a plain shell is not "resident".
{
  const rows = [row(100, 1, 40)]
  const result = rollupWorkspaceMemory(
    [root({ sessionId: 's', rootPid: 100, kind: 'terminal', cli: null, processAlive: true })],
    rows
  )
  assert.equal(result[0].resident, false)
  assert.equal(result[0].totalMemoryBytes, 40 * 1024)
}

console.log('workspace-memory.test.ts passed')
