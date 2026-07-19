import type { IpcMain } from 'electron'

import { materializeTrackerIssues } from '../tracker/materialize/materialize-service'
import { getSharedTrackerService } from '../tracker/tracker-service'
import type {
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
} from '../../shared/tracker/types'

// The tracker IPC surface (plan §3.3). Renderer never issues tracker HTTP — every
// tracker call lands here. The service normalizes provider failures to typed
// TrackerErrors, and the secret only ever flows IN on addConnection; no decrypted
// value crosses back to the renderer.

// The slice of the service this IPC needs. Injectable so tests drive the handlers
// without the Electron-backed singleton.
export type TrackerIpcService = {
  listConnections(): Promise<TrackerListConnectionsResult>
  addConnection(input: TrackerAddConnectionInput): Promise<TrackerAddConnectionResult>
  removeConnection(input: TrackerRemoveConnectionInput): Promise<TrackerRemoveConnectionResult>
  testConnection(input: TrackerTestConnectionInput): Promise<TrackerTestConnectionResult>
  search(input: TrackerSearchInput): Promise<TrackerSearchResult>
  fetchIssue(input: TrackerFetchIssueInput): Promise<TrackerFetchIssueResult>
}

// Materialization needs the connection store + issue fetch (not just the narrow
// IPC service slice), so it is injected separately. The default binds the shared
// tracker service to the backlog-service writer via materializeTrackerIssues.
export type TrackerMaterializeHandler = (input: TrackerMaterializeInput) => Promise<TrackerMaterializeResult>

function defaultMaterializeHandler(input: TrackerMaterializeInput): Promise<TrackerMaterializeResult> {
  const service = getSharedTrackerService()
  return materializeTrackerIssues({
    ...input,
    tracker: {
      getConnection: (id) => service.connections.getConnection(id),
      fetchIssue: (fetchInput) => service.fetchIssue(fetchInput),
    },
  })
}

export function registerTrackerIpc(
  ipcMain: IpcMain,
  service: TrackerIpcService = getSharedTrackerService(),
  materialize: TrackerMaterializeHandler = defaultMaterializeHandler
): void {
  ipcMain.handle('tracker:listConnections', (): Promise<TrackerListConnectionsResult> => {
    return service.listConnections()
  })

  ipcMain.handle('tracker:addConnection', (_event, input: TrackerAddConnectionInput): Promise<TrackerAddConnectionResult> => {
    return service.addConnection(input)
  })

  ipcMain.handle(
    'tracker:removeConnection',
    (_event, input: TrackerRemoveConnectionInput): Promise<TrackerRemoveConnectionResult> => {
      return service.removeConnection(input)
    }
  )

  ipcMain.handle(
    'tracker:testConnection',
    (_event, input: TrackerTestConnectionInput): Promise<TrackerTestConnectionResult> => {
      return service.testConnection(input)
    }
  )

  ipcMain.handle('tracker:search', (_event, input: TrackerSearchInput): Promise<TrackerSearchResult> => {
    return service.search(input)
  })

  ipcMain.handle('tracker:fetchIssue', (_event, input: TrackerFetchIssueInput): Promise<TrackerFetchIssueResult> => {
    return service.fetchIssue(input)
  })

  ipcMain.handle('tracker:materialize', (_event, input: TrackerMaterializeInput): Promise<TrackerMaterializeResult> => {
    return materialize(input)
  })
}
