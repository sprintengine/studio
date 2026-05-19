import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  WorkspaceBackupPayload,
  WorkspaceBackupReadResult,
  WorkspaceBackupWriteResult,
} from '../../shared/electron-api'

export const workspaceBackupApi = {
  workspaceBackupWrite: (payload: WorkspaceBackupPayload): Promise<WorkspaceBackupWriteResult> =>
    ipcRenderer.invoke('workspace-backup:write', payload),
  workspaceBackupRead: (): Promise<WorkspaceBackupReadResult> =>
    ipcRenderer.invoke('workspace-backup:read'),
} satisfies Pick<ElectronApi, 'workspaceBackupWrite' | 'workspaceBackupRead'>
