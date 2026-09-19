import assert from 'node:assert/strict'

import { createWorkspaceSyncApi } from './workspace-sync'
import type { WorkspaceSyncEvent } from '../../shared/workspace-sync'
import { test } from 'vitest'

test('workspace-sync', async () => {
  type Listener = (event: unknown, syncEvent: WorkspaceSyncEvent) => void

  function main(): void {
    const calls: {
      on: { channel: string; listener: Listener }[]
      removed: { channel: string; listener: Listener }[]
    } = {
      on: [],
      removed: [],
    }

    const api = createWorkspaceSyncApi({
      async invoke() {
        throw new Error('invoke is not used in this test')
      },
      on(channel, listener) {
        calls.on.push({ channel, listener: listener as Listener })
      },
      removeListener(channel, listener) {
        calls.removed.push({ channel, listener: listener as Listener })
      },
    })

    const received: WorkspaceSyncEvent[] = []
    const cleanup = api.onWorkspaceSyncEvent((event) => received.push(event))
    assert.equal(calls.on.length, 1)
    assert.equal(calls.on[0]?.channel, 'workspace-sync:event')

    const syncEvent: WorkspaceSyncEvent = {
      id: 'workspace-sync-1',
      type: 'workspace_window.active_changed',
      sourceWindowId: 'primary',
      sequence: 1,
      createdAt: 1,
      payload: { windowId: 'primary', workspaceId: null },
    }
    calls.on[0]?.listener({}, syncEvent)
    assert.deepEqual(received, [syncEvent], 'listener forwards workspace-sync:event payloads')

    cleanup()
    assert.equal(calls.removed.length, 1)
    assert.equal(calls.removed[0]?.channel, 'workspace-sync:event')
    assert.equal(calls.removed[0]?.listener, calls.on[0]?.listener, 'cleanup removes the same listener it registered')

    console.log('workspace-sync-preload.test.ts: ok')
  }

  main()
})
