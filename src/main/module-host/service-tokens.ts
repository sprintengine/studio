import type { AppServices } from '../app-services'
import type { ModuleWorkspaceContextService, ModuleWorkspaceService } from '../modules/module-workspace-service'
import type { ModuleStorageRegistry } from './module-storage'
import type { ModuleWorkspaceGitInfoResult } from '../../shared/modules/workspace-view'
import type { CompanionAgentService, CompanionAgentsModuleRegistry } from '../companion-agent-service'
import type { ModuleGitHubRegistry, ModuleSecretsRegistry } from '../../shared/modules/brokers'
import type {
  ModuleChatRuntimeOption,
  ModuleConversationRegistry,
  ModuleTextGenerationRegistry,
} from '../../shared/modules/conversation-service'
import type { ModuleBacklogRegistry } from '../../shared/modules/backlog-service'
import type { ModuleActivityRegistry, ModuleUsageRegistry } from '../../shared/modules/activity-service'
import type { ScheduledAgentsModuleRegistry, ScheduledAgentsService } from '../scheduled-agents/service'
import {
  CHAT_RUNTIMES_SERVICE_KEY,
  createServiceToken,
  MODULE_APP_STATE_SERVICE_KEY,
  WORKSPACE_GIT_INFO_SERVICE_KEY,
} from './main-host'
import type { ModuleAppStateMirror } from './module-app-state-mirror'

// Tokens for the shared services that capability modules consume across module
// boundaries (instead of importing the concrete instances). index.ts seeds the
// kernel with the live AppServices instances via loadMainModules' provideServices
// hook; modules call host.requireService(<token>).
export const TerminalRuntimeToken = createServiceToken<AppServices['terminalRuntime']>('core.terminal-runtime')
// The single main-process path that drives an agent session: send,
// submit, interrupt, read, wait — serialized per session, dispatched per
// transport. Consumers resolve this instead of writing to a pty themselves.
export const AgentControlPlaneToken = createServiceToken<AppServices['agentControlPlane']>('core.agent-control-plane')
// The single main-process path that COMPOSES an agent launch: CLI and
// permission defaults, connector resolution, naming, spawn.
// Consumers resolve this instead of asking a renderer to launch for them, which
// is what made every headless agent launch fail for want of an open window.
export const AgentLaunchServiceToken =
  createServiceToken<AppServices['agentLaunchService']>('core.agent-launch-service')
export const GitHubTokenStoreToken = createServiceToken<AppServices['githubTokenStore']>('core.github-token-store')
// The main-owned agent-launch settings (CLI runtimes, permission preset, MCP
// servers, knowledge roots, last-selected CLI) that main-side spawns read.
export const AgentLaunchSettingsToken =
  createServiceToken<AppServices['agentLaunchSettings']>('core.agent-launch-settings')
export const SprintEngineAuthToken = createServiceToken<AppServices['sprintengineAuth']>('core.sprintengine-auth')
export const WorkspaceSyncServiceToken =
  createServiceToken<AppServices['workspaceSyncService']>('core.workspace-sync-service')
// The authoritative workspace registry. Modules that need to READ the
// durable record — the phone's scope resolver, a workspace-scoped surface —
// resolve this rather than reaching for the bus, which only carries events.
// Creation still goes through WorkspaceServiceToken below, which writes here.
export const WorkspaceRegistryToken = createServiceToken<AppServices['workspaceRegistry']>('core.workspace-registry')
// The host-internal chat services: the one path that starts a chat in main (a
// module's `create`, an automation run's agent, a paired machine's New chat)
// and the chats they run as (the core's conversation backend; the key keeps the
// name it had when that was the runtime itself). First-party only — neither
// key is on the third-party service list; a module reaches chats through the
// moduleId-scoped ConversationModuleServiceToken below.
export const ConversationLaunchServiceToken =
  createServiceToken<AppServices['conversationLaunchService']>('core.conversation-launch')
