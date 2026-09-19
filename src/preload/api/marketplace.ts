import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
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
    input?: MarketplaceRegistryReadInput,
  ): Promise<MarketplaceRegistryReadResult>
  invoke(
    channel: 'marketplace:plugins:verify',
    entry: Parameters<ElectronApi['verifyMarketplacePlugin']>[0],
  ): Promise<MarketplacePluginVerifyResult>
  invoke(
    channel: 'marketplace:plugins:install-entry',
    input: MarketplacePluginRegistryInstallInput,
  ): Promise<MarketplacePluginRegistryInstallResult>
  invoke(
    channel: 'marketplace:plugins:update-entry',
    input: MarketplacePluginRegistryInstallInput,
  ): Promise<MarketplacePluginRegistryInstallResult>
  invoke(
    channel: 'marketplace:plugins:uninstall',
    input: MarketplacePluginUninstallInput,
  ): Promise<MarketplacePluginUninstallResult>
  invoke(
    channel: 'marketplace:plugins:update-states',
    input?: MarketplaceRegistryReadInput,
  ): Promise<MarketplaceUpdateStatesResult>
}

export function createMarketplaceApi(renderer: MarketplaceIpcRenderer) {
  return {
    readMarketplaceRegistry: (input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult> =>
      renderer.invoke('marketplace:registry:read', input),
    verifyMarketplacePlugin: (
      entry: Parameters<ElectronApi['verifyMarketplacePlugin']>[0],
    ): Promise<MarketplacePluginVerifyResult> => renderer.invoke('marketplace:plugins:verify', entry),
    installMarketplacePluginFromRegistry: (
      input: MarketplacePluginRegistryInstallInput,
    ): Promise<MarketplacePluginRegistryInstallResult> => renderer.invoke('marketplace:plugins:install-entry', input),
    updateMarketplacePluginFromRegistry: (
      input: MarketplacePluginRegistryInstallInput,
    ): Promise<MarketplacePluginRegistryInstallResult> => renderer.invoke('marketplace:plugins:update-entry', input),
    // `input.pluginId` is the marketplace entry's id, or the id of a module it
    // installed — Settings → Modules knows only the latter, and the lifecycle
    // resolves either to the one receipt that owns the files.
    uninstallMarketplacePlugin: (input: MarketplacePluginUninstallInput): Promise<MarketplacePluginUninstallResult> =>
      renderer.invoke('marketplace:plugins:uninstall', input),
    readMarketplacePluginUpdateStates: (input?: MarketplaceRegistryReadInput): Promise<MarketplaceUpdateStatesResult> =>
      renderer.invoke('marketplace:plugins:update-states', input),
  } satisfies Pick<
    ElectronApi,
    | 'readMarketplaceRegistry'
    | 'verifyMarketplacePlugin'
    | 'installMarketplacePluginFromRegistry'
    | 'updateMarketplacePluginFromRegistry'
    | 'uninstallMarketplacePlugin'
    | 'readMarketplacePluginUpdateStates'
  >
}

export const marketplaceApi = createMarketplaceApi(ipcRenderer)
