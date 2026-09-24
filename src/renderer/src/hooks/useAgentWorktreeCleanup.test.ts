import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import type { AgentWorktreeCleanupInput, AgentWorktreeCleanupReport } from '../../../shared/electron-api'

type FakeWorkspace = {
  id: string
  folderPath: string
  worktree: null
  agents: Record<string, { execution: { mode: string; worktreeId: string | null; cwd: string | null } }>
  worktreeState: null
}

const state: { workspaces: FakeWorkspace[]; removeWorktreeEntry: () => void } = {
  workspaces: [],
  removeWorktreeEntry: () => {},
}

vi.mock('../store/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => state, subscribe: () => () => {} },
}))

const { sweepAgentWorktrees } = await import('./useAgentWorktreeCleanup')

const originalWindow = (globalThis as { window?: unknown }).window

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
  state.workspaces = []
})

test('each repository is swept with the records as they are when its turn comes', async () => {
  state.workspaces = [
    { id: 'w1', folderPath: '/Users/dev/app', worktree: null, agents: {}, worktreeState: null },
    { id: 'w2', folderPath: '/Users/dev/site', worktree: null, agents: {}, worktreeState: null },
  ]
  const calls: AgentWorktreeCleanupInput[] = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      cleanupAgentWorktrees: async (input: AgentWorktreeCleanupInput): Promise<AgentWorktreeCleanupReport> => {
        calls.push(input)
        // While the first repository is being swept, an agent starts in a new
        // worktree of the second.
        if (calls.length === 1) {
          state.workspaces[1].agents['agent-new'] = {
            execution: {
              mode: 'worktree',
              worktreeId: null,
              cwd: '/Users/dev/.sprintengine-worktrees/site/new',
            },
          }
        }
        return { repoRoot: input.repoRoot, defaultRef: null, entries: [], dryRun: false }
      },
    },
  }

  await sweepAgentWorktrees()
  assert.deepEqual(
    calls.map((call) => call.repoRoot),
    ['/Users/dev/app', '/Users/dev/site'],
  )
  assert.equal(calls[0].protectedPaths.includes('/Users/dev/.sprintengine-worktrees/site/new'), false)
  assert.ok(
    calls[1].protectedPaths.includes('/Users/dev/.sprintengine-worktrees/site/new'),
    'the second repository sees the agent that started during the first',
  )
})
