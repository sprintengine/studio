import { ipcRenderer } from 'electron'
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
  BacklogMockupsInput,
  BacklogModuleMetadataInput,
  BacklogMutationResult,
  BacklogReadResult,
  BacklogRemoveLinkInput,
  BacklogRemoveRecordInput,
  BacklogStatusInput,
  BacklogTriageInput,
  BacklogMoveSourceInput,
  ElectronApi,
} from '../../shared/electron-api'

type BacklogIpcRenderer = {
  invoke(channel: 'backlog:read-object-store', workspaceRoot: string): Promise<BacklogReadResult>
  invoke(channel: 'backlog:ensure-object-records', workspaceRoot: string, items: BacklogItemRecordInput[]): Promise<BacklogReadResult>
  invoke(channel: 'backlog:ensure-item-ids', input: BacklogEnsureIdsInput): Promise<BacklogEnsureIdsResult>
  invoke(channel: 'backlog:update-status', input: BacklogStatusInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:update-triage', input: BacklogTriageInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:update-highlight', input: BacklogHighlightInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:add-or-update-link', input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:remove-link', input: BacklogRemoveLinkInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:update-module-metadata', input: BacklogModuleMetadataInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:move-object-source', input: BacklogMoveSourceInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:remove-object-record', input: BacklogRemoveRecordInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:update-epic', input: BacklogEpicInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:update-epic-color', input: BacklogEpicColorInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:update-dependencies', input: BacklogDependenciesInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:update-mockups', input: BacklogMockupsInput): Promise<BacklogMutationResult>
  invoke(channel: 'backlog:create-epic', input: BacklogCreateEpicInput): Promise<BacklogCreateEpicResult>
}

export function createBacklogApi(renderer: BacklogIpcRenderer) {
  return {
    readBacklogObjectStore: (workspaceRoot: string): Promise<BacklogReadResult> =>
      renderer.invoke('backlog:read-object-store', workspaceRoot),
    ensureBacklogObjectRecords: (workspaceRoot: string, items: BacklogItemRecordInput[]): Promise<BacklogReadResult> =>
      renderer.invoke('backlog:ensure-object-records', workspaceRoot, items),
    ensureBacklogItemIds: (input: BacklogEnsureIdsInput): Promise<BacklogEnsureIdsResult> =>
      renderer.invoke('backlog:ensure-item-ids', input),
    updateBacklogStatus: (input: BacklogStatusInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:update-status', input),
    updateBacklogTriage: (input: BacklogTriageInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:update-triage', input),
    updateBacklogHighlight: (input: BacklogHighlightInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:update-highlight', input),
    addOrUpdateBacklogLink: (input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:add-or-update-link', input),
    removeBacklogLink: (input: BacklogRemoveLinkInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:remove-link', input),
    updateBacklogModuleMetadata: (input: BacklogModuleMetadataInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:update-module-metadata', input),
    moveBacklogObjectSource: (input: BacklogMoveSourceInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:move-object-source', input),
    removeBacklogObjectRecord: (input: BacklogRemoveRecordInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:remove-object-record', input),
    updateBacklogEpic: (input: BacklogEpicInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:update-epic', input),
    updateBacklogEpicColor: (input: BacklogEpicColorInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:update-epic-color', input),
    updateBacklogDependencies: (input: BacklogDependenciesInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:update-dependencies', input),
    updateBacklogMockups: (input: BacklogMockupsInput): Promise<BacklogMutationResult> =>
      renderer.invoke('backlog:update-mockups', input),
    createBacklogEpic: (input: BacklogCreateEpicInput): Promise<BacklogCreateEpicResult> =>
      renderer.invoke('backlog:create-epic', input),
  } satisfies Pick<
    ElectronApi,
    | 'readBacklogObjectStore'
    | 'ensureBacklogObjectRecords'
    | 'ensureBacklogItemIds'
    | 'updateBacklogStatus'
    | 'updateBacklogTriage'
    | 'updateBacklogHighlight'
    | 'addOrUpdateBacklogLink'
    | 'removeBacklogLink'
    | 'updateBacklogModuleMetadata'
    | 'moveBacklogObjectSource'
    | 'removeBacklogObjectRecord'
    | 'updateBacklogEpic'
    | 'updateBacklogEpicColor'
    | 'updateBacklogDependencies'
    | 'updateBacklogMockups'
    | 'createBacklogEpic'
  >
}

export const backlogApi = createBacklogApi(ipcRenderer)
