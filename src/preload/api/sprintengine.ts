import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  SwarmArtifactCommandResult,
  SwarmTaskCreateInput,
  SwarmTaskUpdateInput,
} from '../../shared/electron-api'

export const sprintEngineApi = {
  openSwarmArtifact: (
    statePath: string,
    artifactPath: string
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:artifact:open', { statePath, artifactPath }),
  approveSwarmArtifact: (
    statePath: string,
    artifactId: string
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:artifact:approve', { statePath, artifactId }),
  autoApproveSwarmArtifact: (
    statePath: string,
    artifactId: string
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:artifact:auto-approve', { statePath, artifactId }),
  requestSwarmArtifactChanges: (
    statePath: string,
    artifactId: string,
    feedback: string
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:artifact:request-changes', { statePath, artifactId, feedback }),
  readySwarmTask: (
    statePath: string,
    taskId: string
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:task:ready', { statePath, taskId }),
  updateSwarmTask: (
    input: SwarmTaskUpdateInput
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:task:update', input),
  createSwarmTask: (
    input: SwarmTaskCreateInput
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('sprintengine:task:create', input),
} satisfies Pick<
  ElectronApi,
  | 'openSwarmArtifact'
  | 'approveSwarmArtifact'
  | 'autoApproveSwarmArtifact'
  | 'requestSwarmArtifactChanges'
  | 'readySwarmTask'
  | 'updateSwarmTask'
  | 'createSwarmTask'
>
