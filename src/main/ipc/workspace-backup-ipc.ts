import type { IpcMain } from 'electron'
import type {
  WorkspaceBackupPayload,
  WorkspaceBackupReadResult,
  WorkspaceBackupWriteResult,
} from '../../shared/electron-api'

export type WorkspaceBackupBridge = {
  write(payload: WorkspaceBackupPayload): Promise<WorkspaceBackupWriteResult>
  read(): Promise<WorkspaceBackupReadResult>
}

export function registerWorkspaceBackupIpc(ipcMain: IpcMain, backup: WorkspaceBackupBridge): void {
  ipcMain.handle('workspace-backup:write', async (_event, payload: WorkspaceBackupPayload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'invalid_payload' } satisfies WorkspaceBackupWriteResult
    }
    return backup.write(payload)
  })

  ipcMain.handle('workspace-backup:read', () => backup.read())
}
