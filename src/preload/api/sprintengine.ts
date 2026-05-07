import { ipcRenderer } from 'electron'
import type { ElectronApi, SwarmArtifactCommandResult } from '../../shared/electron-api'

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
} satisfies Pick<
  ElectronApi,
  'openSwarmArtifact' | 'approveSwarmArtifact' | 'autoApproveSwarmArtifact' | 'requestSwarmArtifactChanges'
>
