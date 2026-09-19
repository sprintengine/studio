import type { AppServices } from '../app-services'
import type { AutomationsEngine } from '../automations/engine'
import type { ModuleAutomationsRegistry } from '../automations/module-service'
import type { AutomationProviderRegistryService } from '../automations/provider-registry'
import type { AutomationsAppFrontDoor } from '../ipc/automations-ipc'
import type { ModuleWorkspaceContextService, ModuleWorkspaceService } from '../modules/module-workspace-service'
import type { ModuleStorageRegistry } from './module-storage'
import type { AgentSessionsModuleRegistry } from '../agent-sessions-module-service'
import type { CompanionAgentService, CompanionAgentsModuleRegistry } from '../companion-agent-service'
import { createServiceToken } from './main-host'

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
// Renderer-pushed agent-launch defaults (CLI runtimes, permission preset, MCP
// servers, knowledge root, model catalog) that main-side spawns read.
export const AgentLaunchSettingsToken =
  createServiceToken<AppServices['agentLaunchSettings']>('core.agent-launch-settings')
export const SprintEngineAuthToken = createServiceToken<AppServices['sprintengineAuth']>('core.sprintengine-auth')
// The provider-agnostic entitlement seam. A module that needs to gate
// on a stable feature key resolves THIS and asks `hasFeature`/`refreshFeature`;
// SprintEngineAuthToken above is the account-service adapter behind it, and resolving
// that one to answer an entitlement question re-couples the module to whichever
// provider is current.
export const EntitlementServiceToken = createServiceToken<AppServices['entitlements']>('core.entitlements')
export const WorkspaceSyncServiceToken =
  createServiceToken<AppServices['workspaceSyncService']>('core.workspace-sync-service')
// The authoritative workspace registry. Modules that need to READ the
// durable record — the phone's scope resolver, a workspace-scoped surface —
// resolve this rather than reaching for the bus, which only carries events.
// Creation still goes through WorkspaceServiceToken below, which writes here.
export const WorkspaceRegistryToken = createServiceToken<AppServices['workspaceRegistry']>('core.workspace-registry')
export const AutomationsEngineToken = createServiceToken<AutomationsEngine>('automations.engine')
// Key mirrors the private service token used by module-sdk's Automations helpers.
export const AutomationsProviderRegistryToken = createServiceToken<AutomationProviderRegistryService>(
  'automations.provider-registry',
)
// Key mirrors the private token behind the SDK's getAutomationsService helper.
export const AutomationsModuleServiceToken = createServiceToken<ModuleAutomationsRegistry>('automations.module-service')
// The IPC-equivalent create/run-now pipeline for app-level (non-module)
// callers — today the automation server's automation.create/automation.run.
export const AutomationsAppFrontDoorToken = createServiceToken<AutomationsAppFrontDoor>('automations.app-front-door')
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
// The moduleId-scoped agent-sessions registry: terminal agents a module spawns,
// prompts, stops and lists under its own agent-id namespaces (D5). Key mirrors
// the private token behind the SDK's getAgentSessionService helper, and every
// method on it checks the module's `agents:session` permission.
export const AgentSessionsModuleServiceToken = createServiceToken<AgentSessionsModuleRegistry>(
  'agent-sessions.module-service',
)
