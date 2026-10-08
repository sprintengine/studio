import { ipc as ipcRenderer } from '../ipc-router'
import type { AgentNotificationMode } from '../../shared/agent-notifications'
import type { ColorScheme, ElectronApi, WindowMaterial } from '../../shared/electron-api'

type AppearanceIpcRenderer = {
  invoke(channel: 'appearance:set-color-scheme', scheme: ColorScheme): Promise<void>
  invoke(channel: 'appearance:set-window-material', material: WindowMaterial, canvasColor?: string): Promise<void>
  invoke(channel: 'app:set-background-mode', enabled: boolean): Promise<void>
  invoke(channel: 'app:set-telemetry-enabled', enabled: boolean): Promise<void>
  invoke(channel: 'app:get-quit-confirmation'): Promise<boolean>
  invoke(channel: 'app:set-quit-confirmation', enabled: boolean): Promise<boolean>
  invoke(channel: 'app:get-agent-browser-tools'): Promise<boolean>
  invoke(channel: 'app:set-agent-browser-tools', enabled: boolean): Promise<boolean>
  invoke(channel: 'app:get-agent-notifications'): Promise<AgentNotificationMode>
  invoke(channel: 'app:set-agent-notifications', mode: AgentNotificationMode): Promise<AgentNotificationMode>
}

function createAppearanceApi(renderer: AppearanceIpcRenderer) {
  return {
    setColorScheme: (scheme: ColorScheme): Promise<void> => renderer.invoke('appearance:set-color-scheme', scheme),
    setWindowMaterial: (material: WindowMaterial, canvasColor?: string): Promise<void> =>
      renderer.invoke('appearance:set-window-material', material, canvasColor),
    // Not an appearance setting, but the same one-way push contract: the
    // renderer owns the preference, main keeps a copy it can read with no
    // window open.
    setBackgroundMode: (enabled: boolean): Promise<void> => renderer.invoke('app:set-background-mode', enabled),
    // Third rider on the same contract: the renderer owns the usage-data
    // choice, main holds the copy it consults with no window open.
    setTelemetryEnabled: (enabled: boolean): Promise<void> => renderer.invoke('app:set-telemetry-enabled', enabled),
    // The other way round: main owns "Ask before quitting", because the quit
    // dialog's "Don't ask again" writes it, so Settings reads it back from main.
    getQuitConfirmation: (): Promise<boolean> => renderer.invoke('app:get-quit-confirmation'),
    setQuitConfirmation: (enabled: boolean): Promise<boolean> => renderer.invoke('app:set-quit-confirmation', enabled),
    getAgentBrowserTools: (): Promise<boolean> => renderer.invoke('app:get-agent-browser-tools'),
    setAgentBrowserTools: (enabled: boolean): Promise<boolean> =>
      renderer.invoke('app:set-agent-browser-tools', enabled),
    getAgentNotifications: (): Promise<AgentNotificationMode> => renderer.invoke('app:get-agent-notifications'),
    setAgentNotifications: (mode: AgentNotificationMode): Promise<AgentNotificationMode> =>
      renderer.invoke('app:set-agent-notifications', mode),
  } satisfies Pick<
    ElectronApi,
    | 'setColorScheme'
    | 'setWindowMaterial'
    | 'setBackgroundMode'
    | 'setTelemetryEnabled'
    | 'getQuitConfirmation'
    | 'setQuitConfirmation'
    | 'getAgentNotifications'
    | 'getAgentBrowserTools'
    | 'setAgentBrowserTools'
    | 'setAgentNotifications'
  >
}

export const appearanceApi = createAppearanceApi(ipcRenderer)
