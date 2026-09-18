import assert from 'node:assert/strict'

import { registerWorkspaceSyncIpc } from './workspace-sync-ipc'
import { createWorkspaceSyncService } from '../workspace-sync-service'
import { createWorkspaceRegistryService } from '../workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../workspace-registry-store'

type Handler = (_event: IpcEvent, input?: unknown) => unknown

type IpcEvent = {
  sender: {
    id: number
    getURL(): string
  }
}

function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle(channel, handler): void {
      handlers.set(channel, handler)
    },
  }
}

function createWindow(id: number): {
  sent: { channel: string; payload: unknown }[]
  window: {
    isDestroyed(): boolean
    webContents: {
      id: number
      isDestroyed(): boolean
      send(channel: string, payload: unknown): void
    }
  }
} {
  const sent: { channel: string; payload: unknown }[] = []
  return {
    sent,
    window: {
      isDestroyed: () => false,
      webContents: {
        id,
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    },
  }
}

async function main(): Promise<void> {
  const ipcMain = createIpcMain()
  const source = createWindow(1)
  const target = createWindow(2)
  const destroyed = {
    isDestroyed: () => true,
    webContents: {
      id: 3,
      isDestroyed: () => false,
      send: () => {
        throw new Error('destroyed window should not receive broadcasts')
      },
    },
  }
  const service = createWorkspaceSyncService({
    registry: createWorkspaceRegistryService({ store: createInMemoryWorkspaceRegistryStore() }),
  })

  registerWorkspaceSyncIpc(ipcMain as unknown as Parameters<typeof registerWorkspaceSyncIpc>[0], service, {
    listWindows: () =>
      [source.window, target.window, destroyed] as unknown as ReturnType<
        NonNullable<NonNullable<Parameters<typeof registerWorkspaceSyncIpc>[2]>['listWindows']>
      >,
    getSourceWindowId: () => 'primary',
  })

  const dispatch = ipcMain.handlers.get('workspace-sync:dispatch')
  const getSnapshot = ipcMain.handlers.get('workspace-sync:get-snapshot')
  const getEventsAfter = ipcMain.handlers.get('workspace-sync:get-events-after')
  assert.ok(dispatch, 'dispatch handler should be registered')
  assert.ok(getSnapshot, 'snapshot handler should be registered')
  assert.ok(getEventsAfter, 'event replay handler should be registered')

  const result = await dispatch(
    { sender: { id: 1, getURL: () => 'app://main/?windowId=primary' } },
    {
      type: 'workspace_window.update_placement',
      payload: {
        windowId: 'primary',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
        displayId: null,
      },
    },
  )

  assert.equal((result as { ok: boolean }).ok, true)
  assert.equal(source.sent.length, 0, 'source renderer receives the accepted event through dispatch result only')
  assert.equal(target.sent.length, 1)
  assert.equal(target.sent[0]?.channel, 'workspace-sync:event')
  assert.equal((target.sent[0]?.payload as { sequence: number }).sequence, 1)

  const snapshot = await getSnapshot({ sender: { id: 1, getURL: () => '' } })
  assert.equal((snapshot as { sequence: number }).sequence, 1)
  const replay = await getEventsAfter({ sender: { id: 1, getURL: () => '' } }, 0)
  assert.equal((replay as unknown[]).length, 1)

  console.log('workspace-sync-ipc.test.ts: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
