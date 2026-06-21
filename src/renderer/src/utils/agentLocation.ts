import type { Workspace } from '../types/workspace'

// The first workspace whose `agents` map contains `agentId`. The renderer store
// is the source of truth: `moveAgentToWorkspace` relocates the AgentState between
// workspaces while keeping the id, so this follows a moved agent with no
// maintained index.
//
// CAUTION: agent ids are NOT globally unique. Template agents are keyed
// positionally (`agent-1`, `agent-2`) and Sprint Engine roster agents by role
// (`architect`, `developer-1`), so the same id recurs in every workspace built
// from the same template. A bare id scan therefore returns an arbitrary match
// when several workspaces share it. When you hold the workspace the agent was
// recorded in (e.g. a persisted Backlog link target), use
// `findWorkspaceForAgentPreferring` so that workspace disambiguates the hit and
// the scan is only a fallback for a genuinely-moved (unique-id) agent.
export function findWorkspaceForAgent<W extends Pick<Workspace, 'id' | 'agents'>>(
  workspaces: ReadonlyArray<W>,
  agentId: string,
): W | null {
  return workspaces.find((workspace) => Boolean(workspace.agents[agentId])) ?? null
}

// Resolve an agent's live workspace, preferring the workspace it was recorded in.
// If `preferredWorkspaceId` is still open and still hosts `agentId`, that wins —
// this is what disambiguates shared ids like `agent-1` across workspaces. Only
// when the recorded workspace is gone (closed, or the agent truly moved out of
// it) do we fall back to the global scan, which keeps move-robustness intact for
// the unique-id agents that can actually be followed across workspaces.
export function findWorkspaceForAgentPreferring<W extends Pick<Workspace, 'id' | 'agents'>>(
  workspaces: ReadonlyArray<W>,
  agentId: string,
  preferredWorkspaceId: string | null | undefined,
): W | null {
  if (preferredWorkspaceId) {
    const preferred = workspaces.find((workspace) => workspace.id === preferredWorkspaceId)
    if (preferred?.agents[agentId]) return preferred
  }
  return findWorkspaceForAgent(workspaces, agentId)
}

export function findWorkspaceIdForAgent(
  workspaces: ReadonlyArray<Pick<Workspace, 'id' | 'agents'>>,
  agentId: string,
): string | null {
  return findWorkspaceForAgent(workspaces, agentId)?.id ?? null
}
