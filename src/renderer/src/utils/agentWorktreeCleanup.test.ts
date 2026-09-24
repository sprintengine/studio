import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorktreeEntry } from '../types/workspace'
import { releaseWorktreeEntriesOwnedBy } from '../store/slices/worktreesSlice'
import { agentWorktreeCleanupPlan, entriesRemovedBy } from './agentWorktreeCleanup'

const CONTAINER = '/Users/dev/.sprintengine-worktrees/app'

function entry(id: string, patch: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    id,
    path: `${CONTAINER}/${id}`,
    branch: `agent/${id}`,
    ownerAgentId: null,
    status: 'available',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function agent(worktreeId: string | null, cwd: string | null = null) {
  return { execution: { mode: worktreeId ? 'worktree' : 'current_workspace', worktreeId, cwd } }
}

test('removing an agent releases the worktree it held', () => {
  const workspace = {
    worktreeState: {
      containerPath: CONTAINER,
      updatedAt: 1,
      entries: {
        mine: entry('mine', { ownerAgentId: 'agent-1', status: 'assigned' }),
        theirs: entry('theirs', { ownerAgentId: 'agent-2', status: 'assigned' }),
      },
    },
  }
  assert.equal(releaseWorktreeEntriesOwnedBy(workspace, 'agent-1', 42), 1)
  assert.equal(workspace.worktreeState.entries.mine.status, 'available')
  assert.equal(workspace.worktreeState.entries.mine.ownerAgentId, null)
  assert.equal(workspace.worktreeState.entries.mine.updatedAt, 42)
  assert.equal(workspace.worktreeState.entries.theirs.status, 'assigned', 'another agent keeps its own')
})

test('the plan protects everything the records still use, and nothing an absent agent held', () => {
  const workspaces = [
    {
      id: 'ws-project',
      folderPath: '/Users/dev/app',
      worktree: null,
      agents: {
        live: agent('held'),
        parked: agent(null, `${CONTAINER}/by-cwd`),
      },
      worktreeState: {
        containerPath: CONTAINER,
        updatedAt: 1,
        entries: {
          held: entry('held', { ownerAgentId: 'live', status: 'assigned' }),
          orphan: entry('orphan', { ownerAgentId: 'long-gone', status: 'assigned' }),
          released: entry('released'),
          removing: entry('removing', { status: 'removing' }),
        },
      },
    },
    {
      id: 'ws-chat',
      folderPath: `${CONTAINER}/chat-ab12`,
      worktree: { branch: 'agent/chat-ab12', baseRef: 'HEAD', repoRoot: '/Users/dev/app' },
      agents: {},
      worktreeState: { containerPath: null, updatedAt: null, entries: {} },
    },
  ] as unknown as Parameters<typeof agentWorktreeCleanupPlan>[0]

  const plan = agentWorktreeCleanupPlan(workspaces)
  assert.deepEqual(plan.repoRoots, ['/Users/dev/app'], 'the chat files under the project it was cut from')
  const protectedSet = new Set(plan.protectedPaths)
  for (const path of [
    '/Users/dev/app',
    `${CONTAINER}/chat-ab12`,
    `${CONTAINER}/held`,
    `${CONTAINER}/by-cwd`,
    `${CONTAINER}/removing`,
  ]) {
    assert.ok(protectedSet.has(path), `${path} is protected`)
  }
  assert.equal(protectedSet.has(`${CONTAINER}/orphan`), false, 'an owner that no longer exists protects nothing')
  assert.equal(protectedSet.has(`${CONTAINER}/released`), false)

  const removed = entriesRemovedBy(workspaces, {
    repoRoot: '/Users/dev/app',
    defaultRef: 'origin/main',
    dryRun: false,
    entries: [
      { path: `${CONTAINER}/orphan`, branch: 'agent/orphan', verdict: 'removed' },
      { path: `${CONTAINER}/released`, branch: 'agent/released', verdict: 'unmerged', uniqueCommits: 2 },
    ],
  })
  assert.deepEqual(removed, [['ws-project', 'orphan']], 'only what was removed leaves the store')
  assert.deepEqual(
    entriesRemovedBy(workspaces, {
      repoRoot: '/Users/dev/app',
      defaultRef: 'origin/main',
      dryRun: true,
      entries: [{ path: `${CONTAINER}/orphan`, branch: 'agent/orphan', verdict: 'removed' }],
    }),
    [],
    'a dry run removes nothing from the store either',
  )
})
