import type { IpcMain } from 'electron'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineDispatchReadInput,
  SprintEngineMcpReadResult,
  SprintEngineProjectionReadResult,
  SprintEngineRegistryRoleReadInput,
  SprintEngineRegistryRolesReadInput,
  SprintEngineRosterReplenishInput,
  SprintEngineRunnerSetInput,
  SprintEngineStateInitializeInput,
  SprintEngineTaskCommentInput,
  SprintEngineTaskCreateInput,
  SprintEngineTaskUpdateInput,
} from '../../shared/electron-api'

export type SprintEngineArtifactOpenPayload = {
  statePath: string
  artifactPath: string
}

export type SprintEngineArtifactReviewPayload = {
  statePath: string
  artifactId: string
  feedback?: string
}

export type SprintEngineTaskReadyPayload = {
  statePath: string
  taskId: string
}

export type SprintEngineProjectionReadPayload = {
  statePath: string
}

export type SprintEngineArtifactReviewAction = 'approve' | 'request-changes'
export type SprintEngineArtifactReviewMode = 'user' | 'auto-run'

type SprintEngineIpcDependencies = {
  openArtifact(payload: SprintEngineArtifactOpenPayload): Promise<SprintEngineArtifactCommandResult>
  reviewArtifact(
    payload: SprintEngineArtifactReviewPayload,
    action: SprintEngineArtifactReviewAction,
    mode: SprintEngineArtifactReviewMode
  ): Promise<SprintEngineArtifactCommandResult>
  readyTask(payload: SprintEngineTaskReadyPayload): Promise<SprintEngineArtifactCommandResult>
  initializeSprintEngineState(payload: SprintEngineStateInitializeInput): Promise<SprintEngineArtifactCommandResult>
  updateTask(payload: SprintEngineTaskUpdateInput): Promise<SprintEngineArtifactCommandResult>
  createTask(payload: SprintEngineTaskCreateInput): Promise<SprintEngineArtifactCommandResult>
  commentTask(payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult>
  setRunnerMode(payload: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult>
  replenishRoster(payload: SprintEngineRosterReplenishInput): Promise<SprintEngineArtifactCommandResult>
  readProjection(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineProjectionReadResult>
  readRegistryRoles(payload: SprintEngineRegistryRolesReadInput): Promise<SprintEngineMcpReadResult>
  readRegistryRole(payload: SprintEngineRegistryRoleReadInput): Promise<SprintEngineMcpReadResult>
  readDispatch(payload: SprintEngineDispatchReadInput): Promise<SprintEngineMcpReadResult>
  summarizeFeedback(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineMcpReadResult>
}

export function registerSprintEngineIpc(ipcMain: IpcMain, deps: SprintEngineIpcDependencies): void {
  ipcMain.handle('sprintengine:artifact:open', async (_, payload: SprintEngineArtifactOpenPayload): Promise<SprintEngineArtifactCommandResult> => {
    return deps.openArtifact(payload)
  })

  ipcMain.handle('sprintengine:artifact:approve', async (_, payload: SprintEngineArtifactReviewPayload): Promise<SprintEngineArtifactCommandResult> => {
    return deps.reviewArtifact(payload, 'approve', 'user')
  })

  ipcMain.handle('sprintengine:artifact:auto-approve', async (_, payload: SprintEngineArtifactReviewPayload): Promise<SprintEngineArtifactCommandResult> => {
    return deps.reviewArtifact(payload, 'approve', 'auto-run')
  })

  ipcMain.handle('sprintengine:artifact:request-changes', async (_, payload: SprintEngineArtifactReviewPayload): Promise<SprintEngineArtifactCommandResult> => {
    return deps.reviewArtifact(payload, 'request-changes', 'user')
  })

  ipcMain.handle('sprintengine:task:ready', async (_, payload: SprintEngineTaskReadyPayload): Promise<SprintEngineArtifactCommandResult> => {
    return deps.readyTask(payload)
  })

  ipcMain.handle('sprintengine:state:initialize', async (_, payload: SprintEngineStateInitializeInput): Promise<SprintEngineArtifactCommandResult> => {
    return deps.initializeSprintEngineState(payload)
  })

  ipcMain.handle('sprintengine:task:update', async (_, payload: SprintEngineTaskUpdateInput): Promise<SprintEngineArtifactCommandResult> => {
    return deps.updateTask(payload)
  })

  ipcMain.handle('sprintengine:task:create', async (_, payload: SprintEngineTaskCreateInput): Promise<SprintEngineArtifactCommandResult> => {
    return deps.createTask(payload)
  })

  ipcMain.handle('sprintengine:task:comment', async (_, payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult> => {
    return deps.commentTask(payload)
  })

  ipcMain.handle('sprintengine:runner:set-mode', async (_, payload: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult> => {
    return deps.setRunnerMode(payload)
  })

  ipcMain.handle('sprintengine:roster:replenish', async (_, payload: SprintEngineRosterReplenishInput): Promise<SprintEngineArtifactCommandResult> => {
    return deps.replenishRoster(payload)
  })

  ipcMain.handle('sprintengine:projection:read', async (_, payload: SprintEngineProjectionReadPayload): Promise<SprintEngineProjectionReadResult> => {
    return deps.readProjection(payload)
  })

  ipcMain.handle('sprintengine:registry:roles:read', async (_, payload: SprintEngineRegistryRolesReadInput): Promise<SprintEngineMcpReadResult> => {
    return deps.readRegistryRoles(payload)
  })

  ipcMain.handle('sprintengine:registry:role:read', async (_, payload: SprintEngineRegistryRoleReadInput): Promise<SprintEngineMcpReadResult> => {
    return deps.readRegistryRole(payload)
  })

  ipcMain.handle('sprintengine:dispatch:read', async (_, payload: SprintEngineDispatchReadInput): Promise<SprintEngineMcpReadResult> => {
    return deps.readDispatch(payload)
  })

  ipcMain.handle('sprintengine:feedback:summarize', async (_, payload: SprintEngineProjectionReadPayload): Promise<SprintEngineMcpReadResult> => {
    return deps.summarizeFeedback(payload)
  })
}
