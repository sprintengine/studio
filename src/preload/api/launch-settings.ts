import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import {
  LAUNCH_SETTINGS_CHANNELS,
  type AgentLaunchSettings,
  type AgentLaunchSettingsWriteAck,
} from '../../shared/launch-settings'

export const launchSettingsApi = {
  syncAgentLaunchSettings: (input: AgentLaunchSettings): Promise<AgentLaunchSettingsWriteAck> =>
    ipcRenderer.invoke(LAUNCH_SETTINGS_CHANNELS.sync, input),
  hydrateAgentLaunchSettings: (input: AgentLaunchSettings): Promise<AgentLaunchSettingsWriteAck> =>
    ipcRenderer.invoke(LAUNCH_SETTINGS_CHANNELS.hydrate, input),
} satisfies Pick<ElectronApi, 'syncAgentLaunchSettings' | 'hydrateAgentLaunchSettings'>
