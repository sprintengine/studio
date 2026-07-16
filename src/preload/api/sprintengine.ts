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
  SprintEngineMcpReadResult,
  SprintEngineProjectionReadResult,
  SprintEngineRegistryRoleReadInput,
  SprintEngineRegistryRolesReadInput,
  SprintEngineRosterRuntimeInput,
  SprintEngineStateInitializeInput,
  SprintEngineTaskCommentInput,
  SprintEngineTaskCreateInput,
  SprintEngineTaskResolveInput,
  SprintEngineTaskStatusSetInput,
  SprintEngineTaskUpdateInput,
} from '../../shared/electron-api'
import type { SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage'
import type { SprintEngineLaunchSettings } from '../../shared/sprintengine/launch-settings'
import {
  SPRINT_RUNTIME_OP_CHANNEL,
  type SprintRuntimeOp,
  type SprintRuntimeRunRegistration,
  type SprintRuntimeStopReasonPush,
} from '../../shared/sprintengine/runtime-bridge'
import type {
  UserRoleDeleteResult,
  UserRoleGetResult,
  UserRoleSaveInput,
  UserRoleSaveResult,
} from '../../shared/sprintengine/role-manifest'

export const sprintEngineApi = {
  openSprintEngineArtifact: (
    statePath: string,
    artifactPath: string
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:artifact:open', { statePath, artifactPath }),
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
  updateSprintEngineTask: (
    input: SprintEngineTaskUpdateInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:task:update', input),
  createSprintEngineTask: (
    input: SprintEngineTaskCreateInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:task:create', input),
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
  setSprintEngineRoleRuntime: (
    input: SprintEngineRosterRuntimeInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:roster:runtime', input),
  readSprintEngineProjection: (
    statePath: string,
    knownToken?: string
  ): Promise<SprintEngineProjectionReadResult> =>
    ipcRenderer.invoke('sprintengine:projection:read', { statePath, knownToken }),
  readSprintEngineRegistryRoles: (
    input: SprintEngineRegistryRolesReadInput
  ): Promise<SprintEngineMcpReadResult> =>
    ipcRenderer.invoke('sprintengine:registry:roles:read', input),
  readSprintEngineRegistryRole: (
    input: SprintEngineRegistryRoleReadInput
  ): Promise<SprintEngineMcpReadResult> =>
    ipcRenderer.invoke('sprintengine:registry:role:read', input),
  summarizeSprintEngineFeedback: (
    statePath: string
  ): Promise<SprintEngineMcpReadResult> =>
    ipcRenderer.invoke('sprintengine:feedback:summarize', { statePath }),
  readSprintEngineTokenUsage: (
    statePath: string
  ): Promise<SprintEngineTokenUsageReport> =>
    ipcRenderer.invoke('sprintengine:token-usage:read', { statePath }),
  installUserSprintEngineRoleFolder: (srcDir: string) =>
    ipcRenderer.invoke('sprintengine:user-roles:install-folder', srcDir),
  listUserSprintEngineRoles: () => ipcRenderer.invoke('sprintengine:user-roles:list'),
  saveUserSprintEngineRole: (input: UserRoleSaveInput): Promise<UserRoleSaveResult> =>
    ipcRenderer.invoke('sprintengine:user-roles:save', input),
  deleteUserSprintEngineRole: (id: string): Promise<UserRoleDeleteResult> =>
    ipcRenderer.invoke('sprintengine:user-roles:delete', id),
  getUserSprintEngineRole: (id: string): Promise<UserRoleGetResult> =>
    ipcRenderer.invoke('sprintengine:user-roles:get', id),
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
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('sprintengine:launch-settings:sync', input),
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
} satisfies Pick<
  ElectronApi,
  | 'openSprintEngineArtifact'
  | 'approveSprintEngineArtifact'
  | 'autoApproveSprintEngineArtifact'
  | 'requestSprintEngineArtifactChanges'
  | 'initializeSprintEngineState'
  | 'updateSprintEngineTask'
  | 'createSprintEngineTask'
  | 'commentSprintEngineTask'
  | 'resolveSprintEngineTaskInput'
  | 'setSprintEngineTaskStatus'
  | 'readSprintEngineAutomationMode'
  | 'setSprintEngineAutomationMode'
  | 'hydrateSprintEngineAutomationMode'
  | 'onSprintEngineAutomationChanged'
  | 'syncSprintEngineLaunchSettings'
  | 'registerSprintRuntimeRun'
  | 'unregisterSprintRuntimeRun'
  | 'pushSprintRuntimeStopReason'
  | 'resumeSprintRuntimeRun'
  | 'cancelSprintEngineRun'
  | 'onSprintRuntimeOp'
  | 'createSprintEnginePullRequest'
  | 'refreshSprintEnginePullRequestStatus'
  | 'setSprintEngineRoleRuntime'
  | 'readSprintEngineProjection'
  | 'readSprintEngineRegistryRoles'
  | 'readSprintEngineRegistryRole'
  | 'summarizeSprintEngineFeedback'
  | 'readSprintEngineTokenUsage'
  | 'installUserSprintEngineRoleFolder'
  | 'listUserSprintEngineRoles'
  | 'saveUserSprintEngineRole'
  | 'deleteUserSprintEngineRole'
  | 'getUserSprintEngineRole'
>
