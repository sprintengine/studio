import { app, BrowserWindow, ipcMain } from 'electron'
import { MODULE_EVENTS_CHANNEL } from '../shared/modules/events'
import { MODULE_NOTIFICATIONS_EVENT_CHANNEL } from '../shared/modules/notifications'
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
import {
  AutomationsAppFrontDoorToken,
  RoadmapAppFrontDoorToken,
} from './module-host/service-tokens'
import { AGENT_RUNTIME_MANIFEST, createAgentRuntimeModule } from './modules/agent-runtime-module'
import type { CapabilityManifest } from '../shared/modules/manifest'
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

// Dev-only capability surfaces (Voice, Switchboard/Watchtower, Mobile
// Relay, and the not-yet-production-ready Roadmap and Review) ship only in
// from-source dev builds. A packaged/installed build is the production channel,
// so they are excluded from registration entirely. See
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
// Live-resolved main enablement, kept in step with the renderer's overrides (see
// recomputeMainEnablement below). The `roadmap` module has no main runtime of its
// own — its orchestrator rides the Automations engine tick — so the reconcile
// gate reads this set each tick to honor the roadmap toggle (and its dependency
// cascade) without a reload. Declared before module construction so the predicate
// can close over it; the set is filled in once the manifest list exists.
const enabledMainModuleIds = new Set<string>()
const activeMainModules = activeForChannel(
  createBundledMainModules({
    automations: {
      checkProviderPermission: checkAutomationProviderPermission,
      isRoadmapReconcileEnabled: () => enabledMainModuleIds.has('roadmap'),
    },
  }),
  (module) => module.manifest.id,
  includeDevModules
)
// Resolves any module id to the permissions it declared in its manifest, across
// every module the app assembled. The companion registry gates attach on it.
const moduleManifestsById = new Map<string, CapabilityManifest>(
  [AGENT_RUNTIME_MANIFEST, ...activeMainModules.map((module) => module.manifest), ...thirdPartyMainLoad.modules.map((module) => module.manifest)].map(
    (manifest) => [manifest.id, manifest]
  )
)
const getModulePermissions = (moduleId: string): readonly string[] | undefined =>
  moduleManifestsById.get(moduleId)?.permissions
// Extracted as a const (rather than inlined) so `mainModuleManifests` below can
// reference its manifest for the roadmap enablement gate; constructed after
// `getModulePermissions` so the companion-attach permission check is wired in.
const agentRuntimeModule = createAgentRuntimeModule(services, { getModulePermissions })
const moduleLoad = loadMainModules({
  ipcMain,
  modules: [agentRuntimeModule, ...activeMainModules, ...thirdPartyMainLoad.modules],
  overrides: moduleOverrides,
  ineligible: thirdPartyMainLoad.ineligible,
  launchErrors: thirdPartyMainLoad.launchErrors,
  deliverNotification: (notification) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(MODULE_NOTIFICATIONS_EVENT_CHANNEL, notification)
    }
  },
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
// The manifest universe the roadmap gate resolves against — every main module
// present this channel, so `roadmap` and its dependencies (sprint-engine,
// automations, agent-runtime) all resolve. Recompute mirrors the renderer's
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
  const report = await moduleLoad.applyEnablement(overrides, { liveModuleIds: ['automations'] })
  const automationsError = report.errors.find((error) => error.id === 'automations')
  if (automationsError) return { ok: false, message: automationsError.message }
  // Roadmap has no live-loadable main module, so its toggle takes effect through
  // the reconcile gate rather than module load/unload — refresh the resolved set.
  recomputeMainEnablement(overrides)
  // Sprint Engine's raw IPC registrations are not live-unloaded yet, but its
  // Python sidecar must honor the toggle immediately: close the spawn gate and
  // stop any live hub. Re-enabling can reopen an already-registered module;
  // enabling one that was disabled at startup still takes effect after restart.
  await services.sprintEngineMcpHub.setModuleEnabled(enabledMainModuleIds.has('sprint-engine'))
  // Module-contributed gateway tools follow enablement live (MC-1855): the
  // gateway re-reads the registry and enablement per request, so only the
  // connected MCP clients need a nudge to refresh their tool lists.
  services.automationService.notifyToolsListChanged()
  return { ok: true }
}
// Automation server ← Automations module: resolved per tool call so a live
// module disable/enable cycle is reflected immediately (token absent ⇒ tools
// report automations_module_unavailable).
services.setAutomationsAppFrontDoorResolver(
  () => moduleLoad.kernel.hostFor('@host').getService(AutomationsAppFrontDoorToken) ?? null
)
// Roadmap.* tools ← the same Automations module, which constructs the orchestrator.
services.setRoadmapAppFrontDoorResolver(
  () => moduleLoad.kernel.hostFor('@host').getService(RoadmapAppFrontDoorToken) ?? null
)
// Module enablement for gateway tools that belong to a capability module: the
// resolved set is recomputed on every override the renderer pushes, so a module
// switched off in Settings is off for MCP callers on their next call, not after
// a restart (MC-1805 is the ruling behind it).
services.setModuleEnabledResolver((moduleId) => enabledMainModuleIds.has(moduleId))
// Module-contributed MCP tools ← the host kernel (MC-1855). The gateway was
// constructed above, before loadMainModules ran; this seam hands it the live
// registry, and the per-request evaluation makes the tools visible immediately.
services.setModuleMcpToolsResolver(() => moduleLoad.kernel.mcpToolRegistrations())
recordThirdPartyMainLaunchReport(
  thirdPartyMainLoad.modules.map((module) => module.manifest.id),
  moduleLoad.report
)
// Trusted third-party entry.renderer bundles are served on demand (the trust
// store is re-read per request, so revoking trust takes effect immediately).
registerThirdPartyRendererEntryIpc(moduleLoad.kernel.hostFor('@host'), {
  discoverModules: () =>
    discoverUserModules(defaultUserModuleRoot(), readModuleTrustContext()),
  trustContext: readModuleTrustContext,
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
  sprintRuntime: services.sprintRuntime,
  moduleKernel: moduleLoad.kernel,
  updateService: services.updateService,
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(services.multicodeAuth, argv)
  },
})
