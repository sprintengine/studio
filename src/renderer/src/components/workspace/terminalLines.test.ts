import assert from 'node:assert/strict'

import type { SessionFileChange, TerminalSessionSnapshot, WorkspaceChangeSummary } from '../../../../shared/electron-api'
import type { RemoteSessionRow } from './remoteBand/remoteSessionsModel'
import { MAX_TERMINAL_LINES, checkoutPathsOf, diffScopeCopy, lineOfRemoteRow, sessionCheckoutPath, terminalLinesOf, type TerminalLinesWorkspace } from './terminalLines'

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
  sprintEngineState: null,
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

// One entry of a session's own hook ledger (hook-file-ledger): what the agent
// edited, as its PostToolUse hooks reported it.
const edited = (path: string, additions: number, deletions: number, edits = 1): SessionFileChange => ({
  path,
  additions,
  deletions,
  edits,
  lastEditedAt: 1_000,
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
  assert.equal(line.diffScope, 'worktree', 'a remote sends a git reading, never a ledger')
  assert.equal(line.changedFiles, 0)
  assert.equal(line.activeSubagents, 0)
  assert.equal(line.worktree, true)
  assert.equal(line.idleSince, 42)
  assert.equal(line.idleLabel, 'Paused')
  const working = lineOfRemoteRow({ ...row, activity: 'working' } as RemoteSessionRow)
  assert.equal(working.working, true)
  assert.equal(working.workingSince, 42)
  assert.equal(working.idleSince, null)
}

// The numbers come from the session's OWN ledger when it has one: summed over
// every file it edited, cumulative, and scoped `session` — no git in it. The
// point of the change: two agents on ONE checkout, where the git reading gave
// both the same numbers, now say different things.
{
  const summaries = { '/repo': summary({ additions: 202, deletions: 122, scope: 'branch', branch: 'feat/x' }) }
  const { lines, rowDiff } = terminalLinesOf({
    workspace: workspace(),
    sessions: [
      session({
        sessionId: 's1',
        lastOutputAt: 20,
        fileChanges: [edited('/repo/src/a.ts', 10, 4), edited('/repo/src/b.ts', 6, 1, 3)],
      }),
      session({ sessionId: 's2', agentId: 'a2', lastOutputAt: 10, fileChanges: [edited('/repo/src/c.ts', 2, 0)] }),
    ],
    fleetPanes: [],
    summaries,
  })
  assert.deepEqual(
    lines.map((line) => [line.name, line.additions, line.deletions, line.changedFiles, line.diffScope]),
    [
      ['Aine Carey', 2, 0, 1, 'session'],
      ['Conor Kirby', 16, 5, 2, 'session'],
    ],
    'each line sums its own ledger; the shared checkout no longer speaks for either'
  )
  assert.equal(lines[0].branch, 'feat/x', 'the branch is still the checkout\u2019s — the ledger says nothing about where it sits')
  // Every agent reports, so the row may add them up and claim the sum.
  assert.deepEqual(rowDiff, { additions: 18, deletions: 5, fileEdits: 3, scope: 'session' })
}

// A ledger recorded path-only (a tool result whose shape the reporter could
// not count) states no lines, so it is not a reading: the line keeps the
// checkout's numbers. Otherwise a CLI whose hooks half-work would draw NOTHING
// — the row hides a +0 −0 — where a CLI with no hooks at all draws the folder.
{
  const { lines } = terminalLinesOf({
    workspace: workspace(),
    sessions: [session({ sessionId: 's1', fileChanges: [edited('/repo/src/a.ts', 0, 0)] })],
    fleetPanes: [],
    summaries: { '/repo': summary({ additions: 202, deletions: 122, changedFiles: 9 }) },
  })
  assert.deepEqual(
    [lines[0].additions, lines[0].deletions, lines[0].changedFiles, lines[0].diffScope],
    [202, 122, 9, 'folder']
  )
  // One countable edit among the uncountable ones IS a reading, and the
  // uncountable file still counts as a file.
  const { lines: some } = terminalLinesOf({
    workspace: workspace(),
    sessions: [session({ sessionId: 's1', fileChanges: [edited('/repo/src/a.ts', 0, 0), edited('/repo/src/b.ts', 5, 2)] })],
    fleetPanes: [],
    summaries: { '/repo': summary({ additions: 202, deletions: 122 }) },
  })
  assert.deepEqual(
    [some[0].additions, some[0].deletions, some[0].changedFiles, some[0].diffScope],
    [5, 2, 2, 'session']
  )
}

// A session in a worktree of its OWN reads its ledger too (owner decision
// 2026-09-09: no git for a session that has one). This is the case where the
// git span was already attributable to the one session, so the choice is
// deliberate — one meaning for the number on every line — and pinned here so
// it cannot change by accident.
{
  const { lines } = terminalLinesOf({
    workspace: workspace(),
    sessions: [session({ sessionId: 's1', observedCheckout: worktreeObserved, fileChanges: [edited('/repo/src/a.ts', 9, 2)] })],
    fleetPanes: [],
    summaries: {
      '/repo/.claude/worktrees/rail': summary({ branch: 'worktree-workspace-rail', additions: 1048, deletions: 21762, scope: 'worktree' }),
    },
  })
  assert.deepEqual([lines[0].additions, lines[0].deletions, lines[0].diffScope], [9, 2, 'session'])
  assert.equal(lines[0].branch, 'worktree-workspace-rail', 'and it is still in its own worktree')
  assert.equal(lines[0].worktree, true)
}

// A shell never claims a session reading, whatever arrives on its snapshot:
// the words the scope licenses say "this agent", and a shell is not one.
{
  const { lines } = terminalLinesOf({
    workspace: workspace(),
    sessions: [
      session({
        sessionId: 'shell',
        kind: 'terminal',
        cli: undefined,
        agentId: undefined,
        fileChanges: [edited('/repo/src/a.ts', 5, 5)],
        activeSubagents: 2,
      }),
    ],
    fleetPanes: [],
    summaries: { '/repo': summary({ additions: 202, deletions: 122 }) },
  })
  assert.deepEqual([lines[0].additions, lines[0].deletions, lines[0].diffScope], [202, 122, 'folder'])
  assert.equal(lines[0].activeSubagents, 0)
}

// No ledger — a hookless CLI, a plain shell, an agent that has not written
// anything yet — falls back to the checkout summary exactly as before.
{
  const summaries = { '/repo': summary({ additions: 202, deletions: 122, changedFiles: 9, scope: 'folder' }) }
  const { lines, rowDiff } = terminalLinesOf({
    workspace: workspace(),
    sessions: [
      session({ sessionId: 'empty', fileChanges: [] }),
      // A snapshot from before the field existed (a parked session restored
      // from an older sidecar) must not throw or claim a session reading.
      session({ sessionId: 'absent', agentId: 'a2', fileChanges: undefined as never }),
    ],
    fleetPanes: [],
    summaries,
  })
  for (const line of lines) {
    assert.deepEqual(
      [line.additions, line.deletions, line.changedFiles, line.diffScope, line.activeSubagents],
      [202, 122, 9, 'folder', 0],
      `${line.key} keeps the checkout reading`
    )
  }
  assert.equal(rowDiff, null, 'a row nobody reports for keeps the behaviour it had')
}

// A MIXED row — one agent with a ledger, one without — may claim no sum: the
// two readings measure different things and adding them would mean nothing.
// A plain shell neither contributes nor disqualifies; nor does a fleet pane.
{
  const summaries = { '/repo': summary({}) }
  const mixed = terminalLinesOf({
    workspace: workspace(),
    sessions: [
      session({ sessionId: 'ledger', fileChanges: [edited('/repo/src/a.ts', 3, 1)] }),
      session({ sessionId: 'none', agentId: 'a2', fileChanges: [] }),
    ],
    fleetPanes: [],
    summaries,
  })
  assert.equal(mixed.rowDiff, null)
  const shellToo = terminalLinesOf({
    workspace: workspace(),
    sessions: [
      session({ sessionId: 'ledger', fileChanges: [edited('/repo/src/a.ts', 3, 1)] }),
      session({ sessionId: 'shell', kind: 'terminal', cli: undefined, agentId: undefined, fileChanges: [] }),
    ],
    fleetPanes: [{ tabId: 'fleet-terminal:c1:s9', machineName: 'air.local', cli: 'codex' }],
    summaries,
  })
  assert.deepEqual(shellToo.rowDiff, { additions: 3, deletions: 1, fileEdits: 1, scope: 'session' })
}

// A row with no agent line has no aggregate to claim — not a zero.
{
  const shellOnly = terminalLinesOf({
    workspace: workspace(),
    sessions: [session({ sessionId: 'shell', kind: 'terminal', cli: undefined, agentId: undefined, fileChanges: [] })],
    fleetPanes: [],
    summaries: { '/repo': summary({}) },
  })
  assert.equal(shellOnly.rowDiff, null)
  const fleetOnly = terminalLinesOf({
    workspace: workspace(),
    sessions: [],
    fleetPanes: [{ tabId: 'fleet-terminal:c1:s9', machineName: 'air.local', cli: 'codex' }],
    summaries: {},
  })
  assert.equal(fleetOnly.rowDiff, null)
  assert.equal(fleetOnly.lines[0].activeSubagents, 0, 'a pane on another machine reports no subagents')
  assert.equal(fleetOnly.lines[0].changedFiles, 0)
}

// The row's figure covers every agent it has, including the ones folded past
// the cap — it is the row's total, not the visible four's.
{
  const sessions = Array.from({ length: MAX_TERMINAL_LINES + 2 }, (_, index) =>
    session({
      sessionId: `s${index}`,
      activity: { kind: 'idle', since: 1_000 + index },
      fileChanges: [edited(`/repo/src/${index}.ts`, 1, 1)],
    })
  )
  const { lines, overflow, rowDiff } = terminalLinesOf({ workspace: workspace(), sessions, fleetPanes: [], summaries: {} })
  assert.equal(lines.length, MAX_TERMINAL_LINES)
  assert.equal(overflow, 2)
  assert.deepEqual(rowDiff, {
    additions: MAX_TERMINAL_LINES + 2,
    deletions: MAX_TERMINAL_LINES + 2,
    fileEdits: MAX_TERMINAL_LINES + 2,
    scope: 'session',
  })
}

// Subagents ride the line for a later renderer; nothing draws them yet.
{
  const { lines } = terminalLinesOf({
    workspace: workspace(),
    sessions: [session({ sessionId: 's1', activeSubagents: 3 })],
    fleetPanes: [],
    summaries: {},
  })
  assert.equal(lines[0].activeSubagents, 3)
}

// The scope's words, one place for both spellings: the tooltip and the
// sentence a screen reader hears. Only `session` speaks of the AGENT, and only
// a folder reading — the one nobody can be credited with — steps back.
{
  const own = diffScopeCopy({ diffScope: 'session', branch: 'main', additions: 31, deletions: 7 })
  assert.equal(own.tooltip, 'Changed by this agent — the edits it made through its tools, including ones it has since undone')
  // The spoken label carries the caveat too: a screen reader never gets the
  // tooltip, so "by this agent" alone would claim more than the words on hover.
  assert.equal(own.srText, '31 added, 7 removed by this agent’s own edits')
  assert.equal(own.dim, false)
  const worktree = diffScopeCopy({ diffScope: 'worktree', branch: 'agent/x', additions: 12, deletions: 3 })
  assert.equal(worktree.srText, '12 added, 3 removed by this terminal')
  assert.equal(worktree.dim, false)
  const branch = diffScopeCopy({ diffScope: 'branch', branch: 'feat/y', additions: 40, deletions: 8 })
  assert.match(branch.tooltip, /^Changed on feat\/y — this terminal shares the checkout/)
  assert.equal(branch.srText, '40 added, 8 removed on feat/y')
  const branchless = diffScopeCopy({ diffScope: 'branch', branch: null, additions: 5, deletions: 1 })
  assert.equal(branchless.srText, '5 added, 1 removed on this branch')
  const folder = diffScopeCopy({ diffScope: 'folder', branch: 'main', additions: 246, deletions: 94 })
  assert.equal(folder.srText, '246 added, 94 removed in this folder')
  assert.equal(folder.dim, true, 'the repo\u2019s state is nobody\u2019s work, so it steps back')
}

console.log('terminalLines: ok')
