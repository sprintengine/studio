import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  SprintEngineArtifactCommandResult,
  SprintEngineProjectionReadResult,
  SprintEngineStateInitializeInput,
  SprintEngineRunnerSetInput,
  SprintEngineTaskCommentInput,
  SprintEngineTaskCreateInput,
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
  setSprintEngineRunnerMode: (
    input: SprintEngineRunnerSetInput
  ): Promise<SprintEngineArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:runner:set-mode', input),
  readSprintEngineProjection: (
    statePath: string
  ): Promise<SprintEngineProjectionReadResult> =>
    ipcRenderer.invoke('sprintengine:projection:read', { statePath }),
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
  | 'setSprintEngineRunnerMode'
  | 'readSprintEngineProjection'
>
