import { expect, test, vi } from 'vitest'
import type { ConversationThread } from '../../../shared/conversation-index'
import { layoutHasConversation, openConversationHistory } from './conversationHistoryNavigation'
import { useWorkspaceStore } from '../store/workspaceStore'
import { revealAgentTerminalTab } from './agentTabReveal'

vi.mock('../store/workspaceStore', () => ({ useWorkspaceStore: { getState: vi.fn() } }))
vi.mock('./agentTabReveal', () => ({ revealAgentTerminalTab: vi.fn(() => true) }))

test('reopening history seeds the original identity and does not launch a terminal', () => {
  const updateAgent = vi.fn()
  vi.mocked(useWorkspaceStore.getState).mockReturnValue({
    workspaces: [{ id: 'workspace' }],
    updateAgent,
  } as unknown as ReturnType<typeof useWorkspaceStore.getState>)
  const thread: ConversationThread = {
    agentId: 'existing-agent',
    title: 'Saved chat',
    titleSource: 'user',
    providerId: 'provider',
    model: 'model',
    createdAt: 1,
    updatedAt: 2,
    turnCount: 1,
    lastSeq: 3,
    firstUserText: 'Hello',
  }
  expect(openConversationHistory('workspace', thread, 2)).toBe(true)
  expect(updateAgent).toHaveBeenCalledWith(
    'workspace',
    'existing-agent',
    expect.objectContaining({
      name: 'Saved chat',
      runtimeKind: 'conversation',
      conversation: { providerId: 'provider', modelId: 'model' },
      cliStartRequested: false,
    }),
  )
  expect(revealAgentTerminalTab).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    agentId: 'existing-agent',
    name: 'Saved chat',
  })
  expect(openConversationHistory('missing', thread)).toBe(false)
})

test('an open agent tab is excluded from the closed-history stream', () => {
  const layout = {
    layout: {
      type: 'row',
      children: [
        { type: 'tabset', children: [{ type: 'tab', component: 'agent', config: { agentId: 'existing-agent' } }] },
      ],
    },
  }
  expect(layoutHasConversation(layout, 'existing-agent')).toBe(true)
  expect(layoutHasConversation(layout, 'another-agent')).toBe(false)
  expect(layoutHasConversation(undefined, 'existing-agent')).toBe(false)
})
