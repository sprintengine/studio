import type { AppServices } from '../app-services'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import {
  AutomationDelegateToken,
  CompanionAgentServiceToken,
  CompanionAgentsModuleServiceToken,
  GitHubTokenStoreToken,
  MulticodeAuthToken,
  SprintEngineArtifactsToken,
  SprintEngineAutomationServiceToken,
  SprintEngineLaunchSettingsToken,
  SprintEngineMcpHubToken,
  SprintRuntimeToken,
  TerminalRuntimeToken,
  WorkspaceContextToken,
  WorkspaceServiceToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import {
  createCompanionAgentService,
  createCompanionAgentsModuleRegistry,
} from '../companion-agent-service'
import { createModuleWorkspaceContextService, createModuleWorkspaceService } from './module-workspace-service'

// Resolves a module id to the capability permissions it declared in its
// manifest (disclosure list). The companion registry uses it to gate `attach`
// on the `agents:companion` permission.
export type ModulePermissionsResolver = (moduleId: string) => readonly string[] | undefined

// The agent runtime is the irreducible core: terminals + the BYO-CLI launch
// path are what every other orchestration module sits on. It is `core: true`, so
// the resolver always loads it and the chooser can't disable it.
//
// Its job in the kernel is to seed the foundational singletons (built in
// createAppServices) as services other modules consume across module boundaries.
// Because every dependent declares `dependsOn: ['agent-runtime']`, the resolver
// topologically orders this module first, so its `provideService` calls run
// before any dependent's `requireService`. This replaces the anonymous
// `provideServices` seeding index.ts used to do — the dependency is now an
// explicit, resolver-enforced edge.
//
// (Terminal/agent IPC itself still registers in register-core-ipc /
// register-workflow-ipc; since agent-runtime is always enabled, that's
// behavior-identical. Migrating that IPC onto this module is optional later
// polish, not required to formalize the core.)
export const AGENT_RUNTIME_MANIFEST: CapabilityManifest = {
  id: 'agent-runtime',
  displayName: 'Agent Runtime',
  version: 1,
  publisher: 'multicode',
  category: 'core',
  summary:
    'Terminals, agent launch, and the session runtime that every other capability builds on. Always on.',
  defaultEnabled: true,
  core: true,
}

export function createAgentRuntimeModule(
  services: AppServices,
  options: { getModulePermissions: ModulePermissionsResolver }
): CapabilityModule {
  return {
    manifest: AGENT_RUNTIME_MANIFEST,
    registerMain(host) {
      host.provideService(TerminalRuntimeToken, () => services.terminalRuntime)
      host.provideService(GitHubTokenStoreToken, () => services.githubTokenStore)
      host.provideService(SprintEngineArtifactsToken, () => services.sprintEngineArtifacts)
      host.provideService(SprintEngineAutomationServiceToken, () => services.sprintEngineAutomation)
      host.provideService(SprintEngineLaunchSettingsToken, () => services.sprintEngineLaunchSettings)
      host.provideService(SprintRuntimeToken, () => services.sprintRuntime)
      host.provideService(MulticodeAuthToken, () => services.multicodeAuth)
      host.provideService(SprintEngineMcpHubToken, () => services.sprintEngineMcpHub)
      host.provideService(AutomationDelegateToken, () => services.automationDelegate)
      host.provideService(WorkspaceSyncServiceToken, () => services.workspaceSyncService)
      // Programmatic workspace creation, routed through the same renderer
      // delegate + workspace-sync confirmation the automation tool uses.
      host.provideService(WorkspaceServiceToken, () =>
        createModuleWorkspaceService({
          delegateToRenderer: (request) => services.automationDelegate.request(request),
          getWorkspaceSyncSnapshot: () => services.workspaceSyncService.getSnapshot(),
        })
      )
      // Read-only workspace context (id → root/name/mode), backed by the same
      // workspace-sync snapshot the create flow confirms against.
      host.provideService(WorkspaceContextToken, () =>
        createModuleWorkspaceContextService({
          getWorkspaceSyncSnapshot: () => services.workspaceSyncService.getSnapshot(),
        })
      )
      // Companion agents: workspace-bound background agents driven through the
      // shared conversation runtime. The core service is app-internal
      // (first-party consumers require it directly); the moduleId-scoped
      // registry is what the SDK's getCompanionAgentsService resolves, and it
      // gates attach on the `agents:companion` permission.
      const companionAgentService = createCompanionAgentService({
        runtime: services.conversationRuntime,
      })
      host.provideService(CompanionAgentServiceToken, () => companionAgentService)
      host.provideService(CompanionAgentsModuleServiceToken, () =>
        createCompanionAgentsModuleRegistry({
          service: companionAgentService,
          getModulePermissions: options.getModulePermissions,
        })
      )
    },
  }
}
