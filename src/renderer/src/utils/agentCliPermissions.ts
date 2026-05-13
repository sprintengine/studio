import type { AgentId, SprintEngineCliPermissionPreset, Workspace } from '../types/workspace'

export function resolveAgentCliPermissionPreset(
  workspace: Workspace | null | undefined,
  agentId: AgentId
): SprintEngineCliPermissionPreset | undefined {
  const agent = workspace?.agents[agentId]
  if (!workspace || !agent) return undefined

  if (agent.kind === 'sprintengine') {
    return workspace.sprintEngineAutoState.cliPermissionPreset
  }

  if (agent.kind === 'multiloop') {
    return agent.cliPermissionPreset ?? workspace.multiloopAutoState.cliPermissionPreset
  }

  return agent.cliPermissionPreset
}
