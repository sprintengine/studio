import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorktreeEntry } from '../types/workspace'
import { releaseWorktreeEntriesOwnedBy } from '../store/slices/worktreesSlice'
import { agentWorktreeCleanupPlan, chatsReclaimedBy, entriesRemovedBy } from './agentWorktreeCleanup'

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

function chat(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    folderPath: `${CONTAINER}/${id}`,
    worktree: { branch: `agent/${id}`, baseRef: 'HEAD', repoRoot: '/Users/dev/app' },
    agents: {},
    worktreeState: { containerPath: null, updatedAt: null, entries: {} },
    ...patch,
  }
}

test('a settled chat counts as deleted: nothing it records keeps anything, unless someone has it open', () => {
  const workspaces = [
    // Settled: its folder, its agents' paths inside it and out, its agents and
    // its branches are all released (owner ruling 2026-10-08).
    chat('rested', {
      settledAt: 1,
      agents: {
        inside: agent(null, `${CONTAINER}/rested/packages/api`),
        elsewhere: agent(null, `${CONTAINER}/rested-agent`),
      },
    }),
    // Not settled: kept, as every chat always was.
    chat('working'),
    // Settled, in the project's own checkout: main never takes a checkout anyway.
    { ...chat('in-place', { settledAt: 1 }), folderPath: '/Users/dev/site', worktree: null },
    // Settled and in a worktree, but open in a window right now.
    chat('reading', { settledAt: 1 }),
  ] as unknown as Parameters<typeof agentWorktreeCleanupPlan>[0]

  const plan = agentWorktreeCleanupPlan(workspaces, ['reading', null])
  const protectedSet = new Set(plan.protectedPaths)
  assert.equal(protectedSet.has(`${CONTAINER}/rested`), false, 'the settled chat releases its worktree')
  assert.equal(protectedSet.has(`${CONTAINER}/rested/packages/api`), false, 'and its agents inside it')
  assert.equal(protectedSet.has(`${CONTAINER}/rested-agent`), false, 'and an agent worktree outside it')
  assert.equal(protectedSet.has('/Users/dev/site'), false)
  assert.ok(protectedSet.has(`${CONTAINER}/working`), 'an unsettled chat keeps its worktree')
  assert.ok(protectedSet.has(`${CONTAINER}/reading`), 'a settled chat someone has open keeps its worktree')
  assert.deepEqual(plan.agentIds, [], 'a settled chat’s agents hold no lease')
  assert.deepEqual(plan.keepBranches.sort(), ['agent/reading', 'agent/working'], 'its merged branch may go')
  assert.ok(plan.repoRoots.includes('/Users/dev/site'), 'its project is still swept')

  // Another record that uses the folder still protects it.
  const shared = [
    ...workspaces,
    { ...chat('neighbour'), folderPath: '/Users/dev/app', agents: { a: agent(null, `${CONTAINER}/rested`) } },
  ] as unknown as Parameters<typeof agentWorktreeCleanupPlan>[0]
  assert.ok(agentWorktreeCleanupPlan(shared).protectedPaths.includes(`${CONTAINER}/rested`))
})

test('a chat whose own folder the sweep removed is marked as having given its worktree back', () => {
  const workspaces = [
    chat('rested', { settledAt: 1 }),
    chat('already', { settledAt: 1, worktree: { branch: 'agent/already', reclaimedAt: 5 } }),
    chat('kept', { settledAt: 1 }),
  ] as unknown as Parameters<typeof chatsReclaimedBy>[0]
  const report = {
    repoRoot: '/Users/dev/app',
    defaultRef: 'origin/main',
    dryRun: false,
    entries: [
      { path: `${CONTAINER}/rested`, branch: 'agent/rested', verdict: 'removed' as const },
      { path: `${CONTAINER}/already`, branch: 'agent/already', verdict: 'removed' as const },
      { path: `${CONTAINER}/kept`, branch: 'agent/kept', verdict: 'unmerged' as const, uniqueCommits: 1 },
    ],
  }
  assert.deepEqual(chatsReclaimedBy(workspaces, report), ['rested'])
  assert.deepEqual(chatsReclaimedBy(workspaces, { ...report, dryRun: true }), [], 'a dry run gives nothing back')
})
