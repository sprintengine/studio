import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  SprintEngineArtifactCommandResult,
  SprintEngineDispatchReadInput,
  SprintEngineMcpReadResult,
  SprintEngineProjectionReadResult,
  SprintEngineRegistryRoleReadInput,
  SprintEngineRegistryRolesReadInput,
  SprintEngineRosterAddInput,
  SprintEngineRosterReplenishInput,
  SprintEngineStateInitializeInput,
  SprintEngineRunnerSetInput,
  SprintEngineTaskCommentInput,
  SprintEngineTaskCreateInput,
  SprintEngineTaskResolveInput,
  SprintEngineTaskStatusSetInput,
  SprintEngineTaskUpdateInput,
} from '../../shared/electron-api'

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
  readySprintEngineTask: (
    statePath: string,
    taskId: string
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:task:ready', { statePath, taskId }),
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
  setSprintEngineRunnerMode: (
    input: SprintEngineRunnerSetInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:runner:set-mode', input),
  replenishSprintEngineRoster: (
    input: SprintEngineRosterReplenishInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:roster:replenish', input),
  addSprintEngineRosterMember: (
    input: SprintEngineRosterAddInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:roster:add', input),
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
  readSprintEngineDispatch: (
    input: SprintEngineDispatchReadInput
  ): Promise<SprintEngineMcpReadResult> =>
    ipcRenderer.invoke('sprintengine:dispatch:read', input),
  summarizeSprintEngineFeedback: (
    statePath: string
  ): Promise<SprintEngineMcpReadResult> =>
    ipcRenderer.invoke('sprintengine:feedback:summarize', { statePath }),
  installUserSprintEngineRoleFolder: (srcDir: string) =>
    ipcRenderer.invoke('sprintengine:user-roles:install-folder', srcDir),
  listUserSprintEngineRoles: () => ipcRenderer.invoke('sprintengine:user-roles:list'),
} satisfies Pick<
  ElectronApi,
  | 'openSprintEngineArtifact'
  | 'approveSprintEngineArtifact'
  | 'autoApproveSprintEngineArtifact'
  | 'requestSprintEngineArtifactChanges'
  | 'readySprintEngineTask'
  | 'initializeSprintEngineState'
  | 'updateSprintEngineTask'
  | 'createSprintEngineTask'
  | 'commentSprintEngineTask'
  | 'resolveSprintEngineTaskInput'
  | 'setSprintEngineTaskStatus'
  | 'setSprintEngineRunnerMode'
  | 'replenishSprintEngineRoster'
  | 'addSprintEngineRosterMember'
  | 'readSprintEngineProjection'
  | 'readSprintEngineRegistryRoles'
  | 'readSprintEngineRegistryRole'
  | 'readSprintEngineDispatch'
  | 'summarizeSprintEngineFeedback'
  | 'installUserSprintEngineRoleFolder'
  | 'listUserSprintEngineRoles'
>
