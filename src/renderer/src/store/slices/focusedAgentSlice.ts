import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { AgentId, WorkspaceId } from '../../types/workspace'

// Which agent a workspace is "on" (sidebar-lists-every-terminal): the agent
// whose tab was selected last. The branch chip follows it, and later the Git
// panel reads the same answer rather than inventing a second one.
//
// Written on tab selection, never cleared on blur — that is what makes "with
// no tab focused, the last one that was" true for free. Per window and
// transient: it describes what this window is looking at, not a setting, so
// the persist partialize (an explicit pick) never carries it.

export type FocusedAgentSlice = {
  focusedAgentByWorkspaceId: Record<WorkspaceId, AgentId>
  setFocusedAgent: (workspaceId: WorkspaceId, agentId: AgentId) => void
  forgetFocusedAgent: (workspaceId: WorkspaceId, agentId: AgentId) => void
}

type FocusedAgentCarrier = { focusedAgentByWorkspaceId: Record<WorkspaceId, AgentId> }
type FocusedAgentSliceSet = (mutator: (state: FocusedAgentCarrier) => void) => void

export function createFocusedAgentSlice(set: FocusedAgentSliceSet): FocusedAgentSlice {
  return {
    focusedAgentByWorkspaceId: {},
    setFocusedAgent: (workspaceId, agentId) => {
      set((state) => {
        // A no-op write keeps identity and wakes no subscriber: selecting the
        // tab that is already focused must not re-render every chip and row.
        if (state.focusedAgentByWorkspaceId[workspaceId] === agentId) return
        state.focusedAgentByWorkspaceId[workspaceId] = agentId
      })
    },
    // For an agent that is GONE (removed from the workspace), not one whose
    // tab merely closed: a closed tab's agent is still the last one focused.
    forgetFocusedAgent: (workspaceId, agentId) => {
      set((state) => {
        if (state.focusedAgentByWorkspaceId[workspaceId] !== agentId) return
        delete state.focusedAgentByWorkspaceId[workspaceId]
      })
    },
  }
}

export type FocusFallbackSession = Pick<
  TerminalSessionSnapshot,
  'agentId' | 'workspaceId' | 'kind' | 'processAlive' | 'suspended' | 'lastInputAt' | 'lastOutputAt'
>

/**
 * The agent a workspace follows: the last focused one while it still exists,
 * else the live agent that did something most recently, else none — at which
 * point a consumer shows the workspace's own checkout. Pure, so the chip, the
 * sidebar and the Git panel can share it.
 */
export function resolveFocusedAgentId(
  workspaceId: WorkspaceId,
  focused: AgentId | undefined,
  agentIds: ReadonlySet<AgentId> | ReadonlyArray<AgentId>,
  sessions: ReadonlyArray<FocusFallbackSession>,
): AgentId | null {
  const known = agentIds instanceof Set ? agentIds : new Set(agentIds)
  if (focused && known.has(focused)) return focused
  let best: { agentId: AgentId; at: number } | null = null
  for (const session of sessions) {
    if (session.workspaceId !== workspaceId || session.kind !== 'agent' || !session.agentId) continue
    if (!session.processAlive || session.suspended) continue
    if (!known.has(session.agentId)) continue
    const at = Math.max(session.lastInputAt ?? 0, session.lastOutputAt ?? 0)
    if (!best || at > best.at) best = { agentId: session.agentId, at }
  }
  return best?.agentId ?? null
}
