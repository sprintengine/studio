import { ipcRenderer } from 'electron'

import type { ElectronApi, PluginRegistryListResult } from '../../shared/electron-api'

type PluginsIpcRenderer = {
  invoke(channel: 'plugins:list'): Promise<PluginRegistryListResult>
}

export function createPluginsApi(renderer: PluginsIpcRenderer) {
  return {
    pluginsList: (): Promise<PluginRegistryListResult> =>
      renderer.invoke('plugins:list'),
  } satisfies Pick<ElectronApi, 'pluginsList'>
}

export const pluginsApi = createPluginsApi(ipcRenderer)
