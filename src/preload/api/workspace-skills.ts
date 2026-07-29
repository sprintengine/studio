import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentCapabilitiesInvalidation,
  AgentCapabilitiesWatchInput,
  ElectronApi,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from '../../shared/electron-api'
import type { AgentCapabilitiesInput, AgentCapabilitiesResult } from '../../shared/skills'

const AGENT_CAPABILITIES_INVALIDATED_CHANNEL = 'skills:agent-capabilities-invalidated'

export const workspaceSkillsApi = {
  workspaceSkillsList: (input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult> =>
    ipcRenderer.invoke('skills:list-workspace', input),
  agentCapabilities: (input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult> =>
    ipcRenderer.invoke('skills:agent-capabilities', input),
  agentCapabilitiesWatchStart: (input: AgentCapabilitiesWatchInput): Promise<void> =>
    ipcRenderer.invoke('skills:agent-capabilities-watch-start', input),
  agentCapabilitiesWatchStop: (input: AgentCapabilitiesWatchInput): Promise<void> =>
    ipcRenderer.invoke('skills:agent-capabilities-watch-stop', input),
  onAgentCapabilitiesInvalidated: (cb: (event: AgentCapabilitiesInvalidation) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void =>
      cb(payload as AgentCapabilitiesInvalidation)
    ipcRenderer.on(AGENT_CAPABILITIES_INVALIDATED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(AGENT_CAPABILITIES_INVALIDATED_CHANNEL, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'workspaceSkillsList'
  | 'agentCapabilities'
  | 'agentCapabilitiesWatchStart'
  | 'agentCapabilitiesWatchStop'
  | 'onAgentCapabilitiesInvalidated'
>
