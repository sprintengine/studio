import { app, BrowserWindow, ipcMain } from 'electron'
import { MODULE_NOTIFICATIONS_EVENT_CHANNEL } from '../shared/modules/notifications'
import { parseAuthCallbackFromArgv } from './auth-service'
import { registerAppLifecycle } from './app-lifecycle'
import { createAppServices } from './app-services'
import { ensureExtensionFolders } from './extension-folders'
import { readTrustedMarketplacePublisherFingerprintsSync } from './marketplace/trusted-publishers'
import type { ModuleEnablementLiveApplier } from './ipc/module-enablement-ipc'
import { activeForChannel } from '../shared/modules/dev-only'
import { loadMainModules } from './module-host/load-modules'
import { readModuleOverridesSync } from './module-host/enablement-store'
import { createAgentRuntimeModule } from './modules/agent-runtime-module'
import { createBundledMainModules } from './modules'
import { isFirstPartyAutomationProviderModule, type AutomationProviderPermissionChecker } from './automations/provider-registry'
import { isLoadEligible, type ModuleTrustContext } from './modules/module-signature'
import { readTrustedModulesSync } from './modules/trust-store'
import { planThirdPartyMainModules, recordThirdPartyMainLaunchReport } from './modules/third-party-main-loader'
import { registerThirdPartyRendererEntryIpc } from './modules/third-party-renderer-entries'
import { defaultUserModuleRoot, discoverUserModules, discoverUserModulesSync } from './modules/user-module-registry'
import { registerCoreIpc } from './register-core-ipc'
import { registerWorkflowIpc } from './register-workflow-ipc'

configureDevUserData()

// Make the drop-in extension roots discoverable on a fresh (packaged) install:
// create ~/.multicode/{modules,plugins} and seed each with a README describing
// what to drop there. Best-effort — never block startup on it.
const extensionFolders = ensureExtensionFolders()

const MULTICODE_DIAGNOSTICS = process.env['MULTICODE_DIAGNOSTICS'] === '1'
const services = createAppServices(MULTICODE_DIAGNOSTICS)
let applyModuleEnablementLive: ModuleEnablementLiveApplier | undefined

// Dev-only capability surfaces (Voice, Switchboard/Watchtower, Multiloop, Mobile
// Relay) ship only in from-source dev builds. A packaged/installed build is the
// production channel, so they are excluded from registration entirely. See
// src/shared/modules/dev-only.ts.
const includeDevModules = !app.isPackaged

registerCoreIpc(ipcMain, services, MULTICODE_DIAGNOSTICS, {
  includeDevModules,
  applyModuleEnablementLive: (overrides) => applyModuleEnablementLive?.(overrides),
})
registerWorkflowIpc(ipcMain, services)

// Capability modules register their own IPC/services/sidecars through the host
// kernel, gated by the user's enablement overrides (mirrored from the renderer
// into userData). A disabled module skips registration entirely. The
// agent-runtime core module seeds the shared services (terminal runtime, auth,
// token stores) that the optional modules consume via the service bridge; the
// resolver orders it first because every dependent declares
// `dependsOn: ['agent-runtime']`. See
// future-plans/2026-05-28-feature-level-pluggable-architecture.md.
const moduleOverrides = readModuleEnablementOverrides()
const thirdPartyMainLoad = planThirdPartyMainModules(
  discoverUserModulesSync(defaultUserModuleRoot(), readModuleTrustContext())
)
const activeMainModules = activeForChannel(
  createBundledMainModules({
    automations: { checkProviderPermission: checkAutomationProviderPermission },
  }),
  (module) => module.manifest.id,
  includeDevModules
)
const moduleLoad = loadMainModules({
  ipcMain,
  modules: [createAgentRuntimeModule(services), ...activeMainModules, ...thirdPartyMainLoad.modules],
  overrides: moduleOverrides,
  ineligible: thirdPartyMainLoad.ineligible,
  launchErrors: thirdPartyMainLoad.launchErrors,
  deliverNotification: (notification) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(MODULE_NOTIFICATIONS_EVENT_CHANNEL, notification)
    }
  },
})
applyModuleEnablementLive = async (overrides) => {
  const report = await moduleLoad.applyEnablement(overrides, { liveModuleIds: ['automations'] })
  const automationsError = report.errors.find((error) => error.id === 'automations')
  if (automationsError) return { ok: false, message: automationsError.message }
  return { ok: true }
}
recordThirdPartyMainLaunchReport(
  thirdPartyMainLoad.modules.map((module) => module.manifest.id),
  moduleLoad.report
)
// Trusted third-party entry.renderer bundles are served on demand (the trust
// store is re-read per request, so revoking trust takes effect immediately).
registerThirdPartyRendererEntryIpc(moduleLoad.kernel.hostFor('@host'), {
  discoverModules: () =>
    discoverUserModules(defaultUserModuleRoot(), readModuleTrustContext()),
})
if (MULTICODE_DIAGNOSTICS) {
  console.info('[modules] extension roots:', extensionFolders.moduleRoot, extensionFolders.pluginRoot)
  if (extensionFolders.errors.length > 0) {
    console.warn('[modules] extension folder setup errors:', extensionFolders.errors)
  }
  console.info(
    '[modules] loaded:', moduleLoad.report.loaded,
    'manifest-only:', moduleLoad.report.manifestOnly,
    'disabled:', moduleLoad.report.disabled,
    'sidecars:', moduleLoad.report.sidecars.map((s) => s.id)
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
  registration: Parameters<AutomationProviderPermissionChecker>[0]
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

function configureDevUserData(): void {
  const userDataDir = process.env['MULTICODE_USER_DATA_DIR']?.trim()
  if (!userDataDir || app.isPackaged) return

  app.setPath('userData', userDataDir)
}

registerAppLifecycle({
  diagnosticsEnabled: MULTICODE_DIAGNOSTICS,
  allowMultipleInstances:
    !app.isPackaged &&
    process.env['MULTICODE_ALLOW_MULTI_INSTANCE'] === '1' &&
    Boolean(process.env['MULTICODE_USER_DATA_DIR']?.trim()),
  terminalRuntime: services.terminalRuntime,
  conversationRuntime: services.conversationRuntime,
  automationService: services.automationService,
  agentStateService: services.agentStateService,
  workspaceSyncService: services.workspaceSyncService,
  moduleKernel: moduleLoad.kernel,
  updateService: services.updateService,
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(services.multicodeAuth, argv)
  },
})
