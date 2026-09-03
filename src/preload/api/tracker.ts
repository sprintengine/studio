import { ipcRenderer } from 'electron'

import type {
  ElectronApi,
  TrackerAddConnectionInput,
  TrackerAddConnectionResult,
  TrackerFetchIssueInput,
  TrackerFetchIssueResult,
  TrackerGetWriteBackConfigInput,
  TrackerGetWriteBackConfigResult,
  TrackerListConnectionsResult,
  TrackerListTransitionsInput,
  TrackerListTransitionsResult,
  TrackerListWriteBackNoticesResult,
  TrackerRemoveConnectionInput,
  TrackerRemoveConnectionResult,
  TrackerRetryWriteBackInput,
  TrackerRetryWriteBackResult,
  TrackerSearchInput,
  TrackerSearchResult,
  TrackerSetWriteBackConfigInput,
  TrackerSetWriteBackConfigResult,
  TrackerTestConnectionInput,
  TrackerTestConnectionResult,
} from '../../shared/electron-api'

// Preload surface for the tracker seam. The renderer reads/writes tracker
// connections and searches/fetches issues only through these typed channels;
// there is no tracker HTTP in the renderer, and the secret only flows in on
// addConnection.
type TrackerIpcRenderer = {
  invoke(channel: 'tracker:listConnections'): Promise<TrackerListConnectionsResult>
  invoke(channel: 'tracker:addConnection', input: TrackerAddConnectionInput): Promise<TrackerAddConnectionResult>
  invoke(channel: 'tracker:removeConnection', input: TrackerRemoveConnectionInput): Promise<TrackerRemoveConnectionResult>
  invoke(channel: 'tracker:testConnection', input: TrackerTestConnectionInput): Promise<TrackerTestConnectionResult>
  invoke(channel: 'tracker:search', input: TrackerSearchInput): Promise<TrackerSearchResult>
  invoke(channel: 'tracker:fetchIssue', input: TrackerFetchIssueInput): Promise<TrackerFetchIssueResult>
  invoke(
    channel: 'tracker:getWriteBackConfig',
    input: TrackerGetWriteBackConfigInput
  ): Promise<TrackerGetWriteBackConfigResult>
  invoke(
    channel: 'tracker:setWriteBackConfig',
    input: TrackerSetWriteBackConfigInput
  ): Promise<TrackerSetWriteBackConfigResult>
  invoke(channel: 'tracker:listTransitions', input: TrackerListTransitionsInput): Promise<TrackerListTransitionsResult>
  invoke(channel: 'tracker:listWriteBackNotices'): Promise<TrackerListWriteBackNoticesResult>
  invoke(channel: 'tracker:retryWriteBack', input: TrackerRetryWriteBackInput): Promise<TrackerRetryWriteBackResult>
}

export function createTrackerApi(renderer: TrackerIpcRenderer) {
  return {
    trackerListConnections: (): Promise<TrackerListConnectionsResult> => renderer.invoke('tracker:listConnections'),
    trackerAddConnection: (input: TrackerAddConnectionInput): Promise<TrackerAddConnectionResult> =>
      renderer.invoke('tracker:addConnection', input),
    trackerRemoveConnection: (input: TrackerRemoveConnectionInput): Promise<TrackerRemoveConnectionResult> =>
      renderer.invoke('tracker:removeConnection', input),
    trackerTestConnection: (input: TrackerTestConnectionInput): Promise<TrackerTestConnectionResult> =>
      renderer.invoke('tracker:testConnection', input),
    trackerSearch: (input: TrackerSearchInput): Promise<TrackerSearchResult> => renderer.invoke('tracker:search', input),
    trackerFetchIssue: (input: TrackerFetchIssueInput): Promise<TrackerFetchIssueResult> =>
      renderer.invoke('tracker:fetchIssue', input),
    trackerGetWriteBackConfig: (input: TrackerGetWriteBackConfigInput): Promise<TrackerGetWriteBackConfigResult> =>
      renderer.invoke('tracker:getWriteBackConfig', input),
    trackerSetWriteBackConfig: (input: TrackerSetWriteBackConfigInput): Promise<TrackerSetWriteBackConfigResult> =>
      renderer.invoke('tracker:setWriteBackConfig', input),
    trackerListTransitions: (input: TrackerListTransitionsInput): Promise<TrackerListTransitionsResult> =>
      renderer.invoke('tracker:listTransitions', input),
    trackerListWriteBackNotices: (): Promise<TrackerListWriteBackNoticesResult> =>
      renderer.invoke('tracker:listWriteBackNotices'),
    trackerRetryWriteBack: (input: TrackerRetryWriteBackInput): Promise<TrackerRetryWriteBackResult> =>
      renderer.invoke('tracker:retryWriteBack', input),
  } satisfies Pick<
    ElectronApi,
    | 'trackerListConnections'
    | 'trackerAddConnection'
    | 'trackerRemoveConnection'
    | 'trackerTestConnection'
    | 'trackerSearch'
    | 'trackerFetchIssue'
    | 'trackerGetWriteBackConfig'
    | 'trackerSetWriteBackConfig'
    | 'trackerListTransitions'
    | 'trackerListWriteBackNotices'
    | 'trackerRetryWriteBack'
  >
}

export const trackerApi = createTrackerApi(ipcRenderer)
