/**
 * Sprint Engine module IPC channels and emit topics.
 *
 * Channel names are `<moduleId>:`-prefixed so `MainHost.registerIpc` ownership
 * tracking and `RendererHost.invoke` agree. Emit topics are module-scoped
 * (no prefix): the kernel stamps `sourceModuleId` on the envelope.
 */
export const SPRINT_ENGINE_MODULE_ID = 'sprint-engine'

export const SPRINT_ENGINE_CHANNELS = {
  artifactApprove: 'sprint-engine:artifact:approve',
  artifactAutoApprove: 'sprint-engine:artifact:auto-approve',
  artifactRequestChanges: 'sprint-engine:artifact:request-changes',
  stateInitialize: 'sprint-engine:state:initialize',
  taskComment: 'sprint-engine:task:comment',
  taskResolveInput: 'sprint-engine:task:resolve-input',
  taskSetStatus: 'sprint-engine:task:set-status',
  runCancel: 'sprint-engine:run:cancel',
  vcsPr: 'sprint-engine:vcs:pr',
  vcsPrStatus: 'sprint-engine:vcs:pr-status',
  vcsPrMerge: 'sprint-engine:vcs:pr-merge',
  vcsTaskWorktree: 'sprint-engine:vcs:task-worktree',
  rosterRuntime: 'sprint-engine:roster:runtime',
  rosterEnable: 'sprint-engine:roster:enable',
  projectionRead: 'sprint-engine:projection:read',
  registryRolesRead: 'sprint-engine:registry:roles:read',
  feedbackSummarize: 'sprint-engine:feedback:summarize',
  tokenUsageRead: 'sprint-engine:token-usage:read',
  runsList: 'sprint-engine:runs:list',
  automationRead: 'sprint-engine:automation:read',
  automationSetMode: 'sprint-engine:automation:set-mode',
  automationHydrate: 'sprint-engine:automation:hydrate',
  automationSetPermissionPreset: 'sprint-engine:automation:set-permission-preset',
  launchSettingsSync: 'sprint-engine:launch-settings:sync',
  launchSettingsHydrate: 'sprint-engine:launch-settings:hydrate',
  runtimeRegisterRun: 'sprint-engine:runtime:register-run',
  runtimeUnregisterRun: 'sprint-engine:runtime:unregister-run',
  runtimeStopReason: 'sprint-engine:runtime:stop-reason',
  runtimeResume: 'sprint-engine:runtime:resume',
  specialistPackInstallBundled: 'sprint-engine:specialist-pack:install-bundled',
} as const

export type SprintEngineChannel = (typeof SPRINT_ENGINE_CHANNELS)[keyof typeof SPRINT_ENGINE_CHANNELS]

export const SPRINT_ENGINE_EVENTS = {
  automationChanged: 'automation-changed',
  runtimeOp: 'runtime-op',
  runsChanged: 'runs-changed',
} as const

export type SprintEngineEventTopic = (typeof SPRINT_ENGINE_EVENTS)[keyof typeof SPRINT_ENGINE_EVENTS]
