import { ipcRenderer } from 'electron'

import type {
  ElectronApi,
  PluginInstallResult,
  PluginRegistryListResult,
} from '../../shared/electron-api'

type PluginsIpcRenderer = {
  invoke(channel: 'plugins:list'): Promise<PluginRegistryListResult>
  invoke(channel: 'plugins:install-folder', srcDir: string): Promise<PluginInstallResult>
  invoke(channel: 'plugins:reload'): Promise<PluginRegistryListResult>
}

export function createPluginsApi(renderer: PluginsIpcRenderer) {
  return {
    pluginsList: (): Promise<PluginRegistryListResult> =>
      renderer.invoke('plugins:list'),
    installPluginFolder: (srcDir: string): Promise<PluginInstallResult> =>
      renderer.invoke('plugins:install-folder', srcDir),
    reloadPlugins: (): Promise<PluginRegistryListResult> =>
      renderer.invoke('plugins:reload'),
  } satisfies Pick<ElectronApi, 'pluginsList' | 'installPluginFolder' | 'reloadPlugins'>
}

export const pluginsApi = createPluginsApi(ipcRenderer)
