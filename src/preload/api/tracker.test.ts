import assert from 'node:assert/strict'

import { createTrackerApi } from './tracker'
import type { TrackerListConnectionsResult } from '../../shared/electron-api'

// Locks the preload channel mapping so a typo can't silently break the wiring to
// the main-process `tracker:*` handlers (src/main/ipc/tracker-ipc.ts).
async function main(): Promise<void> {
  const calls: { channel: string; input: unknown }[] = []
  const result: TrackerListConnectionsResult = { ok: true, connections: [] }

  const api = createTrackerApi({
    async invoke(channel: string, input?: unknown): Promise<never> {
      calls.push({ channel, input })
      return result as never
    },
  })

  await api.trackerListConnections()
  await api.trackerAddConnection({ provider: 'jira', baseUrl: 'https://jira', authMode: 'jira_basic', label: 'J', secret: 'k' })
  await api.trackerRemoveConnection({ connectionId: 'trk-1' })
  await api.trackerTestConnection({ connectionId: 'trk-1' })
  await api.trackerSearch({ connectionId: 'trk-1', query: 'q' })
  await api.trackerFetchIssue({ connectionId: 'trk-1', externalId: '9' })
  await api.trackerMaterialize({ workspaceRoot: '/ws', connectionId: 'trk-1', externalIds: ['9'] })

  assert.deepEqual(calls, [
    { channel: 'tracker:listConnections', input: undefined },
    { channel: 'tracker:addConnection', input: { provider: 'jira', baseUrl: 'https://jira', authMode: 'jira_basic', label: 'J', secret: 'k' } },
    { channel: 'tracker:removeConnection', input: { connectionId: 'trk-1' } },
    { channel: 'tracker:testConnection', input: { connectionId: 'trk-1' } },
    { channel: 'tracker:search', input: { connectionId: 'trk-1', query: 'q' } },
    { channel: 'tracker:fetchIssue', input: { connectionId: 'trk-1', externalId: '9' } },
    { channel: 'tracker:materialize', input: { workspaceRoot: '/ws', connectionId: 'trk-1', externalIds: ['9'] } },
  ])

  console.log('tracker-preload tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
