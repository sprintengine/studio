import type { IpcMain } from 'electron'
import type { WorkspaceSkillsListInput, WorkspaceSkillsListResult } from '../../shared/electron-api'
import type { AgentCapabilitiesInput, AgentCapabilitiesResult } from '../../shared/skills'
import type { AgentCapabilityService, WorkspaceSkillsService } from '../workspace-skills-service'

export function registerWorkspaceSkillsIpc(
  ipcMain: IpcMain,
  services: { workspaceSkills: WorkspaceSkillsService; agentCapabilities: AgentCapabilityService },
): void {
  ipcMain.handle(
    'skills:list-workspace',
    (_, input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult> =>
      services.workspaceSkills.listWorkspaceSkills(input),
  )
  ipcMain.handle(
    'skills:agent-capabilities',
    (_, input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult> =>
      services.agentCapabilities.resolve(input),
  )
}
