import type { AgentId, CliPermissionPreset, Workspace } from '../types/workspace'

export function resolveAgentCliPermissionPreset(
  workspace: Workspace | null | undefined,
  agentId: AgentId,
): CliPermissionPreset | undefined {
  return workspace?.agents[agentId]?.cliPermissionPreset
}
