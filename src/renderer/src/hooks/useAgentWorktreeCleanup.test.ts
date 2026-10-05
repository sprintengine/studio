import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import type { AgentWorktreeCleanupInput, AgentWorktreeCleanupReport } from '../../../shared/electron-api'

type FakeWorkspace = {
  id: string
  folderPath: string
  worktree: { branch: string; reclaimedAt?: number } | null
  settledAt?: number | null
  agents: Record<string, { execution: { mode: string; worktreeId: string | null; cwd: string | null } }>
  worktreeState: null
}

const listeners = new Set<() => void>()
const reclaimed: Array<[string, number | null]> = []
const state: {
  workspaces: FakeWorkspace[]
  activeWorkspaceId: string | null
  workspaceWindows: Array<{ activeWorkspaceId: string | null }>
  removeWorktreeEntry: () => void
  setWorkspaceWorktreeReclaimed: (id: string, at: number | null) => void
} = {
  workspaces: [],
  activeWorkspaceId: null,
  workspaceWindows: [],
  removeWorktreeEntry: () => {},
  setWorkspaceWorktreeReclaimed: (id, at) => {
    reclaimed.push([id, at])
  },
}

vi.mock('../store/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  },
}))

const { scheduleAgentWorktreeSweeps, sweepAgentWorktrees } = await import('./useAgentWorktreeCleanup')

const originalWindow = (globalThis as { window?: unknown }).window

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
  state.workspaces = []
  state.activeWorkspaceId = null
  reclaimed.length = 0
  listeners.clear()
  vi.useRealTimers()
})

const CONTAINER = '/Users/dev/.sprintengine-worktrees/app'

function worktreeChat(id: string, settledAt: number | null = null): FakeWorkspace {
  return {
    id,
    folderPath: `${CONTAINER}/${id}`,
    worktree: { branch: `agent/${id}` },
    settledAt,
    agents: {},
    worktreeState: null,
  }
}

function notify(): void {
  for (const listener of listeners) listener()
}

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

test('a worktree chat settling asks for a sweep in a minute, and again once the idle hour is up', () => {
  vi.useFakeTimers()
  ;(globalThis as { window?: unknown }).window = globalThis
  state.workspaces = [worktreeChat('a'), worktreeChat('b'), { ...worktreeChat('plain'), worktree: null }]
  let sweeps = 0
  const stop = scheduleAgentWorktreeSweeps(() => {
    sweeps += 1
  })
  vi.advanceTimersByTime(2 * 60_000)
  assert.equal(sweeps, 1, 'the sweep a little after launch')

  // A chat on the project's checkout settling offers nothing: no sweep.
  state.workspaces[2] = { ...state.workspaces[2], settledAt: 1 }
  notify()
  vi.advanceTimersByTime(2 * 60 * 60_000)
  assert.equal(sweeps, 1)

  // A worktree chat settling: one sweep a minute later, however many settle.
  state.workspaces[0] = { ...state.workspaces[0], settledAt: 2 }
  notify()
  vi.advanceTimersByTime(30_000)
  state.workspaces[1] = { ...state.workspaces[1], settledAt: 3 }
  notify()
  vi.advanceTimersByTime(30_000)
  assert.equal(sweeps, 2, 'the after-settle sweeps share one pending timer')

  // An hour after the LATEST settle, when main's idle rule no longer keeps a
  // worktree its agent pushed from just before the merge settled it.
  vi.advanceTimersByTime(60 * 60_000 - 60_000)
  assert.equal(sweeps, 2, 'pushed back by the second settle')
  vi.advanceTimersByTime(90_000)
  assert.equal(sweeps, 3)

  // Waking a chat is not a reason to sweep.
  state.workspaces[0] = { ...state.workspaces[0], settledAt: null }
  notify()
  vi.advanceTimersByTime(2 * 60 * 60_000)
  assert.equal(sweeps, 3)
  stop()
  vi.advanceTimersByTime(6 * 60 * 60_000)
  assert.equal(sweeps, 3, 'nothing runs once stopped')
})

test('a sweep that removes a settled chat folder marks the chat, and an open one is never offered', async () => {
  state.workspaces = [worktreeChat('rested', 1), worktreeChat('reading', 1)]
  state.workspaceWindows = [{ activeWorkspaceId: 'reading' }]
  const calls: AgentWorktreeCleanupInput[] = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      cleanupAgentWorktrees: async (input: AgentWorktreeCleanupInput): Promise<AgentWorktreeCleanupReport> => {
        calls.push(input)
        return {
          repoRoot: input.repoRoot,
          defaultRef: 'origin/main',
          dryRun: false,
          entries: [{ path: `${CONTAINER}/rested`, branch: 'agent/rested', verdict: 'removed' }],
        }
      },
    },
  }

  await sweepAgentWorktrees()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].protectedPaths.includes(`${CONTAINER}/rested`), false)
  assert.ok(calls[0].protectedPaths.includes(`${CONTAINER}/reading`), 'the chat open in a window keeps its folder')
  assert.deepEqual(
    reclaimed.map(([id]) => id),
    ['rested'],
  )
  assert.equal(typeof reclaimed[0][1], 'number')
  state.workspaceWindows = []
})
