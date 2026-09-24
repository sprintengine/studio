import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { buildStamp as mainBuildStamp } from 'virtual:sprintengine-build-stamp'
import { MODULE_EVENTS_CHANNEL } from '../shared/modules/events'
import { parseAuthCallbackFromArgv } from './auth-service'
import { registerAppLifecycle } from './app-lifecycle'
import { createAppServices } from './app-services'
import { ensureExtensionFolders } from './extension-folders'
import { readTrustedMarketplacePublisherFingerprintsSync } from './marketplace/trusted-publishers'
import type { ModuleEnablementLiveApplier } from './ipc/module-enablement-ipc'
import { activeForChannel } from '../shared/modules/dev-only'
import { resolveModuleEnablement } from '../shared/modules/resolve'
import { loadMainModules } from './module-host/load-modules'
import { readModuleOverridesSync } from './module-host/enablement-store'
import { AutomationsAppFrontDoorToken } from './module-host/service-tokens'
import { AGENT_RUNTIME_MANIFEST, createAgentRuntimeModule } from './modules/agent-runtime-module'
import { LIVE_ENABLED_MODULE_IDS, type CapabilityManifest } from '../shared/modules/manifest'
import { createBundledMainModules } from './modules'
import {
  isFirstPartyAutomationProviderModule,
  type AutomationProviderPermissionChecker,
} from './automations/provider-registry'
import { isLoadEligible, type ModuleTrustContext } from './modules/module-signature'
import { readTrustedModulesSync } from './modules/trust-store'
import { planThirdPartyMainModules, recordThirdPartyMainLaunchReport } from './modules/third-party-main-loader'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { MODULE_ASSET_SCHEME } from '../shared/modules/assets'
import { createModuleAssetOriginResolver } from './modules/module-asset-origins'
import { createModuleAssetHandler, isAllowedModuleAssetRequest } from './modules/module-assets'
import { registerThirdPartyRendererEntryIpc } from './modules/third-party-renderer-entries'
import { defaultUserModuleRoot, discoverUserModules, discoverUserModulesSync } from './modules/user-module-registry'
import { attachBuildSkewWatch, createBuildSkewWatch } from './build-skew'
import { registerCoreIpc } from './register-core-ipc'
import { markStartup } from './startup-timeline'
import { readStudioEnv } from '../shared/studio-env'
import { allowsMultipleInstances } from './app-instance'

// The app proper, loaded by the entry (index.ts) only in the process that holds
// the single-instance lock. By the time this runs the startup timeline is
// attached, the userData override is applied and the module-asset scheme is
// registered.

// Build-identity check. Registered next to the startup marks and for
// the same reason: a window reports the moment it starts, and the listener has
// to already be there. Log-only by explicit choice (2026-09-01): the dialog
// this used to raise interrupted the normal edit-the-running-app dev loop, so
// a skew now lands on the log (`[build-skew]`, greppable) and nowhere else.
attachBuildSkewWatch(ipcMain, createBuildSkewWatch({ mainStamp: mainBuildStamp }))

// Make the drop-in extension roots discoverable on a fresh (packaged) install:
// create ~/.sprintengine/{modules,plugins} and seed each with a README describing
// what to drop there. Best-effort — never block startup on it.
const extensionFolders = ensureExtensionFolders()

const DIAGNOSTICS_ENABLED = readStudioEnv('SPRINTENGINE_DIAGNOSTICS') === '1'
const services = createAppServices(DIAGNOSTICS_ENABLED)
let applyModuleEnablementLive: ModuleEnablementLiveApplier | undefined

// Dev-only capability surfaces (Voice, Mobile Relay) ship only in
// from-source dev builds. A packaged/installed build is the production channel,
// so they are excluded from registration entirely. See
// src/shared/modules/dev-only.ts.
const includeDevModules = !app.isPackaged

registerCoreIpc(ipcMain, services, DIAGNOSTICS_ENABLED, {
  includeDevModules,
  applyModuleEnablementLive: (overrides) => applyModuleEnablementLive?.(overrides),
})

