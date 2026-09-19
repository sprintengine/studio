import assert from 'node:assert/strict'

import type { ObservedCheckout } from '../../../../shared/observed-checkout'
import { agentCheckoutOf, agentCheckoutProbePath } from './agentCheckout'
import { test } from 'vitest'

test('agentCheckout', async () => {
  // One resolution of "where does this agent run" (sidebar-lists-every-terminal),
  // DOM-free. The tab, the sidebar line and the branch chip all read it.

  const observed = (over: Partial<ObservedCheckout>): ObservedCheckout => ({
    cwd: '/repo/.claude/worktrees/feature/src',
    at: 1,
    resolved: true,
    gitRoot: '/repo/.claude/worktrees/feature',
    repoRoot: '/repo',
    branch: 'agent/feature',
    isLinkedWorktree: true,
    ...over,
  })

  const noIntent = { workspaceWorktree: null, execution: null }
  const workspaceWorktree = {
    workspaceWorktree: { gitRoot: '/repo/.claude/worktrees/run', branch: 'run/1' },
    execution: null,
  }

  // Observed on a linked worktree: the worktree, with the CHECKOUT as the probe
  // path and the cwd (a subdirectory) kept for hover.
  {
    const checkout = agentCheckoutOf({ observedCheckout: observed({}) }, workspaceWorktree)
    assert.deepEqual(checkout, {
      kind: 'worktree',
      branch: 'agent/feature',
      cwd: '/repo/.claude/worktrees/feature/src',
      gitRoot: '/repo/.claude/worktrees/feature',
      observed: true,
    })
    assert.equal(agentCheckoutProbePath(checkout, '/repo'), '/repo/.claude/worktrees/feature')
  }

  // Observed on the primary checkout — even in a worktree-backed workspace, the
  // observation wins over launch intent: the agent LEFT the worktree.
  {
    const checkout = agentCheckoutOf(
      { observedCheckout: observed({ cwd: '/repo', gitRoot: '/repo', branch: 'main', isLinkedWorktree: false }) },
      workspaceWorktree,
    )
    assert.equal(checkout?.kind, 'main')
    assert.equal(checkout?.gitRoot, '/repo')
    assert.equal(checkout?.branch, 'main')
  }

  // A detached HEAD on the primary checkout: main, no branch name.
  {
    const checkout = agentCheckoutOf(
      { observedCheckout: observed({ cwd: '/repo', gitRoot: '/repo', branch: null, isLinkedWorktree: false }) },
      noIntent,
    )
    assert.equal(checkout?.kind, 'main')
    assert.equal(checkout?.branch, null)
  }

  // Not a checkout at all: a folder, nothing to probe — the caller's fallback stands.
  {
    const checkout = agentCheckoutOf(
      {
        observedCheckout: observed({
          cwd: '/tmp/scratch',
          gitRoot: null,
          repoRoot: null,
          branch: null,
          isLinkedWorktree: false,
        }),
      },
      noIntent,
    )
    assert.deepEqual(checkout, { kind: 'folder', cwd: '/tmp/scratch', gitRoot: null, observed: true })
    assert.equal(
      agentCheckoutProbePath(checkout, '/repo'),
      null,
      'the workspace branch is not a folder-bound agent’s answer',
    )
  }

  // The observed directory vanished (a pruned worktree).
  {
    const checkout = agentCheckoutOf(
      {
        observedCheckout: observed({
          cwd: '/repo/.claude/worktrees/gone',
          gitRoot: null,
          repoRoot: null,
          branch: null,
          isLinkedWorktree: false,
          missing: true,
        }),
      },
      noIntent,
    )
    assert.deepEqual(checkout, { kind: 'missing', cwd: '/repo/.claude/worktrees/gone', gitRoot: null, observed: true })
  }

  // Not yet resolved: launch intent answers, marked as such, and the probe path
  // is the intended worktree.
  {
    const checkout = agentCheckoutOf(
      {
        observedCheckout: {
          cwd: '/repo',
          at: 1,
          resolved: false,
          gitRoot: null,
          repoRoot: null,
          branch: null,
          isLinkedWorktree: false,
        },
      },
      workspaceWorktree,
    )
    assert.deepEqual(checkout, {
      kind: 'worktree',
      branch: 'run/1',
      cwd: '/repo/.claude/worktrees/run',
      gitRoot: '/repo/.claude/worktrees/run',
      observed: false,
    })
  }

  // Not yet resolved and no intent: the observation is real, git just has not
  // answered — unverified, with nothing to probe.
  {
    const checkout = agentCheckoutOf(
      {
        observedCheckout: {
          cwd: '/mnt/c/repo',
          at: 1,
          resolved: false,
          gitRoot: null,
          repoRoot: null,
          branch: null,
          isLinkedWorktree: false,
        },
      },
      noIntent,
    )
    assert.deepEqual(checkout, { kind: 'unverified', cwd: '/mnt/c/repo', gitRoot: null, observed: true })
  }

  // No session yet (a tab restored before its terminal): launch intent alone.
  {
    assert.equal(agentCheckoutOf(undefined, workspaceWorktree)?.kind, 'worktree')
    assert.equal(agentCheckoutOf(null, noIntent), null)
  }

  // A per-agent worktree launch (the "+ Worktree" composer) in a plain
  // workspace: the worktree's cwd, no branch claimed, observed false.
  {
    const checkout = agentCheckoutOf(undefined, {
      workspaceWorktree: null,
      execution: { mode: 'worktree', cwd: '/repo/.claude/worktrees/agent-x' },
    })
    assert.deepEqual(checkout, {
      kind: 'worktree',
      branch: null,
      cwd: '/repo/.claude/worktrees/agent-x',
      gitRoot: '/repo/.claude/worktrees/agent-x',
      observed: false,
    })
  }

  // A per-agent worktree launch whose cwd was never recorded: still a worktree
  // by intent, but nothing to probe — the caller falls back.
  {
    const checkout = agentCheckoutOf(undefined, { workspaceWorktree: null, execution: { mode: 'worktree', cwd: null } })
    assert.equal(checkout?.kind, 'worktree')
    assert.equal(
      agentCheckoutProbePath(checkout, '/repo'),
      null,
      'a worktree with no cwd is not the workspace checkout',
    )
  }

  // A main-checkout launch in a plain workspace says nothing until observed.
  {
    assert.equal(
      agentCheckoutOf(undefined, { workspaceWorktree: null, execution: { mode: 'current_workspace', cwd: '/repo' } }),
      null,
    )
    assert.equal(agentCheckoutProbePath(null, '/repo'), '/repo')
  }

  console.log('agentCheckout: ok')
})
