import { app, type IpcMain } from 'electron'

import type {
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryReadInput,
  MarketplaceUpdateStatesResult,
} from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import type { AppServices } from '../app-services'
import { writeDiagnosticLog } from '../diagnostics-service'
import { createMarketplacePluginLifecycleService, defaultMarketplacePluginInstallStorePath } from '../marketplace/plugin-lifecycle'
import { readMarketplaceUpdateStates } from '../marketplace/update-detection'
import { defaultUserModuleRoot } from '../modules/user-module-registry'
import { createDefaultMarketplaceRegistryClient } from './marketplace-registry-ipc'
import { defaultMarketplacePluginStagingRoot, type MarketplaceInstallLog } from '../marketplace/plugin-download'
import { createMarketplacePluginVerifier } from '../marketplace/plugin-verify'
import { resolveInstalledSkillHarnesses } from '../marketplace/skill-harness-targets'
import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers'
import type { MarketplaceAutomationInstaller } from '../modules/plugin-bundle-installer'
import { notifyRendererModulesChanged } from '../modules/notify-renderer-modules-changed'
import { readTrustedModulesSync, setModuleTrust } from '../modules/trust-store'

export type MarketplacePluginPipelineServices = Pick<AppServices, 'mcpConfigService' | 'getAutomationsAppFrontDoor'>

/**
 * The verify + install/uninstall pipeline, built once and shared.
 *
 * Extracted from `registerMarketplacePluginIpc` when the card executor grew an
 * `install.module` verb (G4): a card's Go installs a registry entry through the
 * SAME lifecycle the storefront does — same trust gate, same receipts, same
 * rollback — and a second construction of it in `cards-ipc.ts` would be a
 * second set of those rules to keep in step.
 */
export function createMarketplacePluginPipeline(services: MarketplacePluginPipelineServices) {
  const trustContext = () => ({
    trustedModules: readTrustedModulesSync(app.getPath('userData')),
    trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
  })
  // Verify/install failures used to be invisible (result objects only, no
  // logging anywhere) — every pipeline event now lands in the diagnostics log.
  const marketplaceLog: MarketplaceInstallLog = (event, detail) => {
    const details = detail === undefined ? undefined : JSON.stringify(detail)
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
    // The trust decision the install prompt already took, written through the
    // one trust-store writer the Settings toggle uses — so a trusted install
    // does not land behind a second, identical toggle in Settings → Modules.
    setModuleTrust: async (id, manifestFp) => {
      const { result, previous } = await setModuleTrust(app.getPath('userData'), id, manifestFp)
      return { ...result, previous }
    },
    log: marketplaceLog,
  })

  return { trustContext, log: marketplaceLog, verifier, lifecycle }
}

export function registerMarketplacePluginIpc(
  ipcMain: IpcMain,
  services: MarketplacePluginPipelineServices
): void {
  const { trustContext, verifier, lifecycle } = createMarketplacePluginPipeline(services)

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
        const result = await lifecycle.installFromRegistry(input)
        if (result.ok) notifyRendererModulesChanged()
        return result
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

  // The other end of install (G3). The lifecycle has been able to uninstall a
  // receipt since it was written; nothing could call it, so a marketplace
  // install was a one-way door — the files were removable only by hand, and the
  // receipt that says what they were stayed behind either way. It takes the
  // same envelope install does, because removing an MCP component writes the
  // CLI configs and needs the workspace and settings to do it.
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

  // Per-installed-entry update detection (MC-1873). Constructed lazily so the
  // registry client (and its cache read) only exists once the surface asks.
  let updateStatesRegistryReader: ReturnType<typeof createDefaultMarketplaceRegistryClient> | undefined
  ipcMain.handle(
    'marketplace:plugins:update-states',
    async (_event, input?: MarketplaceRegistryReadInput): Promise<MarketplaceUpdateStatesResult> => {
      try {
        updateStatesRegistryReader ??= createDefaultMarketplaceRegistryClient()
        return await readMarketplaceUpdateStates(
          {
            registryReader: updateStatesRegistryReader,
            receiptStorePath: defaultMarketplacePluginInstallStorePath(app.getPath('userData')),
            moduleRoot: defaultUserModuleRoot,
            trustContext,
          },
          input ?? {}
        )
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
