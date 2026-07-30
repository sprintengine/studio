import { app, type IpcMain } from 'electron'

import type {
  MarketplacePluginInstallInput,
  MarketplacePluginInstallResult,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyResult,
} from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import type { AppServices } from '../app-services'
import { writeDiagnosticLog } from '../diagnostics-service'
import { createMarketplacePluginLifecycleService, defaultMarketplacePluginInstallStorePath } from '../marketplace/plugin-lifecycle'
import { defaultMarketplacePluginStagingRoot, type MarketplaceInstallLog } from '../marketplace/plugin-download'
import { createMarketplacePluginVerifier } from '../marketplace/plugin-verify'
import { resolveInstalledSkillHarnesses } from '../marketplace/skill-harness-targets'
import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers'
import { createMarketplacePluginInstaller, type MarketplaceAutomationInstaller } from '../modules/plugin-bundle-installer'
import { readTrustedModulesSync } from '../modules/trust-store'

export function registerMarketplacePluginIpc(
  ipcMain: IpcMain,
  services: Pick<AppServices, 'mcpConfigService' | 'getAutomationsAppFrontDoor'>
): void {
  const trustContext = () => ({
    trustedModules: readTrustedModulesSync(app.getPath('userData')),
    trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
  })
  // Verify/install failures used to be invisible (result objects only, no
  // logging anywhere) — every pipeline event now lands in the diagnostics
  // log and the main-process console.
  const marketplaceLog: MarketplaceInstallLog = (event, detail) => {
    const details = detail === undefined ? undefined : JSON.stringify(detail)
    console.log(`[marketplace] ${event}${details ? ` ${details}` : ''}`)
    void writeDiagnosticLog({
      level: event.includes('fail') || event.includes('mismatch') ? 'error' : 'info',
      source: 'marketplace',
      title: 'Marketplace plugin pipeline',
      message: event,
      ...(details ? { details } : {}),
    }).catch(() => undefined)
  }
  // An automation component installs through the Automations module's own front
  // door — the app's single write path for definitions. The module registers
  // after app services are built and can be switched off, so it is resolved at
  // call time and its absence is an explicit failure, never a silent skip.
  const installAutomationDefinition: MarketplaceAutomationInstaller = async (input) => {
    const frontDoor = services.getAutomationsAppFrontDoor()
    if (!frontDoor) {
      return { ok: false, code: 'automations_unavailable', message: 'The Automations module is not running.' }
    }
    const result = await frontDoor.installCatalogueDefinition(input)
    if (!result.ok) return result
    return { ok: true, value: { definition: result.value.definition, alreadyAdded: result.value.alreadyAdded } }
  }
  const installPlugin = createMarketplacePluginInstaller({
    mcpConfigService: services.mcpConfigService,
    trustContext,
    installAutomationDefinition,
  })
  const verifier = createMarketplacePluginVerifier({
    trustContext,
    stagingRoot: defaultMarketplacePluginStagingRoot(app.getPath('userData')),
    log: marketplaceLog,
  })
  const lifecycle = createMarketplacePluginLifecycleService({
    mcpConfigService: services.mcpConfigService,
    trustContext,
    installAutomationDefinition,
    receiptStorePath: defaultMarketplacePluginInstallStorePath(app.getPath('userData')),
    stagingRoot: defaultMarketplacePluginStagingRoot(app.getPath('userData')),
    resolveSkillHarnesses: () => resolveInstalledSkillHarnesses(),
    log: marketplaceLog,
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
    'marketplace:plugins:verify',
    async (_event, entry: MarketplacePluginEntry): Promise<MarketplacePluginVerifyResult> => {
      try {
        return await verifier.verify(entry)
      } catch (error) {
        return {
          classification: 'invalid',
          permissions: [],
          sourceUrl: typeof entry?.source === 'string' ? entry.source : '',
          issues: [{ path: 'source', message: error instanceof Error ? error.message : String(error) }],
          message: error instanceof Error ? error.message : String(error),
        }
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
