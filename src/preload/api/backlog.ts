import { ipcRenderer } from 'electron'
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
  ElectronApi,
} from '../../shared/electron-api'

export const backlogApi = {
  readBacklogObjectStore: (workspaceRoot: string): Promise<BacklogReadResult> =>
    ipcRenderer.invoke('backlog:read-object-store', workspaceRoot),
  ensureBacklogObjectRecords: (workspaceRoot: string, items: BacklogItemRecordInput[]): Promise<BacklogReadResult> =>
    ipcRenderer.invoke('backlog:ensure-object-records', workspaceRoot, items),
  updateBacklogStatus: (input: BacklogStatusInput): Promise<BacklogMutationResult> =>
    ipcRenderer.invoke('backlog:update-status', input),
  updateBacklogType: (input: BacklogTypeInput): Promise<BacklogMutationResult> =>
    ipcRenderer.invoke('backlog:update-type', input),
  updateBacklogTriage: (input: BacklogTriageInput): Promise<BacklogMutationResult> =>
    ipcRenderer.invoke('backlog:update-triage', input),
  addOrUpdateBacklogLink: (input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult> =>
    ipcRenderer.invoke('backlog:add-or-update-link', input),
  updateBacklogModuleMetadata: (input: BacklogModuleMetadataInput): Promise<BacklogMutationResult> =>
    ipcRenderer.invoke('backlog:update-module-metadata', input),
  moveBacklogObjectSource: (input: BacklogMoveSourceInput): Promise<BacklogMutationResult> =>
    ipcRenderer.invoke('backlog:move-object-source', input),
  removeBacklogObjectRecord: (input: BacklogRemoveRecordInput): Promise<BacklogMutationResult> =>
    ipcRenderer.invoke('backlog:remove-object-record', input),
} satisfies Pick<
  ElectronApi,
  | 'readBacklogObjectStore'
  | 'ensureBacklogObjectRecords'
  | 'updateBacklogStatus'
  | 'updateBacklogType'
  | 'updateBacklogTriage'
  | 'addOrUpdateBacklogLink'
  | 'updateBacklogModuleMetadata'
  | 'moveBacklogObjectSource'
  | 'removeBacklogObjectRecord'
>
