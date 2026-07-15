import type { IpcMain } from 'electron'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineMcpReadResult,
  SprintEngineProjectionReadResult,
  SprintEngineRegistryRoleReadInput,
  SprintEngineRegistryRolesReadInput,
  SprintEngineRosterRuntimeInput,
  SprintEngineRunnerSetInput,
  SprintEngineStateInitializeInput,
  SprintEngineTaskCommentInput,
  SprintEngineTaskCreateInput,
  SprintEngineTaskResolveInput,
  SprintEngineTaskStatusSetInput,
  SprintEngineTaskUpdateInput,
} from '../../shared/electron-api'
import type { SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage'

export type SprintEngineArtifactOpenPayload = {
  statePath: string
  artifactPath: string
}

export type SprintEngineArtifactReviewPayload = {
  statePath: string
  artifactId: string
  feedback?: string
}

export type SprintEngineVcsPayload = {
  statePath: string
}

export type SprintEngineProjectionReadPayload = {
  statePath: string
  // When provided, the reader returns an `unchanged` result without reading or
  // parsing the projection file if its current token matches.
  knownToken?: string
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
  initializeSprintEngineState(payload: SprintEngineStateInitializeInput): Promise<SprintEngineArtifactCommandResult>
  updateTask(payload: SprintEngineTaskUpdateInput): Promise<SprintEngineArtifactCommandResult>
  createTask(payload: SprintEngineTaskCreateInput): Promise<SprintEngineArtifactCommandResult>
  commentTask(payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult>
  resolveTaskInput(payload: SprintEngineTaskResolveInput): Promise<SprintEngineArtifactCommandResult>
  setTaskStatus(payload: SprintEngineTaskStatusSetInput): Promise<SprintEngineArtifactCommandResult>
  setRunnerMode(payload: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult>
  createPullRequest(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  refreshPullRequestStatus(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  setRoleRuntime(payload: SprintEngineRosterRuntimeInput): Promise<SprintEngineArtifactCommandResult>
  readProjection(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineProjectionReadResult>
  readRegistryRoles(payload: SprintEngineRegistryRolesReadInput): Promise<SprintEngineMcpReadResult>
  readRegistryRole(payload: SprintEngineRegistryRoleReadInput): Promise<SprintEngineMcpReadResult>
  summarizeFeedback(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineMcpReadResult>
  readTokenUsage(payload: SprintEngineVcsPayload): Promise<SprintEngineTokenUsageReport>
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

  ipcMain.handle('sprintengine:task:resolve-input', async (_, payload: SprintEngineTaskResolveInput): Promise<SprintEngineArtifactCommandResult> => {
    return deps.resolveTaskInput(payload)
  })

  ipcMain.handle('sprintengine:task:set-status', async (_, payload: SprintEngineTaskStatusSetInput): Promise<SprintEngineArtifactCommandResult> => {
    return deps.setTaskStatus(payload)
  })

  // `sprintengine:runner:set-mode` was removed (MC-1567): the renderer no
  // longer writes the cliWatchPolling hint — the main automation service's
  // set-mode path bridges it in-process (`deps.setRunnerMode` is still the
  // in-process seam it and the automations front door use).

  ipcMain.handle('sprintengine:vcs:pr', async (_, payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult> => {
    return deps.createPullRequest(payload)
  })

  ipcMain.handle('sprintengine:vcs:pr-status', async (_, payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult> => {
    return deps.refreshPullRequestStatus(payload)
  })

  ipcMain.handle('sprintengine:roster:runtime', async (_, payload: SprintEngineRosterRuntimeInput): Promise<SprintEngineArtifactCommandResult> => {
    return deps.setRoleRuntime(payload)
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

  ipcMain.handle('sprintengine:feedback:summarize', async (_, payload: SprintEngineProjectionReadPayload): Promise<SprintEngineMcpReadResult> => {
    return deps.summarizeFeedback(payload)
  })

  ipcMain.handle('sprintengine:token-usage:read', async (_, payload: SprintEngineVcsPayload): Promise<SprintEngineTokenUsageReport> => {
    return deps.readTokenUsage(payload)
  })
}
