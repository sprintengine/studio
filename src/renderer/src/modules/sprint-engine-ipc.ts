import type { RendererHost } from './renderer-host'
import type { RoleInstallResult } from '../../../shared/sprintengine/role-manifest'
import type { AgentLaunchSettings } from '../../../shared/sprintengine/launch-settings'
import type { SprintEngineTokenUsageReport } from '../../../shared/sprintengine-token-usage'
import type { SprintRunSummary, SprintRunsChangedEvent } from '../../../shared/sprintengine/runSummary'
import type {
  SprintRuntimeOp,
  SprintRuntimeRunRegistration,
  SprintRuntimeStopReasonPush,
} from '../../../shared/sprintengine/runtime-bridge'
import {
  SPRINT_ENGINE_CHANNELS,
  SPRINT_ENGINE_EVENTS,
} from '../../../shared/sprintengine/ipc-channels'
import {
  SPRINT_ENGINE_MODULE_DISABLED_CODE,
  SPRINT_ENGINE_MODULE_DISABLED_MESSAGE,
  type SprintEngineArtifactCommandResult,
  type SprintEngineAutomationChangedEvent,
  type SprintEngineAutomationHydrateInput,
  type SprintEngineAutomationReadInput,
  type SprintEngineAutomationReadResult,
  type SprintEngineAutomationSetModeInput,
  type SprintEngineAutomationWriteResult,
  type SprintEngineCliPermissionPresetSetInput,
  type AgentLaunchSettingsWriteAck,
  type SprintEngineMcpReadResult,
  type SprintEngineProjectionReadResult,
  type SprintEngineRegistryRolesReadInput,
  type SprintEngineRosterEnableInput,
  type SprintEngineRosterRuntimeInput,
  type SprintEngineStateInitializeInput,
  type SprintEngineTaskCommentInput,
  type SprintEngineTaskResolveInput,
  type SprintEngineTaskStatusSetInput,
  type SprintEngineTaskWorktreeInput,
  type SprintEngineTaskWorktreeResult,
} from '../../../shared/sprintengine/ipc-types'

/**
 * Renderer half of the Sprint Engine module's IPC surface. Bound from
 * `registerRenderer` so a window whose module never loaded (or has been
 * unloaded) gets a named-cause rejection instead of an unhandled error.
 */
