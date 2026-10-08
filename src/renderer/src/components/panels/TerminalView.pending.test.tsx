// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// A terminal agent opened before its worktree has no folder. Its launch would
// spawn the CLI in the app's default folder, the one place the person did not
// ask for, so nothing may start until the worktree is its folder.

const PROJECT = '/Users/dev/app'

const fixtures = vi.hoisted(() => ({
  state: { workspaces: [] as unknown[], appSettings: {} as Record<string, unknown> } as Record<string, unknown>,
  calls: [] as string[],
}))
vi.mock('../../store/workspaceStore', () => {
  const useWorkspaceStore = (select: (state: Record<string, unknown>) => unknown) => select(fixtures.state)
  useWorkspaceStore.getState = () => fixtures.state
  useWorkspaceStore.subscribe = () => () => undefined
  return { useWorkspaceStore }
})

const { default: TerminalView, TerminalViewOnThisComputer } = await import('./TerminalView')
const { prepareNewChatWorktree } = await import('../../utils/newChatWorktree')

function pendingAgent(pending: Record<string, unknown> = {}) {
  return {
    id: 'agent',
    name: 'Scout',
    cli: 'claude-code',
    status: 'idle',
    runtimeKind: 'terminal',
    execution: { mode: 'workspace' },
    cliSessionId: undefined,
    cliHasLaunched: false,
    cliStartupPrompt: 'fix the login',
    chatPendingWorktree: { name: '', projectFolder: PROJECT, ...pending },
  }
}

function seed(agent: ReturnType<typeof pendingAgent>, workspaceId = 'chat') {
  fixtures.state.activeWorkspaceId = workspaceId
  fixtures.state.workspaceWindows = []
  fixtures.state.workspaces = [
    {
      id: workspaceId,
      name: 'Chat',
      folderPath: null,
      worktree: { repoRoot: PROJECT },
      agents: { agent },
      worktreeState: { entries: {} },
      memory: {},
    },
  ]
  fixtures.state.updateAgent = (_workspaceId: string, _agentId: string, patch: Record<string, unknown>) => {
    fixtures.calls.push(`updateAgent:${Object.keys(patch).join(',')}`)
  }
  fixtures.state.openFile = () => undefined
  fixtures.state.setFolderMissing = () => undefined
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  fixtures.calls.length = 0
  // Every preload call is recorded; a worktree attempt never lands, so the chat
  // stays waiting on it for as long as the test looks.
  const api = new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => {
      if (typeof property !== 'string' || property === 'then') return undefined
      return (..._args: unknown[]) => {
        fixtures.calls.push(property)
        if (property.startsWith('on')) return () => undefined
        return new Promise(() => undefined)
      }
    },
  })
  Object.assign(window, { api })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const spawnsOrStarts = () =>
  fixtures.calls.filter(
    (call) => call === 'terminalSpawn' || call === 'terminalStatus' || call.startsWith('updateAgent:cliSessionId'),
  )

test('a terminal agent waiting on its worktree spawns nothing and shows the wait with its prompt', async () => {
  seed(pendingAgent())
  void prepareNewChatWorktree('chat')
  await act(async () => root.render(<TerminalView workspaceId="chat" agentId="agent" />))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  expect(spawnsOrStarts()).toEqual([])
  const pane = host.querySelector('[data-pending-worktree-terminal]')
  expect(pane?.getAttribute('data-pending-worktree-terminal')).toBe('preparing-worktree')
  expect(pane?.textContent).toContain('fix the login')
  expect(pane?.textContent).toContain('Preparing worktree…')
})

test('a worktree that could not be made offers Retry and Start in the project, and still spawns nothing', async () => {
  // No attempt runs for this chat in this window: it reads as failed.
  seed(pendingAgent({ failure: 'Could not fetch origin.' }), 'failed-chat')
  await act(async () => root.render(<TerminalView workspaceId="failed-chat" agentId="agent" />))
  expect(spawnsOrStarts()).toEqual([])
  const text = host.textContent ?? ''
  expect(text).toContain('Could not fetch origin.')
  expect(text, 'the prompt it holds is shown with the promise to send it').toContain('fix the login')
  const labels = [...host.querySelectorAll('button')].map((button) => button.textContent?.trim())
  expect(labels).toEqual(expect.arrayContaining(['Retry', 'Start in the project']))
})

test('the launch itself refuses an agent still waiting on its worktree: no session id is minted and nothing spawns', async () => {
  // The pane below the gate, mounted directly, as it would be by anything that
  // reached it without the gate: the launch effect is where a spawn is decided.
  seed(pendingAgent(), 'ungated-chat')
  await act(async () => root.render(<TerminalViewOnThisComputer workspaceId="ungated-chat" agentId="agent" />))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  expect(spawnsOrStarts()).toEqual([])
})

test('after a restart the prompt is read from the pending record, where it survives', async () => {
  const { cliStartupPrompt: _gone, ...agent } = pendingAgent({ failure: 'Studio closed.', prompt: 'add a health check' })
  seed(agent as never, 'restarted-chat')
  await act(async () => root.render(<TerminalView workspaceId="restarted-chat" agentId="agent" />))
  expect(host.textContent).toContain('add a health check')
  expect(spawnsOrStarts()).toEqual([])
})
