import type { IpcMain } from 'electron'

import type {
  BacklogAddOrUpdateLinkInput,
  BacklogCreateEpicInput,
  BacklogCreateEpicResult,
  BacklogEnsureIdsInput,
  BacklogEnsureIdsResult,
  BacklogEpicColorInput,
  BacklogDependenciesInput,
  BacklogEpicInput,
  BacklogHighlightInput,
  BacklogItemRecordInput,
  BacklogModuleMetadataInput,
  BacklogMutationResult,
  BacklogReadResult,
  BacklogRemoveRecordInput,
  BacklogStatusInput,
  BacklogTriageInput,
  BacklogTypeInput,
  BacklogMoveSourceInput,
  BacklogWorkspaceKeyResult,
} from '../../shared/electron-api'
import {
  addOrUpdateBacklogLink,
  createBacklogEpic,
  ensureBacklogItemIds,
  ensureBacklogObjectRecords,
  moveBacklogObjectSource,
  readBacklogObjectStore,
  readBacklogWorkspaceKey,
  removeBacklogObjectRecord,
  updateBacklogDependencies,
  updateBacklogEpic,
  updateBacklogEpicColor,
  updateBacklogHighlight,
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

  ipcMain.handle('backlog:ensure-item-ids', (_event, input: BacklogEnsureIdsInput): Promise<BacklogEnsureIdsResult> => {
    return ensureBacklogItemIds(input)
  })

  ipcMain.handle('backlog:read-workspace-key', (_event, workspaceRoot: string): Promise<BacklogWorkspaceKeyResult> => {
    return readBacklogWorkspaceKey(workspaceRoot)
  })

  ipcMain.handle('backlog:update-status', (_event, input: BacklogStatusInput): Promise<BacklogMutationResult> => {
    return updateBacklogStatus(input)
  })

  ipcMain.handle('backlog:update-type', (_event, input: BacklogTypeInput): Promise<BacklogMutationResult> => {
    return updateBacklogType(input)
  })

  ipcMain.handle('backlog:update-triage', (_event, input: BacklogTriageInput): Promise<BacklogMutationResult> => {
    return updateBacklogTriage(input)
  })

  ipcMain.handle('backlog:update-highlight', (_event, input: BacklogHighlightInput): Promise<BacklogMutationResult> => {
    return updateBacklogHighlight(input)
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

  ipcMain.handle('backlog:update-epic', (_event, input: BacklogEpicInput): Promise<BacklogMutationResult> => {
    return updateBacklogEpic(input)
  })

  ipcMain.handle('backlog:update-epic-color', (_event, input: BacklogEpicColorInput): Promise<BacklogMutationResult> => {
    return updateBacklogEpicColor(input)
  })

  ipcMain.handle('backlog:update-dependencies', (_event, input: BacklogDependenciesInput): Promise<BacklogMutationResult> => {
    return updateBacklogDependencies(input)
  })

  ipcMain.handle('backlog:create-epic', (_event, input: BacklogCreateEpicInput): Promise<BacklogCreateEpicResult> => {
    return createBacklogEpic(input)
  })
}
