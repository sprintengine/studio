import type { AppServices } from '../app-services'
import type { StudioPlatform } from '../../server/platform/platform'
import type { ConversationCliRuntimeOverrides } from '../../shared/conversation-runtime'
import { effectiveAgentLaunchSettings } from '../../shared/launch-settings'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import {
  AgentControlPlaneToken,
  AgentLaunchServiceToken,
  AgentLaunchSettingsToken,
  CompanionAgentServiceToken,
  CompanionAgentsModuleServiceToken,
  ConversationLaunchServiceToken,
  ConversationModuleServiceToken,
  ConversationRuntimeToken,
  GitHubModuleServiceToken,
  GitHubTokenStoreToken,
  ModuleSecretsServiceToken,
  ModuleStorageToken,
  SprintEngineAuthToken,
  TerminalRuntimeToken,
  WorkspaceContextToken,
  WorkspaceGitInfoToken,
  WorkspaceRegistryToken,
  WorkspaceServiceToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import { createConversationModuleRegistry } from '../module-host/module-conversation-service'
import { ConversationSessionApi } from '../conversation-session-api'
import { createModuleGitHubRegistry } from '../module-host/module-github'
import { createModuleSecretsRegistry } from '../module-host/module-secrets'
import { createModuleStorageRegistry } from '../module-host/module-storage'
import { moduleToolCallerCeiling } from '../module-host/module-tool-caller'
import { createCompanionAgentService, createCompanionAgentsModuleRegistry } from '../companion-agent-service'
import { createModuleWorkspaceContextService, createModuleWorkspaceService } from './module-workspace-service'
import { CLOSED_WORKSPACE_HISTORY_FILE, createClosedWorkspaceHistory } from './closed-workspace-history'
import { readFolderGitInfo } from '../workspace-git-info'
import { toModuleWorkspaceView, type ModuleWorkspaceView } from '../../shared/modules/workspace-view'
import { join } from 'node:path'

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
  publisher: 'sprintengine',
  category: 'core',
  summary: 'Terminals, agent launch, and the session runtime that every other capability builds on. Always on.',
  defaultEnabled: true,
  core: true,
}

/**
 * What the module seeds. The shell's own services (terminals, the control
 * plane that types at them, the terminal launch, the account) are present in
 * process and absent in the Studio server out of process, where no module of
 * the app's consumes them and none is on the third-party list.
 */
export type AgentRuntimeServices = Pick<
  AppServices,
  | 'agentLaunchSettings'
  | 'githubTokenStore'
  | 'workspaceSyncService'
  | 'workspaceRegistry'
  | 'conversations'
  | 'conversationLaunchService'
  | 'conversationModelCatalog'
> &
  Partial<Pick<AppServices, 'terminalRuntime' | 'agentControlPlane' | 'agentLaunchService' | 'sprintengineAuth'>>

