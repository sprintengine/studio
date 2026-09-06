import type { AgentCli, TerminalSessionSnapshot } from '../../../../shared/electron-api'
import { resolveFocusedAgentId } from '../../store/slices/focusedAgentSlice'
import type { AgentId, Workspace } from '../../types/workspace'
import { resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { agentCheckoutOf, agentCheckoutProbePath } from './agentCheckout'

// The checkout the branch chip describes (sidebar-lists-every-terminal): the
// focused agent's — with no tab focused, the last one that was — and only for
// a workspace that never focused an agent, the workspace's own. Pure, so the
// chip's rule is testable without the title bar, and so the Git panel
// (MC-2441) can read the same answer later.

export type FollowedCheckout = {
  /** What git is asked about: the followed agent's checkout, else the workspace's. Null: nothing to ask. */
  probePath: string | null
  /** A branch already known (observed by the agent's hooks, or the workspace worktree's); null lets the probe answer. */
  branch: string | null
  /** Known to be a repository without asking; null defers to the probe. */
  isRepo: boolean | null
  /** The agent being followed, for the chip's mark and words; null when the chip shows the workspace's own checkout. */
  agent: { agentId: AgentId; name: string; cli: AgentCli | null } | null
}

export type FollowedCheckoutWorkspace = Pick<Workspace, 'id' | 'folderPath' | 'worktree' | 'sprintEngineState' | 'agents'>

/** The session that speaks for an agent: a live one first, else the most recent parked one (its observation carries over). */
function sessionOfAgent(
  workspaceId: string,
  agentId: AgentId,
  sessions: ReadonlyArray<TerminalSessionSnapshot>
): TerminalSessionSnapshot | undefined {
  let best: TerminalSessionSnapshot | undefined
  for (const session of sessions) {
    if (session.workspaceId !== workspaceId || session.agentId !== agentId) continue
    if (!best) {
      best = session
      continue
    }
    const liveWins = session.processAlive && !best.processAlive
    const laterWins = session.processAlive === best.processAlive && (session.startedAt ?? 0) > (best.startedAt ?? 0)
    if (liveWins || laterWins) best = session
  }
  return best
}

export function followedCheckoutOf(
  workspace: FollowedCheckoutWorkspace,
  focusedAgentId: AgentId | undefined,
  sessions: ReadonlyArray<TerminalSessionSnapshot>
): FollowedCheckout {
  const worktree = resolveWorkspaceWorktree(workspace)
  const own: FollowedCheckout = {
    probePath: worktree?.gitRoot ?? workspace.folderPath ?? null,
    branch: worktree?.branch ?? null,
    isRepo: worktree ? true : null,
    agent: null,
  }
  const agents = workspace.agents ?? {}
  const agentId = resolveFocusedAgentId(workspace.id, focusedAgentId, Object.keys(agents), sessions)
  if (!agentId) return own
  const agent = agents[agentId]
  if (!agent) return own
  const session = sessionOfAgent(workspace.id, agentId, sessions)
  const checkout = agentCheckoutOf(session, {
    workspaceWorktree: worktree ? { gitRoot: worktree.gitRoot, branch: worktree.branch ?? null } : null,
    execution: agent.execution,
  })
  const followed = { agentId, name: agent.name, cli: agent.cli ?? session?.cli ?? null }
  if (!checkout) return { ...own, agent: followed }
  // The chip claims what the line claims: an observed checkout's branch, a
  // launch-intent worktree's path with the branch left to the probe, and
  // nothing at all for an agent git placed outside any checkout.
  const named = checkout.kind === 'worktree' || checkout.kind === 'main'
  return {
    probePath: agentCheckoutProbePath(checkout, own.probePath),
    branch: named ? checkout.branch : null,
    isRepo: named && checkout.observed ? true : checkout.kind === 'worktree' ? true : named ? null : false,
    agent: followed,
  }
}
