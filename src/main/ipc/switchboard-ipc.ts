import type { IpcMain } from 'electron'
import type {
  SwitchboardAddCommentInput,
  SwitchboardCancelTaskInput,
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardCreateTaskInput,
  SwitchboardExecutionLogsInput,
  SwitchboardExecutionLogsResult,
  SwitchboardExecutionStatusInput,
  SwitchboardExecutionStatusResult,
  SwitchboardInitApiResult,
  SwitchboardImportResult,
  SwitchboardMoveTaskInput,
  SwitchboardMutationResult,
  SwitchboardPromoteInboxTaskInput,
  SwitchboardPublishTaskInput,
  SwitchboardReadResult,
  SwitchboardRecoverLockInput,
  SwitchboardRecoverLockResult,
  SwitchboardRequeueTaskInput,
  SwitchboardRunnerResult,
  SwitchboardRunnerStartInput,
  SwitchboardRunnerWorkspaceInput,
  SwitchboardStopExecutionInput,
  SwitchboardStopExecutionResult,
  SwitchboardUpdateTaskInput,
  WatchtowerRunListResult,
  WatchtowerRunResult,
  WatchtowerStartReviewInput,
  WatchtowerStartTriageInput,
} from '../../shared/switchboard'

type SwitchboardIpcDependencies = {
  initialize(input: { workspaceRoot: string }): Promise<SwitchboardInitApiResult>
  readAll(input: { workspaceRoot: string }): Promise<SwitchboardReadResult>
  createTask(input: SwitchboardCreateTaskInput): Promise<SwitchboardMutationResult>
  updateTask(input: SwitchboardUpdateTaskInput): Promise<SwitchboardMutationResult>
  moveTask(input: SwitchboardMoveTaskInput): Promise<SwitchboardMutationResult>
  promoteInboxTask(input: SwitchboardPromoteInboxTaskInput): Promise<SwitchboardMutationResult>
  cancelTask(input: SwitchboardCancelTaskInput): Promise<SwitchboardMutationResult>
  addComment(input: SwitchboardAddCommentInput): Promise<SwitchboardMutationResult>
  claimTask(input: SwitchboardClaimTaskInput): Promise<SwitchboardClaimTaskResult>
  publishTask(input: SwitchboardPublishTaskInput): Promise<SwitchboardMutationResult>
  recoverLock(input: SwitchboardRecoverLockInput): Promise<SwitchboardRecoverLockResult>
  requeueTask(input: SwitchboardRequeueTaskInput): Promise<SwitchboardMutationResult>
  startRunner(input: SwitchboardRunnerStartInput): Promise<SwitchboardRunnerResult>
  pauseRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult>
  resumeRunner(input: SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult>
  stopRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult>
  tickRunner(input: SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult>
  getRunnerState(input?: string | SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult>
  stopExecution(input: SwitchboardStopExecutionInput): Promise<SwitchboardStopExecutionResult>
  getExecutionStatus(input: SwitchboardExecutionStatusInput): Promise<SwitchboardExecutionStatusResult>
  getExecutionLogs(input: SwitchboardExecutionLogsInput): Promise<SwitchboardExecutionLogsResult>
  startWatchtowerReview(input: WatchtowerStartReviewInput): Promise<WatchtowerRunResult>
  startWatchtowerTriage(input: WatchtowerStartTriageInput): Promise<WatchtowerRunResult>
  getWatchtowerRun(input: { workspaceRoot: string; runId: string }): Promise<WatchtowerRunResult>
  listWatchtowerRuns(workspaceRoot: string): Promise<WatchtowerRunListResult>
  importGitHubIssues(workspaceRoot: string): Promise<SwitchboardImportResult>
  importJiraIssues(workspaceRoot: string): Promise<SwitchboardImportResult>
}

export function registerSwitchboardIpc(ipcMain: IpcMain, deps: SwitchboardIpcDependencies): void {
  ipcMain.handle('switchboard:init', async (_, input: { workspaceRoot: string }): Promise<SwitchboardInitApiResult> => {
    return deps.initialize(input)
  })

  ipcMain.handle('switchboard:read-all', async (_, input: { workspaceRoot: string }): Promise<SwitchboardReadResult> => {
    return deps.readAll(input)
  })

  ipcMain.handle('switchboard:create-task', async (_, input: SwitchboardCreateTaskInput): Promise<SwitchboardMutationResult> => {
    return deps.createTask(input)
  })

  ipcMain.handle('switchboard:update-task', async (_, input: SwitchboardUpdateTaskInput): Promise<SwitchboardMutationResult> => {
    return deps.updateTask(input)
  })

  ipcMain.handle('switchboard:move-task', async (_, input: SwitchboardMoveTaskInput): Promise<SwitchboardMutationResult> => {
    return deps.moveTask(input)
  })

  ipcMain.handle(
    'switchboard:promote-inbox-task',
    async (_, input: SwitchboardPromoteInboxTaskInput): Promise<SwitchboardMutationResult> => {
      return deps.promoteInboxTask(input)
    }
  )

  ipcMain.handle('switchboard:cancel-task', async (_, input: SwitchboardCancelTaskInput): Promise<SwitchboardMutationResult> => {
    return deps.cancelTask(input)
  })

  ipcMain.handle('switchboard:add-comment', async (_, input: SwitchboardAddCommentInput): Promise<SwitchboardMutationResult> => {
    return deps.addComment(input)
  })

  ipcMain.handle('switchboard:claim-task', async (_, input: SwitchboardClaimTaskInput): Promise<SwitchboardClaimTaskResult> => {
    return deps.claimTask(input)
  })

  ipcMain.handle('switchboard:publish-task', async (_, input: SwitchboardPublishTaskInput): Promise<SwitchboardMutationResult> => {
    return deps.publishTask(input)
  })

  ipcMain.handle('switchboard:recover-lock', async (_, input: SwitchboardRecoverLockInput): Promise<SwitchboardRecoverLockResult> => {
    return deps.recoverLock(input)
  })

  ipcMain.handle('switchboard:requeue-task', async (_, input: SwitchboardRequeueTaskInput): Promise<SwitchboardMutationResult> => {
    return deps.requeueTask(input)
  })

  ipcMain.handle('switchboard:runner:start', async (_, input: SwitchboardRunnerStartInput): Promise<SwitchboardRunnerResult> => {
    return deps.startRunner(input)
  })

  ipcMain.handle('switchboard:runner:pause', async (_, workspaceRoot: string): Promise<SwitchboardRunnerResult> => {
    return deps.pauseRunner(workspaceRoot)
  })

  ipcMain.handle('switchboard:runner:resume', async (_, input: SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult> => {
    return deps.resumeRunner(input)
  })

  ipcMain.handle('switchboard:runner:stop', async (_, workspaceRoot: string): Promise<SwitchboardRunnerResult> => {
    return deps.stopRunner(workspaceRoot)
  })

  ipcMain.handle('switchboard:runner:tick', async (_, input: SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult> => {
    return deps.tickRunner(input)
  })

  ipcMain.handle('switchboard:runner:state', async (_, input?: string | SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult> => {
    return deps.getRunnerState(input)
  })

  ipcMain.handle('switchboard:execution:stop', async (_, input: SwitchboardStopExecutionInput): Promise<SwitchboardStopExecutionResult> => {
    return deps.stopExecution(input)
  })

  ipcMain.handle(
    'switchboard:execution:status',
    async (_, input: SwitchboardExecutionStatusInput): Promise<SwitchboardExecutionStatusResult> => {
      return deps.getExecutionStatus(input)
    },
  )

  ipcMain.handle(
    'switchboard:execution:logs',
    async (_, input: SwitchboardExecutionLogsInput): Promise<SwitchboardExecutionLogsResult> => {
      return deps.getExecutionLogs(input)
    },
  )

  ipcMain.handle('switchboard:watchtower:start-review', async (_, input: WatchtowerStartReviewInput): Promise<WatchtowerRunResult> => {
    return deps.startWatchtowerReview(input)
  })

  ipcMain.handle('switchboard:watchtower:start-triage', async (_, input: WatchtowerStartTriageInput): Promise<WatchtowerRunResult> => {
    return deps.startWatchtowerTriage(input)
  })

  ipcMain.handle(
    'switchboard:watchtower:get-run',
    async (_, input: { workspaceRoot: string; runId: string }): Promise<WatchtowerRunResult> => {
      return deps.getWatchtowerRun(input)
    }
  )

  ipcMain.handle('switchboard:watchtower:list-runs', async (_, workspaceRoot: string): Promise<WatchtowerRunListResult> => {
    return deps.listWatchtowerRuns(workspaceRoot)
  })

  ipcMain.handle('switchboard:import:github-issues', async (_, workspaceRoot: string): Promise<SwitchboardImportResult> => {
    return deps.importGitHubIssues(workspaceRoot)
  })

  ipcMain.handle('switchboard:import:jira-issues', async (_, workspaceRoot: string): Promise<SwitchboardImportResult> => {
    return deps.importJiraIssues(workspaceRoot)
  })
}
