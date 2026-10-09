import type { IpcMain } from 'electron'

import { GitHubTokenStore } from '../../main/github-token-store'
import { readModuleOverridesSync } from '../../main/module-host/enablement-store'
import { loadMainModules, type LoadMainModulesResult } from '../../main/module-host/load-modules'
import type { McpToolContribution } from '../../main/module-host/main-host'
import { ScheduledAgentsServiceToken } from '../../main/module-host/service-tokens'
import { AGENT_RUNTIME_MANIFEST, createAgentRuntimeModule } from '../../main/modules/agent-runtime-module'
import { createBundledMainModules } from '../../main/modules'
import { applyHostApiGate } from '../../main/modules/host-api-gate'
import { planThirdPartyMainModules, recordThirdPartyMainLaunchReport } from '../../main/modules/third-party-main-loader'
import { readModuleTrustContextSync } from '../../main/modules/trust-context'
import { defaultUserModuleRoot, discoverUserModulesSync } from '../../main/modules/user-module-registry'
import type { ScheduledAgentsService } from '../../main/scheduled-agents/service'
import { activeForChannel } from '../../shared/modules/dev-only'
import { MODULE_EVENTS_CHANNEL } from '../../shared/modules/events'
import { MODULE_NOTIFICATIONS_CHANNEL } from '../../shared/modules/notifications'
import { LIVE_ENABLED_MODULE_IDS, type CapabilityManifest } from '../../shared/modules/manifest'
import { resolveModuleEnablement } from '../../shared/modules/resolve'
import type { StudioCore } from '../core/studio-core'
import type { StudioGateway } from '../core/studio-gateway'
import type { StudioPlatform } from '../platform/platform'
import { installElectronRequireGuard } from './electron-require-guard'

// The module kernel in the Studio server out of process (phase 6 spec, 12.2):
// every module's server half, registered on the server's IPC tunnel, its MCP
// tools on the server's gateway, its events to every window through the
// tunnel. The same steps app-main.ts takes in process, over the server's own
// services.
//
// Enablement and trust are written by the shell (Settings and the marketplace
// live there in this phase) and read here: the overrides once at load, and
// again live through `applyEnablement`, which the shell calls after it has
// written them.

export type ServerModules = {
  /** Register every enabled module. Called once the gateway exists. */
  load(registry: Pick<IpcMain, 'handle' | 'removeHandler'> | unknown, gateway: StudioGateway): void
  mcpTools(): ReadonlyArray<McpToolContribution>
  isEnabled(moduleId: string): boolean
  scheduledAgents(): ScheduledAgentsService | null
  applyEnablement(overrides: Record<string, boolean>): Promise<{ ok: true } | { ok: false; message: string }>
  startup(): void
  shutdownBegin(): Promise<void>
  shutdown(): Promise<void>
}

