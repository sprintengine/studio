import { ipcRenderer } from 'electron'
import type {
  AgentSkillWriteInput,
  AgentSkillWriteResult,
  ElectronApi,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from '../../shared/electron-api'
import type { AgentCapabilitiesInput, AgentCapabilitiesResult } from '../../shared/skills'
import type {
  InstalledSkillsInput,
  InstalledSkillsResult,
  InstalledSkillRemoveInput,
  InstalledSkillRemoveResult,
} from '../../shared/installed-skills'

export const workspaceSkillsApi = {
  installedSkillsList: (input: InstalledSkillsInput): Promise<InstalledSkillsResult> =>
    ipcRenderer.invoke('skills:list-installed', input),
  installedSkillRemove: (input: InstalledSkillRemoveInput): Promise<InstalledSkillRemoveResult> =>
    ipcRenderer.invoke('skills:remove-installed', input),
  workspaceSkillsList: (input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult> =>
    ipcRenderer.invoke('skills:list-workspace', input),
  agentCapabilities: (input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult> =>
    ipcRenderer.invoke('skills:agent-capabilities', input),
  agentSkillAttach: (input: AgentSkillWriteInput): Promise<AgentSkillWriteResult> =>
    ipcRenderer.invoke('skills:agent-skill-attach', input),
} satisfies Pick<
  ElectronApi,
  'workspaceSkillsList' | 'agentCapabilities' | 'agentSkillAttach' | 'installedSkillsList' | 'installedSkillRemove'
>
