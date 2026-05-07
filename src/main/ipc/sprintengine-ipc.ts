import type { IpcMain } from 'electron'
import type { SwarmArtifactCommandResult } from '../../shared/electron-api'

export type SwarmArtifactOpenPayload = {
  statePath: string
  artifactPath: string
}

export type SwarmArtifactReviewPayload = {
  statePath: string
  artifactId: string
  feedback?: string
}

export type SwarmTaskReadyPayload = {
  statePath: string
  taskId: string
}

export type SwarmArtifactReviewAction = 'approve' | 'request-changes'
export type SwarmArtifactReviewMode = 'user' | 'auto-run'

type SprintEngineIpcDependencies = {
  openArtifact(payload: SwarmArtifactOpenPayload): Promise<SwarmArtifactCommandResult>
  reviewArtifact(
    payload: SwarmArtifactReviewPayload,
    action: SwarmArtifactReviewAction,
    mode: SwarmArtifactReviewMode
  ): Promise<SwarmArtifactCommandResult>
  readyTask(payload: SwarmTaskReadyPayload): Promise<SwarmArtifactCommandResult>
}

export function registerSprintEngineIpc(ipcMain: IpcMain, deps: SprintEngineIpcDependencies): void {
  ipcMain.handle('sprintengine:artifact:open', async (_, payload: SwarmArtifactOpenPayload): Promise<SwarmArtifactCommandResult> => {
    return deps.openArtifact(payload)
  })

  ipcMain.handle('sprintengine:artifact:approve', async (_, payload: SwarmArtifactReviewPayload): Promise<SwarmArtifactCommandResult> => {
    return deps.reviewArtifact(payload, 'approve', 'user')
  })

  ipcMain.handle('sprintengine:artifact:auto-approve', async (_, payload: SwarmArtifactReviewPayload): Promise<SwarmArtifactCommandResult> => {
    return deps.reviewArtifact(payload, 'approve', 'auto-run')
  })

  ipcMain.handle('sprintengine:artifact:request-changes', async (_, payload: SwarmArtifactReviewPayload): Promise<SwarmArtifactCommandResult> => {
    return deps.reviewArtifact(payload, 'request-changes', 'user')
  })

  ipcMain.handle('sprintengine:task:ready', async (_, payload: SwarmTaskReadyPayload): Promise<SwarmArtifactCommandResult> => {
    return deps.readyTask(payload)
  })
}
