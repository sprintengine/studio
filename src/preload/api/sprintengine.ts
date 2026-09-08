import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  ElectronApi,
  SprintEngineArtifactCommandResult,
  SprintEngineAutomationChangedEvent,
  SprintEngineAutomationHydrateInput,
  SprintEngineAutomationReadInput,
  SprintEngineAutomationReadResult,
  SprintEngineAutomationSetModeInput,
  SprintEngineAutomationWriteResult,
  SprintEngineCliPermissionPresetSetInput,
  SprintEngineLaunchSettingsWriteAck,
  SprintEngineMcpReadResult,
  SprintEngineProjectionReadResult,
  SprintEngineRegistryRolesReadInput,
  SprintEngineRosterRuntimeInput,
  SprintEngineRosterEnableInput,
  SprintEngineStateInitializeInput,
  SprintEngineTaskCommentInput,
  SprintEngineTaskResolveInput,
  SprintEngineTaskStatusSetInput,
  SprintEngineTaskWorktreeInput,
  SprintEngineTaskWorktreeResult,
} from '../../shared/electron-api'
import type { SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage'
import type { SprintEngineLaunchSettings } from '../../shared/sprintengine/launch-settings'
import {
  SPRINT_RUNTIME_OP_CHANNEL,
  type SprintRuntimeOp,
  type SprintRuntimeRunRegistration,
  type SprintRuntimeStopReasonPush,
} from '../../shared/sprintengine/runtime-bridge'
import {
  SPRINT_RUNS_CHANGED_CHANNEL,
  type SprintRunSummary,
  type SprintRunsChangedEvent,
} from '../../shared/sprintengine/runSummary'
import type { RoleInstallResult } from '../../shared/sprintengine/role-manifest'

export const sprintEngineApi = {
  approveSprintEngineArtifact: (
    statePath: string,
    artifactId: string
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:artifact:approve', { statePath, artifactId }),
  autoApproveSprintEngineArtifact: (
    statePath: string,
    artifactId: string
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:artifact:auto-approve', { statePath, artifactId }),
  requestSprintEngineArtifactChanges: (
    statePath: string,
    artifactId: string,
    feedback: string
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:artifact:request-changes', { statePath, artifactId, feedback }),
  initializeSprintEngineState: (
    input: SprintEngineStateInitializeInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:state:initialize', input),
  commentSprintEngineTask: (
    input: SprintEngineTaskCommentInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:task:comment', input),
  resolveSprintEngineTaskInput: (
    input: SprintEngineTaskResolveInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:task:resolve-input', input),
  setSprintEngineTaskStatus: (
    input: SprintEngineTaskStatusSetInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:task:set-status', input),
  createSprintEnginePullRequest: (
    statePath: string
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:vcs:pr', { statePath }),
  refreshSprintEnginePullRequestStatus: (
    statePath: string
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:vcs:pr-status', { statePath }),
  mergeSprintEnginePullRequest: (
    statePath: string,
    repo?: string
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:vcs:pr-merge', { statePath, repo }),
  ensureSprintEngineTaskWorktree: (
    input: SprintEngineTaskWorktreeInput
  ): Promise<SprintEngineTaskWorktreeResult> =>
    ipcRenderer.invoke('sprintengine:vcs:task-worktree', input),
  setSprintEngineRoleRuntime: (
    input: SprintEngineRosterRuntimeInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:roster:runtime', input),
  enableSprintEngineRole: (
    input: SprintEngineRosterEnableInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:roster:enable', input),
  readSprintEngineProjection: (
    statePath: string,
    knownToken?: string
  ): Promise<SprintEngineProjectionReadResult> =>
    ipcRenderer.invoke('sprintengine:projection:read', { statePath, knownToken }),
  readSprintEngineRegistryRoles: (
    input: SprintEngineRegistryRolesReadInput
  ): Promise<SprintEngineMcpReadResult> =>
    ipcRenderer.invoke('sprintengine:registry:roles:read', input),
  summarizeSprintEngineFeedback: (
    statePath: string
  ): Promise<SprintEngineMcpReadResult> =>
    ipcRenderer.invoke('sprintengine:feedback:summarize', { statePath }),
  readSprintEngineTokenUsage: (
    statePath: string
  ): Promise<SprintEngineTokenUsageReport> =>
    ipcRenderer.invoke('sprintengine:token-usage:read', { statePath }),
  installBundledSpecialistPack: (): Promise<RoleInstallResult> =>
    ipcRenderer.invoke('sprintengine:specialist-pack:install-bundled'),
  readSprintEngineAutomationMode: (
    input: SprintEngineAutomationReadInput
  ): Promise<SprintEngineAutomationReadResult> =>
    ipcRenderer.invoke('sprintengine:automation:read', input),
  setSprintEngineAutomationMode: (
    input: SprintEngineAutomationSetModeInput
  ): Promise<SprintEngineAutomationWriteResult> =>
    ipcRenderer.invoke('sprintengine:automation:set-mode', input),
  hydrateSprintEngineAutomationMode: (
    input: SprintEngineAutomationHydrateInput
  ): Promise<SprintEngineAutomationWriteResult> =>
    ipcRenderer.invoke('sprintengine:automation:hydrate', input),
  setSprintEngineCliPermissionPreset: (
    input: SprintEngineCliPermissionPresetSetInput
  ): Promise<SprintEngineAutomationWriteResult> =>
    ipcRenderer.invoke('sprintengine:automation:set-permission-preset', input),
  onSprintEngineAutomationChanged: (
    cb: (event: SprintEngineAutomationChangedEvent) => void
  ): (() => void) => {
    const ch = 'sprintengine:automation-changed'
    const handler = (_: IpcRendererEvent, event: SprintEngineAutomationChangedEvent) => cb(event)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  syncSprintEngineLaunchSettings: (
    input: SprintEngineLaunchSettings
  ): Promise<SprintEngineLaunchSettingsWriteAck> =>
    ipcRenderer.invoke('sprintengine:launch-settings:sync', input),
  hydrateSprintEngineLaunchSettings: (
    input: SprintEngineLaunchSettings
  ): Promise<SprintEngineLaunchSettingsWriteAck> =>
    ipcRenderer.invoke('sprintengine:launch-settings:hydrate', input),
  registerSprintRuntimeRun: (
    input: SprintRuntimeRunRegistration
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('sprintengine:runtime:register-run', input),
  unregisterSprintRuntimeRun: (
    input: { statePath: string }
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('sprintengine:runtime:unregister-run', input),
  pushSprintRuntimeStopReason: (
    input: SprintRuntimeStopReasonPush
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('sprintengine:runtime:stop-reason', input),
  resumeSprintRuntimeRun: (
    input: { statePath: string }
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('sprintengine:runtime:resume', input),
  cancelSprintEngineRun: (
    input: { statePath: string }
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:run:cancel', input),
  onSprintRuntimeOp: (cb: (op: SprintRuntimeOp) => void): (() => void) => {
    const ch = SPRINT_RUNTIME_OP_CHANNEL
    const handler = (_: IpcRendererEvent, op: SprintRuntimeOp) => cb(op)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  listSprintRuns: (roots: string[]): Promise<SprintRunSummary[]> =>
    ipcRenderer.invoke('sprintengine:runs:list', { roots }),
  onSprintRunsChanged: (cb: (event: SprintRunsChangedEvent) => void): (() => void) => {
    const ch = SPRINT_RUNS_CHANGED_CHANNEL
    const handler = (_: IpcRendererEvent, event: SprintRunsChangedEvent) => cb(event)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'approveSprintEngineArtifact'
  | 'autoApproveSprintEngineArtifact'
  | 'requestSprintEngineArtifactChanges'
  | 'initializeSprintEngineState'
  | 'commentSprintEngineTask'
  | 'resolveSprintEngineTaskInput'
  | 'setSprintEngineTaskStatus'
  | 'readSprintEngineAutomationMode'
  | 'setSprintEngineAutomationMode'
  | 'hydrateSprintEngineAutomationMode'
  | 'setSprintEngineCliPermissionPreset'
  | 'onSprintEngineAutomationChanged'
  | 'syncSprintEngineLaunchSettings'
  | 'hydrateSprintEngineLaunchSettings'
  | 'registerSprintRuntimeRun'
  | 'unregisterSprintRuntimeRun'
  | 'pushSprintRuntimeStopReason'
  | 'resumeSprintRuntimeRun'
  | 'cancelSprintEngineRun'
  | 'onSprintRuntimeOp'
  | 'listSprintRuns'
  | 'onSprintRunsChanged'
  | 'createSprintEnginePullRequest'
  | 'refreshSprintEnginePullRequestStatus'
  | 'mergeSprintEnginePullRequest'
  | 'ensureSprintEngineTaskWorktree'
  | 'setSprintEngineRoleRuntime'
  | 'enableSprintEngineRole'
  | 'readSprintEngineProjection'
  | 'readSprintEngineRegistryRoles'
  | 'summarizeSprintEngineFeedback'
  | 'readSprintEngineTokenUsage'
  | 'installBundledSpecialistPack'
>
