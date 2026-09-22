import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import {
  LAUNCH_SETTINGS_CHANNELS,
  type AgentLaunchSettings,
  type AgentLaunchSettingsPatch,
  type AgentLaunchSettingsRecord,
  type AgentLaunchSettingsSnapshot,
  type AgentLaunchSettingsWriteAck,
} from '../../shared/launch-settings'

// Main owns the launch settings; a window reads them, patches them and follows
// main's broadcast. `onLaunchSettingsChanged` returns the unsubscribe.
export const launchSettingsApi = {
  launchSettingsGet: (): Promise<AgentLaunchSettingsSnapshot> => ipcRenderer.invoke(LAUNCH_SETTINGS_CHANNELS.get),
  launchSettingsUpdate: (patch: AgentLaunchSettingsPatch): Promise<AgentLaunchSettingsWriteAck> =>
    ipcRenderer.invoke(LAUNCH_SETTINGS_CHANNELS.update, patch),
  launchSettingsMigrate: (settings: AgentLaunchSettings): Promise<AgentLaunchSettingsWriteAck> =>
    ipcRenderer.invoke(LAUNCH_SETTINGS_CHANNELS.migrate, settings),
  onLaunchSettingsChanged: (cb: (record: AgentLaunchSettingsRecord) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, record: AgentLaunchSettingsRecord) => cb(record)
    ipcRenderer.on(LAUNCH_SETTINGS_CHANNELS.changed, handler)
    return () => ipcRenderer.removeListener(LAUNCH_SETTINGS_CHANNELS.changed, handler)
  },
} satisfies Pick<
  ElectronApi,
  'launchSettingsGet' | 'launchSettingsUpdate' | 'launchSettingsMigrate' | 'onLaunchSettingsChanged'
>
