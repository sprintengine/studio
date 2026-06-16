import type { Workspace } from '../types/workspace'

// The workspace currently hosting an agent, found by its globally-unique
// (`nanoid`) id. The renderer store is the source of truth: `moveAgentToWorkspace`
// relocates the AgentState between workspaces' `agents` maps while keeping the
// id, so this stays correct across moves with no maintained index.
//
// Prefer this over any stored or spawn-time workspaceId — a Backlog link target,
// a notification's `workspaceId`, or a PTY `session.workspaceId` all capture
// where the agent *was* and go stale the moment it is moved. Anything that
// navigates to a live agent terminal should resolve the workspace here instead.
export function findWorkspaceForAgent<W extends Pick<Workspace, 'id' | 'agents'>>(
  workspaces: ReadonlyArray<W>,
  agentId: string,
): W | null {
  return workspaces.find((workspace) => Boolean(workspace.agents[agentId])) ?? null
}

export function findWorkspaceIdForAgent(
  workspaces: ReadonlyArray<Pick<Workspace, 'id' | 'agents'>>,
  agentId: string,
): string | null {
  return findWorkspaceForAgent(workspaces, agentId)?.id ?? null
}