export function createAgentRuntimeModule(
  services: AgentRuntimeServices,
  options: {
    getModulePermissions: ModulePermissionsResolver
    /** Where module storage and module secrets live, and what the secrets are sealed with. */
    platform: Pick<StudioPlatform, 'paths' | 'secrets'>
  },
): CapabilityModule {
  const { paths, secrets: cipher } = options.platform
  return {
    manifest: AGENT_RUNTIME_MANIFEST,
    registerMain(host) {
      const { terminalRuntime, agentControlPlane, agentLaunchService, sprintengineAuth } = services
      if (terminalRuntime) host.provideService(TerminalRuntimeToken, () => terminalRuntime)
      if (agentControlPlane) host.provideService(AgentControlPlaneToken, () => agentControlPlane)
      if (agentLaunchService) host.provideService(AgentLaunchServiceToken, () => agentLaunchService)
      host.provideService(AgentLaunchSettingsToken, () => services.agentLaunchSettings)
      host.provideService(GitHubTokenStoreToken, () => services.githubTokenStore)
      if (sprintengineAuth) host.provideService(SprintEngineAuthToken, () => sprintengineAuth)
      host.provideService(WorkspaceSyncServiceToken, () => services.workspaceSyncService)
      host.provideService(WorkspaceRegistryToken, () => services.workspaceRegistry)
      // Programmatic workspace creation, minted in main's registry.
      // A module can create a workspace with no window open; the id it gets
      // back is the one main just committed.
      host.provideService(WorkspaceServiceToken, () =>
        createModuleWorkspaceService({ workspaceSync: services.workspaceSyncService }),
      )
      // Read-only workspace context (id → root/name/mode), read from the same
      // registry the create flow writes. Closing a workspace deletes its
      // record, so the history of closed ones is kept beside it, fed by every
      // registry change, for `list({ includeClosed: true })`.
      const workspaceViews = (): ModuleWorkspaceView[] =>
        services.workspaceSyncService
          .getSnapshot()
          .state.workspaces.map((workspace) => toModuleWorkspaceView(workspace))
          .filter((view): view is ModuleWorkspaceView => view !== null)
      const closedWorkspaces = createClosedWorkspaceHistory({
        filePath: join(paths.dataDir(), CLOSED_WORKSPACE_HISTORY_FILE),
      })
      closedWorkspaces.observe(workspaceViews())
      const stopObservingWorkspaces = services.workspaceSyncService.subscribeEvents(() =>
        closedWorkspaces.observe(workspaceViews()),
      )
      host.onShutdown(() => stopObservingWorkspaces())
      host.provideService(WorkspaceContextToken, () =>
        createModuleWorkspaceContextService({
          getWorkspaceSyncSnapshot: () => services.workspaceSyncService.getSnapshot(),
          listClosedWorkspaces: () => closedWorkspaces.list(),
        }),
      )
      // A workspace's branch and remotes, for the module host's
      // getWorkspaceGitInfo: git asked from the workspace's own folder (the
      // worktree, for a worktree-backed one).
      host.provideService(WorkspaceGitInfoToken, () => ({
        read: async (workspaceId: string) => {
          const workspace = services.workspaceSyncService
            .getSnapshot()
            .state.workspaces.find((entry) => entry.id === workspaceId)
          if (!workspace) {
            return { ok: false, code: 'unknown_workspace', message: `No open workspace "${workspaceId}".` } as const
          }
          return readFolderGitInfo(workspace.folderPath ?? null)
        },
      }))
      // Per-module, per-workspace JSON storage (SDK getModuleStorage): the
      // host owns file placement so modules stop inventing locations.
      host.provideService(ModuleStorageToken, () => createModuleStorageRegistry({ userDataDir: () => paths.dataDir() }))
      // Companion agents: workspace-bound background agents driven through the
      // shared conversation runtime. The core service is app-internal
      // (first-party consumers require it directly); the moduleId-scoped
      // registry is what the SDK's getCompanionAgentsService resolves, and it
      // gates attach on the `agents:companion` permission.
      const companionAgentService = createCompanionAgentService({
        runtime: services.conversations,
      })
      host.provideService(CompanionAgentServiceToken, () => companionAgentService)
      host.provideService(CompanionAgentsModuleServiceToken, () =>
        createCompanionAgentsModuleRegistry({
          service: companionAgentService,
          getModulePermissions: options.getModulePermissions,
        }),
      )
      // Chats: the launch service every chat main starts goes through (an
      // automation run's agent first) and the runtime it runs on, both
      // first-party only; and the moduleId-scoped conversation service behind
      // the SDK's getConversationService, which checks `conversation:read` /
      // `conversation:operate` and the chat's owner on every call.
      host.provideService(ConversationLaunchServiceToken, () => services.conversationLaunchService)
      host.provideService(ConversationRuntimeToken, () => services.conversations)
      const conversationSessions = new ConversationSessionApi(services.conversations)
      const conversations = createConversationModuleRegistry({
        launch: (request) => services.conversationLaunchService.launch(request),
        runtime: services.conversations,
        // The same replay, fence and live tail every other follower gets.
        follow: (input, listener) => conversationSessions.subscribe(input, listener),
        // A preset or model switch moves the chat's record as the chat view
        // moves it, through the same bus every window hears.
        writeAgent: (workspaceId, agentId, patch) =>
          services.workspaceSyncService.updateWorkspaceAgent(workspaceId, agentId, patch, 'system'),
        // A model switch takes the ids the person's own picker offers.
        modelCatalog: services.conversationModelCatalog,
        getWorkspaceAgents: () => services.workspaceSyncService.getSnapshot().state.workspaces,
        onWorkspacesChanged: (listener) => services.workspaceSyncService.subscribeEvents(() => listener()),
        getCliRuntimes: () =>
          effectiveAgentLaunchSettings(services.agentLaunchSettings.get()).cliRuntimes as
            ConversationCliRuntimeOverrides | undefined,
        getModulePermissions: options.getModulePermissions,
        // A chat a module's MCP tool starts is held to the calling agent's preset.
        getCallerPermissionCeiling: moduleToolCallerCeiling,
      })
      host.provideService(ConversationModuleServiceToken, () => conversations.registry)
      host.onShutdown(() => conversations.dispose())
      // The brokers behind the SDK's getSecretsService and getGitHubService: a
      // module stores a secret and spends it on the origins it named, or calls
      // the signed-in person's GitHub, without ever holding the value itself.
      // Each checks its permission (`secrets`, `github`) on every call.
      const secrets = createModuleSecretsRegistry({
        userDataDir: paths.dataDir(),
        cipher,
        getModulePermissions: options.getModulePermissions,
      })
      host.provideService(ModuleSecretsServiceToken, () => secrets.registry)
      const github = createModuleGitHubRegistry({
        tokenStore: services.githubTokenStore,
        getModulePermissions: options.getModulePermissions,
      })
      host.provideService(GitHubModuleServiceToken, () => github.registry)
    },
  }
}
