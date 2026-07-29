import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from '../../shared/electron-api'
import type { AgentCapabilitiesInput, AgentCapabilitiesResult } from '../../shared/skills'

export const workspaceSkillsApi = {
  workspaceSkillsList: (input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult> =>
    ipcRenderer.invoke('skills:list-workspace', input),
  agentCapabilities: (input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult> =>
    ipcRenderer.invoke('skills:agent-capabilities', input),
} satisfies Pick<ElectronApi, 'workspaceSkillsList' | 'agentCapabilities'>
