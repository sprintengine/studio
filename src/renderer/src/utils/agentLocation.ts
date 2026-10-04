import { isMintedAgentId } from '../../../shared/agent-ids'
import type { Workspace } from '../types/workspace'

type AgentHost = Pick<Workspace, 'id' | 'agents'>

// CAUTION: agent ids are NOT globally unique. Template agents are keyed
// positionally (`agent-1`, `agent-2`) and a module's own agents by its own key
// (`forecaster`, `worker-1`), so the same id recurs in nearly every workspace.
// Nothing here scans every workspace for a bare id: a closed chat's `agent-1`
// and the open chat's `agent-1` are different agents, and a scan cannot tell a
// moved agent from a namesake. Resolve against the workspace the thing was
// recorded in; if that workspace, or the agent in it, is gone, the thing is
// detached — never re-attached to another chat's agent of the same name.
//
// The one exception is an id minted unique (`isMintedAgentId`): no other agent
// shares it, so finding it in another chat finds the agent itself, moved there.

// The workspace an agent was recorded in, while it is open and still hosts that
// agent; null otherwise.
export function findRecordedAgentWorkspace<W extends AgentHost>(
  workspaces: ReadonlyArray<W>,
  agentId: string,
  workspaceId: string | null | undefined,
): W | null {
  if (!workspaceId) return null
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  return workspace?.agents[agentId] ? workspace : null
}

// The workspace an agent is in now: the one it was recorded in while that still
// hosts it, else, for a minted id only, the one open workspace that does. An
// agent dragged to another chat leaves its links and conversation keyed to the
// chat it left; following it by a minted id cannot land on a namesake. Two
// workspaces holding it (a copied workspace) are not a move, and nothing is
// followed.
export function findAgentWorkspaceFollowingMoves<W extends AgentHost>(
  workspaces: ReadonlyArray<W>,
  agentId: string,
  workspaceId: string | null | undefined,
): W | null {
  const recorded = findRecordedAgentWorkspace(workspaces, agentId, workspaceId)
  if (recorded || !isMintedAgentId(agentId)) return recorded
  const hosts = workspaces.filter((workspace) => workspace.agents[agentId])
  return hosts.length === 1 ? hosts[0] : null
}

// The workspace a live agent terminal belongs to now. `moveAgentToWorkspace`
// relocates the AgentState between workspaces while the PTY keeps its
// spawn-time workspaceId, so the recorded workspace alone would leave a moved
// agent behind. The agent record names its own terminal (`cliSessionId` is the
// PTY session id), and that is unique where the agent id is not: a workspace
// whose agent of that id owns THIS session is where the agent lives, whichever
// workspace the session was spawned in. Without that claim the recorded
// workspace decides, and nothing else does.
export function findAgentSessionWorkspace<W extends AgentHost>(
  workspaces: ReadonlyArray<W>,
  session: { agentId: string; sessionId: string; workspaceId: string | null | undefined },
): W | null {
  const owners = workspaces.filter((workspace) => workspace.agents[session.agentId]?.cliSessionId === session.sessionId)
  if (owners.length === 1) return owners[0]
  const recorded = findRecordedAgentWorkspace(workspaces, session.agentId, session.workspaceId)
  // Two records claiming one session (a copied workspace) are told apart by the
  // recorded workspace, or not at all.
  if (owners.length > 1) return recorded && owners.includes(recorded) ? recorded : null
  return recorded
}
