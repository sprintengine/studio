// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { create } from 'zustand'

type FakeWorkspace = { id: string; folderPath: string; worktree: { branch: string; reclaimedAt?: number } }
type FakeState = {
  workspaces: FakeWorkspace[]
  activeWorkspaceId: string | null
  workspaceWindows: Array<{ activeWorkspaceId: string | null }>
  setFolderMissing: (id: string, missing: boolean) => void
}

const store = create<FakeState>(() => ({
  workspaces: [],
  activeWorkspaceId: null,
  workspaceWindows: [],
  setFolderMissing: () => {},
}))
const ensureChatWorktree = vi.fn(async (_workspaceId: string) => true)

vi.mock('../store/workspaceStore', () => ({ useWorkspaceStore: store }))
vi.mock('../utils/chatWorktreeRestore', () => ({
  ensureChatWorktree: (workspaceId: string) => ensureChatWorktree(workspaceId),
}))

const { useWorkspaceFolderStatus } = await import('./useWorkspaceFolderStatus')

const FOLDER = '/Users/dev/.sprintengine-worktrees/app/rested'
const checks: string[] = []
const originalApi = (window as { api?: unknown }).api

function Probe() {
  useWorkspaceFolderStatus('rested')
  return null
}

async function mounted(): Promise<() => Promise<void>> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as { api?: unknown }).api = {
    checkWorkspaceFolder: async (path: string) => {
      checks.push(path)
      return { ok: true, status: 'ready', path, checkedPath: path }
    },
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  return () => act(async () => root.unmount())
}

function stamp(reclaimedAt: number | undefined): void {
  store.setState((state) => ({
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      worktree: { branch: workspace.worktree.branch, ...(reclaimedAt === undefined ? {} : { reclaimedAt }) },
    })),
  }))
}

afterEach(() => {
  ;(window as { api?: unknown }).api = originalApi
  ensureChatWorktree.mockClear()
  checks.length = 0
})

test('a mark arriving while the chat is open brings the worktree back and looks at the folder again', async () => {
  store.setState({
    workspaces: [{ id: 'rested', folderPath: FOLDER, worktree: { branch: 'agent/rested' } }],
    activeWorkspaceId: 'rested',
    workspaceWindows: [],
  })
  const unmount = await mounted()
  expect(ensureChatWorktree).toHaveBeenCalledTimes(1)
  expect(checks).toEqual([FOLDER])

  await act(async () => stamp(7))
  expect(ensureChatWorktree).toHaveBeenCalledTimes(2)
  expect(checks).toEqual([FOLDER, FOLDER])
  await unmount()
})

test('a chat kept mounted behind another looks again at its folder, but brings the worktree back only once opened', async () => {
  store.setState({
    workspaces: [{ id: 'rested', folderPath: FOLDER, worktree: { branch: 'agent/rested' } }],
    activeWorkspaceId: 'other',
    workspaceWindows: [{ activeWorkspaceId: 'another' }],
  })
  const unmount = await mounted()
  expect(ensureChatWorktree).toHaveBeenCalledTimes(1)

  await act(async () => stamp(7))
  expect(ensureChatWorktree).toHaveBeenCalledTimes(1)
  expect(checks).toEqual([FOLDER, FOLDER])

  // Opened in a second window.
  await act(async () => store.setState({ workspaceWindows: [{ activeWorkspaceId: 'rested' }] }))
  expect(ensureChatWorktree).toHaveBeenCalledTimes(2)
  expect(ensureChatWorktree).toHaveBeenLastCalledWith('rested')
  expect(checks).toHaveLength(3)
  await unmount()
})
