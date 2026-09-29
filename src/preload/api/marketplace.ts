import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  GithubExtensionCheckUpdateInput,
  GithubExtensionCheckUpdateResult,
  GithubExtensionInstallInput,
  GithubExtensionResolveInput,
  GithubExtensionResolveResult,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyInput,
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
    input: MarketplacePluginVerifyInput,
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
  invoke(
    channel: 'extensions:github:resolve',
    input: GithubExtensionResolveInput,
  ): Promise<GithubExtensionResolveResult>
  invoke(
    channel: 'extensions:github:install',
    input: GithubExtensionInstallInput,
  ): Promise<MarketplacePluginRegistryInstallResult>
  invoke(
    channel: 'extensions:github:check-update',
    input: GithubExtensionCheckUpdateInput,
  ): Promise<GithubExtensionCheckUpdateResult>
}

export function createMarketplaceApi(renderer: MarketplaceIpcRenderer) {
  return {
    readMarketplaceRegistry: (input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult> =>
      renderer.invoke('marketplace:registry:read', input),
    // By id: main resolves the entry itself and answers with a trust token
    // for exactly what it disclosed; install and update pass that token back.
    verifyMarketplacePlugin: (input: MarketplacePluginVerifyInput): Promise<MarketplacePluginVerifyResult> =>
      renderer.invoke('marketplace:plugins:verify', input),
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
    resolveGithubExtension: (input: GithubExtensionResolveInput): Promise<GithubExtensionResolveResult> =>
      renderer.invoke('extensions:github:resolve', input),
    installGithubExtension: (input: GithubExtensionInstallInput): Promise<MarketplacePluginRegistryInstallResult> =>
      renderer.invoke('extensions:github:install', input),
    checkGithubExtensionUpdate: (input: GithubExtensionCheckUpdateInput): Promise<GithubExtensionCheckUpdateResult> =>
      renderer.invoke('extensions:github:check-update', input),
  } satisfies Pick<
    ElectronApi,
    | 'readMarketplaceRegistry'
    | 'verifyMarketplacePlugin'
    | 'installMarketplacePluginFromRegistry'
    | 'updateMarketplacePluginFromRegistry'
    | 'uninstallMarketplacePlugin'
    | 'readMarketplacePluginUpdateStates'
    | 'resolveGithubExtension'
    | 'installGithubExtension'
    | 'checkGithubExtensionUpdate'
  >
}

export const marketplaceApi = createMarketplaceApi(ipcRenderer)
