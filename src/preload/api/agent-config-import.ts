import { ipcRenderer } from 'electron'
import type {
  AgentConfigAdoptInput,
  AgentConfigAdoptResult,
  AgentConfigDetectInput,
  AgentConfigDetectResult,
  ElectronApi,
} from '../../shared/electron-api'

export const agentConfigImportApi = {
  detectExistingAgentConfig: (input?: AgentConfigDetectInput): Promise<AgentConfigDetectResult> =>
    ipcRenderer.invoke('agent-config:detect', input),
  adoptAgentConfig: (input: AgentConfigAdoptInput): Promise<AgentConfigAdoptResult> =>
    ipcRenderer.invoke('agent-config:adopt', input),
} satisfies Pick<ElectronApi, 'detectExistingAgentConfig' | 'adoptAgentConfig'>
