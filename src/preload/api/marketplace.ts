import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  MarketplacePluginInstallInput,
  MarketplacePluginInstallResult,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryReadInput,
  MarketplaceRegistryReadResult,
  MarketplaceUpdateStatesResult,
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
    channel: 'marketplace:plugins:verify',
    entry: Parameters<ElectronApi['verifyMarketplacePlugin']>[0]
  ): Promise<MarketplacePluginVerifyResult>
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
  invoke(
    channel: 'marketplace:plugins:update-states',
    input?: MarketplaceRegistryReadInput
  ): Promise<MarketplaceUpdateStatesResult>
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
    verifyMarketplacePlugin: (
      entry: Parameters<ElectronApi['verifyMarketplacePlugin']>[0]
    ): Promise<MarketplacePluginVerifyResult> =>
      renderer.invoke('marketplace:plugins:verify', entry),
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
    readMarketplacePluginUpdateStates: (
      input?: MarketplaceRegistryReadInput
    ): Promise<MarketplaceUpdateStatesResult> =>
      renderer.invoke('marketplace:plugins:update-states', input),
  } satisfies Pick<
    ElectronApi,
    | 'readMarketplaceRegistry'
    | 'installMarketplacePluginFolder'
    | 'verifyMarketplacePlugin'
    | 'installMarketplacePluginFromRegistry'
    | 'updateMarketplacePluginFromRegistry'
    | 'uninstallMarketplacePlugin'
    | 'readMarketplacePluginUpdateStates'
  >
}

export const marketplaceApi = createMarketplaceApi(ipcRenderer)