export type SprintEngineIpc = {
  approveSprintEngineArtifact: (
    statePath: string,
    artifactId: string
  ) => Promise<SprintEngineArtifactCommandResult>
  autoApproveSprintEngineArtifact: (
    statePath: string,
    artifactId: string
  ) => Promise<SprintEngineArtifactCommandResult>
  requestSprintEngineArtifactChanges: (
    statePath: string,
    artifactId: string,
    feedback: string
  ) => Promise<SprintEngineArtifactCommandResult>
  initializeSprintEngineState: (
    input: SprintEngineStateInitializeInput
  ) => Promise<SprintEngineArtifactCommandResult>
  commentSprintEngineTask: (
    input: SprintEngineTaskCommentInput
  ) => Promise<SprintEngineArtifactCommandResult>
  resolveSprintEngineTaskInput: (
    input: SprintEngineTaskResolveInput
  ) => Promise<SprintEngineArtifactCommandResult>
  setSprintEngineTaskStatus: (
    input: SprintEngineTaskStatusSetInput
  ) => Promise<SprintEngineArtifactCommandResult>
  createSprintEnginePullRequest: (statePath: string) => Promise<SprintEngineArtifactCommandResult>
  refreshSprintEnginePullRequestStatus: (statePath: string) => Promise<SprintEngineArtifactCommandResult>
  mergeSprintEnginePullRequest: (
    statePath: string,
    repo?: string
  ) => Promise<SprintEngineArtifactCommandResult>
  ensureSprintEngineTaskWorktree: (
    input: SprintEngineTaskWorktreeInput
  ) => Promise<SprintEngineTaskWorktreeResult>
  setSprintEngineRoleRuntime: (
    input: SprintEngineRosterRuntimeInput
  ) => Promise<SprintEngineArtifactCommandResult>
  enableSprintEngineRole: (
    input: SprintEngineRosterEnableInput
  ) => Promise<SprintEngineArtifactCommandResult>
  readSprintEngineProjection: (
    statePath: string,
    knownToken?: string
  ) => Promise<SprintEngineProjectionReadResult>
  readSprintEngineRegistryRoles: (
    input: SprintEngineRegistryRolesReadInput
  ) => Promise<SprintEngineMcpReadResult>
  summarizeSprintEngineFeedback: (statePath: string) => Promise<SprintEngineMcpReadResult>
  readSprintEngineTokenUsage: (statePath: string) => Promise<SprintEngineTokenUsageReport>
  installBundledSpecialistPack: () => Promise<RoleInstallResult>
  readSprintEngineAutomationMode: (
    input: SprintEngineAutomationReadInput
  ) => Promise<SprintEngineAutomationReadResult>
  setSprintEngineAutomationMode: (
    input: SprintEngineAutomationSetModeInput
  ) => Promise<SprintEngineAutomationWriteResult>
  hydrateSprintEngineAutomationMode: (
    input: SprintEngineAutomationHydrateInput
  ) => Promise<SprintEngineAutomationWriteResult>
  setSprintEngineCliPermissionPreset: (
    input: SprintEngineCliPermissionPresetSetInput
  ) => Promise<SprintEngineAutomationWriteResult>
  onSprintEngineAutomationChanged: (
    cb: (event: SprintEngineAutomationChangedEvent) => void
  ) => () => void
  syncAgentLaunchSettings: (
    input: AgentLaunchSettings
  ) => Promise<AgentLaunchSettingsWriteAck>
  hydrateAgentLaunchSettings: (
    input: AgentLaunchSettings
  ) => Promise<AgentLaunchSettingsWriteAck>
  registerSprintRuntimeRun: (input: SprintRuntimeRunRegistration) => Promise<{ ok: boolean }>
  unregisterSprintRuntimeRun: (input: { statePath: string }) => Promise<{ ok: boolean }>
  pushSprintRuntimeStopReason: (input: SprintRuntimeStopReasonPush) => Promise<{ ok: boolean }>
  resumeSprintRuntimeRun: (input: { statePath: string }) => Promise<{ ok: boolean }>
  cancelSprintEngineRun: (input: { statePath: string }) => Promise<SprintEngineArtifactCommandResult>
  onSprintRuntimeOp: (cb: (op: SprintRuntimeOp) => void) => () => void
  listSprintRuns: (roots: string[]) => Promise<SprintRunSummary[]>
  onSprintRunsChanged: (cb: (event: SprintRunsChangedEvent) => void) => () => void
}

function moduleDisabled(): never {
  throw Object.assign(new Error(SPRINT_ENGINE_MODULE_DISABLED_MESSAGE), {
    code: SPRINT_ENGINE_MODULE_DISABLED_CODE,
  })
}

function isUnknownChannel(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'unknown_channel')
}

async function invokeOrDisabled<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isUnknownChannel(error)) {
      throw Object.assign(new Error(SPRINT_ENGINE_MODULE_DISABLED_MESSAGE), {
        code: SPRINT_ENGINE_MODULE_DISABLED_CODE,
      })
    }
    throw error
  }
}

