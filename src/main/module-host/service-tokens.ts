import type { AppServices } from '../app-services'
import type { AutomationsEngine } from '../automations/engine'
import type { ModuleAutomationsRegistry } from '../automations/module-service'
import type { AutomationProviderRegistryService } from '../automations/provider-registry'
import type { SprintEngineAutomationFrontDoors } from '../automations/actions/sprint-engine'
import type { SwitchboardAutomationFrontDoors } from '../automations/actions/switchboard'
import type { AutomationsAppFrontDoor } from '../ipc/automations-ipc'
import type { RoadmapAppFrontDoor } from '../roadmap-orchestrator'
import type { ModuleWorkspaceService } from '../modules/module-workspace-service'
import type { CompanionAgentService, CompanionAgentsModuleRegistry } from '../companion-agent-service'
import type { ReviewChangeSetService } from '../review/changeset-service'
import type { ReviewGuideTerminalService } from '../review/guide-terminal-service'
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
export const SprintEngineAutomationServiceToken = createServiceToken<AppServices['sprintEngineAutomation']>(
  'core.sprintengine-automation'
)
export const SprintEngineLaunchSettingsToken = createServiceToken<AppServices['sprintEngineLaunchSettings']>(
  'core.sprintengine-launch-settings'
)
export const SprintRuntimeToken = createServiceToken<AppServices['sprintRuntime']>(
  'core.sprint-runtime'
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
// Key mirrors the private token behind the SDK's getAutomationsService helper.
export const AutomationsModuleServiceToken = createServiceToken<ModuleAutomationsRegistry>(
  'automations.module-service'
)
// The IPC-equivalent create/run-now pipeline for app-level (non-module)
// callers — today the automation server's automation.create/automation.run.
export const AutomationsAppFrontDoorToken = createServiceToken<AutomationsAppFrontDoor>(
  'automations.app-front-door'
)
// The instance roadmap's read + plan + steer surface for app-level callers — today
// the automation server's roadmap.* tools. Provided by the automations module (which
// constructs the orchestrator) and resolved lazily, like the Automations front door.
export const RoadmapAppFrontDoorToken = createServiceToken<RoadmapAppFrontDoor>(
  'roadmap.app-front-door'
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
// The app-internal companion-agent service (attach workspace-bound background
// agents). Consumed by first-party surfaces via requireService.
export const CompanionAgentServiceToken = createServiceToken<CompanionAgentService>(
  'core.companion-agent-service'
)
// The moduleId-scoped companion registry with permission enforcement. Key
// mirrors the private token behind the SDK's getCompanionAgentsService helper,
// so a third-party module resolves the instance the app provides here.
export const CompanionAgentsModuleServiceToken = createServiceToken<CompanionAgentsModuleRegistry>(
  'companion-agents.module-service'
)
// The review change-set ingestion service (MC-1676). Provided by the `review`
// capability module so the GitHub PR provider (MC-1678) can register its source
// provider against the same instance.
export const ReviewChangeSetServiceToken = createServiceToken<ReviewChangeSetService>(
  'review.change-set-service'
)
// The review guide's terminal service, provided by the same module. The Studio
// gateway's `review_submit_brief` sink lives in app-services (the tools are
// registered there), and a landed brief ends the run — so it resolves the guide
// through this token to release the terminal, rather than reaching past the
// module into the terminal runtime.
export const ReviewGuideTerminalServiceToken = createServiceToken<ReviewGuideTerminalService>(
  'review.guide-terminal-service'
)
