import type { IJsonModel, IJsonRowNode, IJsonTabNode, IJsonTabSetNode } from 'flexlayout-react'

import { conversationWorkingRoot } from '../../../../shared/agent-state'
import type { ConversationKey } from '../../../../shared/conversation-runtime'
import { normalizeAgentRuntime } from '../../store/slices/agentsSlice'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { Workspace } from '../../types/workspace'

/**
 * Reading a chat while its sidebar row is pointed at, so a click on it finds
 * the transcript already here. A pointer that rests on a row for a moment is
 * taken as the intent to open it; one passing over rows on its way elsewhere
 * reads nothing. Only the chats the workspace would show on opening are read
 * (the selected tab of each tab set), and at most a few of them.
 */

export const PREFETCH_DWELL_MS = 120
const MAX_PREFETCHED_CHATS = 2

let pending: { workspaceId: string; timer: ReturnType<typeof setTimeout> } | null = null

/** The conversations a workspace shows the moment it is opened. */
export function shownConversationKeys(workspace: Workspace): ConversationKey[] {
  const keys: ConversationKey[] = []
  const visit = (node: IJsonRowNode | IJsonTabSetNode | undefined) => {
    if (!node || keys.length >= MAX_PREFETCHED_CHATS) return
    if (node.type === 'tabset') {
      const tabset = node as IJsonTabSetNode
      const tab = (tabset.children ?? [])[tabset.selected ?? 0] as IJsonTabNode | undefined
      if (tab?.component !== 'agent') return
      const agentId = (tab.config as { agentId?: string } | undefined)?.agentId ?? tab.id
      const agent = agentId ? workspace.agents[agentId] : undefined
      if (!agent || normalizeAgentRuntime(agent).runtimeKind !== 'conversation') return
      const workspaceRoot = conversationWorkingRoot(agent, workspace.folderPath)
      if (workspaceRoot && agentId) keys.push({ workspaceRoot, workspaceId: workspace.id, agentId })
      return
    }
    for (const child of (node.children ?? []) as (IJsonRowNode | IJsonTabSetNode)[]) visit(child)
  }
  visit((workspace.layoutModel as IJsonModel | undefined)?.layout)
  return keys
}

function prefetch(workspaceId: string): void {
  const workspace = useWorkspaceStore.getState().workspaces.find((entry) => entry.id === workspaceId)
  const keys = workspace ? shownConversationKeys(workspace) : []
  if (!keys.length) return
  // The chat's code is loaded here too, the first time: the open needs it.
  void Promise.all([
    import('../panels/agentChat/useConversationSession'),
    import('../panels/agentChat/conversationTransport'),
  ])
    .then(([session, transport]) => {
      for (const key of keys) session.prefetchConversationSession(transport.localConversationTransport, key)
    })
    .catch(() => undefined)
}

/** The pointer (or the keyboard's focus) came to rest on a workspace's row. */
export function intendToOpenWorkspace(workspaceId: string): void {
  if (pending?.workspaceId === workspaceId) return
  cancelOpenIntent()
  pending = {
    workspaceId,
    timer: setTimeout(() => {
      pending = null
      prefetch(workspaceId)
    }, PREFETCH_DWELL_MS),
  }
}

/** It moved on before it rested long enough. */
export function cancelOpenIntent(workspaceId?: string): void {
  if (!pending || (workspaceId !== undefined && pending.workspaceId !== workspaceId)) return
  clearTimeout(pending.timer)
  pending = null
}