export function createHostBackedSprintEngineIpc(host: Pick<RendererHost, 'invoke' | 'subscribe'>): SprintEngineIpc {
  const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
    invokeOrDisabled(() => host.invoke(channel, payload) as Promise<T>)

  return {
    approveSprintEngineArtifact: (statePath, artifactId) =>
      invoke(SPRINT_ENGINE_CHANNELS.artifactApprove, { statePath, artifactId }),
    autoApproveSprintEngineArtifact: (statePath, artifactId) =>
      invoke(SPRINT_ENGINE_CHANNELS.artifactAutoApprove, { statePath, artifactId }),
    requestSprintEngineArtifactChanges: (statePath, artifactId, feedback) =>
      invoke(SPRINT_ENGINE_CHANNELS.artifactRequestChanges, { statePath, artifactId, feedback }),
    initializeSprintEngineState: (input) => invoke(SPRINT_ENGINE_CHANNELS.stateInitialize, input),
    commentSprintEngineTask: (input) => invoke(SPRINT_ENGINE_CHANNELS.taskComment, input),
    resolveSprintEngineTaskInput: (input) => invoke(SPRINT_ENGINE_CHANNELS.taskResolveInput, input),
    setSprintEngineTaskStatus: (input) => invoke(SPRINT_ENGINE_CHANNELS.taskSetStatus, input),
    createSprintEnginePullRequest: (statePath) => invoke(SPRINT_ENGINE_CHANNELS.vcsPr, { statePath }),
    refreshSprintEnginePullRequestStatus: (statePath) =>
      invoke(SPRINT_ENGINE_CHANNELS.vcsPrStatus, { statePath }),
    mergeSprintEnginePullRequest: (statePath, repo) =>
      invoke(SPRINT_ENGINE_CHANNELS.vcsPrMerge, { statePath, repo }),
    ensureSprintEngineTaskWorktree: (input) => invoke(SPRINT_ENGINE_CHANNELS.vcsTaskWorktree, input),
    setSprintEngineRoleRuntime: (input) => invoke(SPRINT_ENGINE_CHANNELS.rosterRuntime, input),
    enableSprintEngineRole: (input) => invoke(SPRINT_ENGINE_CHANNELS.rosterEnable, input),
    readSprintEngineProjection: (statePath, knownToken) =>
      invoke(SPRINT_ENGINE_CHANNELS.projectionRead, { statePath, knownToken }),
    readSprintEngineRegistryRoles: (input) => invoke(SPRINT_ENGINE_CHANNELS.registryRolesRead, input),
    summarizeSprintEngineFeedback: (statePath) =>
      invoke(SPRINT_ENGINE_CHANNELS.feedbackSummarize, { statePath }),
    readSprintEngineTokenUsage: (statePath) => invoke(SPRINT_ENGINE_CHANNELS.tokenUsageRead, { statePath }),
    installBundledSpecialistPack: () => invoke(SPRINT_ENGINE_CHANNELS.specialistPackInstallBundled),
    readSprintEngineAutomationMode: (input) => invoke(SPRINT_ENGINE_CHANNELS.automationRead, input),
    setSprintEngineAutomationMode: (input) => invoke(SPRINT_ENGINE_CHANNELS.automationSetMode, input),
    hydrateSprintEngineAutomationMode: (input) => invoke(SPRINT_ENGINE_CHANNELS.automationHydrate, input),
    setSprintEngineCliPermissionPreset: (input) =>
      invoke(SPRINT_ENGINE_CHANNELS.automationSetPermissionPreset, input),
    onSprintEngineAutomationChanged: (cb) =>
      host.subscribe(SPRINT_ENGINE_EVENTS.automationChanged, (payload) => {
        cb(payload as SprintEngineAutomationChangedEvent)
      }),
    syncAgentLaunchSettings: (input) => invoke(SPRINT_ENGINE_CHANNELS.launchSettingsSync, input),
    hydrateAgentLaunchSettings: (input) =>
      invoke(SPRINT_ENGINE_CHANNELS.launchSettingsHydrate, input),
    registerSprintRuntimeRun: (input) => invoke(SPRINT_ENGINE_CHANNELS.runtimeRegisterRun, input),
    unregisterSprintRuntimeRun: (input) => invoke(SPRINT_ENGINE_CHANNELS.runtimeUnregisterRun, input),
    pushSprintRuntimeStopReason: (input) => invoke(SPRINT_ENGINE_CHANNELS.runtimeStopReason, input),
    resumeSprintRuntimeRun: (input) => invoke(SPRINT_ENGINE_CHANNELS.runtimeResume, input),
    cancelSprintEngineRun: (input) => invoke(SPRINT_ENGINE_CHANNELS.runCancel, input),
    onSprintRuntimeOp: (cb) =>
      host.subscribe(SPRINT_ENGINE_EVENTS.runtimeOp, (payload) => {
        cb(payload as SprintRuntimeOp)
      }),
    listSprintRuns: (roots) => invoke(SPRINT_ENGINE_CHANNELS.runsList, { roots }),
    onSprintRunsChanged: (cb) =>
      host.subscribe(SPRINT_ENGINE_EVENTS.runsChanged, (payload) => {
        cb(payload as SprintRunsChangedEvent)
      }),
  }
}

// Process-wide slot so a test bundle that accidentally materialises this
// module twice (esbuild's seams profile does) still shares one client with
// the board. Production has a single copy; the key is a no-op there.
const BOUND_KEY = '__sprintEngineIpcBound'

