import { ipc as ipcRenderer } from '../ipc-router'

import type {
  AgentLaunchPreviewInput,
  AgentLaunchPreviewResult,
  ElectronApi,
  PluginAvailabilityResult,
  PluginDetectAvailabilityInput,
  PluginRegistryListResult,
} from '../../shared/electron-api'

type PluginsIpcRenderer = {
  invoke(channel: 'plugins:list'): Promise<PluginRegistryListResult>
  invoke(
    channel: 'plugins:detect-availability',
    input?: PluginDetectAvailabilityInput,
  ): Promise<PluginAvailabilityResult>
  invoke(channel: 'plugins:launch-preview', input: AgentLaunchPreviewInput): Promise<AgentLaunchPreviewResult>
}

export function createPluginsApi(renderer: PluginsIpcRenderer) {
  return {
    pluginsList: (): Promise<PluginRegistryListResult> => renderer.invoke('plugins:list'),
    pluginsDetectAvailability: (input?: PluginDetectAvailabilityInput): Promise<PluginAvailabilityResult> =>
      renderer.invoke('plugins:detect-availability', input),
    // The launch surface's receipt line: what this spawn would actually run,
    // rendered in main from the manifest the spawn renders from.
    agentLaunchPreview: (input: AgentLaunchPreviewInput): Promise<AgentLaunchPreviewResult> =>
      renderer.invoke('plugins:launch-preview', input),
  } satisfies Pick<ElectronApi, 'pluginsList' | 'pluginsDetectAvailability' | 'agentLaunchPreview'>
}

export const pluginsApi = createPluginsApi(ipcRenderer)
