import type { AgentId, CliPermissionPreset, Workspace } from '../types/workspace'
import {
  isSprintEngineManagedAgent,
  sprintEngineRosterAgentIds,
} from '../../../shared/sprintengine/agent-identity'
import { sprintEngineRunState } from '../store/slices/workspaceModuleState'

export function resolveAgentCliPermissionPreset(
  workspace: Workspace | null | undefined,
  agentId: AgentId
): CliPermissionPreset | undefined {
  const agent = workspace?.agents[agentId]
  if (!workspace || !agent) return undefined

  if (isSprintEngineManagedAgent(agent, {
    agentId,
    rosterIds: sprintEngineRosterAgentIds(sprintEngineRunState(workspace)?.sprintEngineAgents),
  })) {
    return workspace.sprintEngineAutoState.cliPermissionPreset
  }

  return agent.cliPermissionPreset
}