function boundSlot(): { current: SprintEngineIpc | null } {
  const bag = globalThis as typeof globalThis & {
    [BOUND_KEY]?: { current: SprintEngineIpc | null }
  }
  bag[BOUND_KEY] ??= { current: null }
  return bag[BOUND_KEY]
}

export function bindSprintEngineIpc(next: SprintEngineIpc | null): void {
  boundSlot().current = next
}

export function isSprintEngineIpcBound(): boolean {
  return boundSlot().current !== null
}

function requireBound(): SprintEngineIpc {
  return boundSlot().current ?? moduleDisabled()
}

export const sprintEngineIpc: SprintEngineIpc = {
  approveSprintEngineArtifact: (...args) => requireBound().approveSprintEngineArtifact(...args),
  autoApproveSprintEngineArtifact: (...args) => requireBound().autoApproveSprintEngineArtifact(...args),
  requestSprintEngineArtifactChanges: (...args) => requireBound().requestSprintEngineArtifactChanges(...args),
  initializeSprintEngineState: (...args) => requireBound().initializeSprintEngineState(...args),
  commentSprintEngineTask: (...args) => requireBound().commentSprintEngineTask(...args),
  resolveSprintEngineTaskInput: (...args) => requireBound().resolveSprintEngineTaskInput(...args),
  setSprintEngineTaskStatus: (...args) => requireBound().setSprintEngineTaskStatus(...args),
  createSprintEnginePullRequest: (...args) => requireBound().createSprintEnginePullRequest(...args),
  refreshSprintEnginePullRequestStatus: (...args) =>
    requireBound().refreshSprintEnginePullRequestStatus(...args),
  mergeSprintEnginePullRequest: (...args) => requireBound().mergeSprintEnginePullRequest(...args),
  ensureSprintEngineTaskWorktree: (...args) => requireBound().ensureSprintEngineTaskWorktree(...args),
  setSprintEngineRoleRuntime: (...args) => requireBound().setSprintEngineRoleRuntime(...args),
  enableSprintEngineRole: (...args) => requireBound().enableSprintEngineRole(...args),
  readSprintEngineProjection: (...args) => requireBound().readSprintEngineProjection(...args),
  readSprintEngineRegistryRoles: (...args) => requireBound().readSprintEngineRegistryRoles(...args),
  summarizeSprintEngineFeedback: (...args) => requireBound().summarizeSprintEngineFeedback(...args),
  readSprintEngineTokenUsage: (...args) => requireBound().readSprintEngineTokenUsage(...args),
  installBundledSpecialistPack: (...args) => requireBound().installBundledSpecialistPack(...args),
  readSprintEngineAutomationMode: (...args) => requireBound().readSprintEngineAutomationMode(...args),
  setSprintEngineAutomationMode: (...args) => requireBound().setSprintEngineAutomationMode(...args),
  hydrateSprintEngineAutomationMode: (...args) => requireBound().hydrateSprintEngineAutomationMode(...args),
  setSprintEngineCliPermissionPreset: (...args) =>
    requireBound().setSprintEngineCliPermissionPreset(...args),
  onSprintEngineAutomationChanged: (...args) =>
    boundSlot().current?.onSprintEngineAutomationChanged(...args) ?? (() => undefined),
  syncAgentLaunchSettings: (...args) => requireBound().syncAgentLaunchSettings(...args),
  hydrateAgentLaunchSettings: (...args) =>
    requireBound().hydrateAgentLaunchSettings(...args),
  registerSprintRuntimeRun: (...args) => requireBound().registerSprintRuntimeRun(...args),
  unregisterSprintRuntimeRun: (...args) => requireBound().unregisterSprintRuntimeRun(...args),
  pushSprintRuntimeStopReason: (...args) => requireBound().pushSprintRuntimeStopReason(...args),
  resumeSprintRuntimeRun: (...args) => requireBound().resumeSprintRuntimeRun(...args),
  cancelSprintEngineRun: (...args) => requireBound().cancelSprintEngineRun(...args),
  onSprintRuntimeOp: (...args) =>
    boundSlot().current?.onSprintRuntimeOp(...args) ?? (() => undefined),
  listSprintRuns: (...args) => requireBound().listSprintRuns(...args),
  onSprintRunsChanged: (...args) =>
    boundSlot().current?.onSprintRunsChanged(...args) ?? (() => undefined),
}
