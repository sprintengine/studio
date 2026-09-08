import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
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
    readMarketplacePluginUpdateStates: (
      input?: MarketplaceRegistryReadInput
    ): Promise<MarketplaceUpdateStatesResult> =>
      renderer.invoke('marketplace:plugins:update-states', input),
  } satisfies Pick<
    ElectronApi,
    | 'readMarketplaceRegistry'
    | 'verifyMarketplacePlugin'
    | 'installMarketplacePluginFromRegistry'
    | 'updateMarketplacePluginFromRegistry'
    | 'readMarketplacePluginUpdateStates'
  >
}

export const marketplaceApi = createMarketplaceApi(ipcRenderer)
