import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentCapabilitiesInvalidation,
  AgentCapabilitiesWatchInput,
  AgentSkillWriteInput,
  AgentSkillWriteResult,
  ElectronApi,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from '../../shared/electron-api'
import {
  AGENT_CAPABILITIES_INVALIDATED_CHANNEL,
  AGENT_CAPABILITIES_WATCH_START_CHANNEL,
  AGENT_CAPABILITIES_WATCH_STOP_CHANNEL,
  type AgentCapabilitiesInput,
  type AgentCapabilitiesResult,
} from '../../shared/skills'

export const workspaceSkillsApi = {
  workspaceSkillsList: (input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult> =>
    ipcRenderer.invoke('skills:list-workspace', input),
  agentCapabilities: (input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult> =>
    ipcRenderer.invoke('skills:agent-capabilities', input),
  agentCapabilitiesWatchStart: (input: AgentCapabilitiesWatchInput): Promise<void> =>
    ipcRenderer.invoke(AGENT_CAPABILITIES_WATCH_START_CHANNEL, input),
  agentCapabilitiesWatchStop: (input: AgentCapabilitiesWatchInput): Promise<void> =>
    ipcRenderer.invoke(AGENT_CAPABILITIES_WATCH_STOP_CHANNEL, input),
  onAgentCapabilitiesInvalidated: (cb: (event: AgentCapabilitiesInvalidation) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void =>
      cb(payload as AgentCapabilitiesInvalidation)
    ipcRenderer.on(AGENT_CAPABILITIES_INVALIDATED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(AGENT_CAPABILITIES_INVALIDATED_CHANNEL, handler)
  },
  agentSkillAttach: (input: AgentSkillWriteInput): Promise<AgentSkillWriteResult> =>
    ipcRenderer.invoke('skills:agent-skill-attach', input),
  agentSkillRemove: (input: AgentSkillWriteInput): Promise<AgentSkillWriteResult> =>
    ipcRenderer.invoke('skills:agent-skill-remove', input),
} satisfies Pick<
  ElectronApi,
  | 'workspaceSkillsList'
  | 'agentCapabilities'
  | 'agentCapabilitiesWatchStart'
  | 'agentCapabilitiesWatchStop'
  | 'onAgentCapabilitiesInvalidated'
  | 'agentSkillAttach'
  | 'agentSkillRemove'
>
