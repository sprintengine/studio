import { app, type IpcMain } from 'electron'

import type { MarketplacePluginInstallInput, MarketplacePluginInstallResult } from '../../shared/electron-api'
import type { AppServices } from '../app-services'
import { createMarketplacePluginInstaller } from '../modules/plugin-bundle-installer'
import { readTrustedModulesSync } from '../modules/trust-store'

export function registerMarketplacePluginIpc(
  ipcMain: IpcMain,
  services: Pick<AppServices, 'mcpConfigService' | 'skillPackService'>
): void {
  const installPlugin = createMarketplacePluginInstaller({
    mcpConfigService: services.mcpConfigService,
    skillPackService: services.skillPackService,
    trustContext: () => ({
      trustedModules: readTrustedModulesSync(app.getPath('userData')),
    }),
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
}