// Capability modules register their own IPC/services/sidecars through the host
// kernel, gated by the user's enablement overrides (mirrored from the renderer
// into userData). A disabled module skips registration entirely. The
// agent-runtime core module seeds the shared services (terminal runtime, auth,
// token stores) that the optional modules consume via the service bridge; the
// resolver orders it first because every dependent declares
// `dependsOn: ['agent-runtime']`. See docs/module-authors/drop-in-extensions.md.
const moduleOverrides = readModuleEnablementOverrides()
const thirdPartyMainLoad = planThirdPartyMainModules(
  discoverUserModulesSync(defaultUserModuleRoot(), readModuleTrustContext()),
)
// Live-resolved main enablement, kept in step with the renderer's overrides (see
// recomputeMainEnablement below). A module with no main runtime of its own — one
// whose work rides another module's engine tick — is honored through this set
// rather than through load/unload, so its toggle (and its dependency cascade)
// takes effect without a reload. Declared before module construction so the
// predicate can close over it; the set is filled in once the manifest list exists.
const enabledMainModuleIds = new Set<string>()
const activeMainModules = activeForChannel(
  createBundledMainModules({
    automations: {
      checkProviderPermission: checkAutomationProviderPermission,
    },
  }),
  (module) => module.manifest.id,
  includeDevModules,
)
// Resolves any module id to the permissions it declared in its manifest, across
// every module the app assembled. The companion registry gates attach on it.
const moduleManifestsById = new Map<string, CapabilityManifest>(
  [
    AGENT_RUNTIME_MANIFEST,
    ...activeMainModules.map((module) => module.manifest),
    ...thirdPartyMainLoad.modules.map((module) => module.manifest),
  ].map((manifest) => [manifest.id, manifest]),
)
const getModulePermissions = (moduleId: string): readonly string[] | undefined =>
  moduleManifestsById.get(moduleId)?.permissions
// Extracted as a const (rather than inlined) so `mainModuleManifests` below can
// reference its manifest for the enablement gate; constructed after
// `getModulePermissions` so the companion-attach permission check is wired in.
const agentRuntimeModule = createAgentRuntimeModule(services, { getModulePermissions })
const moduleLoad = loadMainModules({
  ipcMain,
  modules: [agentRuntimeModule, ...activeMainModules, ...thirdPartyMainLoad.modules],
  overrides: moduleOverrides,
  // Skill directories a third-party module registers are resolved against —
  // and must stay inside — its install folder.
  moduleRoots: thirdPartyMainLoad.moduleRoots,
  ineligible: thirdPartyMainLoad.ineligible,
  launchErrors: thirdPartyMainLoad.launchErrors,
  // Module events fan out to every open window on the one host-owned channel;
  // the renderer kernel routes each envelope to its own module's subscribers.
  // Nothing is buffered for windows opened later — see shared/modules/events.ts.
  deliverModuleEvent: (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(MODULE_EVENTS_CHANNEL, event)
    }
  },
})
// The manifest universe the enablement gate resolves against — every main module
// present on this channel, so a module and its dependencies (automations,
// agent-runtime) all resolve. Recompute mirrors the renderer's
// resolution so the gate's answer matches what the user sees in Settings.
const mainModuleManifests = [
  agentRuntimeModule.manifest,
  ...activeMainModules.map((module) => module.manifest),
  ...thirdPartyMainLoad.modules.map((module) => module.manifest),
]
const recomputeMainEnablement = (overrides: Record<string, boolean>): void => {
  const { order } = resolveModuleEnablement(mainModuleManifests, overrides)
  enabledMainModuleIds.clear()
  for (const id of order) enabledMainModuleIds.add(id)
}
recomputeMainEnablement(moduleOverrides)
applyModuleEnablementLive = async (overrides) => {
  const report = await moduleLoad.applyEnablement(overrides, { liveModuleIds: LIVE_ENABLED_MODULE_IDS })
  const automationsError = report.errors.find((error) => error.id === 'automations')
  if (automationsError) return { ok: false, message: automationsError.message }
  // A module with no live-loadable main half takes its toggle through the
  // enablement gate rather than module load/unload — refresh the resolved set.
  recomputeMainEnablement(overrides)
  // Module-contributed gateway tools follow enablement live: the
  // gateway re-reads the registry and enablement per request, so only the
  // connected MCP clients need a nudge to refresh their tool lists.
  services.automationService.notifyToolsListChanged()
  return { ok: true }
}
// Automation server ← Automations module: resolved per tool call so a live
// module disable/enable cycle is reflected immediately (token absent ⇒ tools
// report automations_module_unavailable).
services.setAutomationsAppFrontDoorResolver(
  () => moduleLoad.kernel.hostFor('@host').getService(AutomationsAppFrontDoorToken) ?? null,
)
// Module enablement for gateway tools that belong to a capability module: the
// resolved set is recomputed on every override the renderer pushes, so a module
// switched off in Settings is off for MCP callers on their next call, not after
// a restart (an owner ruling).
services.setModuleEnabledResolver((moduleId) => enabledMainModuleIds.has(moduleId))
// Module-contributed MCP tools ← the host kernel. The gateway was
// constructed above, before loadMainModules ran; this seam hands it the live
// registry, and the per-request evaluation makes the tools visible immediately.
services.setModuleMcpToolsResolver(() => moduleLoad.kernel.mcpToolRegistrations())
recordThirdPartyMainLaunchReport(
  thirdPartyMainLoad.modules.map((module) => module.manifest.id),
  moduleLoad.report,
)
const moduleAssetOrigin = createModuleAssetOriginResolver(app.getPath('userData'))
// Trusted third-party entry.renderer bundles are served on demand (the trust
// store is re-read per request, so revoking trust takes effect immediately).
registerThirdPartyRendererEntryIpc(moduleLoad.kernel.hostFor('@host'), {
  discoverModules: () => discoverUserModules(defaultUserModuleRoot(), readModuleTrustContext()),
  trustContext: readModuleTrustContext,
  assetOrigin: moduleAssetOrigin,
})
void app.whenReady().then(() => {
  const shellUrl = process.env['ELECTRON_RENDERER_URL'] ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href
  session.defaultSession.webRequest.onBeforeRequest({ urls: [`${MODULE_ASSET_SCHEME}://*/*`] }, (details, callback) => {
    callback({ cancel: !isAllowedModuleAssetRequest(details, shellUrl) })
  })
  protocol.handle(
    MODULE_ASSET_SCHEME,
    createModuleAssetHandler({
      assetOrigin: moduleAssetOrigin,
      discoverModules: () => discoverUserModules(defaultUserModuleRoot(), readModuleTrustContext()),
      isEnabled: (installed, modules) => {
        const trusted = modules.filter((module) => isLoadEligible(module.trust.status))
        const manifests = [
          ...mainModuleManifests.filter((manifest) => !modules.some((module) => module.manifest.id === manifest.id)),
          ...trusted.map((module) => module.manifest),
        ]
        return resolveModuleEnablement(manifests, readModuleEnablementOverrides()).order.includes(installed.manifest.id)
      },
    }),
  )
})
if (DIAGNOSTICS_ENABLED) {
  console.info('[modules] extension roots:', extensionFolders.moduleRoot, extensionFolders.pluginRoot)
  if (extensionFolders.errors.length > 0) {
    console.warn('[modules] extension folder setup errors:', extensionFolders.errors)
  }
  console.info(
    '[modules] loaded:',
    moduleLoad.report.loaded,
    'manifest-only:',
    moduleLoad.report.manifestOnly,
    'disabled:',
    moduleLoad.report.disabled,
    'sidecars:',
    moduleLoad.report.sidecars.map((s) => s.id),
  )
  if (moduleLoad.report.errors.length > 0) {
    console.warn('[modules] load errors:', moduleLoad.report.errors)
  }
  if (thirdPartyMainLoad.diagnostics.rejected.length > 0) {
    console.warn('[modules] rejected third-party modules:', thirdPartyMainLoad.diagnostics.rejected)
  }
}

