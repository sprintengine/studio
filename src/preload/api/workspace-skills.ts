import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from '../../shared/electron-api'

export const workspaceSkillsApi = {
  workspaceSkillsList: (input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult> =>
    ipcRenderer.invoke('skills:list-workspace', input),
} satisfies Pick<ElectronApi, 'workspaceSkillsList'>
