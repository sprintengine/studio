import type { IpcMain } from 'electron'

import type {
  BacklogAddOrUpdateLinkInput,
  BacklogItemRecordInput,
  BacklogModuleMetadataInput,
  BacklogMutationResult,
  BacklogReadResult,
  BacklogRemoveRecordInput,
  BacklogStatusInput,
  BacklogTriageInput,
  BacklogTypeInput,
  BacklogMoveSourceInput,
} from '../../shared/electron-api'
import {
  addOrUpdateBacklogLink,
  ensureBacklogObjectRecords,
  moveBacklogObjectSource,
  readBacklogObjectStore,
  removeBacklogObjectRecord,
  updateBacklogModuleMetadata,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from '../backlog-service'

export function registerBacklogIpc(ipcMain: IpcMain): void {
  ipcMain.handle('backlog:read-object-store', (_event, workspaceRoot: string): Promise<BacklogReadResult> => {
    return readBacklogObjectStore(workspaceRoot)
  })

  ipcMain.handle(
    'backlog:ensure-object-records',
    (_event, workspaceRoot: string, items: BacklogItemRecordInput[]): Promise<BacklogReadResult> => {
      return ensureBacklogObjectRecords(workspaceRoot, items)
    },
  )

  ipcMain.handle('backlog:update-status', (_event, input: BacklogStatusInput): Promise<BacklogMutationResult> => {
    return updateBacklogStatus(input)
  })

  ipcMain.handle('backlog:update-type', (_event, input: BacklogTypeInput): Promise<BacklogMutationResult> => {
    return updateBacklogType(input)
  })

  ipcMain.handle('backlog:update-triage', (_event, input: BacklogTriageInput): Promise<BacklogMutationResult> => {
    return updateBacklogTriage(input)
  })

  ipcMain.handle('backlog:add-or-update-link', (_event, input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult> => {
    return addOrUpdateBacklogLink(input)
  })

  ipcMain.handle('backlog:update-module-metadata', (_event, input: BacklogModuleMetadataInput): Promise<BacklogMutationResult> => {
    return updateBacklogModuleMetadata(input)
  })

  ipcMain.handle('backlog:move-object-source', (_event, input: BacklogMoveSourceInput): Promise<BacklogMutationResult> => {
    return moveBacklogObjectSource(input)
  })

  ipcMain.handle('backlog:remove-object-record', (_event, input: BacklogRemoveRecordInput): Promise<BacklogMutationResult> => {
    return removeBacklogObjectRecord(input)
  })
}
