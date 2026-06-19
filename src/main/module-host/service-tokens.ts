import type { AppServices } from '../app-services'
import type { AutomationsEngine } from '../automations/engine'
import type { AutomationProviderRegistryService } from '../automations/provider-registry'
import type { SprintEngineAutomationFrontDoors } from '../automations/actions/sprint-engine'
import type { SwitchboardAutomationFrontDoors } from '../automations/actions/switchboard'
import type { ModuleWorkspaceService } from '../modules/module-workspace-service'
import { createServiceToken } from './main-host'

// Tokens for the shared services that capability modules consume across module
// boundaries (instead of importing the concrete instances). index.ts seeds the
// kernel with the live AppServices instances via loadMainModules' provideServices
// hook; modules call host.requireService(<token>).
export const TerminalRuntimeToken = createServiceToken<AppServices['terminalRuntime']>(
  'core.terminal-runtime'
)
export const GitHubTokenStoreToken = createServiceToken<AppServices['githubTokenStore']>(
  'core.github-token-store'
)
export const SprintEngineArtifactsToken = createServiceToken<AppServices['sprintEngineArtifacts']>(
  'core.sprintengine-artifacts'
)
export const MulticodeAuthToken = createServiceToken<AppServices['multicodeAuth']>(
  'core.multicode-auth'
)
export const SprintEngineMcpHubToken = createServiceToken<AppServices['sprintEngineMcpHub']>(
  'core.sprintengine-mcp-hub'
)
export const AutomationDelegateToken = createServiceToken<AppServices['automationDelegate']>(
  'core.automation-delegate'
)
export const WorkspaceSyncServiceToken = createServiceToken<AppServices['workspaceSyncService']>(
  'core.workspace-sync-service'
)
export const AutomationsEngineToken = createServiceToken<AutomationsEngine>(
  'automations.engine'
)
// Key mirrors the private service token used by module-sdk's Automations helpers.
export const AutomationsProviderRegistryToken = createServiceToken<AutomationProviderRegistryService>(
  'automations.provider-registry'
)
export const SwitchboardAutomationFrontDoorsToken = createServiceToken<SwitchboardAutomationFrontDoors>(
  'switchboard.automation-front-doors'
)
export const SprintEngineAutomationFrontDoorsToken = createServiceToken<SprintEngineAutomationFrontDoors>(
  'sprint-engine.automation-front-doors'
)
// Programmatic workspace creation for capability modules. The key MUST equal the
// SDK's WorkspaceServiceToken ('core.workspace') so a module that imports the
// token from @multicode/module-sdk resolves the instance the app provides here.
export const WorkspaceServiceToken = createServiceToken<ModuleWorkspaceService>('core.workspace')
