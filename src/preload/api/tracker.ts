import { ipcRenderer } from 'electron'

import type {
  ElectronApi,
  TrackerAddConnectionInput,
  TrackerAddConnectionResult,
  TrackerFetchIssueInput,
  TrackerFetchIssueResult,
  TrackerListConnectionsResult,
  TrackerMaterializeInput,
  TrackerMaterializeResult,
  TrackerRemoveConnectionInput,
  TrackerRemoveConnectionResult,
  TrackerSearchInput,
  TrackerSearchResult,
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
  invoke(channel: 'tracker:materialize', input: TrackerMaterializeInput): Promise<TrackerMaterializeResult>
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
    trackerMaterialize: (input: TrackerMaterializeInput): Promise<TrackerMaterializeResult> =>
      renderer.invoke('tracker:materialize', input),
  } satisfies Pick<
    ElectronApi,
    | 'trackerListConnections'
    | 'trackerAddConnection'
    | 'trackerRemoveConnection'
    | 'trackerTestConnection'
    | 'trackerSearch'
    | 'trackerFetchIssue'
    | 'trackerMaterialize'
  >
}

export const trackerApi = createTrackerApi(ipcRenderer)