export function createServerModules(deps: {
  platform: StudioPlatform
  core: StudioCore
  log: (message: string) => void
}): ServerModules {
  const { platform, core } = deps
  const dataDir = platform.paths.dataDir()
  const includeDevModules = !platform.paths.isPackaged()
  const readOverrides = (): Record<string, boolean> => {
    try {
      return readModuleOverridesSync(dataDir)
    } catch {
      return {}
    }
  }
  const enabled = new Set<string>()
  let load: LoadMainModulesResult | null = null
  let gateway: StudioGateway | null = null
  let manifests: CapabilityManifest[] = []

  const recompute = (overrides: Record<string, boolean>): void => {
    const { order } = resolveModuleEnablement(manifests, overrides)
    enabled.clear()
    for (const id of order) enabled.add(id)
  }

  return {
    load(registry, nextGateway) {
      gateway = nextGateway
      const overrides = readOverrides()
      // Main halves run here without Electron: a module that declares it needs
      // it loads manifest-only, and one that requires it anyway is refused at
      // the require (12.4).
      const thirdParty = planThirdPartyMainModules(
        discoverUserModulesSync(defaultUserModuleRoot(), readModuleTrustContextSync(dataDir)),
        { electronMain: false },
      )
      installElectronRequireGuard(() => Object.values(thirdParty.moduleRoots))
      applyHostApiGate(thirdParty.ineligible, thirdParty.modules)
      const bundled = activeForChannel(
        // Read only once a module asks, by which time `byId` exists.
        createBundledMainModules(
          platform,
          (moduleId): readonly string[] | undefined => byId.get(moduleId)?.permissions,
        ),
        (module) => module.manifest.id,
        includeDevModules,
      )
      const byId = new Map<string, CapabilityManifest>(
        [AGENT_RUNTIME_MANIFEST, ...bundled.map((m) => m.manifest), ...thirdParty.modules.map((m) => m.manifest)].map(
          (manifest) => [manifest.id, manifest],
        ),
      )
      const agentRuntime = createAgentRuntimeModule(
        {
          agentLaunchSettings: core.agentLaunchSettings,
          githubTokenStore: new GitHubTokenStore(),
          workspaceSyncService: core.workspaceSyncService,
          workspaceRegistry: core.workspaceRegistry,
          conversations: core.conversations,
          conversationLaunchService: core.conversationLaunchService,
          conversationModelCatalog: core.conversationModelCatalog,
        },
        {
          getModulePermissions: (moduleId) => byId.get(moduleId)?.permissions,
          platform,
          getTextGenerationSettings: () => core.textGenerationSettings.get(),
        },
      )
      load = loadMainModules({
        ipcMain: registry as IpcMain,
        modules: [agentRuntime, ...bundled, ...thirdParty.modules],
        overrides,
        moduleRoots: thirdParty.moduleRoots,
        moduleVerifiedFiles: thirdParty.verifiedFiles,
        ineligible: thirdParty.ineligible,
        launchErrors: thirdParty.launchErrors,
        deliverModuleEvent: (event) => platform.clients.publish(MODULE_EVENTS_CHANNEL, event),
        deliverModuleNotification: (notification) =>
          platform.clients.publish(MODULE_NOTIFICATIONS_CHANNEL, notification),
        electronMain: false,
        // A module tool that would shadow one of the gateway's own is refused
        // at registration, naming the tool it collides with.
        coreMcpToolNames: () => nextGateway.coreToolNames(),
      })
      manifests = [
        agentRuntime.manifest,
        ...bundled.map((m) => m.manifest),
        ...thirdParty.modules.map((m) => m.manifest),
      ]
      recompute(overrides)
      recordThirdPartyMainLaunchReport(
        thirdParty.modules.map((module) => module.manifest.id),
        load.report,
      )
      if (load.report.errors.length > 0) {
        deps.log(`module load errors: ${load.report.errors.map((error) => `${error.id}: ${error.message}`).join('; ')}`)
      }
    },
    mcpTools: () => load?.kernel.mcpToolRegistrations() ?? [],
    isEnabled: (moduleId) => enabled.has(moduleId),
    scheduledAgents: () => load?.kernel.hostFor('@host').getService(ScheduledAgentsServiceToken) ?? null,
    async applyEnablement(overrides) {
      if (!load) return { ok: true }
      const report = await load.applyEnablement(overrides, { liveModuleIds: LIVE_ENABLED_MODULE_IDS })
      // The rest of the change was applied even when one module's half
      // failed, so the gate follows it either way.
      recompute(overrides)
      // The gateway reads the registry and enablement per request; connected
      // clients only need telling that their lists changed.
      gateway?.notifyToolsListChanged()
      const scheduledAgentsError = report.errors.find((error) => error.id === 'scheduled-agents')
      if (scheduledAgentsError) return { ok: false, message: scheduledAgentsError.message }
      return { ok: true }
    },
    startup() {
      const current = load
      if (current) void current.ready.then(() => current.kernel.runStartup())
    },
    shutdownBegin: () => load?.kernel.runShutdownBegin() ?? Promise.resolve(),
    shutdown: () => load?.kernel.runShutdown() ?? Promise.resolve(),
  }
}
