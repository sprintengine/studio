import assert from 'node:assert/strict'

import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import { followedCheckoutOf, type FollowedCheckoutWorkspace } from './followedCheckout'

// The branch chip's rule (sidebar-lists-every-terminal): follow the focused
// agent, else the last focused, else the most recently active, else the
// workspace's own checkout. DOM-free.

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
    activity: { kind: 'idle', since: 1 },
    lastOutputAt: null,
    lastInputAt: null,
    startedAt: 0,
    ...over,
  }) as TerminalSessionSnapshot

const workspace = (over: Partial<FollowedCheckoutWorkspace> = {}): FollowedCheckoutWorkspace => ({
  id: 'ws',
  folderPath: '/repo',
  agents: {
    a1: { id: 'a1', name: 'Conor Kirby', cli: 'claude-code', execution: { mode: 'current_workspace', worktreeId: null, cwd: '/repo' } },
    a2: { id: 'a2', name: 'Aine Carey', cli: 'codex', execution: { mode: 'current_workspace', worktreeId: null, cwd: '/repo' } },
  } as never,
  ...over,
})

const inWorktree = {
  cwd: '/repo/.claude/worktrees/rail',
  at: 5,
  resolved: true,
  gitRoot: '/repo/.claude/worktrees/rail',
  repoRoot: '/repo',
  branch: 'worktree-workspace-rail',
  isLinkedWorktree: true,
}

// Never focused, nothing live: the workspace's own checkout, nobody followed.
{
  const own = followedCheckoutOf(workspace(), undefined, [])
  assert.deepEqual(own, { probePath: '/repo', branch: null, isRepo: null, agent: null })
}

// The focused agent in its worktree: the chip probes THAT, names its branch,
// and says who it follows.
{
  const followed = followedCheckoutOf(workspace(), 'a2', [
    session({ sessionId: 's1' }),
    session({ sessionId: 's2', agentId: 'a2', cli: 'codex', observedCheckout: inWorktree }),
  ])
  assert.deepEqual(followed, {
    probePath: '/repo/.claude/worktrees/rail',
    branch: 'worktree-workspace-rail',
    isRepo: true,
    agent: { agentId: 'a2', name: 'Aine Carey', cli: 'codex' },
  })
}

// The focused agent on the primary checkout: the workspace path, the observed
// branch, still attributed.
{
  const followed = followedCheckoutOf(workspace(), 'a1', [
    session({ sessionId: 's1', observedCheckout: { ...inWorktree, cwd: '/repo/src', gitRoot: '/repo', branch: 'main', isLinkedWorktree: false } }),
  ])
  assert.equal(followed.probePath, '/repo')
  assert.equal(followed.branch, 'main')
  assert.equal(followed.agent?.name, 'Conor Kirby')
}

// Focused but unobserved: the agent is followed, the probe answers for the
// workspace checkout, and the branch is left to it.
{
  const followed = followedCheckoutOf(workspace(), 'a1', [session({ sessionId: 's1' })])
  assert.deepEqual(followed, { probePath: '/repo', branch: null, isRepo: null, agent: { agentId: 'a1', name: 'Conor Kirby', cli: 'claude-code' } })
}

// The focused agent's tab closed and its session gone: still the one followed
// (the last focused), on the workspace checkout.
{
  const followed = followedCheckoutOf(workspace(), 'a2', [session({ sessionId: 's1', lastOutputAt: 99 })])
  assert.equal(followed.agent?.agentId, 'a2')
  assert.equal(followed.probePath, '/repo')
}

// A focused agent that no longer exists: the most recently active live agent
// stands in; with none, the workspace's own checkout.
{
  const sessions = [session({ sessionId: 's1', lastOutputAt: 10 }), session({ sessionId: 's2', agentId: 'a2', lastOutputAt: 20, observedCheckout: inWorktree })]
  assert.equal(followedCheckoutOf(workspace(), 'gone', sessions).agent?.agentId, 'a2')
  assert.equal(followedCheckoutOf(workspace(), 'gone', sessions).probePath, '/repo/.claude/worktrees/rail')
  assert.equal(followedCheckoutOf(workspace(), 'gone', []).agent, null)
}

// A live session speaks for the agent over a parked one, whatever their order.
{
  const parked = session({ sessionId: 'old', processAlive: false, suspended: true, observedCheckout: { ...inWorktree, gitRoot: '/repo', cwd: '/repo', branch: 'old-branch', isLinkedWorktree: false } })
  const live = session({ sessionId: 'new', observedCheckout: inWorktree, startedAt: 5 })
  assert.equal(followedCheckoutOf(workspace(), 'a1', [parked, live]).branch, 'worktree-workspace-rail')
  assert.equal(followedCheckoutOf(workspace(), 'a1', [live, parked]).branch, 'worktree-workspace-rail')
}

// An agent git placed in a plain folder: followed, but nothing to probe and
// no repository claimed — the workspace's branch is not its answer.
{
  const followed = followedCheckoutOf(workspace(), 'a1', [
    session({ sessionId: 's1', observedCheckout: { ...inWorktree, cwd: '/tmp/x', gitRoot: null, repoRoot: null, branch: null, isLinkedWorktree: false } }),
  ])
  assert.equal(followed.probePath, null)
  assert.equal(followed.isRepo, false)
  assert.equal(followed.agent?.agentId, 'a1')
}

// A worktree-backed workspace with nobody followed keeps its worktree, as before.
{
  const own = followedCheckoutOf(
    workspace({ folderPath: '/repo/.worktrees/feat', worktree: { branch: 'feat' } as never, agents: {} as never }),
    undefined,
    []
  )
  assert.equal(own.probePath, '/repo/.worktrees/feat')
  assert.equal(own.branch, 'feat')
  assert.equal(own.isRepo, true)
}

console.log('followedCheckout: ok')
