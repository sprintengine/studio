import assert from 'node:assert/strict'

import {
  registerTrackerIpc,
  type TrackerIpcService,
  type TrackerWriteBackNoticeDeps,
} from './tracker-ipc'
import type { TrackerWriteBackIpcDeps } from './tracker-ipc'
import { DEFAULT_TRACKER_WRITEBACK_CONFIG, type TrackerWriteBackNotice } from '../../shared/tracker/writeback'

// Locks the tracker IPC wiring: every channel is registered and each delegates to
// the matching service / dependency method with the invoked input. The service
// mock keeps `listTransitions` (the gap that once broke the surface must not
// reintroduce), and the T18 write-back notice channels are covered end to end.

type Handler = (_event: unknown, ...args: unknown[]) => Promise<unknown>

function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle(channel, handler): void {
      handlers.set(channel, handler)
    },
  }
}

async function main(): Promise<void> {
  const calls: { method: string; input: unknown }[] = []
  const service: TrackerIpcService = {
    listConnections: async () => {
      calls.push({ method: 'listConnections', input: undefined })
      return { ok: true, connections: [] }
    },
    addConnection: async (input) => {
      calls.push({ method: 'addConnection', input })
      return { ok: true, connection: { id: 'trk-x', provider: 'github', baseUrl: null, authMode: 'github_pat', label: 'x', status: 'unknown' } }
    },
    removeConnection: async (input) => {
      calls.push({ method: 'removeConnection', input })
      return { ok: true }
    },
    testConnection: async (input) => {
      calls.push({ method: 'testConnection', input })
      return { ok: true, probe: { ok: true } }
    },
    search: async (input) => {
      calls.push({ method: 'search', input })
      return { ok: true, issues: [] }
    },
    fetchIssue: async (input) => {
      calls.push({ method: 'fetchIssue', input })
      return { ok: false, error: { kind: 'not_found', message: 'gone' } }
    },
    listTransitions: async (input) => {
      calls.push({ method: 'listTransitions', input })
      return { ok: true, transitions: [] }
    },
  }

  const ipcMain = createIpcMain()
  // Materialization is injected separately (it needs the writer, not just the IPC
  // service slice), so a mock captures its delegation without the real backlog fs.
  const materialize = async (input: unknown) => {
    calls.push({ method: 'materialize', input })
    return { ok: true as const, added: 1, refreshed: 0, failed: [] }
  }
  // Write-back config + sample-issue seam, mocked so the config/transition handlers
  // run without a real userData file or backlog.
  const writeBack: TrackerWriteBackIpcDeps = {
    getConfig: async (connectionId) => {
      calls.push({ method: 'getConfig', input: { connectionId } })
      return DEFAULT_TRACKER_WRITEBACK_CONFIG
    },
    setConfig: async (connectionId, config) => {
      calls.push({ method: 'setConfig', input: { connectionId, config } })
    },
    resolveSampleIssue: async (workspaceRoot, connectionId) => {
      calls.push({ method: 'resolveSampleIssue', input: { workspaceRoot, connectionId } })
      return { externalId: '42', nativeKey: 'PROJ-42' }
    },
  }
  const failingNotice: TrackerWriteBackNotice = {
    connectionId: 'trk-x',
    externalId: '42',
    provider: 'github',
    postKind: 'comment:started',
    relativePath: 'backlog/PROJ-42.md',
    message: 'GitHub rejected the credential.',
    at: '2026-07-22T00:00:00Z',
  }
  const writeBackNotices: TrackerWriteBackNoticeDeps = {
    listNotices: async () => {
      calls.push({ method: 'listNotices', input: undefined })
      return [failingNotice]
    },
    retryConnection: async (connectionId) => {
      calls.push({ method: 'retryConnection', input: { connectionId } })
      // Retry cleared it: nothing still failing for this connection.
      return []
    },
  }
  registerTrackerIpc(
    ipcMain as unknown as Parameters<typeof registerTrackerIpc>[0],
    service,
    materialize,
    writeBack,
    writeBackNotices,
  )

  for (const channel of [
    'tracker:listConnections',
    'tracker:addConnection',
    'tracker:removeConnection',
    'tracker:testConnection',
    'tracker:search',
    'tracker:fetchIssue',
    'tracker:materialize',
    'tracker:getWriteBackConfig',
    'tracker:setWriteBackConfig',
    'tracker:listTransitions',
    'tracker:listWriteBackNotices',
    'tracker:retryWriteBack',
  ]) {
    assert.ok(ipcMain.handlers.has(channel), `${channel} should be registered`)
  }

  await ipcMain.handlers.get('tracker:listConnections')!(null)
  await ipcMain.handlers.get('tracker:addConnection')!(null, { provider: 'github', baseUrl: null, authMode: 'github_pat', label: 'x', secret: 's' })
  await ipcMain.handlers.get('tracker:removeConnection')!(null, { connectionId: 'trk-x' })
  await ipcMain.handlers.get('tracker:testConnection')!(null, { connectionId: 'trk-x' })
  await ipcMain.handlers.get('tracker:search')!(null, { connectionId: 'trk-x', query: 'bug' })
  await ipcMain.handlers.get('tracker:fetchIssue')!(null, { connectionId: 'trk-x', externalId: '42' })
  await ipcMain.handlers.get('tracker:materialize')!(null, { workspaceRoot: '/ws', connectionId: 'trk-x', externalIds: ['42'] })
  await ipcMain.handlers.get('tracker:getWriteBackConfig')!(null, { connectionId: 'trk-x' })
  await ipcMain.handlers.get('tracker:setWriteBackConfig')!(null, { connectionId: 'trk-x', config: DEFAULT_TRACKER_WRITEBACK_CONFIG })

  assert.deepEqual(calls, [
    { method: 'listConnections', input: undefined },
    { method: 'addConnection', input: { provider: 'github', baseUrl: null, authMode: 'github_pat', label: 'x', secret: 's' } },
    { method: 'removeConnection', input: { connectionId: 'trk-x' } },
    { method: 'testConnection', input: { connectionId: 'trk-x' } },
    { method: 'search', input: { connectionId: 'trk-x', query: 'bug' } },
    { method: 'fetchIssue', input: { connectionId: 'trk-x', externalId: '42' } },
    { method: 'materialize', input: { workspaceRoot: '/ws', connectionId: 'trk-x', externalIds: ['42'] } },
    { method: 'getConfig', input: { connectionId: 'trk-x' } },
    { method: 'setConfig', input: { connectionId: 'trk-x', config: DEFAULT_TRACKER_WRITEBACK_CONFIG } },
  ])

  // listTransitions resolves a sample issue, then delegates to the service — the
  // mock gap (a service without listTransitions) must never come back.
  const transitionsResult = await ipcMain.handlers.get('tracker:listTransitions')!(null, {
    connectionId: 'trk-x',
    workspaceRoot: '/ws',
  })
  assert.deepEqual(transitionsResult, { ok: true, transitions: [], sampleKey: 'PROJ-42' })
  assert.deepEqual(calls.at(-2), { method: 'resolveSampleIssue', input: { workspaceRoot: '/ws', connectionId: 'trk-x' } })
  assert.deepEqual(calls.at(-1), { method: 'listTransitions', input: { connectionId: 'trk-x', externalId: '42' } })

  // Notices: list surfaces the recorded failure; retry delegates the connection id
  // and returns the post-retry state (here, cleared).
  const noticesResult = await ipcMain.handlers.get('tracker:listWriteBackNotices')!(null)
  assert.deepEqual(noticesResult, { ok: true, notices: [failingNotice] })

  const retryResult = await ipcMain.handlers.get('tracker:retryWriteBack')!(null, { connectionId: 'trk-x' })
  assert.deepEqual(retryResult, { ok: true, notices: [] })
  assert.deepEqual(calls.at(-1), { method: 'retryConnection', input: { connectionId: 'trk-x' } })

  console.log('tracker-ipc tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
