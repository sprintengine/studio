import assert from 'node:assert/strict'

import { registerTrackerIpc, type TrackerIpcService } from './tracker-ipc'

// Locks the tracker IPC wiring: every channel is registered and each delegates to
// the matching service method with the invoked input.

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
  }

  const ipcMain = createIpcMain()
  // Materialization is injected separately (it needs the writer, not just the IPC
  // service slice), so a mock captures its delegation without the real backlog fs.
  const materialize = async (input: unknown) => {
    calls.push({ method: 'materialize', input })
    return { ok: true as const, added: 1, refreshed: 0, failed: [] }
  }
  registerTrackerIpc(ipcMain as unknown as Parameters<typeof registerTrackerIpc>[0], service, materialize)

  for (const channel of [
    'tracker:listConnections',
    'tracker:addConnection',
    'tracker:removeConnection',
    'tracker:testConnection',
    'tracker:search',
    'tracker:fetchIssue',
    'tracker:materialize',
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

  assert.deepEqual(calls, [
    { method: 'listConnections', input: undefined },
    { method: 'addConnection', input: { provider: 'github', baseUrl: null, authMode: 'github_pat', label: 'x', secret: 's' } },
    { method: 'removeConnection', input: { connectionId: 'trk-x' } },
    { method: 'testConnection', input: { connectionId: 'trk-x' } },
    { method: 'search', input: { connectionId: 'trk-x', query: 'bug' } },
    { method: 'fetchIssue', input: { connectionId: 'trk-x', externalId: '42' } },
    { method: 'materialize', input: { workspaceRoot: '/ws', connectionId: 'trk-x', externalIds: ['42'] } },
  ])

  console.log('tracker-ipc tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
