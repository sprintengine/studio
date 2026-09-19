import { app } from 'electron'

import type { AppServices } from '../app-services'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import {
  AgentControlPlaneToken,
  AgentLaunchServiceToken,
  AgentLaunchSettingsToken,
  AgentSessionsModuleServiceToken,
  CompanionAgentServiceToken,
  CompanionAgentsModuleServiceToken,
  GitHubTokenStoreToken,
  ModuleStorageToken,
  EntitlementServiceToken,
  MulticodeAuthToken,
  TerminalRuntimeToken,
  WorkspaceContextToken,
  WorkspaceRegistryToken,
  WorkspaceServiceToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import { createModuleStorageRegistry } from '../module-host/module-storage'
import { createCompanionAgentService, createCompanionAgentsModuleRegistry } from '../companion-agent-service'
import { createAgentSessionsModuleRegistry } from '../agent-sessions-module-service'
import { findBuiltinSkill } from '../builtin-skills'
import { getPluginById } from '../plugin-registry-instance'
import { resolveSkillInvocation } from '../../shared/skill-invocation'
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
// (Terminal/agent IPC itself still registers in register-core-ipc; since
// agent-runtime is always enabled, that's
// behavior-identical. Migrating that IPC onto this module is optional later
// polish, not required to formalize the core.)
export const AGENT_RUNTIME_MANIFEST: CapabilityManifest = {
  id: 'agent-runtime',
  displayName: 'Agent Runtime',
  version: 1,
  publisher: 'multicode',
  category: 'core',
  summary: 'Terminals, agent launch, and the session runtime that every other capability builds on. Always on.',
  defaultEnabled: true,
  core: true,
}

export function createAgentRuntimeModule(
  services: AppServices,
  options: { getModulePermissions: ModulePermissionsResolver },
): CapabilityModule {
  return {
    manifest: AGENT_RUNTIME_MANIFEST,
    registerMain(host) {
      host.provideService(TerminalRuntimeToken, () => services.terminalRuntime)
      host.provideService(AgentControlPlaneToken, () => services.agentControlPlane)
      host.provideService(AgentLaunchServiceToken, () => services.agentLaunchService)
      host.provideService(AgentLaunchSettingsToken, () => services.agentLaunchSettings)
      host.provideService(GitHubTokenStoreToken, () => services.githubTokenStore)
      host.provideService(MulticodeAuthToken, () => services.multicodeAuth)
      host.provideService(EntitlementServiceToken, () => services.entitlements)
      host.provideService(WorkspaceSyncServiceToken, () => services.workspaceSyncService)
      host.provideService(WorkspaceRegistryToken, () => services.workspaceRegistry)
      // Programmatic workspace creation, minted in main's registry (MC-2158).
      // A module can create a workspace with no window open; the id it gets
      // back is the one main just committed.
      host.provideService(WorkspaceServiceToken, () =>
        createModuleWorkspaceService({ workspaceSync: services.workspaceSyncService }),
      )
      // Read-only workspace context (id → root/name/mode), read from the same
      // registry the create flow writes.
      host.provideService(WorkspaceContextToken, () =>
        createModuleWorkspaceContextService({
          getWorkspaceSyncSnapshot: () => services.workspaceSyncService.getSnapshot(),
        }),
      )
      // Per-module, per-workspace JSON storage (SDK getModuleStorage): the
      // host owns file placement so modules stop inventing locations.
      host.provideService(ModuleStorageToken, () =>
        createModuleStorageRegistry({ userDataDir: () => app.getPath('userData') }),
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
        }),
      )
      // Agent sessions: ordinary agent TERMINALS a module owns (D5). Composed
      // through the same AgentLaunchService every app-level launch uses, so a
      // module's agent gets the user's CLI, permission default, runtime
      // overrides, MCP and knowledge graph — and a tab — rather than a
      // hand-rolled spawn payload. Every method checks `agents:session`.
      const agentSessions = createAgentSessionsModuleRegistry({
        launchAgent: (request) => services.agentLaunchService.launch(request),
        terminal: {
          list: () => services.terminalRuntime.ipcHandlers.listTerminals(),
          kill: (sessionId) => services.terminalRuntime.ipcHandlers.killTerminal(sessionId),
          setReapExempt: (sessionId, exempt) =>
            services.terminalRuntime.ipcHandlers.setTerminalReapExempt(sessionId, exempt),
          onAgentSessionExit: (listener) => services.terminalRuntime.registerAgentSessionExitListener(listener),
        },
        sendPrompt: async (sessionId, text) => {
          const result = await services.agentControlPlane.send({ sessionId }, text, { submit: true })
          return result.ok ? { ok: true } : { ok: false, message: result.message }
        },
        hasWorkspace: (workspaceId) =>
          services.workspaceSyncService
            .getSnapshot()
            .state.workspaces.some((workspace) => workspace.id === workspaceId),
        // The builtin catalogue today; WP-D widens `findBuiltinSkill` itself to
        // skills a module registered, so this seam needs no second branch.
        resolveSkill: (skillId) => findBuiltinSkill(skillId),
        resolveSkillInvocation: (cli, skillId) =>
          resolveSkillInvocation(getPluginById(cli)?.manifest.skillIntegration, skillId),
        getModulePermissions: options.getModulePermissions,
      })
      host.provideService(AgentSessionsModuleServiceToken, () => agentSessions)
      host.onShutdown(() => agentSessions.dispose())
    },
  }
}
