import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
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

export const switchboardApi = {
  initializeSwitchboard: (workspaceRoot: string): Promise<SwitchboardInitApiResult> =>
    ipcRenderer.invoke('switchboard:init', { workspaceRoot }),
  readSwitchboardTasks: (workspaceRoot: string): Promise<SwitchboardReadResult> =>
    ipcRenderer.invoke('switchboard:read-all', { workspaceRoot }),
  createSwitchboardTask: (input: SwitchboardCreateTaskInput): Promise<SwitchboardMutationResult> =>
    ipcRenderer.invoke('switchboard:create-task', input),
  updateSwitchboardTask: (input: SwitchboardUpdateTaskInput): Promise<SwitchboardMutationResult> =>
    ipcRenderer.invoke('switchboard:update-task', input),
  moveSwitchboardTask: (input: SwitchboardMoveTaskInput): Promise<SwitchboardMutationResult> =>
    ipcRenderer.invoke('switchboard:move-task', input),
  promoteSwitchboardInboxTask: (input: SwitchboardPromoteInboxTaskInput): Promise<SwitchboardMutationResult> =>
    ipcRenderer.invoke('switchboard:promote-inbox-task', input),
  cancelSwitchboardTask: (input: SwitchboardCancelTaskInput): Promise<SwitchboardMutationResult> =>
    ipcRenderer.invoke('switchboard:cancel-task', input),
  addSwitchboardComment: (input: SwitchboardAddCommentInput): Promise<SwitchboardMutationResult> =>
    ipcRenderer.invoke('switchboard:add-comment', input),
  claimSwitchboardTask: (input: SwitchboardClaimTaskInput): Promise<SwitchboardClaimTaskResult> =>
    ipcRenderer.invoke('switchboard:claim-task', input),
  publishSwitchboardTask: (input: SwitchboardPublishTaskInput): Promise<SwitchboardMutationResult> =>
    ipcRenderer.invoke('switchboard:publish-task', input),
  recoverSwitchboardLock: (input: SwitchboardRecoverLockInput): Promise<SwitchboardRecoverLockResult> =>
    ipcRenderer.invoke('switchboard:recover-lock', input),
  requeueSwitchboardTask: (input: SwitchboardRequeueTaskInput): Promise<SwitchboardMutationResult> =>
    ipcRenderer.invoke('switchboard:requeue-task', input),
  startSwitchboardRunner: (input: SwitchboardRunnerStartInput): Promise<SwitchboardRunnerResult> =>
    ipcRenderer.invoke('switchboard:runner:start', input),
  pauseSwitchboardRunner: (workspaceRoot: string): Promise<SwitchboardRunnerResult> =>
    ipcRenderer.invoke('switchboard:runner:pause', workspaceRoot),
  getSwitchboardRunnerState: (workspaceRoot?: string): Promise<SwitchboardRunnerResult> =>
    ipcRenderer.invoke('switchboard:runner:state', workspaceRoot),
} satisfies Pick<
  ElectronApi,
  | 'initializeSwitchboard'
  | 'readSwitchboardTasks'
  | 'createSwitchboardTask'
  | 'updateSwitchboardTask'
  | 'moveSwitchboardTask'
  | 'promoteSwitchboardInboxTask'
  | 'cancelSwitchboardTask'
  | 'addSwitchboardComment'
  | 'claimSwitchboardTask'
  | 'publishSwitchboardTask'
  | 'recoverSwitchboardLock'
  | 'requeueSwitchboardTask'
  | 'startSwitchboardRunner'
  | 'pauseSwitchboardRunner'
  | 'getSwitchboardRunnerState'
>
