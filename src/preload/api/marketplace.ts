import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  MarketplacePluginInstallInput,
  MarketplacePluginInstallResult,
  MarketplaceRegistryReadInput,
  MarketplaceRegistryReadResult,
} from '../../shared/electron-api'

type MarketplaceIpcRenderer = {
  invoke(
    channel: 'marketplace:registry:read',
    input?: MarketplaceRegistryReadInput
  ): Promise<MarketplaceRegistryReadResult>
  invoke(
    channel: 'marketplace:plugins:install-folder',
    input: MarketplacePluginInstallInput
  ): Promise<MarketplacePluginInstallResult>
}

export function createMarketplaceApi(renderer: MarketplaceIpcRenderer) {
  return {
    readMarketplaceRegistry: (
      input?: MarketplaceRegistryReadInput
    ): Promise<MarketplaceRegistryReadResult> =>
      renderer.invoke('marketplace:registry:read', input),
    installMarketplacePluginFolder: (
      input: MarketplacePluginInstallInput
    ): Promise<MarketplacePluginInstallResult> =>
      renderer.invoke('marketplace:plugins:install-folder', input),
  } satisfies Pick<ElectronApi, 'readMarketplaceRegistry' | 'installMarketplacePluginFolder'>
}

export const marketplaceApi = createMarketplaceApi(ipcRenderer)
