import type { AppServices } from '../app-services'
import { createServiceToken } from '../module-host/main-host'

// Sprint Engine module-owned service tokens. Provisioned from
// `createSprintEngineModule`; other modules resolve them via
// `host.requireService`. Re-exported from `service-tokens.ts` so existing
// consumers keep compiling without retargeting every import.

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
export const SprintPullRequestMergePollerToken = createServiceToken<AppServices['sprintPullRequestMergePoller']>(
  'core.sprint-pull-request-merge-poller'
)
export const SprintEngineMcpHubToken = createServiceToken<AppServices['sprintEngineMcpHub']>(
  'core.sprintengine-mcp-hub'
)
// Sprint creation in main (MC-2160): the automations module's `sprint-engine-start`
// action creates runs through it, so it needs no window.
export const SprintCreateServiceToken = createServiceToken<AppServices['sprintCreateService']>(
  'core.sprint-create-service'
)
