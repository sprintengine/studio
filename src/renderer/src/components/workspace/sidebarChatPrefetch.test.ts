import { afterEach, expect, test, vi } from 'vitest'

const prefetched = vi.hoisted(() => [] as unknown[])
vi.mock('../panels/agentChat/useConversationSession', () => ({
  prefetchConversationSession: (_transport: unknown, key: unknown) => prefetched.push(key),
}))
vi.mock('../panels/agentChat/conversationTransport', () => ({ localConversationTransport: {} }))

import { useWorkspaceStore } from '../../store/workspaceStore'
import type { Workspace } from '../../types/workspace'
import {
  cancelOpenIntent,
  intendToOpenWorkspace,
  PREFETCH_DWELL_MS,
  shownConversationKeys,
} from './sidebarChatPrefetch'

const chat = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  runtimeKind: 'conversation',
  conversation: { providerId: 'claude-agent', modelId: 'model' },
  ...extra,
})
const tab = (agentId: string, component = 'agent') => ({
  type: 'tab',
  id: `tab-${agentId}`,
  component,
  config: { agentId },
})

const workspace = {
  id: 'workspace',
  folderPath: '/Users/dev/project',
  agents: {
    shown: chat('shown'),
    behind: chat('behind'),
    worktree: chat('worktree', { execution: { mode: 'worktree', cwd: '/Users/dev/project-wt' } }),
    terminal: { id: 'terminal', name: 'terminal', runtimeKind: 'terminal' },
  },
  layoutModel: {
    global: {},
    layout: {
      type: 'row',
      children: [
        { type: 'tabset', selected: 0, children: [tab('shown'), tab('behind')] },
        { type: 'row', children: [{ type: 'tabset', selected: 1, children: [tab('x', 'editor'), tab('worktree')] }] },
        { type: 'tabset', children: [tab('terminal')] },
      ],
    },
  },
} as unknown as Workspace

afterEach(() => {
  vi.useRealTimers()
  prefetched.length = 0
  cancelOpenIntent()
})

test('a workspace’s shown chats are its tab sets’ selected chat tabs, each under the root it runs in', () => {
  expect(shownConversationKeys(workspace)).toEqual([
    { workspaceRoot: '/Users/dev/project', workspaceId: 'workspace', agentId: 'shown' },
    { workspaceRoot: '/Users/dev/project-wt', workspaceId: 'workspace', agentId: 'worktree' },
  ])
})

test('a pointer resting on a row reads its chats; one passing over it reads nothing', async () => {
  vi.useFakeTimers()
  useWorkspaceStore.setState({ workspaces: [workspace] as never })
  intendToOpenWorkspace('workspace')
  vi.advanceTimersByTime(PREFETCH_DWELL_MS - 1)
  cancelOpenIntent('workspace')
  vi.advanceTimersByTime(PREFETCH_DWELL_MS)
  await vi.dynamicImportSettled()
  expect(prefetched).toEqual([])

  intendToOpenWorkspace('workspace')
  // Moving within the row does not restart the wait.
  vi.advanceTimersByTime(PREFETCH_DWELL_MS / 2)
  intendToOpenWorkspace('workspace')
  vi.advanceTimersByTime(PREFETCH_DWELL_MS / 2)
  vi.useRealTimers()
  await vi.waitFor(() => expect(prefetched).toHaveLength(2))
})
