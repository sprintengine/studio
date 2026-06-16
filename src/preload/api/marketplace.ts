import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  MarketplacePluginInstallInput,
  MarketplacePluginInstallResult,
} from '../../shared/electron-api'

type MarketplaceIpcRenderer = {
  invoke(
    channel: 'marketplace:plugins:install-folder',
    input: MarketplacePluginInstallInput
  ): Promise<MarketplacePluginInstallResult>
}

export function createMarketplaceApi(renderer: MarketplaceIpcRenderer) {
  return {
    installMarketplacePluginFolder: (
      input: MarketplacePluginInstallInput
    ): Promise<MarketplacePluginInstallResult> =>
      renderer.invoke('marketplace:plugins:install-folder', input),
  } satisfies Pick<ElectronApi, 'installMarketplacePluginFolder'>
}

export const marketplaceApi = createMarketplaceApi(ipcRenderer)