export const ConversationRuntimeToken = createServiceToken<AppServices['conversations']>('core.conversation-runtime')
// Scheduled agents: the one door every caller — the New chat panel, an
// extension, an agent's MCP call — creates and changes them through.
export const ScheduledAgentsServiceToken = createServiceToken<ScheduledAgentsService>('scheduled-agents.service')
// Key mirrors the private token behind the SDK's getScheduledAgentsService.
export const ScheduledAgentsModuleServiceToken = createServiceToken<ScheduledAgentsModuleRegistry>(
  'scheduled-agents.module-service',
)
// Programmatic workspace creation for capability modules. The key MUST equal the
// SDK's WorkspaceServiceToken ('core.workspace') so a module that imports the
// token from @sprintengine/module-sdk resolves the instance the app provides here.
export const WorkspaceServiceToken = createServiceToken<ModuleWorkspaceService>('core.workspace')
// Read-only workspace context (id → root/name/mode). The key MUST equal the
// SDK's WorkspaceContextToken ('core.workspace-context') for the same reason.
export const WorkspaceContextToken = createServiceToken<ModuleWorkspaceContextService>('core.workspace-context')
// Per-module, per-workspace JSON storage. The key mirrors the private token
// behind the SDK's getModuleStorage helper ('core.module-storage').
export const ModuleStorageToken = createServiceToken<ModuleStorageRegistry>('core.module-storage')
// The app-internal companion-agent service (attach workspace-bound background
// agents). Consumed by first-party surfaces via requireService.
export const CompanionAgentServiceToken = createServiceToken<CompanionAgentService>('core.companion-agent-service')
// The moduleId-scoped companion registry with permission enforcement. Key
// mirrors the private token behind the SDK's getCompanionAgentsService helper,
// so a third-party module resolves the instance the app provides here.
export const CompanionAgentsModuleServiceToken = createServiceToken<CompanionAgentsModuleRegistry>(
  'companion-agents.module-service',
)
// The moduleId-scoped conversation registry: chats a module creates, drives
// and reads, checked per call against `conversation:read` /
// `conversation:operate` and the chat's owner. Key mirrors the private token
// behind the SDK's getConversationService helper.
export const ConversationModuleServiceToken =
  createServiceToken<ModuleConversationRegistry>('conversation.module-service')
// Headless text generation per module (`agents:generate`): one prompt, no
// workspace, no tools, no tab. Key mirrors the private token behind the SDK's
// getTextGenerationService helper.
export const TextGenerationModuleServiceToken = createServiceToken<ModuleTextGenerationRegistry>(
  'text-generation.module-service',
)
// The chat runtimes this machine can run, as the renderer's listChatRuntimes
// lists them: what MainHost.listChatRuntimes answers. App-internal; the host
// method is a module's way to it.
export const ChatRuntimesToken = createServiceToken<() => Promise<ModuleChatRuntimeOption[]>>(CHAT_RUNTIMES_SERVICE_KEY)
// Per-module brokered secrets (`secrets` permission). Key mirrors the private
// token behind the SDK's getSecretsService helper.
export const ModuleSecretsServiceToken = createServiceToken<ModuleSecretsRegistry>('module-secrets.module-service')
// The signed-in user's GitHub, brokered per module (`github` permission). Key
// mirrors the private token behind the SDK's getGitHubService helper.
export const GitHubModuleServiceToken = createServiceToken<ModuleGitHubRegistry>('github.module-service')
// ── Backlog, usage and activity services ──
// Each key mirrors the private token behind its SDK helper
// (getBacklogService, getUsageService, getActivityService); each registry
// checks its permission on every call (`backlog.read`/`backlog.write`,
// `usage:read`, `conversation:read-all`).
export const BacklogModuleServiceToken = createServiceToken<ModuleBacklogRegistry>('backlog.module-service')
export const UsageModuleServiceToken = createServiceToken<ModuleUsageRegistry>('usage.module-service')
export const ActivityModuleServiceToken = createServiceToken<ModuleActivityRegistry>('activity.module-service')
// A workspace's branch and remotes, read for the module host's own
// `getWorkspaceGitInfo` (which checks the calling module's permission first).
// First-party only: not on the third-party service list, and not resolved by
// any SDK helper — a module asks its host.
export const WorkspaceGitInfoToken = createServiceToken<{
  read(workspaceId: string): Promise<ModuleWorkspaceGitInfoResult>
}>(WORKSPACE_GIT_INFO_SERVICE_KEY)
// Main's mirror of every module's app-level state (the renderer pushes it),
// read by the module host's `getModuleAppState` / `watchModuleAppState`, each
// scoped to the calling module. First-party only, like the git read above.
export const ModuleAppStateToken = createServiceToken<ModuleAppStateMirror>(MODULE_APP_STATE_SERVICE_KEY)
