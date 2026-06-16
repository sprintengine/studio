import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  MarketplacePluginInstallInput,
  MarketplacePluginInstallResult,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
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
  invoke(
    channel: 'marketplace:plugins:install-entry',
    input: MarketplacePluginRegistryInstallInput
  ): Promise<MarketplacePluginRegistryInstallResult>
  invoke(
    channel: 'marketplace:plugins:update-entry',
    input: MarketplacePluginRegistryInstallInput
  ): Promise<MarketplacePluginRegistryInstallResult>
  invoke(
    channel: 'marketplace:plugins:uninstall',
    input: MarketplacePluginUninstallInput
  ): Promise<MarketplacePluginUninstallResult>
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
    installMarketplacePluginFromRegistry: (
      input: MarketplacePluginRegistryInstallInput
    ): Promise<MarketplacePluginRegistryInstallResult> =>
      renderer.invoke('marketplace:plugins:install-entry', input),
    updateMarketplacePluginFromRegistry: (
      input: MarketplacePluginRegistryInstallInput
    ): Promise<MarketplacePluginRegistryInstallResult> =>
      renderer.invoke('marketplace:plugins:update-entry', input),
    uninstallMarketplacePlugin: (
      input: MarketplacePluginUninstallInput
    ): Promise<MarketplacePluginUninstallResult> =>
      renderer.invoke('marketplace:plugins:uninstall', input),
  } satisfies Pick<
    ElectronApi,
    | 'readMarketplaceRegistry'
    | 'installMarketplacePluginFolder'
    | 'installMarketplacePluginFromRegistry'
    | 'updateMarketplacePluginFromRegistry'
    | 'uninstallMarketplacePlugin'
  >
}

export const marketplaceApi = createMarketplaceApi(ipcRenderer)
