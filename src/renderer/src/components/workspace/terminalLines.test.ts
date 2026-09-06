import assert from 'node:assert/strict'

import type { TerminalSessionSnapshot, WorkspaceChangeSummary } from '../../../../shared/electron-api'
import type { RemoteSessionRow } from './remoteBand/remoteSessionsModel'
import { MAX_TERMINAL_LINES, checkoutPathsOf, lineOfRemoteRow, sessionCheckoutPath, terminalLinesOf, type TerminalLinesWorkspace } from './terminalLines'

// The sidebar row's terminal lines (sidebar-lists-every-terminal), DOM-free:
// one per live terminal, each on ITS checkout, working first, capped.

const session = (over: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot =>
  ({
    sessionId: 's',
    kind: 'agent',
    processAlive: true,
    suspended: false,
    visible: true,
    workspaceId: 'ws',
    agentId: 'a1',
    cli: 'claude-code',
    activity: { kind: 'idle', since: 1_000 },
    lastOutputAt: null,
    lastInputAt: null,
    startedAt: 0,
    ...over,
  }) as TerminalSessionSnapshot

const workspace = (over: Partial<TerminalLinesWorkspace> = {}): TerminalLinesWorkspace => ({
  folderPath: '/repo',
  agents: {
    a1: { id: 'a1', name: 'Conor Kirby', execution: { mode: 'current_workspace', worktreeId: null, cwd: '/repo' } },
    a2: { id: 'a2', name: 'Aine Carey', execution: { mode: 'current_workspace', worktreeId: null, cwd: '/repo' } },
  } as never,
  ...over,
})

const summary = (over: Partial<WorkspaceChangeSummary>): WorkspaceChangeSummary => ({
  branch: 'main',
  additions: 202,
  deletions: 122,
  changedFiles: 9,
  scope: 'folder',
  ...over,
})

const worktreeObserved = {
  cwd: '/repo/.claude/worktrees/rail/src',
  at: 5,
  resolved: true,
  gitRoot: '/repo/.claude/worktrees/rail',
  repoRoot: '/repo',
  branch: 'worktree-workspace-rail',
  isLinkedWorktree: true,
}

// A session with nothing observed reports on the workspace checkout; one
// observed in a worktree reports on THAT; one in a plain folder on nothing.
{
  const ws = workspace()
  assert.equal(sessionCheckoutPath(ws, session({})), '/repo')
  assert.equal(sessionCheckoutPath(ws, session({ observedCheckout: worktreeObserved })), '/repo/.claude/worktrees/rail')
  assert.equal(
    sessionCheckoutPath(ws, session({ observedCheckout: { ...worktreeObserved, gitRoot: null, repoRoot: null, branch: null, isLinkedWorktree: false, cwd: '/tmp' } })),
    null
  )
  // Distinct, for the poll: two on main ask once, the worktree asks for itself.
  assert.deepEqual(
    checkoutPathsOf(ws, [session({ sessionId: 's1' }), session({ sessionId: 's2', agentId: 'a2' }), session({ sessionId: 's3', observedCheckout: worktreeObserved })]),
    ['/repo', '/repo/.claude/worktrees/rail']
  )
}

// Each line reads ITS checkout's facts: the shared checkout quietly (folder
// scope), the worktree at full strength with the path for hover.
{
  const summaries = {
    '/repo': summary({}),
    '/repo/.claude/worktrees/rail': summary({ branch: 'worktree-workspace-rail', additions: 1048, deletions: 21762, scope: 'worktree' }),
  }
  const { lines, overflow } = terminalLinesOf({
    workspace: workspace(),
    sessions: [
      session({ sessionId: 's1', lastOutputAt: 10 }),
      session({ sessionId: 's2', agentId: 'a2', observedCheckout: worktreeObserved, lastOutputAt: 20 }),
    ],
    fleetPanes: [],
    summaries,
  })
  assert.equal(overflow, 0)
  assert.deepEqual(
    lines.map((line) => [line.name, line.branch, line.worktree, line.additions, line.diffScope, line.cwd]),
    [
      ['Aine Carey', 'worktree-workspace-rail', true, 1048, 'worktree', '/repo/.claude/worktrees/rail/src'],
      ['Conor Kirby', 'main', false, 202, 'folder', null],
    ],
    'the more recent line first; each on its own checkout'
  )
}

// A working line outranks a more recent idle one; a plain shell is a line too,
// named Terminal; a fleet pane is a line with its machine and no diff claim.
{
  const { lines } = terminalLinesOf({
    workspace: workspace({ remoteOrigin: { checkout: { branch: 'remote-main' } } as never }),
    sessions: [
      session({ sessionId: 'idle-recent', lastOutputAt: 900 }),
      session({
        sessionId: 'working',
        agentId: 'a2',
        activity: { kind: 'working', since: 100 },
        agentState: { phase: 'thinking', source: 'hook', since: 100 } as never,
        lastPrompt: { at: 120 } as never,
      }),
      session({ sessionId: 'shell', kind: 'terminal', cli: undefined, agentId: undefined, lastOutputAt: 500 }),
    ],
    fleetPanes: [{ tabId: 'fleet-terminal:c1:s9', machineName: 'air.local', cli: 'codex' }],
    summaries: { '/repo': summary({}) },
  })
  assert.deepEqual(
    lines.map((line) => [line.key, line.kind, line.name, line.working, line.workingSince]),
    [
      ['working', 'agent', 'Aine Carey', true, 120],
      ['idle-recent', 'agent', 'Conor Kirby', false, null],
      ['shell', 'shell', 'Terminal', false, null],
      ['fleet-terminal:c1:s9', 'remote', null, false, null],
    ]
  )
  const pane = lines[3]
  assert.equal(pane.machineName, 'air.local', 'the machine is the glyph’s name, never line text')
  assert.equal(pane.branch, 'remote-main', 'the branch stamped at the remote create')
  assert.equal(pane.additions + pane.deletions, 0, 'no ±lines are claimed for a checkout on another disk')
  assert.equal(lines[2].branch, 'main', 'a shell on the workspace checkout still names the branch')
}

// A waiting line says so; a failed one says so.
{
  const { lines } = terminalLinesOf({
    workspace: workspace(),
    sessions: [
      session({ sessionId: 'waiting', agentState: { phase: 'awaiting_input', source: 'hook', since: 1 } as never }),
      session({ sessionId: 'failed', agentId: 'a2', activity: { kind: 'failed', at: 7, exitCode: 1 } }),
    ],
    fleetPanes: [],
    summaries: {},
  })
  const byKey = Object.fromEntries(lines.map((line) => [line.key, line]))
  assert.equal(byKey.waiting.needsInput, true)
  assert.equal(byKey.failed.failed, true)
  assert.equal(byKey.failed.idleSince, 7, 'a failure is when it stopped')
}

// Past the cap the rest fold into an overflow count, most recent kept.
{
  const sessions = Array.from({ length: MAX_TERMINAL_LINES + 2 }, (_, index) =>
    session({ sessionId: `s${index}`, activity: { kind: 'idle', since: 1_000 + index } })
  )
  const { lines, overflow } = terminalLinesOf({ workspace: workspace(), sessions, fleetPanes: [], summaries: {} })
  assert.equal(lines.length, MAX_TERMINAL_LINES)
  assert.equal(overflow, 2)
  assert.equal(lines[0].key, `s${MAX_TERMINAL_LINES + 1}`, 'the most recent stays')
}

// A remote band row's line: no name (the row's title is the conversation),
// its stamped facts, and paused reads as paused.
{
  const row = {
    sessionId: 'r1',
    cli: 'codex',
    branch: 'feat/x',
    additions: 3,
    deletions: 1,
    diffScope: 'worktree',
    activity: 'paused',
    since: 42,
  } as RemoteSessionRow
  const line = lineOfRemoteRow(row)
  assert.equal(line.name, null)
  assert.equal(line.worktree, true)
  assert.equal(line.idleSince, 42)
  assert.equal(line.idleLabel, 'Paused')
  const working = lineOfRemoteRow({ ...row, activity: 'working' } as RemoteSessionRow)
  assert.equal(working.working, true)
  assert.equal(working.workingSince, 42)
  assert.equal(working.idleSince, null)
}

console.log('terminalLines: ok')
