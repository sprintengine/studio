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

function publish(request: AgentFocusRequest): void {
  current = request
  for (const listener of listeners) listener()
}

/**
 * Open the Agents tab for a chat, on one of its agents when `laneId` names one
 * or on the list when it is null.
 */
export function openAgentsPane(workspaceId: string, agentId: string, laneId: string | null): void {
  publish({ workspaceId, agentId, laneId, serial: ++serial })
  useWorkspaceStore.getState().openPaneTab(workspaceId, { kind: 'agents' })
}

/**
 * The latest request for this workspace's Agents tab, outside React: the pane
 * pop-out's owner hands it to the window an Agents tab was popped out into
 * (panePopOutHost.ts), and listens for the next.
 */
export function readAgentFocusRequest(workspaceId: string): AgentFocusRequest | null {
  return current?.workspaceId === workspaceId ? current : null
}

export const subscribeAgentFocusRequests = subscribe

/**
 * In a pop-out window: take a request its owner window made, as if it were
 * made here, without opening a tab — the owner already decided where the tab
 * is. Its own serial, so the tab sees a new request even when the owner's
 * numbering and this window's collide.
 */
export function adoptAgentFocusRequest(workspaceId: string, agentId: string, laneId: string | null): void {
  publish({ workspaceId, agentId, laneId, serial: ++serial })
}

/** The latest request for this workspace's Agents tab, if any. */
export function useAgentFocusRequest(workspaceId: string): AgentFocusRequest | null {
  const request = useSyncExternalStore(subscribe, () => current)
  return request?.workspaceId === workspaceId ? request : null
}
