import { useSyncExternalStore } from 'react'
import { useWorkspaceStore } from '../../../../store/workspaceStore'

// Which agent the Agents tab should open on, when something asked for one: a
// chat's agent lane, the "agents working" line. A request, not state: the tab
// takes it once, on the workspace it names, and the person moves on from
// there. Nothing about it is persisted; after a restart the tab opens on its
// list.

export type AgentFocusRequest = {
  workspaceId: string
  // The chat the agent belongs to.
  agentId: string
  // The call that spawned the agent: its lane.
  laneId: string | null
  // Distinguishes two requests for the same agent, so asking again re-opens it.
  serial: number
}

let current: AgentFocusRequest | null = null
let serial = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Open the Agents tab for a chat, on one of its agents when `laneId` names one
 * or on the list when it is null.
 */
export function openAgentsPane(workspaceId: string, agentId: string, laneId: string | null): void {
  current = { workspaceId, agentId, laneId, serial: ++serial }
  for (const listener of listeners) listener()
  useWorkspaceStore.getState().openPaneTab(workspaceId, { kind: 'agents' })
}

/** The latest request for this workspace's Agents tab, if any. */
export function useAgentFocusRequest(workspaceId: string): AgentFocusRequest | null {
  const request = useSyncExternalStore(subscribe, () => current)
  return request?.workspaceId === workspaceId ? request : null
}
