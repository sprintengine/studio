import type { IpcMain } from 'electron'

import { resolveConnectionSampleIssue } from '../tracker/connection-sample-issue'
import { materializeTrackerIssues } from '../tracker/materialize/materialize-service'
import { getSharedTrackerService } from '../tracker/tracker-service'
import { getSharedTrackerWriteBackConfigStore } from '../tracker/writeback/config-store'
import {
  normalizeTrackerWriteBackConfig,
  type TrackerGetWriteBackConfigInput,
  type TrackerGetWriteBackConfigResult,
  type TrackerListTransitionsInput,
  type TrackerListTransitionsResult,
  type TrackerSetWriteBackConfigInput,
  type TrackerSetWriteBackConfigResult,
  type TrackerWriteBackConfig,
} from '../../shared/tracker/writeback'
import {
  toTrackerError,
  type TrackerAddConnectionInput,
  type TrackerAddConnectionResult,
  type TrackerFetchIssueInput,
  type TrackerFetchIssueResult,
  type TrackerListConnectionsResult,
  type TrackerMaterializeInput,
  type TrackerMaterializeResult,
  type TrackerRemoveConnectionInput,
  type TrackerRemoveConnectionResult,
  type TrackerSearchInput,
  type TrackerSearchResult,
  type TrackerTestConnectionInput,
  type TrackerTestConnectionResult,
  type TrackerTransition,
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
  listTransitions(input: {
    connectionId: string
    externalId: string
  }): Promise<{ ok: true; transitions: TrackerTransition[] } | { ok: false; error: ReturnType<typeof toTrackerError> }>
}

// The write-back seam the T11 settings surface drives: the per-connection config
// store (T10) and the representative-issue resolver that sources real transitions.
// Injected so tests exercise the handlers without a real userData file or backlog.
export type TrackerWriteBackIpcDeps = {
  getConfig(connectionId: string): Promise<TrackerWriteBackConfig>
  setConfig(connectionId: string, config: TrackerWriteBackConfig): Promise<void>
  resolveSampleIssue(
    workspaceRoot: string,
    connectionId: string,
  ): Promise<{ externalId: string; nativeKey: string } | null>
}

function defaultWriteBackDeps(): TrackerWriteBackIpcDeps {
  const store = getSharedTrackerWriteBackConfigStore()
  return {
    getConfig: (connectionId) => store.get(connectionId),
    setConfig: (connectionId, config) => store.set(connectionId, config),
    resolveSampleIssue: (workspaceRoot, connectionId) => resolveConnectionSampleIssue(workspaceRoot, connectionId),
  }
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
  materialize: TrackerMaterializeHandler = defaultMaterializeHandler,
  writeBack: TrackerWriteBackIpcDeps = defaultWriteBackDeps()
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

  // Write-back config round-trips the T10 schema (no secret). The store normalizes
  // on read and write, so a malformed blob degrades to the opt-in default rather
  // than corrupting the engine's gating.
  ipcMain.handle(
    'tracker:getWriteBackConfig',
    async (_event, input: TrackerGetWriteBackConfigInput): Promise<TrackerGetWriteBackConfigResult> => {
      try {
        return { ok: true, config: await writeBack.getConfig(input.connectionId) }
      } catch (err) {
        return { ok: false, error: toTrackerError(err, { connectionId: input.connectionId }) }
      }
    }
  )

  ipcMain.handle(
    'tracker:setWriteBackConfig',
    async (_event, input: TrackerSetWriteBackConfigInput): Promise<TrackerSetWriteBackConfigResult> => {
      try {
        await writeBack.setConfig(input.connectionId, normalizeTrackerWriteBackConfig(input.config))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: toTrackerError(err, { connectionId: input.connectionId }) }
      }
    }
  )

  // Enumerate a connection's status transitions from a REAL issue it already owns
  // in this workspace. No local issue ⇒ an honest empty list with `no_sample_issue`
  // (the UI asks the user to add one first); a provider without `canTransition`
  // ⇒ `unsupported`. Auth/network failures surface as ok:false so the UI shows the
  // real reason rather than a silently empty picker.
  ipcMain.handle(
    'tracker:listTransitions',
    async (_event, input: TrackerListTransitionsInput): Promise<TrackerListTransitionsResult> => {
      let sample: { externalId: string; nativeKey: string } | null
      try {
        sample = await writeBack.resolveSampleIssue(input.workspaceRoot, input.connectionId)
      } catch (err) {
        return { ok: false, error: toTrackerError(err, { connectionId: input.connectionId }) }
      }
      if (!sample) return { ok: true, transitions: [], sampleKey: null, reason: 'no_sample_issue' }

      const result = await service.listTransitions({ connectionId: input.connectionId, externalId: sample.externalId })
      if (!result.ok) {
        if (result.error.kind === 'unsupported') {
          return { ok: true, transitions: [], sampleKey: sample.nativeKey, reason: 'unsupported' }
        }
        return { ok: false, error: result.error }
      }
      return { ok: true, transitions: result.transitions, sampleKey: sample.nativeKey }
    }
  )
}
