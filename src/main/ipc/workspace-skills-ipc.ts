import type { IpcMain } from 'electron'
import type { WorkspaceSkillsListInput, WorkspaceSkillsListResult } from '../../shared/electron-api'
import type { WorkspaceSkillsService } from '../workspace-skills-service'

export function registerWorkspaceSkillsIpc(ipcMain: IpcMain, service: WorkspaceSkillsService): void {
  ipcMain.handle(
    'skills:list-workspace',
    (_, input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult> =>
      service.listWorkspaceSkills(input),
  )
}
