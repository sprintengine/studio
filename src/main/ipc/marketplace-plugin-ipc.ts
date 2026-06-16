import { app, type IpcMain } from 'electron'

import type {
  MarketplacePluginInstallInput,
  MarketplacePluginInstallResult,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
} from '../../shared/electron-api'
import type { AppServices } from '../app-services'
import { createMarketplacePluginLifecycleService, defaultMarketplacePluginInstallStorePath } from '../marketplace/plugin-lifecycle'
import { defaultMarketplacePluginStagingRoot } from '../marketplace/plugin-download'
import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers'
import { createMarketplacePluginInstaller } from '../modules/plugin-bundle-installer'
import { readTrustedModulesSync } from '../modules/trust-store'

export function registerMarketplacePluginIpc(
  ipcMain: IpcMain,
  services: Pick<AppServices, 'mcpConfigService' | 'skillPackService'>
): void {
  const trustContext = () => ({
    trustedModules: readTrustedModulesSync(app.getPath('userData')),
    trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
  })
  const installPlugin = createMarketplacePluginInstaller({
    mcpConfigService: services.mcpConfigService,
    skillPackService: services.skillPackService,
    trustContext,
  })
  const lifecycle = createMarketplacePluginLifecycleService({
    mcpConfigService: services.mcpConfigService,
    skillPackService: services.skillPackService,
    trustContext,
    receiptStorePath: defaultMarketplacePluginInstallStorePath(app.getPath('userData')),
    stagingRoot: defaultMarketplacePluginStagingRoot(app.getPath('userData')),
  })

  ipcMain.handle(
    'marketplace:plugins:install-folder',
    async (_event, input: MarketplacePluginInstallInput): Promise<MarketplacePluginInstallResult> => {
      try {
        return await installPlugin(input)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'marketplace:plugins:install-entry',
    async (_event, input: MarketplacePluginRegistryInstallInput): Promise<MarketplacePluginRegistryInstallResult> => {
      try {
        return await lifecycle.installFromRegistry(input)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'marketplace:plugins:update-entry',
    async (_event, input: MarketplacePluginRegistryInstallInput): Promise<MarketplacePluginRegistryInstallResult> => {
      try {
        return await lifecycle.updateFromRegistry(input)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'marketplace:plugins:uninstall',
    async (_event, input: MarketplacePluginUninstallInput): Promise<MarketplacePluginUninstallResult> => {
      try {
        return await lifecycle.uninstall(input)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
