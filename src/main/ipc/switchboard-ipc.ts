import type { IpcMain, WebContents } from 'electron'
import type {
  SwitchboardAddCommentInput,
  SwitchboardCancelTaskInput,
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardCreateTaskInput,
  SwitchboardInitApiResult,
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
  SwitchboardUpdateTaskInput,
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
  startRunner(sender: WebContents, input: SwitchboardRunnerStartInput): Promise<SwitchboardRunnerResult>
  pauseRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult>
  resumeRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult>
  tickRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult>
  getRunnerState(workspaceRoot?: string): Promise<SwitchboardRunnerResult>
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

  ipcMain.handle('switchboard:runner:start', async (event, input: SwitchboardRunnerStartInput): Promise<SwitchboardRunnerResult> => {
    return deps.startRunner(event.sender, input)
  })

  ipcMain.handle('switchboard:runner:pause', async (_, workspaceRoot: string): Promise<SwitchboardRunnerResult> => {
    return deps.pauseRunner(workspaceRoot)
  })

  ipcMain.handle('switchboard:runner:resume', async (_, workspaceRoot: string): Promise<SwitchboardRunnerResult> => {
    return deps.resumeRunner(workspaceRoot)
  })

  ipcMain.handle('switchboard:runner:tick', async (_, workspaceRoot: string): Promise<SwitchboardRunnerResult> => {
    return deps.tickRunner(workspaceRoot)
  })

  ipcMain.handle('switchboard:runner:state', async (_, workspaceRoot?: string): Promise<SwitchboardRunnerResult> => {
    return deps.getRunnerState(workspaceRoot)
  })
}
