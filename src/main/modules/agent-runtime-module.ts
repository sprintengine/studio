import { app } from 'electron'

import type { AppServices } from '../app-services'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import {
  AgentControlPlaneToken,
  AgentLaunchServiceToken,
  SprintCreateServiceToken,
  CompanionAgentServiceToken,
  CompanionAgentsModuleServiceToken,
  GitHubTokenStoreToken,
  ModuleStorageToken,
  MulticodeAuthToken,
  SprintEngineArtifactsToken,
  SprintEngineAutomationServiceToken,
  SprintEngineLaunchSettingsToken,
  SprintEngineMcpHubToken,
  SprintPullRequestMergePollerToken,
  SprintRuntimeToken,
  TerminalRuntimeToken,
  WorkspaceContextToken,
  WorkspaceRegistryToken,
  WorkspaceServiceToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import { createModuleStorageRegistry } from '../module-host/module-storage'
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
      host.provideService(AgentControlPlaneToken, () => services.agentControlPlane)
      host.provideService(AgentLaunchServiceToken, () => services.agentLaunchService)
      host.provideService(GitHubTokenStoreToken, () => services.githubTokenStore)
      host.provideService(SprintEngineArtifactsToken, () => services.sprintEngineArtifacts)
      host.provideService(SprintEngineAutomationServiceToken, () => services.sprintEngineAutomation)
      host.provideService(SprintEngineLaunchSettingsToken, () => services.sprintEngineLaunchSettings)
      host.provideService(SprintRuntimeToken, () => services.sprintRuntime)
      host.provideService(SprintPullRequestMergePollerToken, () => services.sprintPullRequestMergePoller)
      host.provideService(MulticodeAuthToken, () => services.multicodeAuth)
      host.provideService(SprintEngineMcpHubToken, () => services.sprintEngineMcpHub)
      host.provideService(SprintCreateServiceToken, () => services.sprintCreateService)
      host.provideService(WorkspaceSyncServiceToken, () => services.workspaceSyncService)
      host.provideService(WorkspaceRegistryToken, () => services.workspaceRegistry)
      // Programmatic workspace creation, minted in main's registry (MC-2158).
      // A module can create a workspace with no window open; the id it gets
      // back is the one main just committed.
      host.provideService(WorkspaceServiceToken, () =>
        createModuleWorkspaceService({ workspaceSync: services.workspaceSyncService })
      )
      // Read-only workspace context (id → root/name/mode), read from the same
      // registry the create flow writes.
      host.provideService(WorkspaceContextToken, () =>
        createModuleWorkspaceContextService({
          getWorkspaceSyncSnapshot: () => services.workspaceSyncService.getSnapshot(),
        })
      )
      // Per-module, per-workspace JSON storage (SDK getModuleStorage): the
      // host owns file placement so modules stop inventing locations.
      host.provideService(ModuleStorageToken, () =>
        createModuleStorageRegistry({ userDataDir: () => app.getPath('userData') })
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
