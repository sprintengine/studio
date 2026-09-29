import { resolve } from 'node:path'

import { app, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import type {
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryReadInput,
  MarketplaceRegistryReadResult,
  MarketplaceUpdateStatesResult,
  McpClientTarget,
  SkillHarness,
} from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { isRecord } from '../../shared/records'
import { SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import type { AppServices } from '../app-services'
import { writeDiagnosticLog } from '../diagnostics-service'
import {
  createMarketplacePluginLifecycleService,
  defaultMarketplacePluginInstallStorePath,
  type MarketplacePluginLifecycleInstallInput,
} from '../marketplace/plugin-lifecycle'
import { consumeTrustToken, issueTrustToken } from '../marketplace/trust-tokens'
import { listKnownWorkspaceRoots } from '../workspace-roots'
import { assertAppSender } from './ipc-sender'
import { readMarketplaceUpdateStates } from '../marketplace/update-detection'
import { defaultUserModuleRoot } from '../modules/user-module-registry'
import { createDefaultMarketplaceRegistryClient } from './marketplace-registry-ipc'
import { defaultMarketplacePluginStagingRoot, type MarketplaceInstallLog } from '../marketplace/plugin-download'
import { createMarketplacePluginVerifier } from '../marketplace/plugin-verify'
import { resolveInstalledSkillHarnesses } from '../marketplace/skill-harness-targets'
import type { MarketplaceAutomationInstaller } from '../modules/plugin-bundle-installer'
import { notifyRendererModulesChanged } from '../modules/notify-renderer-modules-changed'
import { readModuleTrustContextSync } from '../modules/trust-context'
import { setModuleTrust } from '../modules/trust-store'

export type MarketplacePluginPipelineServices = Pick<AppServices, 'mcpConfigService' | 'getAutomationsAppFrontDoor'>

// The IPC surface also answers "is this a workspace the app has open?" — the
// renderer names the workspace an install writes into, and main checks it.
export type MarketplacePluginIpcServices = MarketplacePluginPipelineServices & Pick<AppServices, 'workspaceSyncService'>

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
  const trustContext = () => readModuleTrustContextSync(app.getPath('userData'))
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

type MarketplaceRegistryReader = {
  read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
}

export function registerMarketplacePluginIpc(
  ipcMain: IpcMain,
  services: MarketplacePluginIpcServices,
  // Test seam: the registry the handlers resolve ids against.
  overrides: { registryReader?: MarketplaceRegistryReader } = {},
): void {
  const { trustContext, verifier, lifecycle } = createMarketplacePluginPipeline(services)
  // One registry reader for verify, install and update detection, so all
  // three share its cache and its bundled-first/override policy.
  let registryReader: MarketplaceRegistryReader | undefined = overrides.registryReader
  const readRegistry = () => (registryReader ??= createDefaultMarketplaceRegistryClient())
  const knownWorkspaceRoots = () => listKnownWorkspaceRoots(services.workspaceSyncService.getSnapshot())

  async function registryEntry(id: string): Promise<MarketplacePluginEntry | { message: string }> {
    const registry = await readRegistry().read()
    if (!registry.ok) return { message: registry.message || 'The marketplace could not be read.' }
    return (
      registry.marketplace.plugins.find((plugin) => plugin.id === id) ?? {
        message: `${id} is not in the marketplace.`,
      }
    )
  }

  // M-F2: the renderer names an entry; main looks it up in its own registry,
  // discloses what installing it would do, and issues the only thing that can
  // approve that install — a one-time token pinned to what was disclosed.
  ipcMain.handle(
    'marketplace:plugins:verify',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<MarketplacePluginVerifyResult> => {
      try {
        assertAppSender(event)
        const id = isRecord(input) && typeof input.id === 'string' ? input.id.trim() : ''
        if (!id) return invalidVerifyResult('An extension id is required.')
        const entry = await registryEntry(id)
        if ('message' in entry) return invalidVerifyResult(entry.message)
        const result = await verifier.verify(entry)
        if (!result.pin || result.classification === 'invalid') return withoutPin(result)
        return {
          ...result,
          trustToken: issueTrustToken({ entryId: entry.id, source: 'registry', pin: result.pin, entry }),
        }
      } catch (error) {
        return invalidVerifyResult(formatError(error))
      }
    },
  )

  // Install and update take the same envelope: which entry, the token verify
  // issued for it, and where it goes. The token is spent here whatever
  // happens next, so a failed install goes back through verify.
  async function installOrUpdate(
    event: IpcMainInvokeEvent,
    input: unknown,
    run: (input: MarketplacePluginLifecycleInstallInput) => Promise<MarketplacePluginRegistryInstallResult>,
  ): Promise<MarketplacePluginRegistryInstallResult> {
    assertAppSender(event)
    if (!isRecord(input)) return { ok: false, message: 'Install request is invalid.' }
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!id) return { ok: false, message: 'An extension id is required.' }
    const envelope = installEnvelope(input, knownWorkspaceRoots())
    if (!envelope.ok) return { ok: false, message: envelope.message }

    let grant = null
    if (input.trustToken !== undefined) {
      grant = typeof input.trustToken === 'string' ? consumeTrustToken(input.trustToken, id) : null
      if (!grant) {
        return {
          ok: false,
          message: 'Your approval for this extension expired or was already used. Review it again to install.',
        }
      }
    }
    // The entry the approval was given for, as main resolved it then; with no
    // approval, only the registry's own copy — which installs only if it
    // needs none.
    let entry = grant?.entry
    if (!entry) {
      const found = await registryEntry(id)
      if ('message' in found) return { ok: false, message: found.message }
      entry = found
    }
    return run({ ...envelope.value, entry, grant })
  }

  ipcMain.handle(
    'marketplace:plugins:install-entry',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<MarketplacePluginRegistryInstallResult> => {
      try {
        const result = await installOrUpdate(event, input, lifecycle.install)
        if (result.ok) notifyRendererModulesChanged()
        return result
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )

  ipcMain.handle(
    'marketplace:plugins:update-entry',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<MarketplacePluginRegistryInstallResult> => {
      try {
        return await installOrUpdate(event, input, lifecycle.update)
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )

  // The other end of install (G3). The lifecycle has been able to uninstall a
  // receipt since it was written; nothing could call it, so a marketplace
  // install was a one-way door — the files were removable only by hand, and the
  // receipt that says what they were stayed behind either way. It takes the
  // same envelope install does, because removing an MCP component writes the
  // CLI configs and needs the workspace and settings to do it.
  ipcMain.handle(
    'marketplace:plugins:uninstall',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<MarketplacePluginUninstallResult> => {
      try {
        assertAppSender(event)
        if (!isRecord(input) || typeof input.pluginId !== 'string') {
          return { ok: false, message: 'Plugin id is required.' }
        }
        const envelope = installEnvelope(input, knownWorkspaceRoots())
        if (!envelope.ok) return { ok: false, message: envelope.message }
        const uninstall: MarketplacePluginUninstallInput = { ...envelope.value, pluginId: input.pluginId }
        return await lifecycle.uninstall(uninstall)
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )

  // Per-installed-entry update detection. The registry client is constructed
  // lazily so it (and its cache read) only exists once a surface asks.
  ipcMain.handle(
    'marketplace:plugins:update-states',
    async (_event, input?: MarketplaceRegistryReadInput): Promise<MarketplaceUpdateStatesResult> => {
      try {
        return await readMarketplaceUpdateStates(
          {
            registryReader: readRegistry(),
            receiptStorePath: defaultMarketplacePluginInstallStorePath(app.getPath('userData')),
            moduleRoot: defaultUserModuleRoot,
            trustContext,
          },
          input ?? {},
        )
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )
}

type InstallEnvelope = Omit<MarketplacePluginLifecycleInstallInput, 'entry' | 'grant'>

// The renderer-supplied half of an install, checked. `workspaceRoot` is where
// MCP configs and skill copies get written, and a failed update deletes and
// restores paths under it — so it must be a workspace the app has open (M-F7),
// not any folder the renderer names. Skill harnesses are only ever the app's
// own. Settings and clients pass through to the MCP sync, which normalises
// every server it writes.
function installEnvelope(
  input: Record<string, unknown>,
  openWorkspaceRoots: string[],
): { ok: true; value: InstallEnvelope } | { ok: false; message: string } {
  const value: InstallEnvelope = {}
  if (input.workspaceRoot !== undefined && input.workspaceRoot !== null) {
    if (typeof input.workspaceRoot !== 'string') return { ok: false, message: 'Workspace root is invalid.' }
    const trimmed = input.workspaceRoot.trim()
    if (trimmed) {
      if (!openWorkspaceRoots.includes(resolve(trimmed))) {
        return { ok: false, message: 'Open this workspace in SprintEngine Studio, then install again.' }
      }
      value.workspaceRoot = trimmed
    }
  }
  if (Array.isArray(input.skillHarnesses)) {
    const requested = input.skillHarnesses.filter((harness): harness is string => typeof harness === 'string')
    value.skillHarnesses = SKILL_PACK_HARNESSES.filter((harness) => requested.includes(harness)) as SkillHarness[]
  }
  if (isRecord(input.mcpSettings)) value.mcpSettings = input.mcpSettings as InstallEnvelope['mcpSettings']
  if (Array.isArray(input.mcpClients)) {
    value.mcpClients = input.mcpClients.filter((client): client is McpClientTarget => typeof client === 'string')
  }
  if (typeof input.automationDefaultCli === 'string' && input.automationDefaultCli.trim()) {
    value.automationDefaultCli = input.automationDefaultCli.trim()
  }
  return { ok: true, value }
}

function invalidVerifyResult(message: string): MarketplacePluginVerifyResult {
  return {
    classification: 'invalid',
    permissions: [],
    sourceUrl: '',
    issues: [{ path: 'source', message }],
    message,
  }
}

// A result there is nothing to approve in carries no pin either.
function withoutPin(result: MarketplacePluginVerifyResult): MarketplacePluginVerifyResult {
  const { pin: _pin, ...rest } = result
  return rest
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