function readModuleEnablementOverrides(): Record<string, boolean> {
  try {
    return readModuleOverridesSync(app.getPath('userData'))
  } catch {
    return {}
  }
}

function readModuleTrustContext(): ModuleTrustContext {
  return {
    trustedModules: readTrustedModulesSync(app.getPath('userData')),
    trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
  }
}

function checkAutomationProviderPermission(
  registration: Parameters<AutomationProviderPermissionChecker>[0],
): ReturnType<AutomationProviderPermissionChecker> {
  if (isFirstPartyAutomationProviderModule(registration.moduleId)) return { ok: true }

  const { modules } = discoverUserModulesSync(defaultUserModuleRoot(), readModuleTrustContext())
  const installed = modules.find((module) => module.manifest.id === registration.moduleId)
  if (!installed) {
    return { ok: false, reason: `Module "${registration.moduleId}" is not installed.` }
  }
  if (!isLoadEligible(installed.trust.status)) {
    if (installed.trust.status === 'invalid') {
      return { ok: false, reason: `Module "${registration.moduleId}" has an invalid signature.` }
    }
    return { ok: false, reason: `Module "${registration.moduleId}" is not trusted in Settings -> Modules.` }
  }

  const overrides = readModuleEnablementOverrides()
  const enabled = overrides[registration.moduleId] ?? installed.manifest.defaultEnabled
  if (!enabled) {
    return { ok: false, reason: `Module "${registration.moduleId}" is disabled in Settings -> Modules.` }
  }

  return { ok: true }
}

// Everything above ran synchronously during entry evaluation: module
// construction, sync user-module discovery, IPC registration. This mark closes
// that phase, so a slow module registration shows up as its own segment rather
// than hiding inside "app ready".
markStartup('main.module-evaluated')

registerAppLifecycle({
  diagnosticsEnabled: DIAGNOSTICS_ENABLED,
  allowMultipleInstances: allowsMultipleInstances(app),
  terminalRuntime: services.terminalRuntime,
  conversationRuntime: services.conversationRuntime,
  automationService: services.automationService,
  agentStateService: services.agentStateService,
  workspaceSyncService: services.workspaceSyncService,
  canvasService: services.canvasService,
  pullRequestRecord: services.pullRequestRecord,
  analytics: services.analytics,
  moduleKernel: moduleLoad.kernel,
  updateService: services.updateService,
  checkPluginSourceUpdates: () => services.skillsService.checkSourceUpdates(),
  backgroundMode: {
    isEnabled: () => services.backgroundModeStore.isEnabled(),
    readStatus: () => services.readBackgroundStatus(),
  },
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(services.sprintengineAuth, argv)
  },
})
